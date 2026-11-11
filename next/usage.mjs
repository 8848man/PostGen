// 모델 호출 후 실제 사용량을 실행 경로와 무관한 형태(ModelUsage)로 정규화한다.
// 계약: docs/sdd/next/04-contracts.md

const SUBSCRIPTION_UNAVAILABLE = {
  codex: 'Codex CLI exec 출력은 구독 한도 정보를 제공하지 않습니다.',
  openai: '직접 API 호출은 종량제라 구독 한도 대상이 아닙니다.',
  anthropic: '직접 API 호출은 종량제라 구독 한도 대상이 아닙니다.',
  claude: 'Claude Code CLI가 이번 호출에서 한도 정보를 보내지 않았습니다.'
};

const count = value => (Number.isFinite(value) && value >= 0 ? value : 0);

function tokens(provider, raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (provider === 'claude' || provider === 'anthropic') {
    const cached = count(raw.cache_read_input_tokens);
    const inputTokens = count(raw.input_tokens) + count(raw.cache_creation_input_tokens) + cached;
    return { inputTokens, cachedInputTokens: cached, outputTokens: count(raw.output_tokens) };
  }
  if (provider === 'codex') return { inputTokens: count(raw.input_tokens), cachedInputTokens: count(raw.cached_input_tokens), outputTokens: count(raw.output_tokens) };
  if (provider === 'openai') return { inputTokens: count(raw.input_tokens), cachedInputTokens: count(raw.input_tokens_details?.cached_tokens), outputTokens: count(raw.output_tokens) };
  return null;
}

function limitWindow(info) {
  if (!info || !Number.isFinite(info.utilization)) return null;
  return { usedPercent: Math.round(info.utilization * 1000) / 10, resetsAt: Number.isFinite(info.resetsAt) ? new Date(info.resetsAt * 1000).toISOString() : null };
}

export function subscriptionFromClaude(rateLimitInfo) {
  const windows = rateLimitInfo?.unifiedWindows;
  const fiveHour = limitWindow(windows?.five_hour), sevenDay = limitWindow(windows?.seven_day);
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

export function normalizeUsage(provider, raw, subscription = null) {
  const counted = tokens(provider, raw);
  return {
    provider,
    known: counted !== null,
    ...(counted ? { ...counted, totalTokens: counted.inputTokens + counted.outputTokens } : {}),
    subscription: provider === 'claude' ? subscription : null,
    subscriptionReason: provider === 'claude' && subscription ? null : SUBSCRIPTION_UNAVAILABLE[provider] || '구독 한도 정보를 알 수 없습니다.'
  };
}

export function summarizeUsage(entries) {
  const calls = entries.filter(Boolean).map(({ step, usage }) => ({ step, ...(usage || { known: false, subscription: null, subscriptionReason: '사용량을 받지 못했습니다.' }) }));
  const known = calls.filter(call => call.known);
  const sum = key => known.reduce((total, call) => total + call[key], 0);
  const latest = calls.filter(call => call.subscription).at(-1);
  return {
    calls,
    complete: calls.length > 0 && known.length === calls.length,
    totals: known.length ? { inputTokens: sum('inputTokens'), cachedInputTokens: sum('cachedInputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens') } : null,
    subscription: latest?.subscription || null,
    subscriptionReason: latest ? null : calls.at(-1)?.subscriptionReason || '구독 한도 정보를 알 수 없습니다.'
  };
}

export function describeUsage(summary) {
  if (!summary) return '사용량 확인 불가';
  const n = value => value.toLocaleString('ko-KR');
  const tokensText = summary.totals
    ? `토큰 입력 ${n(summary.totals.inputTokens)}(캐시 ${n(summary.totals.cachedInputTokens)}) · 출력 ${n(summary.totals.outputTokens)}${summary.complete ? '' : ' · 일부 호출 확인 불가'}`
    : '토큰 확인 불가';
  const sub = summary.subscription;
  const limitText = sub
    ? `구독 한도 사용률: 5시간 ${sub.fiveHour ? `${sub.fiveHour.usedPercent}%` : '확인 불가'} · 7일 ${sub.sevenDay ? `${sub.sevenDay.usedPercent}%` : '확인 불가'}`
    : `구독 한도 사용률 확인 불가 (${summary.subscriptionReason})`;
  return `${tokensText}\n${limitText}`;
}
