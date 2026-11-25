import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { addAccount, emptyRegistry, saveRegistry } from '../skill/postgen/scripts/account-registry.mjs';
import { createJob, emptyState, saveState, setDraft, setImageProvider, approveImagePlan, recordImageCandidate } from '../next/core.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-image-placement-'));
process.env.POSTGEN_DATA_DIR = dir;
let browser, child;
try {
  const registry = addAccount(emptyRegistry(), { channel: 'naver', handle: 'image-placement', defaultGoal: 'explain' });
  saveRegistry(registry, 0);
  const account = registry.accounts[0];
  const source = { id: 'source-1', type: 'text', ref: 'test', text: 'Selected source', capturedAt: new Date().toISOString() };
  let state = createJob(emptyState(), { accountId: account.id, accountHandle: account.handle, audience: 'reader', goal: account.defaultGoal, sources: [source] });
  saveState(state, 0);
  const jobId = state.jobs[0].id;
  state = setDraft(state, jobId, { title: 'Image placement', body: 'First paragraph\nSecond paragraph', claims: [], images: [{ id: 'image-1', afterParagraph: 1, description: 'A diagram' }], standard: { set: 'naver-blog-post', sha256: 'a'.repeat(64) } });
  saveState(state, 1);
  state = setImageProvider(state, jobId, 'codex');
  saveState(state, 2);
  state = approveImagePlan(state, jobId);
  saveState(state, 3);
  const imageDir = path.join(dir, 'next', 'images');
  fs.mkdirSync(imageDir, { recursive: true });
  const candidate = path.join(imageDir, 'candidate.png');
  fs.copyFileSync(path.resolve('tests/fixtures/postgen-editor-test.png'), candidate);
  state = recordImageCandidate(state, jobId, 'image-1', candidate, [{ usage: { known: true, inputTokens: 1, outputTokens: 1 }, imageUsage: { known: false }, check: null, checkUsage: null }]);
  saveState(state, 4);

  child = spawn(process.execPath, [path.resolve('next/server.mjs')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const launch = await Promise.race([
    new Promise((resolve, reject) => { let output = ''; child.stdout.on('data', part => { output += part; if (output.includes('\n')) resolve(output.trim()); }); child.on('error', reject); child.on('exit', code => reject(new Error(`Server exited: ${code}`))); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not start')), 10_000))
  ]);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  await page.goto(launch);
  await page.locator('.image-review-item img.image-preview').waitFor();
  assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('job'), jobId);
  await page.reload();
  await page.locator('.image-review-item img.image-preview').waitFor();
  assert.equal(await page.locator('.image-review-item img.image-preview').count(), 1);
  assert.ok(await page.locator('.image-review-item img.image-preview').isVisible());
  await page.getByRole('combobox', { name: 'A diagram 배치 위치' }).selectOption('2');
  await page.getByText('본문 2번째 문단 뒤', { exact: false }).waitFor();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'next', 'jobs.json'), 'utf8'));
  assert.equal(saved.jobs[0].draft.images[0].afterParagraph, 2);
  assert.equal(saved.jobs[0].draft.images[0].pendingPath, candidate);
  assert.equal(await page.getByRole('button', { name: '이 이미지 확인·연결' }).count(), 0);
  let revisionRequest;
  await page.route('**/api/images/regenerate', async route => { revisionRequest = route.request().postDataJSON(); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ attempts: 1 }) }); });
  await page.getByRole('button', { name: '이 이미지 재생성' }).click();
  const dialog = page.getByRole('dialog', { name: '이 이미지 재생성' });
  await dialog.getByRole('textbox', { name: '추가 지침' }).fill('인물의 자세를 바꿔 주세요');
  await dialog.getByRole('button', { name: '재생성' }).click();
  await page.waitForFunction(() => document.querySelector('#message')?.textContent?.includes('새 이미지 후보가 준비됐습니다'));
  assert.equal(revisionRequest.imageId, 'image-1');
  assert.equal(revisionRequest.previousPath, candidate);
  assert.equal(revisionRequest.instructions, '인물의 자세를 바꿔 주세요');
  await page.route('**/api/start', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/prepare-browser', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessionId: 'test', loginRequired: true, message: 'Test browser handoff' }) }));
  await page.getByRole('button', { name: '발행', exact: true }).click();
  await page.locator('#message').filter({ hasText: '로그인 후 재개' }).waitFor();
  const published = JSON.parse(fs.readFileSync(path.join(dir, 'next', 'jobs.json'), 'utf8'));
  assert.equal(published.jobs[0].draft.images[0].generatedPath, candidate);
  assert.equal(published.jobs[0].draft.images[0].afterParagraph, 2);
  assert.equal(published.jobs[0].status, 'awaiting_registration');
  assert.ok(published.jobs[0].approval);
  assert.ok(published.jobs[0].schedule.at);
  process.stdout.write('Image placement dashboard smoke passed: candidate preview, placement, and one-click reservation action\n');
} finally {
  if (browser) await browser.close();
  if (child) child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
