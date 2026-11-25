import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDraft } from '../next/generate.mjs';

const input = { sources: [{ id: 'source-1', type: 'text', text: '사실', ref: 'user' }], account: { channel: 'naver', handle: 'me' }, sample: null, audience: '초보자', goal: '설명' };

test('generated claims cannot cite a source the user did not select', async () => {
  await assert.rejects(generateDraft(input, {}, async () => ({ result: { title: '제목', body: '본문', claims: [{ text: '주장', sourceIds: ['other'] }], images: [], diagnostics: [] } })), /unselected source/);
});

test('generation applies the project prefix and keeps five suggested tags', async () => {
  const result = await generateDraft({ ...input, projectName: 'PostGen' }, {}, async () => ({ result: { title: 'PostGen 검토 화면', tags: ['PostGen', '블로그', '검토', '원본', '초안'], body: '본문', headings: [], claims: [], images: [], diagnostics: [] } }));
  assert.equal(result.draft.title, '[PostGen] 검토 화면');
  assert.deepEqual(result.draft.tags, ['PostGen', '블로그', '검토', '원본', '초안']);
});

test('generated Naver tags become single words so the body tag line can be saved', async () => {
  const result = await generateDraft(input, {}, async () => ({ result: { title: '제목', tags: ['네이버 블로그', '예약-발행', '네이버블로그', 'AI'], body: '본문', headings: [], claims: [], images: [], diagnostics: [] } }));
  assert.deepEqual(result.draft.tags, ['네이버블로그', '예약발행', 'AI']);
  assert.ok(result.diagnostics.some(item => item.code === 'naver_tags_squeezed'));
  const tistory = await generateDraft({ ...input, account: { channel: 'tistory', handle: 'me' } }, {}, async () => ({ result: { title: '제목', tags: ['네이버 블로그'], body: '본문', headings: [], claims: [], images: [], diagnostics: [] } }));
  assert.deepEqual(tistory.draft.tags, ['네이버 블로그']);
});

test('Naver draft prompt asks for single-word tags', async () => {
  let prompt = '';
  await generateDraft(input, {}, async text => { prompt = text; return { result: { title: '제목', tags: [], body: '본문', headings: [], claims: [], images: [], diagnostics: [] } }; });
  assert.match(prompt, /single word with no spaces/);
  assert.doesNotMatch(prompt, /Tistory formatting/);
});

test('headings repeated by the table of contents are kept and Tistory prompt explains the formatting', async () => {
  let prompt = '';
  const body = '도입\n\n목차\n1. 첫째\n2. 둘째\n\n1. 첫째\n본문\n2. 둘째\n본문';
  const result = await generateDraft({ ...input, account: { channel: 'tistory', handle: 'me' } }, {}, async text => { prompt = text; return { result: { title: '제목', tags: [], body, headings: ['1. 첫째', '2. 둘째', '1. 첫째'], claims: [], images: [], diagnostics: [] } }; });
  assert.deepEqual(result.draft.headings, ['1. 첫째', '2. 둘째']);
  assert.ok(!result.diagnostics.some(item => item.code === 'heading_mismatch'));
  assert.match(prompt, /Tistory formatting is applied/);
});
