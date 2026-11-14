import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const dir = fs.mkdtempSync(path.join(path.resolve('tests'), '.postgen-browser-real-'));
const child = spawn(process.execPath, [path.resolve('next/server.mjs')], { env: { ...process.env, POSTGEN_DATA_DIR: dir, POSTGEN_NEXT_DIR: path.join(dir, 'next') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let browser;
try {
  const launch = await Promise.race([
    new Promise((resolve, reject) => { let output = ''; child.stdout.on('data', part => { output += part; if (output.includes('\n')) resolve(output.trim()); }); child.on('error', reject); child.on('exit', code => reject(new Error(`Server exited: ${code}`))); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not start')), 10_000))
  ]);
  const address = new URL(launch), token = new URLSearchParams(address.hash.slice(1)).get('token');
  async function api(route, value) {
    const response = await fetch(`${address.origin}${route}`, { method: 'POST', headers: { 'x-postgen-token': token, 'Content-Type': 'application/json', Origin: address.origin }, body: JSON.stringify(value) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  }
  const account = (await api('/api/account', { channel: 'naver', handle: 'real-smoke', defaultGoal: '쉽게 설명' })).registry.accounts[0];
  const created = await api('/api/job', { accountIds: [account.id], audience: '처음 접하는 독자', model: 'codex', sources: [{ type: 'text', text: 'PostGen은 블로그 초안을 만든다. 사용자는 게시 전에 초안을 검토한다.' }] });
  const jobId = created.state.jobs[0].id;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  await page.goto(launch);
  await page.getByRole('button', { name: '초안 생성' }).click();
  await page.waitForFunction(() => document.querySelector('#message')?.textContent?.includes('토큰 입력'), null, { timeout: 240_000 });
  const message = await page.locator('#message').textContent();
  const job = (await (await fetch(`${address.origin}/api/state`, { headers: { 'x-postgen-token': token } })).json()).state.jobs.find(item => item.id === jobId);
  if (job?.status !== 'draft' || !job.draft.title || !message.includes('초안 생성 완료')) throw new Error('Real browser generation did not save a draft and display usage');
  process.stdout.write(JSON.stringify({ title: job.draft.title, status: job.status, usageShown: true }) + '\n');
} finally {
  if (browser) await browser.close();
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
