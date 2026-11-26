#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewMarker = 'class="review-workspace"';
const hasCurrentReviewScreen = root => {
  const page = path.join(root, 'next', 'web', 'index.html');
  const ui = path.join(root, 'next', 'web', 'app.js');
  const server = path.join(root, 'next', 'server.mjs');
  return fs.existsSync(page) && fs.existsSync(ui) && fs.existsSync(server)
    && fs.readFileSync(page, 'utf8').includes(reviewMarker)
    && fs.readFileSync(ui, 'utf8').includes('/api/publish-reservation')
    && fs.readFileSync(server, 'utf8').includes('/api/publish-reservation');
};

export function resolveAppRoot(root = projectRoot) {
  if (hasCurrentReviewScreen(root)) return root;
  throw new Error('The current image review screen is unavailable. Update this checkout to the merged master branch.');
}

export function resolveDataDir(env = process.env, home = os.homedir()) {
  if (env.POSTGEN_DATA_DIR) return path.resolve(env.POSTGEN_DATA_DIR);
  const priorChromeData = path.join(home, 'Documents', 'ChatGPT', 'new_sample', 'postgen-data');
  if (fs.existsSync(path.join(priorChromeData, 'account-registry.json')) && fs.existsSync(path.join(priorChromeData, 'next', 'jobs.json'))) return priorChromeData;
  return null;
}

export function checkoutLag(root = projectRoot, runGit = spawnSync) {
  const result = runGit('git', ['-C', root, 'rev-list', '--count', 'HEAD..origin/master'], {
    encoding: 'utf8', windowsHide: true, timeout: 3000
  });
  if (result.status !== 0) return 0;
  const count = Number(result.stdout.trim());
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export function startReview({ noBrowser = false, root = projectRoot, env = process.env } = {}) {
  const appRoot = resolveAppRoot(root);
  const behind = checkoutLag(appRoot);
  if (behind) console.warn(`PostGen code is ${behind} commit(s) behind origin/master. Update this checkout to use the latest review screen.`);
  const dataDir = resolveDataDir(env);
  const childEnv = { ...env, ...(dataDir ? { POSTGEN_DATA_DIR: dataDir } : {}), POSTGEN_BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9333' };
  const server = spawn(process.execPath, [path.join(appRoot, 'next', 'server.mjs')], { cwd: appRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  let opened = false;
  console.log(`PostGen code: ${appRoot}`);
  console.log(`PostGen data: ${dataDir || 'default user data directory'}`);
  server.stdout.on('data', part => {
    if (opened) return;
    buffer += part.toString('utf8');
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const url = buffer.slice(0, newline).trim();
    if (!/^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+$/.test(url)) { console.error(`Unexpected server address: ${url}`); server.kill(); return; }
    opened = true;
    console.log(`Review screen: ${url}`);
    console.log('Keep this window open while using PostGen. Press Ctrl+C to stop.');
    if (noBrowser) return;
    if (process.platform !== 'win32') { console.error('Open the address above in a browser.'); return; }
    const shortcut = path.join(os.homedir(), 'Desktop', '포스팅용 크롬.lnk');
    if (!fs.existsSync(shortcut)) { console.error(`Posting Chrome shortcut not found: ${shortcut}. Open the address above in posting Chrome.`); return; }
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const browser = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath ${quote(shortcut)} -ArgumentList ${quote(url)} -WindowStyle Normal`], { stdio: 'ignore', windowsHide: true });
    browser.on('error', error => console.error(`Could not open posting Chrome: ${error.message}. Open the address above manually.`));
    browser.on('exit', code => { if (code) console.error(`Could not open posting Chrome (exit ${code}). Open the address above manually.`); });
    browser.unref();
  });
  server.stderr.on('data', part => process.stderr.write(part));
  server.on('error', error => { console.error(`Could not start PostGen: ${error.message}`); process.exitCode = 1; });
  server.on('exit', code => { if (!opened) console.error(`PostGen exited before the review screen opened (code ${code}).`); if (code && code !== 0) process.exitCode = code; });
  process.on('SIGINT', () => server.kill());
  process.on('SIGTERM', () => server.kill());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { startReview({ noBrowser: process.argv.includes('--no-browser') }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
