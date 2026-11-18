import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTags, projectNameForSources, projectTitle } from '../next/post-metadata.mjs';
import { createJob, emptyState, setDraft } from '../skill/postgen/scripts/next-core.mjs';

test('source project becomes one title prefix and five editable tags', () => {
  const sources = [{ id: 'source-1', type: 'text', ref: 'posts/postgen/2026-11-17-overview.md', text: '작업 기록' }];
  assert.equal(projectNameForSources(sources), 'PostGen');
  assert.equal(projectTitle('PostGen 첫 예약 기록', 'PostGen'), '[PostGen] 첫 예약 기록');
  assert.equal(projectTitle('[PostGen] 첫 예약 기록', 'PostGen'), '[PostGen] 첫 예약 기록');
  let state = createJob(emptyState(), { accountId: 'a', audience: '독자', goal: '목표', sources });
  state = setDraft(state, state.jobs[0].id, { title: 'PostGen 첫 예약 기록', body: '본문', claims: [], images: [], tags: ['PostGen', '블로그', '예약', '개발', '검토'] });
  assert.equal(state.jobs[0].draft.title, '[PostGen] 첫 예약 기록');
  assert.equal(state.jobs[0].draft.tags.length, 5);
  assert.throws(() => cleanTags(['중복', '중복']), /unique/);
  assert.throws(() => cleanTags(['1', '2', '3', '4', '5', '6']), /five/);
});
