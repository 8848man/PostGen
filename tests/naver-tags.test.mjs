import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNaverBodyHasNoHashtags } from '../next/browser-adapter.mjs';
import { draftPrompt } from '../next/generate.mjs';

test('Naver body rejects text that the editor can interpret as a tag', () => {
  for (const body of ['PR #15 기록', '본문 #프로젝트', '#태그\n다음 문단', '내용 (#검토)']) {
    assert.throws(() => assertNaverBodyHasNoHashtags(body), /hashtag-like/);
  }
  for (const body of ['PR 15번 기록', 'C# 언어', '제목 # 기호']) {
    assert.doesNotThrow(() => assertNaverBodyHasNoHashtags(body));
  }
  assert.doesNotThrow(() => assertNaverBodyHasNoHashtags('#태그1 #태그2\n본문', ['태그1', '태그2']));
  assert.throws(() => assertNaverBodyHasNoHashtags('#태그1 #태그2\n본문 #15', ['태그1', '태그2']), /unapproved/);
});

test('draft prompt keeps hashtag-like references out of the body', () => {
  const prompt = draftPrompt({ sources: [], account: { channel: 'naver', handle: 'test' }, sample: null });
  assert.match(prompt, /Do not write hashtag-like # words or # numbers in the body/);
  assert.match(prompt, /PR 15번/);
});
