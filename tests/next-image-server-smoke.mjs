import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadState, saveState, recordImageCandidate } from '../next/core.mjs';

const dir = fs.mkdtempSync(path.join(path.resolve('tests'), '.postgen-image-server-'));
const nextDir = path.join(dir, 'next');
const child = spawn(process.execPath, [path.resolve('next/server.mjs')], { env: { ...process.env, POSTGEN_DATA_DIR: dir, POSTGEN_NEXT_DIR: nextDir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
try {
  const launch = await Promise.race([
    new Promise((resolve, reject) => { let output = ''; child.stdout.on('data', part => { output += part; if (output.includes('\n')) resolve(output.trim()); }); child.on('error', reject); child.on('exit', code => reject(new Error(`Server exited: ${code}`))); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not start')), 10_000))
  ]);
  const address = new URL(launch), origin = address.origin, token = new URLSearchParams(address.hash.slice(1)).get('token');
  async function api(route, value, expected = 200) {
    const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'x-postgen-token': token, 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(value) });
    const data = await response.json();
    if (response.status !== expected) throw new Error(`${route}: expected ${expected}, got ${response.status}: ${data.error}`);
    return data;
  }
  const account = (await api('/api/account', { channel: 'naver', handle: 'image-smoke', defaultGoal: 'explain' })).registry.accounts[0];
  const created = await api('/api/job', { accountIds: [account.id], audience: 'reader', model: 'claude', imageProvider: 'codex', sources: [{ type: 'text', text: 'selected source' }] });
  const jobId = created.state.jobs[0].id;
  if (created.state.jobs[0].model !== 'claude' || created.state.jobs[0].imageProvider !== 'codex') throw new Error('Text and image hosts were not kept separate');
  const reference = path.resolve('tests/fixtures/postgen-editor-test.png');
  await api('/api/draft', { jobId, draft: { title: 'Title', body: 'Paragraph', images: [{ id: 'image-1', afterParagraph: 1, description: 'A simple chart' }], standard: { set: 'naver-blog-post', imageTemplate: '### 이미지 1: <들어갈 자리>\n- 참조 이미지로 첨부: [1] postgen-editor-test.png (chart reference)\n- 장면: <장면>', files: [reference] } } });
  await api('/api/images/approve-plan', { jobId });
  const request = await api('/api/images/request', { jobId, imageId: 'image-1' });
  if (!request.request.text.includes('본문 1번째 문단 뒤') || !request.request.text.includes('A simple chart') || request.request.referencePaths[0] !== reference) throw new Error('Chart slot did not produce a reference image request');
  const imageDir = path.join(nextDir, 'images');
  fs.mkdirSync(imageDir, { recursive: true });
  const candidate = path.join(imageDir, 'candidate.png');
  fs.copyFileSync(path.resolve('tests/fixtures/postgen-editor-test.png'), candidate);
  const jobsFile = path.join(nextDir, 'jobs.json');
  const current = loadState(jobsFile);
  saveState(recordImageCandidate(current, jobId, 'image-1', candidate, [{ usage: { provider: 'codex', known: true, inputTokens: 1, outputTokens: 1 }, imageUsage: { known: false }, check: null, checkUsage: null }]), current.revision, jobsFile);
  const preview = await api('/api/images/preview', { jobId, imageId: 'image-1' });
  if (!preview.dataUrl.startsWith('data:image/png;base64,')) throw new Error('Image candidate could not be previewed');
  await api('/api/images/confirm', { jobId, imageId: 'image-1', candidatePath: path.join(imageDir, 'wrong.png'), reviewed: true }, 400);
  const confirmed = await api('/api/images/confirm', { jobId, imageId: 'image-1', candidatePath: candidate, reviewed: true });
  const image = confirmed.state.jobs[0].draft.images[0];
  if (image.generatedPath !== candidate || image.afterParagraph !== 1 || !image.check.passed) throw new Error('Reviewed image was not attached to its paragraph');
  process.stdout.write('Image server smoke passed: split hosts, chart request, preview, candidate identity, visual confirmation, paragraph placement\n');
} finally {
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
