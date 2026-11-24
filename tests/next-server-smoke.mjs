import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadState, saveState, setDraft } from '../next/core.mjs';

const testsRoot = path.resolve('tests');
const dir = fs.mkdtempSync(path.join(testsRoot, '.postgen-server-'));
if (!path.resolve(dir).startsWith(testsRoot + path.sep)) throw new Error('Smoke data is outside the tests directory');
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
  const jobsFile = path.join(dir, 'next', 'jobs.json');
  const beforeDraft = loadState(jobsFile);
  const standard = { set: 'naver-blog-post', sha256: 'a'.repeat(64) };
  saveState(setDraft(beforeDraft, jobId, { title: 'Initial title', body: 'Initial body', claims: [], images: [], standard }), beforeDraft.revision, jobsFile);
  const lock = (await api('/api/draft/lock', { jobId })).lock;
  const edited = await api('/api/draft', { jobId, lockToken: lock.token, expectedDraftRevision: 1, draft: { title: 'Approved title', body: 'Approved body', claims: [], images: [{ id: 'image-1', afterParagraph: 1, description: 'Test image' }] } });
  if (edited.state.jobs[0].draft.revision !== 2 || edited.state.jobs[0].draft.standard.sha256 !== standard.sha256) throw new Error('Draft edit did not preserve its standard and revision');
  await api('/api/draft/unlock', { jobId, token: lock.token });
  await api('/api/images/approve-plan', { jobId });
  const imported = await api('/api/images/import', { jobId, imageId: 'image-1', path: path.resolve('tests/fixtures/postgen-editor-test.png'), reviewed: true });
  if (imported.usage.known !== false || !fs.existsSync(imported.state.jobs[0].draft.images[0].generatedPath)) throw new Error('Host image was not copied or usage was invented');
  await api('/api/approve', { jobId });
  const atDate = new Date(Date.now() + 24 * 60 * 60_000); atDate.setUTCSeconds(0, 0); atDate.setUTCMinutes(Math.ceil(atDate.getUTCMinutes() / 10) * 10);
  const at = atDate.toISOString();
  const scheduled = await api('/api/schedule', { jobId, at });
  if (scheduled.state.jobs[0].status !== 'awaiting_registration') throw new Error('Job was not queued for platform registration');
  const preparing = await api('/api/start', { jobId });
  if (preparing.state.jobs[0].status !== 'preparing') throw new Error('Job was not prepared for platform registration');
  const stored = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
  stored.jobs[0].createdAt = '2026-01-01T00:00:00Z';
  fs.writeFileSync(jobsFile, JSON.stringify(stored));
  const pruned = (await api('/api/state')).state;
  if (pruned.jobs[0].sources[0].text !== null || pruned.retentionTrash.length !== 1) throw new Error('Expired source was not moved to retention trash');
  const restored = (await api('/api/retention/restore', { jobId })).state;
  if (restored.jobs[0].sources[0].text !== 'selected source') throw new Error('Retention restore failed');
  process.stdout.write('Next server smoke passed: settings, account, source, approval, platform reservation queue, retention restore\n');
} finally {
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
