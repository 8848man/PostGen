import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTextRequest, requireCostAcknowledgement } from '../next/cost.mjs';

test('unknown model price requires confirmation before a paid request', () => {
  const estimate = estimateTextRequest({ provider: 'claude', promptChars: 1000 });
  assert.equal(estimate.known, false);
  assert.throws(() => requireCostAcknowledgement(estimate, false), /confirmation/);
  assert.doesNotThrow(() => requireCostAcknowledgement(estimate, true));
});
