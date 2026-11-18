// Assets Manager standard (the user's work standard library) for blog drafts and image requests.
// PostGen runs the library's command line (`cli.py standard --json`) instead of MCP: same PC, no server,
// deterministic output for the same library state. Configure with POSTGEN_ASSETS_CLI (path to app/core/cli.py).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

const DEFAULT_SETS = { naver: 'naver-blog-post' };

export function assetsStandardConfig(env = process.env) {
  const cli = env.POSTGEN_ASSETS_CLI ? path.resolve(env.POSTGEN_ASSETS_CLI) : null;
  return {
    cli,
    python: env.POSTGEN_ASSETS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    sets: { ...DEFAULT_SETS, ...(env.POSTGEN_ASSETS_SET_NAVER ? { naver: env.POSTGEN_ASSETS_SET_NAVER } : {}), ...(env.POSTGEN_ASSETS_SET_TISTORY ? { tistory: env.POSTGEN_ASSETS_SET_TISTORY } : {}) }
  };
}

function run(python, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Assets Manager standard timed out')); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// The "## 이미지 생성" section's fenced request template, as the library rendered it.
export function imageRequestTemplate(text) {
  const section = String(text).split(/\n(?=## )/).find(part => part.startsWith('## 이미지 생성'));
  const match = section?.match(/```markdown\n([\s\S]*?)\n```/);
  return match ? match[1] : null;
}

// Self-check items ("- [ ] ...") from the standard, used as evaluation criteria.
export function standardChecks(text) {
  return String(text).split('\n').map(line => line.match(/^- \[ \] (.+)$/)?.[1]?.trim()).filter(Boolean);
}

export function chartReference(text) {
  const rule = String(text).split('\n').find(line => /^- \*\*차트·도식 스타일\*\*:/.test(line));
  const match = rule?.match(/\[(\d+)\] ([^\s,()]+?\.(?:png|jpe?g|webp))/i);
  if (match) return { index: match[1], name: match[2], rule: rule.replace(/^- \*\*차트·도식 스타일\*\*: /, '') };
  const referenceLine = (imageRequestTemplate(text) || String(text)).split('\n').find(line => line.startsWith('- 참조 이미지로 첨부:'));
  const templateMatch = referenceLine?.match(/\[(\d+)\] ([^\s,()]+?\.(?:png|jpe?g|webp)) \([^)]*차트·도식[^)]*\)/i);
  return templateMatch ? { index: templateMatch[1], name: templateMatch[2], rule: null } : null;
}

function imageKind(kind, scene) {
  if (['chart', 'diagram', 'illustration'].includes(kind)) return kind;
  return /차트|그래프|도식|흐름도|매트릭스|다이어그램|graph|chart|diagram|flowchart/i.test(scene) ? 'diagram' : 'illustration';
}

// Fill one ImageGen request: the library's template with the position and scene, plus absolute reference paths.
export function imageRequest(standard, { position, scene, kind }) {
  const template = standard?.imageTemplate;
  if (!template) return null;
  const chart = imageKind(kind, scene) !== 'illustration';
  const graph = standard.chartReference || chartReference(template);
  if (chart && !graph) throw new Error('Assets Manager standard has no chart/diagram reference');
  let filled = template.replace('<들어갈 자리>', position).replace(/^(- 장면(?: 또는 내용)?: ).*$/m, (_, prefix) => `${prefix}${scene}`);
  const referenceLine = filled.split('\n').find(line => line.startsWith('- 참조 이미지로 첨부:'));
  if (chart) {
    filled = filled.replace(/^- 참조 이미지로 첨부: .*$/m, `- 참조 이미지로 첨부: [${graph.index}] ${graph.name} (차트·도식 원본)`)
      .replace(/^- 원본과 다르게 할 점: .*\n?/m, '')
      .replace(/^- 지시: .*$/m, `- 지시: ${graph.rule || '첨부한 차트·도식 원본의 형태를 따르세요.'} 장면의 데이터와 라벨을 정확히 반영하세요.`);
  } else if (graph && referenceLine) {
    const graphEntry = new RegExp(`\\[${graph.index}\\] ${graph.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\([^)]*\\)(?:, )?`);
    filled = filled.replace(referenceLine, referenceLine.replace(graphEntry, '').replace(/, $/, ''));
  }
  const refs = [...new Set([...filled.matchAll(/\[(\d+)\] ([^\s,()]+)/g)].map(match => match[2]))];
  const paths = refs.map(name => standard.files.find(file => path.basename(file) === name)).filter(Boolean);
  return { text: filled, referencePaths: paths };
}

export function parseStandard(raw, expectedSet) {
  const result = JSON.parse(raw);
  if (!result?.found || result.set !== expectedSet || typeof result.text !== 'string' || !Array.isArray(result.files)) throw new Error(`Assets Manager standard ${expectedSet} was not found`);
  const files = result.files.filter(file => path.basename(file) !== 'prompt.md');
  return {
    set: result.set,
    title: result.title,
    sha256: crypto.createHash('sha256').update(result.text).digest('hex'),
    text: result.text,
    files,
    imageTemplate: imageRequestTemplate(result.text),
    chartReference: chartReference(result.text),
    checks: standardChecks(result.text)
  };
}

// Returns null when no library is configured or the channel has no set. When configured, failures throw:
// silently writing without the standard would break the point of connecting it.
export async function loadAssetsStandard({ channel, task }, config = assetsStandardConfig(), runner = run) {
  const setId = config.sets[channel];
  if (!config.cli || !setId) return null;
  const { code, stdout, stderr } = await runner(config.python, [config.cli, 'standard', String(task || `${channel} 블로그 포스트`).slice(0, 300), '--set', setId, '--no-gate', '--json'], 60_000);
  if (code !== 0) throw new Error(`Assets Manager standard failed (${code}): ${String(stderr || stdout).slice(0, 300)}`);
  return parseStandard(stdout, setId);
}

// What the draft keeps: enough to trace which standard wrote it, not the whole prompt.
export function standardRecord(standard) {
  return standard ? { set: standard.set, title: standard.title, sha256: standard.sha256, files: standard.files, imageTemplate: standard.imageTemplate, chartReference: standard.chartReference } : null;
}
