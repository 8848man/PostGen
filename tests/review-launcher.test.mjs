import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveAppRoot, resolveDataDir } from '../scripts/open-review.mjs';

test('launcher uses only this checkout and never falls back to a worktree or an older screen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-launch-path-'));
  try {
    const writeScreen = (root, { reservation = true } = {}) => {
      fs.mkdirSync(path.join(root, 'next', 'web'), { recursive: true });
      fs.writeFileSync(path.join(root, 'next', 'web', 'index.html'), '<section class="review-workspace">');
      fs.writeFileSync(path.join(root, 'next', 'web', 'app.js'), reservation ? "fetch('/api/publish-reservation')" : "fetch('/api/state')");
      fs.writeFileSync(path.join(root, 'next', 'server.mjs'), reservation ? "'/api/publish-reservation'" : "'/api/state'");
    };
    writeScreen(path.join(dir, '.worktrees', 'image-placement-preview'));
    assert.throws(() => resolveAppRoot(dir), /current image review screen/);
    writeScreen(dir, { reservation: false });
    assert.throws(() => resolveAppRoot(dir), /current image review screen/);
    writeScreen(dir);
    assert.equal(resolveAppRoot(dir), dir);
    assert.equal(resolveDataDir({ POSTGEN_DATA_DIR: dir }), dir);
    const priorData = path.join(dir, 'Documents', 'ChatGPT', 'new_sample', 'postgen-data');
    fs.mkdirSync(path.join(priorData, 'next'), { recursive: true });
    fs.writeFileSync(path.join(priorData, 'account-registry.json'), '{}');
    fs.writeFileSync(path.join(priorData, 'next', 'jobs.json'), '{}');
    assert.equal(resolveDataDir({}, dir), priorData);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('launcher starts the review UI and exposes its token URL without opening a browser', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-launch-server-'));
  const child = spawn(process.execPath, [path.resolve('scripts/open-review.mjs'), '--no-browser'], { cwd: path.resolve('.'), env: { ...process.env, POSTGEN_DATA_DIR: dir, POSTGEN_NEXT_DIR: path.join(dir, 'next') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let timer;
  try {
    const url = await Promise.race([
      new Promise((resolve, reject) => { let output = ''; child.stdout.on('data', part => { output += part; const match = output.match(/Review screen: (http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+)/); if (match) resolve(match[1]); }); child.on('error', reject); child.on('exit', code => reject(new Error(`Launcher exited ${code}: ${output}`))); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Launcher did not print a review URL')), 10_000); })
    ]);
    const parsed = new URL(url);
    const response = await fetch(`${parsed.origin}/api/state`, { headers: { 'x-postgen-token': new URLSearchParams(parsed.hash.slice(1)).get('token') } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state.schemaVersion, 'postgen-next/v1');
  } finally {
    clearTimeout(timer);
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
