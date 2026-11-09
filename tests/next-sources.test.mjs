import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSelected } from '../next/sources.mjs';

test('only explicitly selected text and connected source are copied', async () => {
  const sources = await collectSelected([
    { type: 'text', text: '직접 쓴 자료' },
    { type: 'connected', ref: 'doc-1' }
  ], { connectedReader: async spec => spec.ref === 'doc-1' ? '연결된 문서' : '' });
  assert.deepEqual(sources.map(source => source.type), ['text', 'connected']);
  assert.equal(sources[1].text, '연결된 문서');
  assert.equal(sources[0].sha256.length, 64);
});

test('connected source cannot be silently read without its adapter', async () => {
  await assert.rejects(collectSelected([{ type: 'connected', ref: 'doc-1' }]), /adapter unavailable/);
});
