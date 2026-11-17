#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewMarker = 'class="review-workspace"';
const hasReviewScreen = root => {
  const page = path.join(root, 'next', 'web', 'index.html');
  return fs.existsSync(page) && fs.readFileSync(page, 'utf8').includes(reviewMarker);
};

export function resolveAppRoot(root = projectRoot) {
  if (hasReviewScreen(root)) return root;
  const previewRoot = path.join(root, '.worktrees', 'review-dashboard');
  if (hasReviewScreen(previewRoot)) return previewRoot;
  throw new Error('The three-step review screen is unavailable in this checkout. Update the project to the merged master branch.');
}

export function resolveDataDir(env = process.env, home = os.homedir()) {
  if (env.POSTGEN_DATA_DIR) return path.resolve(env.POSTGEN_DATA_DIR);
  const priorChromeData = path.join(home, 'Documents', 'ChatGPT', 'new_sample', 'postgen-data');
  if (fs.existsSync(path.join(priorChromeData, 'account-registry.json')) && fs.existsSync(path.join(priorChromeData, 'next', 'jobs.json'))) return priorChromeData;
  return null;
}

export function startReview({ noBrowser = false, root = projectRoot, env = process.env } = {}) {
  const appRoot = resolveAppRoot(root);
  const dataDir = resolveDataDir(env);
  const childEnv = { ...env, ...(dataDir ? { POSTGEN_DATA_DIR: dataDir } : {}) };
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
    const browser = spawn('explorer.exe', [url], { stdio: 'ignore', windowsHide: true });
    browser.on('error', error => console.error(`Could not open browser: ${error.message}. Open the address above manually.`));
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
