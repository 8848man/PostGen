import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDraft } from '../next/generate.mjs';

const input = { sources: [{ id: 'source-1', type: 'text', text: '사실', ref: 'user' }], account: { channel: 'naver', handle: 'me' }, sample: null, audience: '초보자', goal: '설명' };

test('generated claims cannot cite a source the user did not select', async () => {
  await assert.rejects(generateDraft(input, {}, async () => ({ result: { title: '제목', body: '본문', claims: [{ text: '주장', sourceIds: ['other'] }], images: [], diagnostics: [] } })), /unselected source/);
});
