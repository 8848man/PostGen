import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTags, projectNameForSources, projectTitle, withNaverTagLine } from '../next/post-metadata.mjs';
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

test('Naver draft keeps approved tags on the first line and shifts image positions once', () => {
  const sources = [{ id: 's', type: 'text', ref: 'source', text: 'text' }];
  let state = createJob(emptyState(), { accountId: 'a', audience: '독자', goal: '목표', sources });
  const id = state.jobs[0].id;
  const draft = { title: '제목', body: '첫 문단\n둘째 문단', tags: ['태그1', '태그2'], claims: [], images: [{ id: 'image', afterParagraph: 1, description: 'scene' }] };
  state = setDraft(state, id, draft, [], { channel: 'naver' });
  assert.equal(state.jobs[0].draft.body, '#태그1 #태그2\n첫 문단\n둘째 문단');
  assert.equal(state.jobs[0].draft.images[0].afterParagraph, 2);
  state = setDraft(state, id, { ...state.jobs[0].draft, tags: ['새태그'] }, [], { channel: 'naver' });
  assert.equal(state.jobs[0].draft.body, '#새태그\n첫 문단\n둘째 문단');
  assert.equal(state.jobs[0].draft.images[0].afterParagraph, 2);
  assert.throws(() => withNaverTagLine('본문', ['띄어 쓴 태그']), /single words/);
});
