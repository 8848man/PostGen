import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { addAccount, emptyRegistry, saveRegistry } from '../skill/postgen/scripts/account-registry.mjs';
import { createCampaign, emptyState, saveState, setDraft } from '../next/core.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-review-'));
process.env.POSTGEN_DATA_DIR = dir;
process.env.POSTGEN_NEXT_DIR = path.join(dir, 'next');
let browser;
let child;
try {
  let registry = addAccount(emptyRegistry(), { channel: 'naver', handle: 'test-naver', defaultGoal: 'explain' });
  saveRegistry(registry, 0);
  registry = addAccount(registry, { channel: 'tistory', handle: 'test-tistory', defaultGoal: 'explain' });
  saveRegistry(registry, 1);
  const accounts = registry.accounts.map(account => ({ id: account.id, handle: account.handle, goal: account.defaultGoal }));
  const source = { id: 'source-1', type: 'text', ref: 'test', text: '검토할 원본 본문입니다.', capturedAt: new Date().toISOString() };
  let state = createCampaign(emptyState(), { accounts, audience: '독자', sources: [source] });
  saveState(state, 0);
  state = setDraft(state, state.jobs[0].id, { title: '네이버 글', body: '네이버 본문', claims: [], images: [] });
  saveState(state, 1);
  state = setDraft(state, state.jobs[1].id, { title: '티스토리 글', body: '티스토리 본문', claims: [], images: [] });
  saveState(state, 2);

  child = spawn(process.execPath, [path.resolve('next/server.mjs')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const launch = await Promise.race([
    new Promise((resolve, reject) => { let output = ''; child.stdout.on('data', part => { output += part; if (output.includes('\n')) resolve(output.trim()); }); child.on('error', reject); child.on('exit', code => reject(new Error(`Server exited: ${code}`))); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not start')), 10_000))
  ]);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(launch);
  await page.locator('.channel-card').first().waitFor();
  assert.equal(await page.locator('.channel-card').count(), 2);
  assert.match(await page.locator('#sources').innerText(), /검토할 원본 본문/);
  await page.locator('.channel-card').filter({ hasText: '티스토리' }).click();
  await page.locator('#jobs').getByText('티스토리 본문').waitFor();
  assert.match(await page.locator('#jobs').innerText(), /티스토리 본문/);
  await page.screenshot({ path: path.join(dir, 'review-dashboard.png'), fullPage: true });
  page.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? '출처 표현을 수정' : undefined));
  await page.getByRole('button', { name: '반려', exact: true }).click();
  await page.getByText('반려: 출처 표현을 수정').waitFor();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'next', 'jobs.json'), 'utf8')).jobs[1].review.decision, 'rejected');
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await page.getByRole('button', { name: '발행 예약' }).waitFor();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'next', 'jobs.json'), 'utf8')).jobs[1].status, 'approved');
  process.stdout.write('Review dashboard smoke passed: source, channel selection, body, rejection, approval\n');
} finally {
  if (browser) await browser.close();
  if (child) child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
