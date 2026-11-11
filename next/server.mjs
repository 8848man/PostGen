import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRegistry, resolveAccount, addAccount, addSample, approveSample, setDefaultSample, addAsset, saveRegistry } from '../skill/postgen/scripts/account-registry.mjs';
import { discover } from '../skill/postgen/scripts/collect.mjs';
import { collectSelected } from './sources.mjs';
import { createCampaign, setCampaignPlan, loadState, saveState, acquireDraftLock, releaseDraftLock, setDraft, approveImagePlan, attachGeneratedImage, acceptImageCheck, approveDraft, scheduleJob, rescheduleExpired, refreshDue, startPreparation, reviewPreparation, approveEditorChanges, beginScheduleSubmission, markScheduleUnknown, confirmPlatformSchedule, recordPublication, pruneOldSources, restoreRetainedSources } from './core.mjs';
import { generateDraft, generatePlan, draftPrompt } from './generate.mjs';
import { evaluateDraft } from './evaluate.mjs';
import { estimateTextRequest, estimateImageRequest, requireCostAcknowledgement } from './cost.mjs';
import { summarizeUsage, describeUsage } from './usage.mjs';
import { analyzeSample } from './sample-analysis.mjs';
import { importAsset, generateImage, checkImage } from './images.mjs';
import { loadConnectors, registerConnector, inspectConnector, approveConnector } from './connectors.mjs';
import { readConnectedSource, prepareWithMcp, registerScheduledWithMcp } from './mcp-client.mjs';
import { openEditor, resumeEditorSession, readEditorSession, submitPlatformReservation } from './browser-adapter.mjs';
import { loadSettings, updateSettings } from './settings.mjs';

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const token = crypto.randomBytes(24).toString('base64url');
const notified = new Set();
const staticFiles = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
let origin = '';

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}
async function inputJson(req) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 1_000_000) throw new Error('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function mutateState(fn, options) {
  const current = loadState();
  const next = fn(current);
  saveState(next, current.revision, undefined, options);
  return next;
}
function mutateRegistry(fn) {
  const current = loadRegistry();
  const next = fn(current);
  saveRegistry(next, current.revision);
  return next;
}
function statusState() {
  const current = loadState(), due = refreshDue(current);
  const pruned = pruneOldSources(due, loadSettings().retentionMonths);
  if (pruned.revision !== current.revision) { pruned.revision = current.revision + 1; saveState(pruned, current.revision); }
  return pruned;
}
function editorUrlFor(account) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(account.handle)) throw new Error('Use the blog ID as the account handle');
  if (account.channel === 'naver') return `https://blog.naver.com/${account.handle}?Redirect=Write&`;
  if (account.channel === 'tistory') return `https://${account.handle}.tistory.com/manage/newpost`;
  throw new Error('No native browser editor for this channel');
}
async function registerBrowserReservation(jobId, sessionId) {
  const job = loadState().jobs.find(item => item.id === jobId);
  const account = loadRegistry().accounts.find(item => item.id === job?.accountId);
  if (job?.status !== 'ready_to_register' || !account) throw new Error('Approved editor content is not ready for reservation');
  mutateState(current => beginScheduleSubmission(current, jobId));
  try {
    const result = await submitPlatformReservation(sessionId, { ...job, channel: account.channel });
    const state = result.verified ? mutateState(current => confirmPlatformSchedule(current, jobId, result)) : mutateState(current => markScheduleUnknown(current, jobId, result.reason));
    return { result, state };
  } catch (error) {
    const state = mutateState(current => markScheduleUnknown(current, jobId, error.message));
    return { result: { verified: false, reason: String(error.message).slice(0,300) }, state };
  }
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== origin.slice(7)) return json(res, 403, { error: 'Invalid host' });
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && staticFiles.has(url.pathname)) {
      const [file, type] = staticFiles.get(url.pathname);
      res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'", 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(fs.readFileSync(path.join(webRoot, file))); return;
    }
    if (req.headers['x-postgen-token'] !== token) return json(res, 403, { error: 'Unauthorized' });
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { state: statusState(), registry: loadRegistry(), connectors: loadConnectors(), settings: loadSettings() });
    if (req.method === 'GET' && url.pathname === '/api/discover') return json(res, 200, discover(url.searchParams.get('workspace') || process.cwd(), { query: url.searchParams.get('query') || '' }));
    if (req.method !== 'POST' || req.headers.origin !== origin) return json(res, 404, { error: 'Not found' });
    const input = await inputJson(req);
    if (url.pathname === '/api/retention/restore') return json(res, 200, { state: mutateState(current => restoreRetainedSources(current, input.jobId)) });
    if (url.pathname === '/api/account') return json(res, 200, { registry: mutateRegistry(current => addAccount(current, input)) });
    if (url.pathname === '/api/settings') return json(res, 200, { settings: updateSettings(input) });
    if (url.pathname === '/api/connector') return json(res, 200, { connectors: registerConnector(input) });
    if (url.pathname === '/api/connector/inspect') return json(res, 200, await inspectConnector(input.id));
    if (url.pathname === '/api/connector/approve') return json(res, 200, { connectors: approveConnector(input.id, input.fingerprint) });
    if (url.pathname === '/api/sample') return json(res, 200, { registry: mutateRegistry(current => addSample(current, input)) });
    if (url.pathname === '/api/sample/analyze') return json(res, 200, { analysis: await analyzeSample(input) });
    if (url.pathname === '/api/sample/approve') return json(res, 200, { registry: mutateRegistry(current => approveSample(current, input.sampleId, input.rules)) });
    if (url.pathname === '/api/sample/default') return json(res, 200, { registry: mutateRegistry(current => setDefaultSample(current, input.accountId, input.sampleId)) });
    if (url.pathname === '/api/asset') {
      if (!loadRegistry().accounts.some(account => account.id === input.accountId)) throw new Error('Unknown asset account');
      const storedPath = await importAsset(input.path);
      return json(res, 200, { registry: mutateRegistry(current => addAsset(current, { accountId: input.accountId, kind: input.kind, rights: input.rights, storedPath, features: input.features })) });
    }
    if (url.pathname === '/api/job') {
      const ids = Array.isArray(input.accountIds) ? input.accountIds : [input.accountId];
      const accounts = ids.map(id => loadRegistry().accounts.find(item => item.id === id));
      if (!accounts.length || accounts.some(account => !account)) throw new Error('Select registered accounts');
      const sources = await collectSelected(input.sources, { workspace: input.workspace || process.cwd(), connectedReader: async spec => {
        const connector = loadConnectors().servers.find(item => item.id === spec.connectorId);
        if (!connector) throw new Error('Unknown connected source server');
        return readConnectedSource(connector, spec.toolName, spec.args || {});
      } });
      const state = mutateState(current => createCampaign(current, { accounts: accounts.map(account => ({ id: account.id, handle: account.handle, goal: account.defaultGoal })), audience: input.audience, sources, model: input.model || 'codex' }));
      return json(res, 200, { state });
    }
    if (url.pathname === '/api/generate') {
      const current = loadState(); let job = current.jobs.find(item => item.id === input.jobId);
      if (!job || !['selected','draft'].includes(job.status)) throw new Error('Job is not ready for generation');
      if (job.sources.some(source => source.expired)) throw new Error('Source copy expired; restore it or create a new job');
      const registry = loadRegistry(), account = registry.accounts.find(item => item.id === job.accountId);
      if (!account) throw new Error('Account no longer exists');
      const sample = resolveAccount(registry, account.channel, account.handle).sample;
      const modelOptions = { provider: input.provider || job.model, model: input.model };
      const initialInput = { sources: job.sources, account, sample, audience: job.audience, goal: job.goal, plan: job.plan };
      const estimate = estimateTextRequest({ provider: modelOptions.provider, model: modelOptions.model, promptText: draftPrompt(initialInput), calls: 3, outputTokens: 12_000 });
      requireCostAcknowledgement(estimate, input.costAcknowledged === true);
      const usageEntries = [];
      if (!job.plan) { const planned = await generatePlan(job.sources, modelOptions); usageEntries.push({ step: 'plan', usage: planned.usage }); const plannedState = mutateState(latest => setCampaignPlan(latest, job.campaignId, planned.plan)); job = plannedState.jobs.find(item => item.id === input.jobId); }
      const generationInput = { sources: job.sources, account, sample, audience: job.audience, goal: job.goal, plan: job.plan };
      const output = await generateDraft(generationInput, modelOptions);
      usageEntries.push({ step: 'draft', usage: output.usage });
      let evaluation = null;
      try { const evaluated = await evaluateDraft({ draft: output.draft, sample, audience: job.audience, goal: job.goal, sources: job.sources }, modelOptions); evaluation = evaluated.evaluation; usageEntries.push({ step: 'evaluation', usage: evaluated.usage }); }
      catch (error) { usageEntries.push({ step: 'evaluation', usage: null }); output.diagnostics.push({ code: 'evaluation_unavailable', message: String(error.message).slice(0,200) }); }
      output.draft.evaluation = evaluation;
      const state = mutateState(latest => setDraft(latest, job.id, output.draft, output.diagnostics));
      const usage = summarizeUsage(usageEntries);
      return json(res, 200, { state, usage: { ...usage, text: describeUsage(usage) } });
    }
    if (url.pathname === '/api/estimate') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      if (!job) throw new Error('Unknown job');
      const account = loadRegistry().accounts.find(item => item.id === job.accountId);
      const sample = account ? resolveAccount(loadRegistry(), account.channel, account.handle).sample : null;
      if (!account) throw new Error('Unknown account');
      return json(res, 200, { estimate: estimateTextRequest({ provider: input.provider || job.model, model: input.model, promptChars: draftPrompt({ sources: job.sources, account, sample, audience: job.audience, goal: job.goal, plan: job.plan }), calls: 3, outputTokens: 12_000 }) });
    }
    if (url.pathname === '/api/draft/lock') return json(res, 200, { lock: acquireDraftLock(input.jobId) });
    if (url.pathname === '/api/draft/unlock') return json(res, 200, { released: releaseDraftLock(input.jobId, input.token) });
    if (url.pathname === '/api/draft') {
      const existingJob = loadState().jobs.find(item => item.id === input.jobId);
      if (!existingJob) throw new Error('Unknown job');
      if (existingJob.status === 'draft' && (!input.lockToken || !Number.isInteger(input.expectedDraftRevision))) throw new Error('Draft edit lock and revision required');
      const options = existingJob.status === 'draft' ? { draftLockToken: input.lockToken, expectedDraftRevision: input.expectedDraftRevision } : undefined;
      return json(res, 200, { state: mutateState(current => setDraft(current, input.jobId, input.draft, input.diagnostics || []), options) });
    }
    if (url.pathname === '/api/images/approve-plan') {
      if (input.assetId && !loadRegistry().assets?.some(asset => asset.id === input.assetId && asset.accountId === loadState().jobs.find(job => job.id === input.jobId)?.accountId)) throw new Error('Asset belongs to another account');
      return json(res, 200, { state: mutateState(current => approveImagePlan(current, input.jobId, input.assetId || null)) });
    }
    if (url.pathname === '/api/images/estimate') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      const image = job?.draft?.images.find(item => item.id === input.imageId);
      if (job?.status !== 'draft' || !job.draft.imagePlanApproved || !image || image.generatedPath) throw new Error('Image is not ready for generation');
      const settings = loadSettings();
      return json(res, 200, { estimate: estimateImageRequest({ model: input.model || 'gpt-image-2.5-sunburst', hasAsset: Boolean(image.assetId), attempts: settings.autoImageCheck ? settings.maxImageGenerations : 1, autoCheck: settings.autoImageCheck }) });
    }
    if (url.pathname === '/api/images/generate') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      const image = job?.draft?.images.find(item => item.id === input.imageId);
      if (job?.status !== 'draft' || !job.draft.imagePlanApproved || !image) throw new Error('Image plan is not approved');
      const asset = image.assetId ? loadRegistry().assets?.find(item => item.id === image.assetId && item.accountId === job.accountId) : null;
      if (image.assetId && !asset) throw new Error('Selected asset unavailable');
      const settings = loadSettings();
      const attempts = settings.autoImageCheck ? settings.maxImageGenerations : 1;
      const estimate = estimateImageRequest({ model: input.model || 'gpt-image-2.5-sunburst', hasAsset: Boolean(asset), attempts, autoCheck: settings.autoImageCheck });
      requireCostAcknowledgement(estimate, input.costAcknowledged === true);
      if (input.costAcknowledged !== true) throw new Error('Image cost requires confirmation');
      let result, check = null, feedback = '';
      for (let attempt = 1; attempt <= attempts; attempt++) {
        result = await generateImage({ description: `${image.description}${feedback}`, asset, model: input.model || undefined });
        if (!settings.autoImageCheck) break;
        try { check = await checkImage({ imagePath: result.path, description: image.description, asset }); }
        catch (error) { check = { passed: false, reason: `자동 점검 실패: ${String(error.message).slice(0,200)}` }; }
        check.attempts = attempt;
        if (check.passed) break;
        feedback = ` Improve on this issue: ${check.reason}`;
      }
      const state = mutateState(current => attachGeneratedImage(current, job.id, image.id, result.path, check));
      return json(res, 200, { state, usage: result.usage, check });
    }
    if (url.pathname === '/api/images/accept-check') return json(res, 200, { state: mutateState(current => acceptImageCheck(current, input.jobId, input.imageId)) });
    if (url.pathname === '/api/approve') return json(res, 200, { state: mutateState(current => approveDraft(current, input.jobId, { conflictAcknowledged: input.conflictAcknowledged === true })) });
    if (url.pathname === '/api/schedule') return json(res, 200, { state: mutateState(current => scheduleJob(current, input.jobId, input.at)) });
    if (url.pathname === '/api/reschedule') return json(res, 200, { state: mutateState(current => rescheduleExpired(current, input.jobId, input.at, { factsAndLinksReviewed: input.factsAndLinksReviewed === true })) });
    if (url.pathname === '/api/start') return json(res, 200, { state: mutateState(current => startPreparation(current, input.jobId)) });
    if (url.pathname === '/api/prepare-mcp') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      if (job?.status !== 'preparing') throw new Error('Job is not preparing');
      const connector = loadConnectors().servers.find(item => item.id === input.connectorId);
      if (!connector) throw new Error('Unknown MCP connector');
      return json(res, 200, { result: await prepareWithMcp(connector, input.toolName, job) });
    }
    if (url.pathname === '/api/prepare-browser') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      const account = loadRegistry().accounts.find(item => item.id === job?.accountId);
      if (job?.status !== 'preparing' || !account) throw new Error('Job is not preparing');
      const result = await openEditor({ ...job, channel: account.channel }, input.editorUrl || editorUrlFor(account), input.mapping || null);
      if (result.loginRequired) return json(res, 200, result);
      const state = mutateState(current => reviewPreparation(current, job.id, result.editor));
      return json(res, 200, { ...result, state });
    }
    if (url.pathname === '/api/prepare-browser/resume') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      const account = loadRegistry().accounts.find(item => item.id === job?.accountId);
      if (job?.status !== 'preparing' || !account) throw new Error('Job is not preparing');
      const result = await resumeEditorSession(input.sessionId, { ...job, channel: account.channel });
      const state = mutateState(current => reviewPreparation(current, job.id, result.editor));
      return json(res, 200, { ...result, state });
    }
    if (url.pathname === '/api/registration/browser') return json(res, 200, await registerBrowserReservation(input.jobId, input.sessionId));
    if (url.pathname === '/api/registration/mcp') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      const connector = loadConnectors().servers.find(item => item.id === input.connectorId);
      if (job?.status !== 'ready_to_register' || !connector) throw new Error('Approved MCP reservation is not ready');
      mutateState(current => beginScheduleSubmission(current, job.id));
      try {
        const result = await registerScheduledWithMcp(connector, input.toolName, job);
        return json(res, 200, { result, state: mutateState(current => confirmPlatformSchedule(current, job.id, result)) });
      } catch (error) {
        return json(res, 200, { result: { verified: false, reason: String(error.message).slice(0,300) }, state: mutateState(current => markScheduleUnknown(current, job.id, error.message)) });
      }
    }
    if (url.pathname === '/api/review-changes') return json(res, 200, { state: mutateState(current => approveEditorChanges(current, input.jobId, { factsAndLinksReviewed: input.factsAndLinksReviewed === true })) });
    if (url.pathname === '/api/browser/read') return json(res, 200, { editor: await readEditorSession(input.sessionId) });
    if (url.pathname === '/api/review') return json(res, 200, { state: mutateState(current => reviewPreparation(current, input.jobId, input.editor)) });
    if (url.pathname === '/api/publication') return json(res, 200, { state: mutateState(current => recordPublication(current, input.jobId, input.publication)) });
    return json(res, 404, { error: 'Not found' });
  } catch (error) { return json(res, 400, { error: String(error.message || error).slice(0, 500) }); }
});

server.listen(0, '127.0.0.1', () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  process.stdout.write(`${origin}/#token=${token}\n`);
  statusState();
  setInterval(() => { try { statusState(); } catch (error) { process.stderr.write(`Retention cleanup failed: ${error.message}\n`); } }, 86_400_000).unref();
  if (process.platform === 'win32') setInterval(() => {
    try {
      if (!loadSettings().backgroundNotifications && process.env.POSTGEN_BACKGROUND_NOTIFICATIONS !== '1') return;
      for (const job of statusState().jobs.filter(item => ['awaiting_registration','unknown','verification_due'].includes(item.status))) {
        if (notified.has(job.id)) continue;
        notified.add(job.id);
        spawn('powershell.exe', ['-NoProfile','-WindowStyle','Hidden','-File',path.join(path.dirname(fileURLToPath(import.meta.url)),'notify.ps1'),'-Title','PostGen 예약 준비','-Body',`${job.accountHandle}: 글을 준비할 시간입니다. 클릭해 검토하세요.`,'-Url',`${origin}/#token=${token}`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      }
    } catch { /* The UI will show due work on the next refresh. */ }
  }, 60_000).unref();
});
