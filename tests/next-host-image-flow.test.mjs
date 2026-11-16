import test from 'node:test';
import assert from 'node:assert/strict';
import { runImageAttempts } from '../next/host-image-flow.mjs';

test('automatic check retries a failed candidate and keeps only the last one', async () => {
  const discarded = [];
  const feedback = [];
  const result = await runImageAttempts({ scene: 'chart', referencePaths: [], request: null }, { remaining: 3, autoCheck: true }, {
    generate: async input => { feedback.push(input.feedback); return { path: `source-${feedback.length}`, usage: { known: true, totalTokens: 2 }, imageUsage: { known: false } }; },
    importImage: async file => `managed-${file}`,
    check: async ({ generatedPath }) => ({ check: { passed: generatedPath.endsWith('2'), reason: generatedPath.endsWith('2') ? '맞음' : '장면이 다름' }, usage: { known: true, totalTokens: 3 } }),
    discard: async file => discarded.push(file)
  });
  assert.deepEqual(feedback, ['', '장면이 다름']);
  assert.deepEqual(discarded, ['managed-source-1']);
  assert.equal(result.storedPath, 'managed-source-2');
  assert.deepEqual(result.attempts.map(a => a.check.passed), [false, true]);
  assert.equal(result.attempts[1].checkUsage.totalTokens, 3);
});

test('check errors fail closed and the last candidate remains for human review', async () => {
  let count = 0;
  const result = await runImageAttempts({ scene: 'diagram', referencePaths: [] }, { remaining: 2, autoCheck: true }, {
    generate: async () => ({ path: `source-${++count}`, usage: null, imageUsage: { known: false } }),
    importImage: async file => file,
    check: async () => { throw new Error('unavailable'); },
    discard: async () => {}
  });
  assert.equal(count, 2);
  assert.equal(result.storedPath, 'source-2');
  assert.equal(result.attempts.at(-1).check.passed, false);
  assert.match(result.attempts.at(-1).check.reason, /unavailable/);
});
