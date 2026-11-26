// Review screen: first five sources visible with the rest scrolled, 14-day archive, checked-channel image generation,
// and the image progress bar in the activity panel.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { addAccount, emptyRegistry, saveRegistry } from '../skill/postgen/scripts/account-registry.mjs';
import { createCampaign, emptyState, saveState, setDraft } from '../next/core.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-batch-archive-'));
process.env.POSTGEN_DATA_DIR = dir;
let browser, child;
try {
  let registry = addAccount(emptyRegistry(), { channel: 'naver', handle: 'naver-smoke', defaultGoal: 'explain' });
  saveRegistry(registry, 0);
  const firstRevision = registry.revision;
  registry = addAccount(registry, { channel: 'tistory', handle: 'tistory-smoke', defaultGoal: 'inform' });
  saveRegistry(registry, firstRevision);
  const accounts = registry.accounts.map(account => ({ id: account.id, handle: account.handle, goal: account.defaultGoal }));
  let state = emptyState();
  state = createCampaign(state, { accounts, audience: 'reader', sources: [{ id: 'old', type: 'text', ref: 'posts/postgen/2026-01-05-daily-old.md', text: 'Old vault post' }] });
  for (let index = 1; index <= 6; index++) state = createCampaign(state, { accounts, audience: 'reader', sources: [{ id: `s${index}`, type: 'text', ref: 'user', text: `Recent source ${index}` }] });
  const target = state.jobs.slice(-2);
  for (const job of target) state = setDraft(state, job.id, { title: `Draft ${job.accountHandle}`, body: 'First paragraph\nSecond paragraph', claims: [], images: [{ id: 'image-1', afterParagraph: 1, description: 'A diagram' }, { id: 'image-2', afterParagraph: 2, description: 'A scene' }], standard: { set: 'naver-blog-post', sha256: 'a'.repeat(64) } });
  state.revision = 1;
  saveState(state, 0);

  child = spawn(process.execPath, [path.resolve('next/server.mjs')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const launch = await Promise.race([
    new Promise((resolve, reject) => { let output = ''; child.stdout.on('data', part => { output += part; if (output.includes('\n')) resolve(output.trim()); }); child.on('error', reject); child.on('exit', code => reject(new Error(`Server exited: ${code}`))); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not start')), 10_000))
  ]);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  let activity = { activities: [], averageImageMs: 90_000 };
  await page.route('**/api/activity', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activity) }));
  await page.goto(launch);
  await page.locator('#channel-jobs .channel-pick').first().waitFor();

  // Six recent sources: five fit, the sixth needs scrolling. The 2026-01-05 vault post went to the archive.
  assert.equal(await page.locator('#campaigns > .campaign-card').count(), 6);
  await page.waitForFunction(() => document.querySelector('#campaigns').classList.contains('scroll-limited'));
  const box = await page.locator('#campaigns').evaluate(list => ({ scroll: list.scrollHeight, client: list.clientHeight, fifth: list.children[4].getBoundingClientRect().bottom - list.getBoundingClientRect().top }));
  assert.ok(box.scroll > box.client, 'the rest of the list scrolls');
  assert.ok(box.client >= box.fifth - 1, 'five cards stay visible');
  assert.ok(await page.locator('#archive').isVisible());
  assert.equal(await page.locator('#archive-count').textContent(), '1');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'next', 'jobs.json'), 'utf8'));
  assert.ok(saved.jobs.slice(0, 2).every(job => job.archivedAt) && saved.jobs.slice(2).every(job => !job.archivedAt));

  // Check every channel of the selected source and generate their images in one request.
  let batch;
  await page.route('**/api/images/generate-batch', async route => { batch = route.request().postDataJSON(); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: batch.jobIds.map(jobId => ({ jobId, generated: 2, requested: 2, error: null })), total: 4 }) }); });
  await page.locator('.channel-bulk label input').check();
  await page.getByText('전체 선택 (2/2)').waitFor();
  await page.getByRole('button', { name: '선택 채널 이미지 생성' }).click();
  await page.waitForFunction(() => document.querySelector('#message')?.textContent?.includes('이미지 4장이 준비됐습니다'));
  assert.deepEqual(new Set(batch.jobIds), new Set(target.map(job => job.id)));

  // Publishing checked channels with images still missing is refused with the reason per channel.
  await page.getByRole('button', { name: '선택 채널 발행' }).click();
  await page.waitForFunction(() => document.querySelector('#message')?.textContent?.includes('발행할 수 있는 채널이 없습니다'));

  // Progress bar: 1 of 4 images done and half of the average time spent on the second → 37%.
  activity = { averageImageMs: 90_000, activities: [{ id: 'a1', route: '/api/images/generate-batch', label: '이미지 일괄 생성', jobId: null, imageId: null, title: null, detail: '이미지 2/4 생성 중', status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null, elapsedMs: 135_000, progress: { done: 1, total: 4, itemElapsedMs: 45_000 } }] };
  await page.locator('#activity-fab').click();
  const bar = page.locator('.activity-bar');
  await bar.waitFor();
  assert.equal(await bar.getAttribute('aria-valuenow'), '37');
  assert.match(await page.locator('.activity-bar-caption').textContent(), /이미지 1\/4장 · 37%/);
  await page.locator('#activity-fab').click();

  // Open the archived source and take it out of the archive.
  await page.locator('#archive summary').click();
  await page.locator('#archive-list .campaign-card').click();
  await page.getByRole('button', { name: '창고에서 꺼내기' }).click();
  await page.waitForFunction(() => document.querySelector('#archive').hidden);
  assert.equal(await page.locator('#campaigns > .campaign-card').count(), 7);
  const restored = JSON.parse(fs.readFileSync(path.join(dir, 'next', 'jobs.json'), 'utf8'));
  assert.ok(restored.jobs.slice(0, 2).every(job => !job.archivedAt && job.archiveReleasedAt));
  console.log('Batch and archive dashboard smoke passed: five visible sources, archive, checked-channel images, progress bar');
} finally {
  await browser?.close();
  child?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
