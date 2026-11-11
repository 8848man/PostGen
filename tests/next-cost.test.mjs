import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { approximateTokens, estimateTextRequest, estimateImageRequest, requireCostAcknowledgement } from '../next/cost.mjs';

test('token approximation counts Korean characters individually', () => {
  assert.equal(approximateTokens('abcdefgh'), 2);
  assert.equal(approximateTokens('한국어 문장'), 5 + 1);
  assert.equal(approximateTokens(''), 0);
});

test('text estimate multiplies approximated prompt tokens by call count', () => {
  const dir = fs.mkdtempSync(path.join(path.resolve('tests'), '.postgen-price-'));
  const previousTable = process.env.POSTGEN_PRICE_TABLE;
  try {
    process.env.POSTGEN_PRICE_TABLE = path.join(dir, 'prices.json');
    fs.writeFileSync(process.env.POSTGEN_PRICE_TABLE, JSON.stringify({ 'anthropic:test-model': { inputPerMillion: 1, outputPerMillion: 10 } }));
    const estimate = estimateTextRequest({ provider: 'anthropic', model: 'test-model', promptText: '가나다라abcd', calls: 3, outputTokens: 1000 });
    assert.equal(estimate.known, true);
    assert.equal(estimate.inputTokens, (4 + 1) * 3);
    assert.ok(Math.abs(estimate.estimatedUsd - (15 * 1 + 1000 * 10) / 1_000_000) < 1e-12);
    assert.match(estimate.basis, /3회/);
    assert.throws(() => estimateTextRequest({ provider: 'anthropic', model: 'test-model', promptText: 'x', calls: 0 }), /call count/);
  } finally {
    if (previousTable === undefined) delete process.env.POSTGEN_PRICE_TABLE; else process.env.POSTGEN_PRICE_TABLE = previousTable;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown model price requires confirmation before a paid request', () => {
  const estimate = estimateTextRequest({ provider: 'claude', promptChars: 1000 });
  assert.equal(estimate.known, false);
  assert.throws(() => requireCostAcknowledgement(estimate, false), /confirmation/);
  assert.doesNotThrow(() => requireCostAcknowledgement(estimate, true));
});

test('image estimate uses sourced user price and exposes excluded check cost', () => {
  const dir = fs.mkdtempSync(path.join(path.resolve('tests'), '.postgen-price-'));
  const previousTable = process.env.POSTGEN_PRICE_TABLE;
  const previousLimit = process.env.POSTGEN_COST_LIMIT_USD;
  try {
    process.env.POSTGEN_PRICE_TABLE = path.join(dir, 'prices.json');
    process.env.POSTGEN_COST_LIMIT_USD = '1';
    fs.writeFileSync(process.env.POSTGEN_PRICE_TABLE, JSON.stringify({
      'image:openai:test-model:generation': { perImageUsd: 0.4, verified: true, sourceUrl: 'https://example.com/prices', verifiedAt: '2026-11-10' },
      'image:openai:test-model:edit': { perImageUsd: 0.6 }
    }));
    const estimate = estimateImageRequest({ model: 'test-model', attempts: 3 });
    assert.equal(estimate.known, true);
    assert.ok(Math.abs(estimate.estimatedUsd - 1.2) < 1e-9);
    assert.equal(estimate.priceVerifiedAt, '2026-11-10');
    assert.throws(() => requireCostAcknowledgement(estimate, false), /confirmation/);
    const checked = estimateImageRequest({ model: 'test-model', attempts: 3, autoCheck: true });
    assert.equal(checked.known, false);
    assert.ok(Math.abs(checked.generationEstimatedUsd - 1.2) < 1e-9);
    assert.match(checked.limitation, /점검/);
    assert.equal(estimateImageRequest({ model: 'test-model', hasAsset: true }).known, false);
    assert.equal(estimateImageRequest({ model: 'missing' }).known, false);
  } finally {
    if (previousTable === undefined) delete process.env.POSTGEN_PRICE_TABLE; else process.env.POSTGEN_PRICE_TABLE = previousTable;
    if (previousLimit === undefined) delete process.env.POSTGEN_COST_LIMIT_USD; else process.env.POSTGEN_COST_LIMIT_USD = previousLimit;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
