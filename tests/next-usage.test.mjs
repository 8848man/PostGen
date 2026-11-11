import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, subscriptionFromClaude, summarizeUsage, describeUsage } from '../next/usage.mjs';
import { parseClaudeStream } from '../next/generate.mjs';

const rateLimitEvent = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.51, resetsAt: 1794401400, status: 'allowed' }, seven_day: { utilization: 0.41, resetsAt: 1794675600, status: 'allowed' } } } };

test('Claude stream output yields structured result, tokens and subscription utilization', () => {
  const stdout = [
    { type: 'system', subtype: 'init' },
    rateLimitEvent,
    { type: 'result', is_error: false, result: '', structured_output: { ok: 'yes' }, usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 11 } }
  ].map(event => JSON.stringify(event)).join('\n');
  const { result, usage } = parseClaudeStream(stdout);
  assert.deepEqual(result, { ok: 'yes' });
  assert.equal(usage.inputTokens, 152);
  assert.equal(usage.cachedInputTokens, 50);
  assert.equal(usage.outputTokens, 11);
  assert.equal(usage.subscription.fiveHour.usedPercent, 51);
  assert.equal(usage.subscription.sevenDay.usedPercent, 41);
  assert.equal(usage.subscription.fiveHour.resetsAt, new Date(1794401400 * 1000).toISOString());
});

test('Claude stream errors and missing results are rejected', () => {
  assert.throws(() => parseClaudeStream(JSON.stringify({ type: 'result', is_error: true, result: 'boom' })), /boom/);
  assert.throws(() => parseClaudeStream(JSON.stringify(rateLimitEvent)), /no result/);
});

test('Codex and direct API usage report tokens but no subscription limit', () => {
  const codex = normalizeUsage('codex', { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 20 });
  assert.equal(codex.totalTokens, 1020);
  assert.equal(codex.subscription, null);
  assert.match(codex.subscriptionReason, /Codex/);
  const openai = normalizeUsage('openai', { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } });
  assert.equal(openai.cachedInputTokens, 4);
  assert.match(openai.subscriptionReason, /종량제/);
  assert.equal(normalizeUsage('codex', null).known, false);
  assert.equal(subscriptionFromClaude(undefined), null);
});

test('summary does not count unknown calls as zero and keeps the latest subscription snapshot', () => {
  const sub = subscriptionFromClaude(rateLimitEvent.rate_limit_info);
  const summary = summarizeUsage([
    { step: 'plan', usage: normalizeUsage('claude', { input_tokens: 10, output_tokens: 5 }, sub) },
    { step: 'draft', usage: normalizeUsage('claude', { input_tokens: 20, output_tokens: 7 }, null) },
    { step: 'evaluation', usage: null }
  ]);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.totals, { inputTokens: 30, cachedInputTokens: 0, outputTokens: 12, totalTokens: 42 });
  assert.equal(summary.subscription.fiveHour.usedPercent, 51);
  const text = describeUsage(summary);
  assert.match(text, /일부 호출 확인 불가/);
  assert.match(text, /5시간 51%/);
  const codexOnly = describeUsage(summarizeUsage([{ step: 'draft', usage: normalizeUsage('codex', { input_tokens: 1, output_tokens: 1 }) }]));
  assert.match(codexOnly, /구독 한도 사용률 확인 불가 \(Codex/);
});
