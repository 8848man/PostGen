import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.env.POSTGEN_ASSETS_CLI || path.resolve(repositoryRoot, '..', 'assets_manager', 'app', 'core', 'cli.py');
if (!fs.existsSync(cli)) {
  throw new Error(`Assets Manager CLI not found: ${cli}. Set POSTGEN_ASSETS_CLI to its path.`);
}
process.env.POSTGEN_ASSETS_CLI = cli;
if (!process.env.POSTGEN_ASSETS_PYTHON && process.platform === 'win32') {
  const installations = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python');
  const versions = fs.existsSync(installations)
    ? fs.readdirSync(installations).filter(name => /^Python\d+$/.test(name)).sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)))
    : [];
  const executable = versions.map(name => path.join(installations, name, 'python.exe')).find(candidate => fs.existsSync(candidate));
  if (executable) process.env.POSTGEN_ASSETS_PYTHON = executable;
}
await import('../tests/next-assets-live.mjs');
