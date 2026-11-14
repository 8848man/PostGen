import test from 'node:test';
import assert from 'node:assert/strict';
import { assetsStandardConfig, loadAssetsStandard, parseStandard, imageRequest, standardChecks, standardRecord } from '../next/assets-standard.mjs';
import { draftPrompt, generateDraft } from '../next/generate.mjs';
import { evaluateDraft } from '../next/evaluate.mjs';

const text = `<!-- Assets Manager 표준: 네이버 블로그 포스팅 (naver-blog-post) -->

# 작업 지침: 네이버 블로그 포스팅

## 규칙
- **톤과 말투**: 1인칭 평서체(~다)

## 첨부 레퍼런스
- [1] naver-graph-style.png — 그래프
- [2] naver-illustration-style.png — 삽화

## 이미지 생성 (ImageGen 요청서)
이미지는 직접 그리지 마세요.

\`\`\`markdown
### 이미지 1: <들어갈 자리>
- 참조 이미지로 첨부: [2] naver-illustration-style.png (화풍)
- 장면: <무엇이, 어디서, 무엇을 하는가 — 1~3문장>
- 지시: 첨부한 이미지를 참조 이미지로 그대로 사용하세요.
\`\`\`

## 출력 전 자가 점검
- [ ] 존댓말 없이 1인칭 평서체(~다)로 썼는가
- [ ] 금지 사항에 해당하는 표현이 하나도 없는가
`;
const raw = JSON.stringify({ found: true, set: 'naver-blog-post', title: '네이버 블로그 포스팅', text, files: ['C:/lib/.assets/drops/naver-blog-post/codex/prompt.md', 'C:/lib/image/naver-graph-style.png', 'C:/lib/image/naver-illustration-style.png'] });

test('standard is off unless the library command line is configured', async () => {
  assert.equal(assetsStandardConfig({}).cli, null);
  assert.equal(await loadAssetsStandard({ channel: 'naver', task: 't' }, assetsStandardConfig({})), null);
  assert.equal(assetsStandardConfig({ POSTGEN_ASSETS_CLI: 'x/cli.py' }).sets.naver, 'naver-blog-post');
});

test('standard is loaded with the channel set, no approval gate, as JSON; failures are not silent', async () => {
  let call;
  const config = { cli: 'C:/lib/app/core/cli.py', python: 'python', sets: { naver: 'naver-blog-post' } };
  const standard = await loadAssetsStandard({ channel: 'naver', task: '네이버 블로그 포스트: 주제' }, config, async (python, args) => { call = { python, args }; return { code: 0, stdout: raw, stderr: '' }; });
  assert.deepEqual(call.args, ['C:/lib/app/core/cli.py', 'standard', '네이버 블로그 포스트: 주제', '--set', 'naver-blog-post', '--no-gate', '--json']);
  assert.equal(standard.set, 'naver-blog-post');
  assert.deepEqual(standard.files, ['C:/lib/image/naver-graph-style.png', 'C:/lib/image/naver-illustration-style.png']);
  assert.match(standard.sha256, /^[0-9a-f]{64}$/);
  assert.equal(await loadAssetsStandard({ channel: 'tistory' }, config, async () => { throw new Error('not called'); }), null);
  await assert.rejects(loadAssetsStandard({ channel: 'naver' }, config, async () => ({ code: 1, stdout: '', stderr: 'boom' })), /failed \(1\): boom/);
  assert.throws(() => parseStandard(JSON.stringify({ found: true, set: 'global', text, files: [] }), 'naver-blog-post'), /was not found/);
});

test('image request fills the library template and resolves reference originals', () => {
  const standard = parseStandard(raw, 'naver-blog-post');
  assert.deepEqual(standardChecks(text), ['존댓말 없이 1인칭 평서체(~다)로 썼는가', '금지 사항에 해당하는 표현이 하나도 없는가']);
  const request = imageRequest(standardRecord(standard), { position: '본문 1번째 문단 뒤', scene: '두 캐릭터가 블록을 쌓는다.' });
  assert.match(request.text, /### 이미지 1: 본문 1번째 문단 뒤/);
  assert.match(request.text, /- 장면: 두 캐릭터가 블록을 쌓는다\./);
  assert.match(request.text, /지시: 첨부한 이미지를 참조 이미지로/);
  assert.deepEqual(request.referencePaths, ['C:/lib/image/naver-illustration-style.png']);
  assert.equal(imageRequest(null, { position: 'p', scene: 's' }), null);
});

test('draft prompt carries the standard as the base rule set and keeps JSON output', async () => {
  const standard = parseStandard(raw, 'naver-blog-post');
  const input = { sources: [{ id: 's1', type: 'text', text: '근거' }], account: { channel: 'naver', handle: 'h' }, sample: null, audience: 'a', goal: 'g', plan: null, standard };
  const prompt = draftPrompt(input);
  assert.match(prompt, /set naver-blog-post\) is mandatory/);
  assert.match(prompt, /<<<STANDARD\n<!-- Assets Manager 표준/);
  assert.doesNotMatch(draftPrompt({ ...input, standard: null }), /Assets Manager/);
  const result = { title: 't', body: '도입이다.\n\n먼저 정한 것\n\n본문이다.', headings: ['먼저 정한 것', '없는 소제목'], claims: [], images: [], diagnostics: [] };
  const { draft, diagnostics } = await generateDraft(input, {}, async () => ({ result, usage: null }));
  assert.deepEqual(draft.headings, ['먼저 정한 것']);
  assert.equal(diagnostics[0].code, 'heading_mismatch');
});

test('evaluation must answer every standard self-check item in order', async () => {
  const checks = ['A인가', 'B인가'];
  const draft = { title: 't', body: 'b' };
  const ok = { ruleScores: [], warnings: [], standardChecks: [{ item: 'A인가', passed: true, reason: 'r' }, { item: 'B인가', passed: false, reason: 'r' }] };
  let prompt;
  const { evaluation } = await evaluateDraft({ draft, sample: null, audience: 'a', goal: 'g', sources: [], standardChecks: checks }, {}, async p => { prompt = p; return { result: ok, usage: null }; });
  assert.equal(evaluation.standardChecks[1].passed, false);
  assert.match(prompt, /Standard self-check items: \["A인가","B인가"\]/);
  await assert.rejects(evaluateDraft({ draft, sample: null, audience: 'a', goal: 'g', sources: [], standardChecks: checks }, {}, async () => ({ result: { ...ok, standardChecks: ok.standardChecks.slice(0, 1) }, usage: null })), /standard self-check/);
  const none = await evaluateDraft({ draft, sample: null, audience: 'a', goal: 'g', sources: [] }, {}, async () => ({ result: { ruleScores: [], warnings: [], standardChecks: [] }, usage: null }));
  assert.deepEqual(none.evaluation.standardChecks, []);
});
