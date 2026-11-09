import { generatePlan, generateDraft } from '../next/generate.mjs';
import { evaluateDraft } from '../next/evaluate.mjs';

const sources = [{ id: 'synthetic-1', type: 'text', ref: 'synthetic', text: 'PostGen은 블로그 초안을 만든다. 사용자는 게시 전에 초안을 검토한다.' }];
const options = { provider: 'codex' };
const { plan } = await generatePlan(sources, options);
const { draft } = await generateDraft({ sources, account: { channel: 'naver', handle: 'test' }, sample: null, audience: '처음 접하는 독자', goal: '쉽게 설명', plan }, options);
const { evaluation } = await evaluateDraft({ draft, sample: null, audience: '처음 접하는 독자', goal: '쉽게 설명', sources }, options);
process.stdout.write(JSON.stringify({ angle: plan.angle, title: draft.title, claims: draft.claims.length, evaluated: Array.isArray(evaluation.ruleScores) }) + '\n');
