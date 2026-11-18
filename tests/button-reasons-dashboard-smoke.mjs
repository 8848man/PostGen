import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { addAccount, emptyRegistry, saveRegistry } from '../skill/postgen/scripts/account-registry.mjs';
import { createJob, emptyState, saveState, setDraft, setImageProvider, approveImagePlan, recordImageCandidate } from '../next/core.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-button-reasons-'));
process.env.POSTGEN_DATA_DIR = dir;
let browser, child;
try {
  const registry = addAccount(emptyRegistry(), { channel: 'naver', handle: 'button-reasons', defaultGoal: 'explain' });
  saveRegistry(registry, 0);
  const account = registry.accounts[0];
  const source = { id: 'source-1', type: 'text', ref: 'test', text: 'Selected source' };
  const standard = { set: 'naver-blog-post', sha256: 'a'.repeat(64) };
  const ids = [];
  let state = emptyState();
  for (const [title, withStandard] of [
    ['[AI 사서] AI가 작업 창을 열어 주면, 사람은 할 일을 고른다', false],
    ['Image missing', true],
    ['Image generation limit', true]
  ]) {
    state = createJob(state, { accountId: account.id, accountHandle: account.handle, audience: 'reader', goal: account.defaultGoal, sources: [source] });
    const id = state.jobs.at(-1).id;
    ids.push(id);
    state = setDraft(state, id, { title, body: 'First paragraph\nSecond paragraph', claims: [], images: [{ id: 'image-1', afterParagraph: 1, description: 'A diagram' }], ...(withStandard ? { standard } : {}) });
    state = setImageProvider(state, id, 'codex');
    state = approveImagePlan(state, id);
  }
  const imageDir = path.join(dir, 'next', 'images');
  fs.mkdirSync(imageDir, { recursive: true });
  const candidate = path.join(imageDir, 'candidate.png');
  fs.copyFileSync(path.resolve('tests/fixtures/postgen-editor-test.png'), candidate);
  for (const id of [ids[0], ids[2]]) state = recordImageCandidate(state, id, 'image-1', candidate, [{ usage: null, check: null }]);
  state.jobs.find(job => job.id === ids[2]).draft.images[0].generationAttempts = 3;
  state.revision = 1;
  saveState(state, 0);

  child = spawn(process.execPath, [path.resolve('next/server.mjs')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const launch = await Promise.race([
    new Promise((resolve, reject) => { let output = ''; child.stdout.on('data', part => { output += part; if (output.includes('\n')) resolve(output.trim()); }); child.on('error', reject); child.on('exit', code => reject(new Error(`Server exited: ${code}`))); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not start')), 10_000))
  ]);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  let publishRequests = 0, regenerationRequests = 0;
  page.on('request', request => { if (request.url().endsWith('/api/publish-reservation')) publishRequests++; if (request.url().endsWith('/api/images/regenerate')) regenerationRequests++; });
  async function openJob(id) { await page.goto(`${launch}&job=${id}`); await page.reload(); await page.getByRole('button', { name: '발행', exact: true }).waitFor(); }
  await openJob(ids[0]);
  const publish = page.getByRole('button', { name: '발행', exact: true });
  assert.equal(await publish.isEnabled(), true);
  await publish.click();
  await page.getByRole('status').getByText('Assets Manager 지침 적용 기록이 없어 발행할 수 없습니다.', { exact: false }).waitFor();
  assert.equal(publishRequests, 0);

  await openJob(ids[1]);
  await page.getByRole('button', { name: '발행', exact: true }).click();
  await page.getByRole('status').getByText('이미지 1장을 아직 만들지 않아 발행할 수 없습니다.', { exact: false }).waitFor();
  assert.equal(publishRequests, 0);

  await openJob(ids[2]);
  const regenerate = page.getByRole('button', { name: '이 이미지 재생성' });
  assert.equal(await regenerate.isEnabled(), true);
  await regenerate.click();
  await page.getByRole('status').getByText('생성 시도 한도 3회에 도달했습니다.', { exact: false }).waitFor();
  assert.equal(regenerationRequests, 0);
  let releasePublish;
  await page.route('**/api/publish-reservation', route => { releasePublish = () => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
  await page.route('**/api/start', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/prepare-browser', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessionId: 'test', loginRequired: true, message: 'Test browser handoff' }) }));
  await page.getByLabel('공개 시각').fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));
  const busyPublish = page.getByRole('button', { name: '발행', exact: true });
  const pendingRequest = page.waitForRequest(request => request.url().endsWith('/api/publish-reservation'));
  await busyPublish.click();
  await pendingRequest;
  assert.equal(await busyPublish.isEnabled(), true);
  await busyPublish.click();
  await page.getByRole('status').getByText('발행 작업이 진행 중입니다.', { exact: false }).waitFor();
  assert.equal(publishRequests, 1);
  await releasePublish();
  process.stdout.write('Button reasons dashboard smoke passed: blocked conditions and in-progress clicks use toasts\n');
} finally {
  if (browser) await browser.close();
  if (child) child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
