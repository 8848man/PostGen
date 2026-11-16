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
  state = setDraft(state, jobId, { title: 'Image placement', body: 'First paragraph\nSecond paragraph', claims: [], images: [{ id: 'image-1', afterParagraph: 1, description: 'A diagram' }] });
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
  assert.equal(await page.locator('.image-review-item img.image-preview').count(), 1);
  await page.getByRole('combobox', { name: 'A diagram 배치 위치' }).selectOption('2');
  await page.getByRole('button', { name: '위치 저장' }).click();
  await page.getByText('본문 2번째 문단 뒤', { exact: false }).waitFor();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'next', 'jobs.json'), 'utf8'));
  assert.equal(saved.jobs[0].draft.images[0].afterParagraph, 2);
  assert.equal(saved.jobs[0].draft.images[0].pendingPath, candidate);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '이 이미지 확인·연결' }).click();
  await page.getByRole('button', { name: '승인', exact: true }).waitFor();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await page.getByRole('button', { name: '발행 예약' }).waitFor();
  const approved = JSON.parse(fs.readFileSync(path.join(dir, 'next', 'jobs.json'), 'utf8'));
  assert.equal(approved.jobs[0].draft.images[0].generatedPath, candidate);
  assert.equal(approved.jobs[0].status, 'approved');
  process.stdout.write('Image placement dashboard smoke passed: candidate preview, placement, image confirmation, and reservation action\n');
} finally {
  if (browser) await browser.close();
  if (child) child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
