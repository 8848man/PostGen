import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, createJob, setDraft, approveDraft, cancelJob } from '../skill/postgen/scripts/next-core.mjs';
const standard = { set: 'naver-blog-post', sha256: 'a'.repeat(64) };

function selected() {
  return createJob(emptyState(), { accountId: 'account', accountHandle: 'blog', audience: '독자', goal: '설명', sources: [{ id: 'source', type: 'text', ref: 'input', text: '근거' }] });
}

test('approved draft retains unique heading metadata', () => {
  const state = selected(), id = state.jobs[0].id;
  const drafted = setDraft(state, id, { title: '제목', body: '도입\n소제목\n본문', headings: ['소제목'], claims: [], images: [], standard });
  const approved = approveDraft(drafted, id);
  assert.deepEqual(approved.jobs[0].draft.headings, ['소제목']);
  assert.throws(() => approveDraft(setDraft(state, id, { title: '제목', body: '도입\n본문', headings: ['없는 소제목'], claims: [], images: [], standard }), id), /heading must match/);
});

test('unsubmitted reservation may be cancelled for a corrected draft', () => {
  const state = selected(), id = state.jobs[0].id;
  const drafted = setDraft(state, id, { title: '제목', body: '본문', claims: [], images: [], standard });
  const approved = approveDraft(drafted, id);
  const awaiting = structuredClone(approved);
  awaiting.jobs[0].status = 'awaiting_registration';
  awaiting.jobs[0].schedule = { at: '2026-11-18T00:00:00.000Z', expiresAt: '2026-11-18T00:00:00.000Z' };
  assert.equal(cancelJob(awaiting, id).jobs[0].status, 'cancelled');
});
