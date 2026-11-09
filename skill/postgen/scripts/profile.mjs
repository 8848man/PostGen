import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const PRESETS = Object.freeze({
  explain: { tags: ['#쉽게이해', '#개념정리'], label: '쉽게 이해', values: { writingStyle: '쉬운 설명과 구체적인 비유', tone: '친근하고 명료한 존댓말', paragraphLength: 'short', audience: '처음 접하는 독자', explanationLevel: 'beginner', structure: '문제 → 쉬운 개념 → 예시 → 핵심 정리', uiImageStyle: '간결한 도식', visualCriteria: '개념 관계가 복잡할 때만 도식 제안' } },
  worklog: { tags: ['#실무기록', '#의사결정'], label: '실무 기록', values: { writingStyle: '문제와 선택의 이유를 구체적으로 기록', tone: '담백한 존댓말', paragraphLength: 'medium', audience: '같은 일을 하는 실무자', explanationLevel: 'intermediate', structure: '맥락 → 시도 → 결정 → 결과 → 배운 점', uiImageStyle: '단정한 표와 흐름도', visualCriteria: '비교나 절차가 길 때 표 또는 흐름도 제안' } },
  analysis: { tags: ['#깊이있는분석', '#근거중심'], label: '깊이 있는 분석', values: { writingStyle: '대안과 한계를 근거와 함께 분석', tone: '차분하고 정확한 존댓말', paragraphLength: 'medium', audience: '배경 지식이 있는 독자', explanationLevel: 'advanced', structure: '질문 → 근거 → 대안 → 결론과 한계', uiImageStyle: '정보 밀도 높은 도표', visualCriteria: '수치·대안 비교에 도움이 될 때만 시각화 제안' } }
});
export const FIELD_NAMES = Object.keys(PRESETS.explain.values);
const ENUMS = { paragraphLength: ['short', 'medium', 'long'], explanationLevel: ['beginner', 'intermediate', 'advanced'] };

export function dataDir() {
  if (process.env.POSTGEN_DATA_DIR) return path.resolve(process.env.POSTGEN_DATA_DIR);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Postgen');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'postgen');
}
export function profilePath(scope = 'user', workspace = process.cwd()) {
  if (scope === 'user') return path.join(dataDir(), 'style-profile.json');
  if (scope === 'workspace') {
    const root=fs.realpathSync.native(path.resolve(workspace)), dir=path.join(root,'.postgen');
    if(fs.existsSync(dir) && fs.realpathSync.native(dir)!==dir) throw new Error('Workspace profile directory cannot be a link');
    return path.join(dir, 'style-profile.json');
  }
  throw new Error('Invalid profile scope');
}
export function activeScope(workspace = process.cwd()) { return fs.existsSync(profilePath('workspace', workspace)) ? 'workspace' : 'user'; }
export function defaultProfile(scope = 'user') {
  const p = PRESETS.explain;
  return { schemaVersion: 'style-profile/v1', profileId: scope === 'workspace' ? 'workspace' : 'default', revision: 0, updatedAt: null, scope, presetId: 'explain', chooseTopicBeforeGeneration: false, suggestionPolicy: { threshold: 3, decisions: {}, counts: {} }, fields: Object.fromEntries(FIELD_NAMES.map(k => [k, { value: p.values[k], provenance: 'default' }])), references: [] };
}
export function loadProfile(scope = activeScope()) {
  const file = profilePath(scope);
  if (!fs.existsSync(file)) {
    if (scope === 'workspace') {
      const inherited = structuredClone(loadProfile('user'));
      return { ...inherited, profileId: 'workspace', scope: 'workspace', revision: 0, updatedAt: null, references: [], suggestionPolicy: { ...inherited.suggestionPolicy, counts: {}, decisions: {} } };
    }
    return defaultProfile(scope);
  }
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateProfile(p);
  if (p.scope !== scope) throw new Error('Profile scope mismatch');
  return p;
}
export function validateProfile(p) {
  if (!p || p.schemaVersion !== 'style-profile/v1' || !Number.isInteger(p.revision) || p.revision < 0 || !['user','workspace'].includes(p.scope) || typeof p.chooseTopicBeforeGeneration !== 'boolean') throw new Error('Invalid Style Profile');
  if (!(p.presetId === null || Object.hasOwn(PRESETS, p.presetId))) throw new Error('Invalid preset');
  if (!p.fields || FIELD_NAMES.some(k => !validField(k, p.fields[k]?.value) || !['default','preset','user','ai_inferred'].includes(p.fields[k]?.provenance))) throw new Error('Invalid style field');
  if (!p.suggestionPolicy || !Number.isInteger(p.suggestionPolicy.threshold) || p.suggestionPolicy.threshold < 1 || p.suggestionPolicy.threshold > 20 || !p.suggestionPolicy.decisions || typeof p.suggestionPolicy.decisions !== 'object' || !p.suggestionPolicy.counts || typeof p.suggestionPolicy.counts !== 'object') throw new Error('Invalid suggestion policy');
  if (!Array.isArray(p.references) || p.references.length > 30) throw new Error('Invalid references');
  return p;
}
function validField(k, value) {
  if (!FIELD_NAMES.includes(k) || typeof value !== 'string' || value.length < 1 || value.length > 500) return false;
  return !ENUMS[k] || ENUMS[k].includes(value);
}
export function applyCommands(current, commands) {
  validateProfile(current);
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 20) throw new Error('Expected 1–20 commands');
  const next = structuredClone(current);
  for (const c of commands) {
    if (!c || !Number.isInteger(c.expectedRevision) || c.expectedRevision !== current.revision || !['user','workspace'].includes(c.scope) || !['set_field','unset_field','apply_preset','remove_reference','set_topic_choice','set_suggestion_policy'].includes(c.operation)) throw new Error('Invalid or stale setting command');
    if (c.scope !== current.scope) throw new Error('Scope mismatch');
    switch (c.operation) {
      case 'set_field':
        if (!validField(c.path, c.value)) throw new Error('Invalid field or value');
        next.fields[c.path] = { value: c.value, provenance: c.provenance === 'ai_inferred' ? 'ai_inferred' : 'user' };
        break;
      case 'unset_field':
        if (!FIELD_NAMES.includes(c.path)) throw new Error('Invalid field');
        next.fields[c.path] = { value: PRESETS[next.presetId || 'explain'].values[c.path], provenance: 'default' };
        break;
      case 'apply_preset':
        if (!Object.hasOwn(PRESETS, c.value)) throw new Error('Invalid preset');
        next.presetId = c.value;
        for (const k of FIELD_NAMES) next.fields[k] = { value: PRESETS[c.value].values[k], provenance: 'preset' };
        break;
      case 'remove_reference':
        if (typeof c.value !== 'string' || !next.references.some(r => r.id === c.value)) throw new Error('Unknown reference');
        next.references = next.references.filter(r => r.id !== c.value);
        break;
      case 'set_topic_choice':
        if (typeof c.value !== 'boolean') throw new Error('Invalid topic choice');
        next.chooseTopicBeforeGeneration = c.value;
        break;
      case 'set_suggestion_policy':
        if (!Number.isInteger(c.value) || c.value < 1 || c.value > 20) throw new Error('Invalid threshold');
        next.suggestionPolicy.threshold = c.value;
        break;
    }
  }
  next.revision++;
  next.updatedAt = new Date().toISOString();
  validateProfile(next);
  return next;
}
export function saveProfile(next, expectedRevision) {
  const current = loadProfile(next.scope);
  if (current.revision !== expectedRevision) throw new Error('Profile changed; reload and retry');
  validateProfile(next);
  const dest = profilePath(next.scope), dir=path.dirname(dest); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.style-profile-${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.renameSync(temp, dest); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function addReference(current, ref) {
  if (current.references.length >= 30) throw new Error('Reference limit reached');
  const next = structuredClone(current);
  next.references.push(ref);
  next.revision++;
  next.updatedAt = new Date().toISOString();
  saveProfile(next, current.revision);
  return next;
}
export function recordStyleEvent(current, field) {
  if (!FIELD_NAMES.includes(field)) throw new Error('Unknown style field');
  const next = structuredClone(current);
  const prior = Number(next.suggestionPolicy.counts[field] || 0);
  next.suggestionPolicy.counts[field] = prior + 1;
  next.revision++;
  next.updatedAt = new Date().toISOString();
  const decision = next.suggestionPolicy.decisions[field];
  return { profile: next, count: prior + 1, shouldSuggest: !['rejected','deferred','accepted'].includes(decision) && prior + 1 >= next.suggestionPolicy.threshold };
}
export function recordSuggestionDecision(current, field, decision) {
  if (!FIELD_NAMES.includes(field) || !['accepted','rejected','deferred'].includes(decision)) throw new Error('Invalid suggestion decision');
  const next = structuredClone(current);
  next.suggestionPolicy.decisions[field] = decision;
  next.revision++;
  next.updatedAt = new Date().toISOString();
  return next;
}
