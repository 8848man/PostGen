import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { addAccount, emptyRegistry, saveRegistry } from '../skill/postgen/scripts/account-registry.mjs';
import { createCampaign, emptyState, loadState, saveState, setDraft, startPreparation } from '../next/core.mjs';

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
  const standard = { set: 'naver-blog-post', sha256: 'a'.repeat(64) };
  state = setDraft(state, state.jobs[0].id, { title: '네이버 글', body: '네이버 본문', tags: ['네이버'], claims: [], images: [], standard });
  saveState(state, 1);
  state = setDraft(state, state.jobs[1].id, { title: '티스토리 글', body: '티스토리 본문', claims: [], images: [], standard });
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
  assert.match(await page.locator('.campaign-progress').innerText(), /0\/2/);
  assert.match(await page.locator('#sources').innerText(), /검토할 원본 본문/);
  await page.locator('.channel-card').filter({ hasText: '티스토리' }).click();
  await page.locator('#jobs').getByText('티스토리 본문').waitFor();
  assert.match(await page.locator('#jobs').innerText(), /티스토리 본문/);
  await page.getByRole('checkbox', { name: '수동으로 발행함' }).check();
  await page.waitForFunction(() => document.querySelector('.campaign-progress')?.textContent.includes('1/2'));
  assert.match(await page.locator('.campaign-progress').innerText(), /1\/2/);
  await page.getByRole('checkbox', { name: '수동으로 발행함' }).uncheck();
  await page.waitForFunction(() => document.querySelector('.campaign-progress')?.textContent.includes('0/2'));
  assert.match(await page.locator('.campaign-progress').innerText(), /0\/2/);
  await page.screenshot({ path: path.join(dir, 'review-dashboard.png'), fullPage: true });
  page.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? '출처 표현을 수정' : undefined));
  await page.getByText('글·이미지 편집 옵션').click();
  await page.getByRole('button', { name: '반려', exact: true }).click();
  await page.getByText('반려: 출처 표현을 수정').waitFor();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'next', 'jobs.json'), 'utf8')).jobs[1].review.decision, 'rejected');
  await page.route('**/api/start', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/prepare-browser', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessionId: 'test', loginRequired: true, message: 'Test browser handoff' }) }));
  const publishAt = new Date(Date.now() + 86_400_000);
  publishAt.setMinutes(Math.ceil(publishAt.getMinutes() / 10) * 10, 0, 0);
  await page.getByLabel('공개 시각').fill(new Date(publishAt.getTime() - publishAt.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  await page.getByRole('button', { name: '발행', exact: true }).click();
  await page.locator('#message').getByText('로그인 후 재개', { exact: false }).waitFor();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'next', 'jobs.json'), 'utf8')).jobs[1].status, 'awaiting_registration');
  await page.getByRole('button', { name: '재발행', exact: true }).click();
  await page.getByText('재발행 1회', { exact: false }).waitFor();
  assert.equal(loadState().jobs[1].republishHistory.length, 1);
  const beforeRecovery = loadState();
  saveState(startPreparation(beforeRecovery, beforeRecovery.jobs[1].id), beforeRecovery.revision);
  await page.reload();
  await page.locator('.channel-card').filter({ hasText: '티스토리' }).click();
  await page.getByText('글·이미지 편집 옵션').click();
  await page.getByRole('button', { name: '편집기 다시 열기' }).waitFor();
  await page.getByRole('button', { name: '편집기 다시 열기' }).click();
  await page.locator('#message').getByText('로그인 후 재개', { exact: false }).waitFor();
  const progressFor = async statuses => {
    await page.unroute('**/api/state');
    await page.route('**/api/state', async route => { const response = await route.fetch(); const body = await response.json(); body.state.jobs.forEach((job, index) => { job.status = statuses[index]; }); await route.fulfill({ response, json: body }); });
    await page.reload();
    const progress = page.locator('.campaign-card .campaign-progress');
    await progress.waitFor();
    return { text: await progress.innerText(), className: await page.locator('.campaign-card').getAttribute('class') };
  };
  let card = await progressFor(['registered', 'verification_due']);
  assert.match(card.text, /예약 발행 등록됨 · 예약 2 · 발행 0\/2/);
  assert.match(card.className, /\bscheduled\b/);
  card = await progressFor(['published', 'registered']);
  assert.match(card.text, /남은 채널 예약 발행 등록됨 · 예약 1 · 발행 1\/2/);
  assert.match(card.className, /\bscheduled\b/);
  card = await progressFor(['registered', 'draft']);
  assert.match(card.text, /일부 채널 예약 등록됨 · 예약 1 · 발행 0\/2/);
  assert.match(card.className, /\bin-progress\b/);
  process.stdout.write('Review dashboard smoke passed: source, channel selection, body, rejection, one-click reservation, recovery, scheduled campaign state\n');
} finally {
  if (browser) await browser.close();
  if (child) child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
