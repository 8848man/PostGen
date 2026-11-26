// 채널 설정 dialog: turning a channel off greys its posts in 채널별 글, keeps them out of the source counts and bulk
// actions, and keeps its accounts out of new sources.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { addAccount, emptyRegistry, saveRegistry } from '../skill/postgen/scripts/account-registry.mjs';
import { createCampaign, emptyState, saveState, setDraft } from '../next/core.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-channel-toggle-'));
process.env.POSTGEN_DATA_DIR = dir;
let browser, child;
try {
  let registry = addAccount(emptyRegistry(), { channel: 'naver', handle: 'naver-smoke', defaultGoal: 'explain' });
  saveRegistry(registry, 0);
  const revision = registry.revision;
  registry = addAccount(registry, { channel: 'tistory', handle: 'tistory-smoke', defaultGoal: 'inform' });
  saveRegistry(registry, revision);
  const accounts = registry.accounts.map(account => ({ id: account.id, handle: account.handle, goal: account.defaultGoal }));
  let state = createCampaign(emptyState(), { accounts, audience: 'reader', sources: [{ id: 's', type: 'text', ref: 'user', text: 'Toggle source' }] });
  for (const job of state.jobs) state = setDraft(state, job.id, { title: `Draft ${job.accountHandle}`, body: 'Body', claims: [], images: [], standard: { set: 'naver-blog-post', sha256: 'a'.repeat(64) } });
  state.revision = 1;
  saveState(state, 0);
  const tistoryJob = state.jobs.find(job => job.accountHandle === 'tistory-smoke');

  child = spawn(process.execPath, [path.resolve('next/server.mjs')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const launch = await Promise.race([
    new Promise((resolve, reject) => { let output = ''; child.stdout.on('data', part => { output += part; if (output.includes('\n')) resolve(output.trim()); }); child.on('error', reject); child.on('exit', code => reject(new Error(`Server exited: ${code}`))); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not start')), 10_000))
  ]);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/login-status', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ statuses: [] }) }));
  await page.goto(launch);
  await page.locator('#channel-jobs .channel-pick').nth(1).waitFor();
  assert.match(await page.locator('#campaigns .campaign-card small').first().textContent(), /^2개 채널 글/);

  // Turn Tistory off in the dialog.
  await page.getByRole('button', { name: '채널 설정' }).click();
  const dialog = page.getByRole('dialog', { name: '채널 설정' });
  await dialog.waitFor();
  await dialog.getByRole('switch', { name: '티스토리 켜기' }).uncheck();
  await dialog.getByRole('button', { name: '저장' }).click();
  await page.waitForFunction(() => document.querySelector('#message')?.textContent?.includes('꺼진 채널: 티스토리'));
  assert.equal(await dialog.isVisible(), false);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'next', 'settings.json'), 'utf8'));
  assert.equal(settings.channels.tistory, false);

  // The Tistory post stays visible, greyed, and cannot be checked; counts and bulk actions cover Naver only.
  const off = page.locator('#channel-jobs .channel-pick.channel-off');
  assert.equal(await off.count(), 1);
  assert.match(await off.textContent(), /꺼진 채널/);
  assert.match(await off.textContent(), /tistory-smoke/);
  assert.equal(await off.locator('input[type=checkbox]').isDisabled(), true);
  assert.match(await page.locator('#campaigns .campaign-card small').first().textContent(), /^1개 채널 글 \(꺼진 채널 1개 제외\)/);
  assert.match(await page.locator('#campaigns .campaign-progress').first().textContent(), /발행 0\/1/);
  await page.locator('.channel-bulk label input').check();
  await page.getByText('전체 선택 (1/1)').waitFor();
  // An off-channel post can still be opened.
  await off.locator('.pick-card').click();
  await page.waitForFunction(id => new URLSearchParams(location.hash.slice(1)).get('job') === id, tistoryJob.id);
  // New sources cannot pick the Tistory account.
  assert.equal(await page.locator('#accounts option:disabled').count(), 1);
  assert.match(await page.locator('#accounts option:disabled').textContent(), /꺼진 채널/);

  // Turning it back on restores the card.
  await page.getByRole('button', { name: '채널 설정' }).click();
  await dialog.getByRole('switch', { name: '티스토리 켜기' }).check();
  await dialog.getByRole('button', { name: '저장' }).click();
  await page.waitForFunction(() => document.querySelector('#message')?.textContent?.includes('모든 채널이 켜져 있습니다'));
  assert.equal(await page.locator('#channel-jobs .channel-pick.channel-off').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Channel toggle dashboard smoke passed: dialog, greyed off channel, counts and bulk actions without it, restored when on');
} finally {
  await browser?.close();
  child?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
