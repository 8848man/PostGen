import { spawn } from 'node:child_process';
import path from 'node:path';

export async function codexJson(prompt, schemaPath, options = {}) {
  const binary = process.env.POSTGEN_CODEX_BIN || (process.platform === 'win32' ? 'codex.exe' : 'codex');
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
  const messages = output.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(x => x?.type === 'item.completed' && x.item?.type === 'agent_message');
  const final = messages.at(-1)?.item?.text;
  if (!final) throw new Error('Codex returned no structured answer');
  return JSON.parse(final);
}
