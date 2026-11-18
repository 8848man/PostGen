import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyState, createJob, createCampaign, setCampaignPlan, setDraft as saveDraft, recordModelUsage, setDraftEvaluation, setImageProvider, approveImagePlan, attachGeneratedImage, recordImageCandidate, publishDraftReservation, approveDraft, reviewDraft, scheduleJob, rescheduleExpired, refreshDue, startPreparation, reviewPreparation, beginScheduleSubmission, markScheduleUnknown, confirmPlatformSchedule, confirmUnknownSchedule, recordPublication, pruneOldSources, restoreRetainedSources } from '../next/core.mjs';

const source = { id: 's1', type: 'text', ref: 'user-input', text: '근거 문장' };
const draft = { title: '제목', body: '본문', claims: [], images: [{ id: 'image-1', afterParagraph: 1, description: '테스트 그림' }] };
const standard = { set: 'naver-blog-post', sha256: 'a'.repeat(64) };
const setDraft = (state, id, value, diagnostics) => saveDraft(state, id, { ...value, standard }, diagnostics);

test('drafts without applied standard cannot enter normal review or publication', () => {
  const state = createJob(emptyState(), { accountId: 'a', audience: '독자', goal: '설명', sources: [source] });
  const id = state.jobs[0].id;
  const missing = saveDraft(state, id, { title: '제목', body: '본문', claims: [], images: [] });
  assert.throws(() => reviewDraft(missing, id, 'rejected', '다시 작성'), /standard record is missing/);
  assert.throws(() => approveDraft(missing, id), /standard record is missing/);
  assert.throws(() => publishDraftReservation(missing, id, '2026-11-20T00:00:00Z', {}, new Date('2026-11-18T00:00:00Z')), /standard record is missing/);
});

test('model calls persist by job and shared call ID can be deduplicated for campaign totals', () => {
  let state = createCampaign(emptyState(), { accounts: [{ id: 'a', handle: 'a', goal: '설명' }, { id: 'b', handle: 'b', goal: '설명' }], audience: '독자', sources: [source] });
  const id = state.jobs[0].id;
  state = recordModelUsage(state, id, 'shared-plan', { provider: 'codex', known: true, inputTokens: 10, outputTokens: 5, totalTokens: 15 }, { campaign: true, callId: 'one' });
  state = recordModelUsage(state, id, 'draft', { provider: 'codex', known: true, inputTokens: 20, outputTokens: 10, totalTokens: 30 }, { callId: 'two' });
  assert.deepEqual(state.jobs.map(job => job.modelUsage.map(entry => entry.id)), [['one','two'], ['one']]);
  state = setDraft(state, id, { title: '제목', body: '본문', claims: [], images: [] });
  state = setDraftEvaluation(state, id, { score: 4 });
  assert.equal(state.jobs[0].draft.evaluation.score, 4);
});

test('one publish action connects every candidate and starts reservation without partial changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-publish-'));
  try {
    const files = [path.join(dir, 'one.png'), path.join(dir, 'two.png')];
    files.forEach(file => fs.writeFileSync(file, 'image fixture'));
    let state = createJob(emptyState(), { accountId: 'account-1', audience: '독자', goal: '설명', sources: [source] });
    const id = state.jobs[0].id;
    state = setDraft(state, id, { title: '제목', body: '첫 문단\n둘째 문단', claims: [], images: [{ id: 'one', afterParagraph: 1, description: '첫 그림' }, { id: 'two', afterParagraph: 2, description: '둘째 그림' }] });
    state = setImageProvider(state, id, 'codex');
    state = approveImagePlan(state, id);
    state = recordImageCandidate(state, id, 'one', files[0], [{ check: { passed: false, reason: 'visual check failed' } }]);
    state = recordImageCandidate(state, id, 'two', files[1], [{ check: { passed: true, reason: 'ok' } }]);
    const now = new Date('2026-11-17T00:00:00Z');
    assert.throws(() => publishDraftReservation(state, id, '2026-11-17T00:05:00Z', {}, now), /ten minutes/);
    assert.equal(state.jobs[0].draft.images[0].pendingPath, files[0]);
    const result = publishDraftReservation(state, id, '2026-11-18T00:00:00Z', {}, now);
    assert.equal(result.jobs[0].status, 'awaiting_registration');
    assert.deepEqual(result.jobs[0].draft.images.map(image => image.generatedPath), files);
    assert.equal(result.jobs[0].draft.images[0].check.manualAccepted, true);
    assert.equal(result.jobs[0].approval.draftRevision, result.jobs[0].draft.revision);
    assert.equal(result.jobs[0].schedule.at, '2026-11-18T00:00:00.000Z');
    fs.unlinkSync(files[1]);
    assert.throws(() => publishDraftReservation(state, id, '2026-11-18T00:00:00Z', {}, now), /Image file is missing/);
    assert.equal(state.jobs[0].draft.images[0].generatedPath, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('review reason remains visible and approval is revoked before scheduling', () => {
  let state = createJob(emptyState(), { accountId: 'account-1', audience: '독자', goal: '설명', sources: [source] });
  const id = state.jobs[0].id;
  state = setDraft(state, id, { ...draft, images: [] });
  assert.throws(() => reviewDraft(state, id, 'rejected', ''), /reason/);
  state = reviewDraft(state, id, 'improvement_requested', '원본의 시각을 다시 확인');
  assert.equal(state.jobs[0].review.note, '원본의 시각을 다시 확인');
  state = approveDraft(state, id);
  assert.equal(state.jobs[0].review, null);
  state = reviewDraft(state, id, 'rejected', '제목을 다시 작성');
  assert.equal(state.jobs[0].status, 'draft');
  assert.equal(state.jobs[0].approval, null);
  assert.throws(() => scheduleJob(state, id, '2026-11-20T00:00:00Z'), /Cannot change draft job/);
  state = setDraft(state, id, { title: '수정한 제목', body: '본문', images: [] });
  assert.equal(state.jobs[0].review, null);
});

test('account approval, expiry, and editor checks gate publication', () => {
  let state = createJob(emptyState(), { accountId: 'account-1', audience: '처음 접하는 독자', goal: '설명', sources: [source] });
  const id = state.jobs[0].id;
  state = setDraft(state, id, draft, [{ code: 'source_conflict' }]);
  assert.throws(() => approveDraft(state, id), /Generate images/);
  state = approveImagePlan(state, id);
  state = attachGeneratedImage(state, id, 'image-1', 'C:/mock/image.png');
  assert.throws(() => approveDraft(state, id), /explicit acknowledgement/);
  state = approveDraft(state, id, { conflictAcknowledged: true });
  const now = new Date('2026-11-06T00:00:00Z');
  state = scheduleJob(state, id, '2026-11-07T00:00:00Z', now);
  assert.equal(state.jobs[0].status, 'awaiting_registration');
  state = startPreparation(state, id, new Date('2026-11-06T01:00:00Z'));
  const editor = { editorUrl: 'https://example.com/editor', visibleAccount: 'account-1', title: '제목', body: '본문', uploadedImages: ['image-1'] };
  assert.throws(() => reviewPreparation(state, id, { ...editor, visibleAccount: 'wrong' }), /Account mismatch/);
  assert.throws(() => reviewPreparation(state, id, { ...editor, uploadedImages: [] }), /Image upload/);
  state = reviewPreparation(state, id, editor);
  assert.equal(state.jobs[0].status, 'ready_to_register');
  state = beginScheduleSubmission(state, id, new Date('2026-11-06T02:00:00Z'));
  assert.throws(() => confirmPlatformSchedule(state, id, { accountHandle: 'wrong', publishAt: '2026-11-07T00:00:00Z', remoteId: 'r1', evidence: 'receipt', verified: true }), /account, time/);
  state = confirmPlatformSchedule(state, id, { accountHandle: 'account-1', publishAt: '2026-11-07T00:00:00Z', remoteId: 'r1', evidence: 'receipt', verified: true });
  assert.equal(state.jobs[0].status, 'registered');
  state = refreshDue(state, new Date('2026-11-07T01:00:00Z'));
  assert.equal(state.jobs[0].status, 'verification_due');
  state = recordPublication(state, id, { postUrl: 'https://example.com/post', source: 'user' }, new Date('2026-11-07T01:00:00Z'));
  assert.equal(state.jobs[0].status, 'published');
});

test('seven-day missed preparation expires', () => {
  let state = createJob(emptyState(), { accountId: 'account-1', audience: '독자', goal: '설명', sources: [source] });
  const id = state.jobs[0].id;
  state = approveDraft(setDraft(state, id, { ...draft, images: [] }), id);
  state = scheduleJob(state, id, '2026-11-20T00:00:00Z', new Date('2026-11-06T00:00:00Z'));
  state = refreshDue(state, new Date('2026-11-13T00:00:00Z'));
  assert.equal(state.jobs[0].status, 'expired');
  assert.throws(() => rescheduleExpired(state, id, '2026-11-16T00:00:00Z', {}, new Date('2026-11-15T00:00:00Z')), /new review/);
  state = rescheduleExpired(state, id, '2026-11-16T00:00:00Z', { factsAndLinksReviewed: true }, new Date('2026-11-15T00:00:00Z'));
  assert.equal(state.jobs[0].status, 'awaiting_registration');
});

test('retention removes old source copies but keeps final post', () => {
  let state = createJob(emptyState(), { accountId: 'a', audience: '독자', goal: '설명', sources: [source] });
  const id = state.jobs[0].id;
  state = approveDraft(setDraft(state, id, { ...draft, images: [] }), id);
  state = scheduleJob(state, id, '2026-01-02T00:00:00Z', new Date('2026-01-01T00:00:00Z'));
  state = startPreparation(state, id, new Date('2026-01-01T01:00:00Z'));
  state = reviewPreparation(state, id, { editorUrl: 'https://example.com/edit', visibleAccount: 'a', title: '제목', body: '본문' });
  state = beginScheduleSubmission(state, id, new Date('2026-01-01T02:00:00Z'));
  state = confirmPlatformSchedule(state, id, { accountHandle: 'a', publishAt: '2026-01-02T00:00:00Z', remoteId: 'r1', evidence: 'receipt', verified: true });
  state = refreshDue(state, new Date('2026-01-02T01:00:00Z'));
  state = recordPublication(state, id, { postUrl: 'https://example.com/post' }, new Date('2026-01-02T01:00:00Z'));
  state.jobs[0].createdAt = '2026-01-01T00:00:00Z';
  state = pruneOldSources(state, 3, new Date('2026-05-01T00:00:00Z'));
  assert.equal(state.jobs[0].sources[0].text, null);
  assert.equal(state.jobs[0].publication.postUrl, 'https://example.com/post');
});

test('two accounts share evidence plan but keep separate drafts and approvals', () => {
  let state = createCampaign(emptyState(), { accounts: [{ id: 'a', handle: 'first', goal: '설명' }, { id: 'b', handle: 'second', goal: '분석' }], audience: '독자', sources: [source] });
  assert.equal(state.jobs[0].campaignId, state.jobs[1].campaignId);
  state = setCampaignPlan(state, state.jobs[0].campaignId, { angle: '공통 주제', keyClaims: [{ text: '사실', sourceIds: ['s1'] }], conflicts: [] });
  state = setDraft(state, state.jobs[0].id, { title: '계정 A', body: '설명', claims: [], images: [] });
  assert.equal(state.jobs[1].draft, null);
  assert.equal(state.jobs[1].plan.angle, '공통 주제');
});

test('an uncertain platform submission cannot be silently retried', () => {
  let state = createJob(emptyState(), { accountId: 'a', audience: 'reader', goal: 'inform', sources: [source] });
  const id = state.jobs[0].id, now = new Date('2026-11-06T00:00:00Z');
  state = approveDraft(setDraft(state, id, { title: 'title', body: 'body', claims: [], images: [] }), id);
  state = scheduleJob(state, id, '2026-11-08T00:00:00Z', now);
  state = startPreparation(state, id, now);
  state = reviewPreparation(state, id, { editorUrl: 'https://example.com/edit', visibleAccount: 'a', title: 'title', body: 'body' });
  state = beginScheduleSubmission(state, id, now);
  state = markScheduleUnknown(state, id, 'No receipt');
  assert.equal(state.jobs[0].status, 'unknown');
  assert.throws(() => beginScheduleSubmission(state, id, now), /Cannot change unknown job/);
  // only a verified re-read of the platform list can confirm it, with the same account and time checks
  assert.throws(() => confirmUnknownSchedule(state, id, { accountHandle: 'a', publishAt: '2026-11-08T01:00:00Z', reservationUrl: 'https://blog.naver.com/a?Redirect=Write&', evidence: 'list', verified: true }), /account, time/);
  assert.throws(() => confirmUnknownSchedule(state, id, { accountHandle: 'a', publishAt: '2026-11-08T00:00:00Z', reservationUrl: 'https://blog.naver.com/a?Redirect=Write&', evidence: 'list', verified: false }), /account, time/);
  state = confirmUnknownSchedule(state, id, { accountHandle: 'a', publishAt: '2026-11-08T00:00:00Z', reservationUrl: 'https://blog.naver.com/a?Redirect=Write&', evidence: 'list', verified: true });
  assert.equal(state.jobs[0].status, 'registered');
  assert.equal(state.jobs[0].registration.recheckedAfterUnknown, true);
  assert.throws(() => confirmUnknownSchedule(state, id, { accountHandle: 'a', publishAt: '2026-11-08T00:00:00Z', reservationUrl: 'x', evidence: 'list', verified: true }), /Cannot change registered job/);
});

test('expired source copies can be restored for 14 days, then are purged', () => {
  let state = createJob(emptyState(), { accountId: 'a', audience: 'reader', goal: 'explain', sources: [source] });
  const id = state.jobs[0].id;
  state = setDraft(state, id, { title: 'Final title', body: 'Final body', claims: [], images: [], evaluation: { score: 4 } });
  state.jobs[0].createdAt = '2026-01-01T00:00:00Z';
  state.jobs[0].plan = { angle: 'Working plan' };
  state.jobs[0].diagnostics = [{ code: 'review' }];
  const removed = pruneOldSources(state, 3, new Date('2026-05-01T00:00:00Z'));
  assert.equal(removed.jobs[0].sources[0].text, null);
  assert.equal(removed.jobs[0].plan, null);
  assert.deepEqual(removed.jobs[0].diagnostics, []);
  assert.equal(removed.jobs[0].draft.body, 'Final body');
  assert.equal(removed.jobs[0].draft.evaluation.score, 4);
  assert.equal(removed.retentionTrash.length, 1);
  const restored = restoreRetainedSources(removed, id, new Date('2026-05-14T00:00:00Z'));
  assert.equal(restored.jobs[0].sources[0].text, source.text);
  assert.equal(restored.jobs[0].plan.angle, 'Working plan');
  assert.equal(restored.retentionTrash.length, 0);
  assert.equal(pruneOldSources(restored, 3, new Date('2026-05-15T00:00:00Z')).jobs[0].sources[0].text, source.text);
  const purged = pruneOldSources(removed, 3, new Date('2026-05-16T00:00:00Z'));
  assert.equal(purged.retentionTrash.length, 0);
  assert.throws(() => restoreRetainedSources(purged, id, new Date('2026-05-16T00:00:00Z')), /No restorable/);
});
