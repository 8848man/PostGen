import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, createJob, createCampaign, setCampaignPlan, setDraft, approveImagePlan, attachGeneratedImage, approveDraft, scheduleJob, rescheduleExpired, refreshDue, startPreparation, reviewPreparation, beginScheduleSubmission, markScheduleUnknown, confirmPlatformSchedule, recordPublication, pruneOldSources } from '../next/core.mjs';

const source = { id: 's1', type: 'text', ref: 'user-input', text: '근거 문장' };
const draft = { title: '제목', body: '본문', claims: [], images: [{ id: 'image-1', afterParagraph: 1, description: '테스트 그림' }] };

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
});
