// Review screen for a social channel: no reservation time, "작성 창 채우기" approves and fills the composer through the
// server, then the user posts and marks it with "게시 완료 표시". Browser automation is stubbed at the API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { addAccount, emptyRegistry, saveRegistry } from '../skill/postgen/scripts/account-registry.mjs';
import { createJob, emptyState, saveState, setDraft, loadState } from '../next/core.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-social-'));
process.env.POSTGEN_DATA_DIR = dir;
let browser, child;
try {
  const registry = addAccount(emptyRegistry(), { channel: 'x', handle: 'me', defaultGoal: 'share' });
  saveRegistry(registry, 0);
  const account = registry.accounts[0];
  let state = createJob(emptyState(), { accountId: account.id, accountHandle: account.handle, audience: 'reader', goal: 'share', sources: [{ id: 's', type: 'text', ref: 'user', text: 'Selected source' }] });
  state = setDraft(state, state.jobs[0].id, { title: '내부 제목', body: '짧은 X 글입니다.', tags: ['AI'], claims: [], images: [], standard: { set: 'x-post', sha256: 'a'.repeat(64) } }, [], { channel: 'x' });
  state.revision = 1;
  saveState(state, 0);
  const jobId = state.jobs[0].id;

  child = spawn(process.execPath, [path.resolve('next/server.mjs')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const launch = await Promise.race([
    new Promise((resolve, reject) => { let output = ''; child.stdout.on('data', part => { output += part; if (output.includes('\n')) resolve(output.trim()); }); child.on('error', reject); child.on('exit', code => reject(new Error(`Server exited: ${code}`))); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not start')), 10_000))
  ]);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Stand in for the composer automation: report the composer as filled, as reviewPreparation would.
  await page.route('**/api/prepare-browser', async route => {
    const current = JSON.parse(fs.readFileSync(path.join(dir, 'next', 'jobs.json'), 'utf8'));
    const job = current.jobs.find(item => item.id === jobId);
    job.status = 'ready_to_register';
    job.editor = { editorUrl: 'https://x.com/compose/post', visibleAccount: 'me', title: job.draft.title, body: job.draft.body, uploadedImages: [], checkedAt: new Date().toISOString(), postedBy: 'user' };
    current.revision++;
    fs.writeFileSync(path.join(dir, 'next', 'jobs.json'), JSON.stringify(current));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessionId: 'session', editor: job.editor, state: current }) });
  });
  await page.goto(launch);
  await page.getByRole('button', { name: '작성 창 채우기' }).waitFor();
  assert.equal(await page.getByLabel('공개 시각').count(), 0, 'social channels have no reservation time');
  await page.getByRole('button', { name: '작성 창 채우기' }).click();
  await page.waitForFunction(() => document.querySelector('#message')?.textContent?.includes('게시 버튼을 직접 누른 뒤'));
  assert.equal(loadState().jobs[0].schedule.manualPost, true);
  await page.getByRole('button', { name: '게시 완료 표시' }).click();
  await page.waitForFunction(() => document.querySelector('#message')?.textContent?.includes('게시 완료로 표시했습니다'));
  const done = loadState().jobs[0];
  assert.equal(done.status, 'published');
  assert.equal(done.publication.source, 'manual');
  assert.deepEqual(errors, []);
  console.log('Social dashboard smoke passed: composer fill without reservation time, user posts, marked published');
} finally {
  await browser?.close();
  child?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
