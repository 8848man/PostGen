// Length rule from an Assets Manager standard ("- **분량**: 본문 2,000~3,000자") and the body length check.
// Only the lower bound is checked here: a short draft is the case that slipped through review (job 5ed8405c, 1,924 chars).
const LENGTH_LINE = /^- \*\*분량\*\*:\s*(.+)$/m;
const number = text => Number(String(text).replace(/,/g, ''));

// Returns { rule, min, max, excludeSpaces } or null when the standard states no length.
// Parenthesised notes such as "(권장 300~800자)" are recommendations, not bounds, so they are not read as a range;
// "(공백 제외)" only switches the count to non-space characters.
export function parseLengthRule(text) {
  const rule = String(text || '').match(LENGTH_LINE)?.[1]?.trim();
  if (!rule) return null;
  const main = rule.replace(/\([^)]*\)/g, ' ');
  const range = main.match(/(\d[\d,]*)\s*[~～-]\s*(\d[\d,]*)\s*자/);
  const upTo = main.match(/(\d[\d,]*)\s*자\s*이내/);
  const atLeast = main.match(/(\d[\d,]*)\s*자\s*이상/);
  const min = range ? number(range[1]) : atLeast ? number(atLeast[1]) : null;
  const max = range ? number(range[2]) : upTo ? number(upTo[1]) : null;
  if (min === null && max === null) return null;
  return { rule, min, max, excludeSpaces: /공백\s*제외/.test(rule) };
}

// Characters of the body as a reader sees it: line breaks and hashtag-only lines (the Naver tag line) are not counted.
export function bodyLength(body, { excludeSpaces = false } = {}) {
  const text = String(body || '').split(/\r?\n/).filter(line => !/^\s*(#\S+\s*)+$/.test(line)).join('');
  return excludeSpaces ? text.replace(/\s/g, '').length : text.length;
}

// Returns null when the rule has no lower bound, otherwise { count, min, excludeSpaces, rule, below }.
export function checkLengthFloor(body, rule) {
  if (!Number.isInteger(rule?.min) || rule.min <= 0) return null;
  const count = bodyLength(body, rule);
  return { count, min: rule.min, excludeSpaces: !!rule.excludeSpaces, rule: rule.rule, below: count < rule.min };
}

export function lengthFloorMessage(check) {
  return `본문 ${check.count.toLocaleString('en-US')}자${check.excludeSpaces ? '(공백 제외)' : ''}로 Assets Manager 표준 분량 하한 ${check.min.toLocaleString('en-US')}자에 못 미칩니다 (표준: ${check.rule}).`;
}
