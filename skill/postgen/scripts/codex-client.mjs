import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function resolveCodexBinary({ env = process.env, platform = process.platform, arch = process.arch, exists = fs.existsSync } = {}) {
  if (env.POSTGEN_CODEX_BIN) return env.POSTGEN_CODEX_BIN;
  if (platform !== 'win32') return 'codex';
  const target = arch === 'arm64' ? ['codex-win32-arm64', 'aarch64-pc-windows-msvc'] : ['codex-win32-x64', 'x86_64-pc-windows-msvc'];
  const pathDirs = (env.Path || env.PATH || '').split(path.delimiter).filter(Boolean);
  const roots = [env.APPDATA && path.join(env.APPDATA, 'npm'), env.npm_config_prefix, process.cwd(), ...pathDirs].filter(Boolean);
  for (const dir of pathDirs) {
    const binary = path.join(dir, 'codex.exe');
    if (exists(binary)) return binary;
  }
  for (const root of roots) {
    const packageRoots = [path.join(root, 'node_modules', '@openai', target[0]), path.join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', target[0])];
    for (const packageRoot of packageRoots) {
      for (const folder of ['bin', 'codex']) {
        const binary = path.join(packageRoot, 'vendor', target[1], folder, 'codex.exe');
        if (exists(binary)) return binary;
      }
    }
  }
  throw new Error('Codex 실행 파일을 찾지 못했습니다. @openai/codex 설치를 확인하거나 POSTGEN_CODEX_BIN에 codex.exe 전체 경로를 지정하세요.');
}

export async function codexJson(prompt, schemaPath, options = {}) {
  return (await codexRun(prompt, schemaPath, options)).result;
}

// 결과와 함께 exec --json의 turn.completed 사용량(토큰)을 돌려준다. 구독 한도 정보는 이 출력에 없다.
export async function codexRun(prompt, schemaPath, options = {}) {
  const binary = resolveCodexBinary();
  const args = ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '--output-schema', path.resolve(schemaPath)];
  if (options.imagePath) args.push('--image', path.resolve(options.imagePath));
  args.push('-');
  const output = await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd || process.cwd(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill(), options.timeoutMs || 120000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 3_000_000) child.kill(); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 50_000) stderr = stderr.slice(-50_000); });
    child.on('error', err => { clearTimeout(timeout); reject(err); });
    child.on('close', code => { clearTimeout(timeout); if (code !== 0) reject(new Error(`Codex failed (${code}): ${stderr.slice(-1200)}`)); else resolve(stdout); });
    child.stdin.end(prompt);
  });
  const events = output.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const messages = events.filter(x => x.type === 'item.completed' && x.item?.type === 'agent_message');
  const final = messages.at(-1)?.item?.text;
  if (!final) throw new Error('Codex returned no structured answer');
  const usage = events.filter(x => x.type === 'turn.completed' && x.usage).at(-1)?.usage || null;
  return { result: JSON.parse(final), usage };
}
