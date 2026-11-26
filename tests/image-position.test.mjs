import test from 'node:test';
import assert from 'node:assert/strict';
import { settleImagePosition, imagePositionAllowed } from '../skill/postgen/scripts/body-structure.mjs';
import { emptyState, createJob, setDraft, setImagePosition } from '../skill/postgen/scripts/next-core.mjs';

// Same shape as the Tistory draft that failed: 목차 entries repeat the headings, sections hold "- " lists.
const headings = ['1. 첫째 절', '2. 둘째 절'];
const body = ['도입 문단', '목차', '1. 첫째 절', '2. 둘째 절', '1. 첫째 절', '첫째 문단', '- 항목 하나: 설명', '- 항목 둘: 설명', '✔ Point = 정리', '2. 둘째 절', '둘째 문단'].join('\n');

test('an image on a table of contents entry moves under the real subheading', () => {
  assert.equal(settleImagePosition(body, headings, 3), 5);
  assert.equal(settleImagePosition(body, headings, 4), 10);
});

test('an image inside a list moves to the block before the list', () => {
  assert.equal(settleImagePosition(body, headings, 7), 6);
  assert.equal(settleImagePosition(body, headings, 8), 6);
});

test('paragraphs, subheadings and out-of-range positions stay as they are', () => {
  for (const position of [1, 5, 6, 9, 10, 11, 99]) assert.equal(settleImagePosition(body, headings, position), position);
  assert.equal(imagePositionAllowed(body, headings, 7), false);
  assert.equal(imagePositionAllowed(body, headings, 3), false);
  assert.equal(imagePositionAllowed(body, headings, 9), true);
});

test('saved drafts settle positions and the review screen cannot move an image into a list', () => {
  let state = createJob(emptyState(), { accountId: 'tistory', accountHandle: 'blog', audience: 'reader', goal: 'inform', sources: [{ id: 's', type: 'text', ref: 'input', text: 'source' }] });
  const id = state.jobs[0].id;
  state = setDraft(state, id, { title: '제목', body, headings, claims: [], images: [{ id: 'a', afterParagraph: 3, description: '요약 도식' }, { id: 'b', afterParagraph: 8, description: '목록 도식' }], standard: { set: 'tistory-blog-post', sha256: 'a'.repeat(64) } }, [], { channel: 'tistory' });
  assert.deepEqual(state.jobs[0].draft.images.map(image => image.afterParagraph), [5, 6]);
  assert.throws(() => setImagePosition(state, id, 'a', 7), /inside the table of contents or a list/);
  assert.equal(setImagePosition(state, id, 'a', 9).jobs[0].draft.images[0].afterParagraph, 9);
});
