import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveCodexBinary } from '../skill/postgen/scripts/codex-client.mjs';

test('Windows Codex resolves the native npm binary without a shell wrapper', () => {
  const root = path.resolve('C:/npm-prefix');
  const binary = path.join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  assert.equal(resolveCodexBinary({ env: { npm_config_prefix: root, Path: '' }, platform: 'win32', arch: 'x64', exists: candidate => candidate === binary }), binary);
});

test('explicit Codex executable path keeps precedence', () => {
  assert.equal(resolveCodexBinary({ env: { POSTGEN_CODEX_BIN: 'C:/tools/codex.exe' }, platform: 'win32' }), 'C:/tools/codex.exe');
});
