import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(path.resolve('tests'), '.postgen-server-'));
const child = spawn(process.execPath, [path.resolve('next/server.mjs')], { env: { ...process.env, POSTGEN_DATA_DIR: dir, POSTGEN_NEXT_DIR: path.join(dir, 'next') }, stdio: ['ignore','pipe','pipe'], windowsHide: true });
try {
  const launch = await Promise.race([
    new Promise((resolve, reject) => { let output = ''; child.stdout.on('data', part => { output += part; if (output.includes('\n')) resolve(output.trim()); }); child.on('error', reject); child.on('exit', code => reject(new Error(`Server exited: ${code}`))); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not start')), 10_000))
  ]);
  const address = new URL(launch), token = new URLSearchParams(address.hash.slice(1)).get('token');
  const origin = address.origin;
  async function api(route, value) {
    const response = await fetch(`${origin}${route}`, { method: value ? 'POST' : 'GET', headers: { 'x-postgen-token': token, ...(value ? { 'Content-Type': 'application/json', Origin: origin } : {}) }, body: value ? JSON.stringify(value) : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(`${route}: ${data.error}`);
    return data;
  }
  const settings = await api('/api/settings', { retentionMonths: 2, maxImageGenerations: 2, autoImageCheck: true, backgroundNotifications: false });
  if (settings.settings.retentionMonths !== 2 || (await api('/api/state')).settings.maxImageGenerations !== 2) throw new Error('Settings were not persisted');
  const account = (await api('/api/account', { channel: 'naver', handle: 'smoke', defaultGoal: 'explain' })).registry.accounts[0];
  const state = (await api('/api/job', { accountIds: [account.id], audience: 'reader', model: 'codex', sources: [{ type: 'text', text: 'selected source' }] })).state;
  if (state.jobs.length !== 1 || state.jobs[0].accountId !== account.id) throw new Error('Job was not created');
  const jobId = state.jobs[0].id;
  await api('/api/draft', { jobId, draft: { title: 'Approved title', body: 'Approved body', claims: [], images: [] } });
  await api('/api/approve', { jobId });
  const at = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const scheduled = await api('/api/schedule', { jobId, at });
  if (scheduled.state.jobs[0].status !== 'awaiting_registration') throw new Error('Job was not queued for platform registration');
  const preparing = await api('/api/start', { jobId });
  if (preparing.state.jobs[0].status !== 'preparing') throw new Error('Job was not prepared for platform registration');
  process.stdout.write('Next server smoke passed: settings, account, source, approval, platform reservation queue\n');
} finally {
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
