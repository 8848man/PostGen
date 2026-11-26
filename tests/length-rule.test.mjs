import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyLength, checkLengthFloor, lengthFloorMessage, parseLengthRule } from '../skill/postgen/scripts/length-rule.mjs';
import { parseStandard, standardRecord } from '../next/assets-standard.mjs';
import { evaluateDraft } from '../next/evaluate.mjs';
import { emptyState, createJob, setDraft, setDraftEvaluation } from '../next/core.mjs';

// The "분량" lines of the current Assets Manager sets (2026-11-27).
test('length rule reads the lower bound from each Assets Manager set', () => {
  assert.deepEqual(parseLengthRule('## 규칙\n- **분량**: 본문 2,000~3,000자\n- **톤**: 친근'), { rule: '본문 2,000~3,000자', min: 2000, max: 3000, excludeSpaces: false });
  assert.deepEqual(parseLengthRule('- **분량**: 본문 3,000~5,000자(공백 제외)'), { rule: '본문 3,000~5,000자(공백 제외)', min: 3000, max: 5000, excludeSpaces: true });
  assert.deepEqual(parseLengthRule('- **분량**: 해시태그 포함 1,200~2,500자'), { rule: '해시태그 포함 1,200~2,500자', min: 1200, max: 2500, excludeSpaces: false });
  // A recommendation in parentheses is not a floor.
  assert.equal(parseLengthRule('- **분량**: 해시태그 포함 2,000자 이내(권장 300~800자)').min, null);
  assert.equal(parseLengthRule('- **분량**: 해시태그 포함 280자 이내(X는 한글을 2자로 세므로 공백 포함 약 120자)').min, null);
  assert.equal(parseLengthRule('## 규칙\n- **톤**: 친근'), null);
});

test('body length skips line breaks and the hashtag line, and spaces when the standard says so', () => {
  const body = '첫 문단 입니다\n\n둘째 문단\n\n#태그 #예약발행';
  assert.equal(bodyLength(body), '첫 문단 입니다둘째 문단'.length);
  assert.equal(bodyLength(body, { excludeSpaces: true }), '첫문단입니다둘째문단'.length);
  assert.equal(bodyLength('제목 #1 같은 문장'), '제목 #1 같은 문장'.length);
});

test('floor check flags a short draft and passes a long one', () => {
  const rule = parseLengthRule('- **분량**: 본문 2,000~3,000자');
  const short = checkLengthFloor('가'.repeat(1924), rule);
  assert.deepEqual(short, { count: 1924, min: 2000, excludeSpaces: false, rule: '본문 2,000~3,000자', below: true });
  assert.match(lengthFloorMessage(short), /1,924자.*하한 2,000자/);
  assert.equal(checkLengthFloor('가'.repeat(2000), rule).below, false);
  assert.equal(checkLengthFloor('가', parseLengthRule('- **분량**: 280자 이내')), null);
  assert.equal(checkLengthFloor('가', null), null);
});

test('standard record keeps the length rule so the saved draft carries its check', () => {
  const text = '## 규칙\n- **분량**: 본문 2,000~3,000자\n\n## 자체 점검\n- [ ] 분량을 지켰는가';
  const standard = parseStandard(JSON.stringify({ found: true, set: 'naver-blog-post', title: '네이버', text, files: [] }), 'naver-blog-post');
  assert.equal(standard.length.min, 2000);
  const record = standardRecord(standard);
  assert.equal(record.length.min, 2000);
  let state = createJob(emptyState(), { accountId: 'a', audience: '독자', goal: '설명', sources: [{ id: 's1', type: 'text', ref: 'user-input', text: '근거' }] });
  const id = state.jobs[0].id;
  state = setDraft(state, id, { title: '제목', body: '짧은 본문', claims: [], images: [], standard: record }, [], { channel: 'naver' });
  assert.equal(state.jobs[0].draft.lengthCheck.below, true);
  // An edit that keeps the standard record recomputes the check.
  state = setDraft(state, id, { ...state.jobs[0].draft, body: '가'.repeat(2100) }, [], { channel: 'naver' });
  assert.equal(state.jobs[0].draft.lengthCheck.below, false);
});

test('evaluation counts the length itself and fills in the rule for drafts saved before it was recorded', async () => {
  const rule = parseLengthRule('- **분량**: 본문 2,000~3,000자');
  const draft = { title: '제목', body: '가'.repeat(1924), claims: [], images: [] };
  const { evaluation } = await evaluateDraft({ draft, sample: null, audience: 'a', goal: 'g', sources: [], lengthRule: rule }, {}, async () => ({ result: { ruleScores: [], warnings: [], standardChecks: [] }, usage: null }));
  assert.equal(evaluation.lengthCheck.count, 1924);
  assert.equal(evaluation.lengthCheck.below, true);
  let state = createJob(emptyState(), { accountId: 'a', audience: '독자', goal: '설명', sources: [{ id: 's1', type: 'text', ref: 'user-input', text: '근거' }] });
  const id = state.jobs[0].id;
  state = setDraft(state, id, { ...draft, standard: { set: 'naver-blog-post', sha256: 'a'.repeat(64) } });
  assert.equal(state.jobs[0].draft.lengthCheck, null);
  state = setDraftEvaluation(state, id, evaluation, { lengthRule: rule });
  assert.equal(state.jobs[0].draft.standard.length.min, 2000);
  assert.equal(state.jobs[0].draft.lengthCheck.below, true);
});
