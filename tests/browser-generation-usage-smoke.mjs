import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const dir = fs.mkdtempSync(path.join(path.resolve('tests'), '.postgen-browser-generation-'));
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
  const account = (await api('/api/account', { channel: 'naver', handle: 'usage-smoke', defaultGoal: 'explain' })).registry.accounts[0];
  await api('/api/job', { accountIds: [account.id], audience: 'reader', model: 'codex', sources: [{ type: 'text', text: 'selected source' }] });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/api/generate', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: {}, usage: { text: '토큰 입력 12 · 출력 8\n구독 한도 사용률 확인 불가' } }) }));
  await page.goto(launch);
  await page.getByRole('button', { name: '초안 생성' }).click();
  await page.getByRole('status').getByText(/토큰 입력 12 · 출력 8/).waitFor({ timeout: 10_000 });
  process.stdout.write('Browser generation usage smoke passed: UI displays completed usage (model response mocked)\n');
} finally {
  if (browser) await browser.close();
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
