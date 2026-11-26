import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRegistry, resolveAccount, addAccount, addSample, approveSample, setDefaultSample, addAsset, saveRegistry, setPostingUrl } from '../skill/postgen/scripts/account-registry.mjs';
import { postingUrlFor, validatePostingUrl, loginUrlFor, checkLoginStatus, openInPostingBrowser } from './posting-accounts.mjs';
import { createActivityLog, TRACKED_ROUTES } from './activity.mjs';
import { discover } from '../skill/postgen/scripts/collect.mjs';
import { collectSelected } from './sources.mjs';
import { republishJob, createCampaign, recordModelUsage, setDraftEvaluation, loadState, saveState, acquireDraftLock, releaseDraftLock, setDraft, approveImagePlan, setImageProvider, setImagePosition, removeImageSuggestion, attachGeneratedImage, recordImageCandidate, recordReplacementCandidate, confirmImageCandidate, discardImageCandidate, acceptImageCheck, approveDraft, reviewDraft, publishDraftReservation, scheduleJob, rescheduleExpired, refreshDue, startPreparation, reviewPreparation, approveEditorChanges, beginScheduleSubmission, markScheduleUnknown, confirmPlatformSchedule, confirmUnknownSchedule, recordPublication, declineImplicitPublication, recordAutomationError, markManualPublication, unmarkManualPublication, cancelJob, retryPublication, pruneOldSources, restoreRetainedSources } from './core.mjs';
import { evaluateDraft } from './evaluate.mjs';
import { loadAssetsStandard, imageRequest, standardTask } from './assets-standard.mjs';
import { normalizeUsage, summarizeUsage, describeUsage } from './usage.mjs';
import { analyzeSample } from './sample-analysis.mjs';
import { importAsset, importGeneratedImage, previewGeneratedImage, discardGeneratedImage } from './images.mjs';
import { runImageAttempts } from './host-image-flow.mjs';
import { loadConnectors, registerConnector, inspectConnector, approveConnector } from './connectors.mjs';
import { readConnectedSource, prepareWithMcp, registerScheduledWithMcp, tagsNeedBrowser } from './mcp-client.mjs';
import { openEditor, resumeEditorSession, readEditorSession, submitPlatformReservation, recheckPlatformReservation } from './browser-adapter.mjs';
import { loadSettings, updateSettings } from './settings.mjs';
import { codexModelOptions } from './codex-models.mjs';
import { generateJobDraft } from './draft-job.mjs';

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const token = crypto.randomBytes(24).toString('base64url');
const notified = new Set();
const staticFiles = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
let origin = '';

function json(res, code, value) {
  // Every handler answers through here, even after the page went away, so this closes the activity entry.
  if (res.activityId) { activity.finish(res.activityId, code >= 400 ? value?.error || `HTTP ${code}` : null); res.activityId = null; }
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
  return postingUrlFor(account);
}
const activity = createActivityLog();
// What the activity panel names: the post title and, for image work, the image scene.
function activitySubject(input) {
  const jobId = typeof input?.jobId === 'string' ? input.jobId : null;
  const imageId = typeof input?.imageId === 'string' ? input.imageId : null;
  let title = null, detail = null;
  try {
    const job = jobId ? loadState().jobs.find(item => item.id === jobId) : null;
    title = job?.draft?.title || job?.plan?.angle || null;
    detail = imageId ? job?.draft?.images?.find(item => item.id === imageId)?.description?.slice(0, 80) || null : null;
  } catch {}
  return { jobId, imageId, title, detail };
}
function postingAccounts() {
  return loadRegistry().accounts.filter(account => ['naver', 'tistory'].includes(account.channel)).map(account => {
    try { return { accountId: account.id, postingUrl: postingUrlFor(account), custom: Boolean(account.postingUrl) }; }
    catch (error) { return { accountId: account.id, postingUrl: null, custom: false, error: error.message }; }
  });
}
// Keep the failed step and reason on the job; the on-screen message disappears after a few seconds.
async function withAutomationRecord(jobId, step, action) {
  try { return await action(); }
  catch (error) {
    try { mutateState(current => recordAutomationError(current, jobId, { step, stage: error?.stage, message: error?.message || String(error) })); }
    catch (recordError) { process.stderr.write(`Automation error record failed: ${recordError.message}\n`); }
    throw error;
  }
}
async function registerBrowserReservation(jobId, sessionId) {
  const job = loadState().jobs.find(item => item.id === jobId);
  const account = loadRegistry().accounts.find(item => item.id === job?.accountId);
  if (job?.status !== 'ready_to_register' || !account) throw new Error('Approved editor content is not ready for reservation');
  let submitting = false;
  try {
    const result = await submitPlatformReservation(sessionId, { ...job, channel: account.channel }, async () => {
      mutateState(current => beginScheduleSubmission(current, jobId));
      submitting = true;
    });
    if (!submitting) throw new Error('Platform submission did not start');
    const state = result.verified ? mutateState(current => confirmPlatformSchedule(current, jobId, result)) : mutateState(current => markScheduleUnknown(current, jobId, result.reason));
    return { result, state };
  } catch (error) {
    const failure = { step: 'registration', stage: error?.stage, message: error?.message || String(error) };
    if (!submitting) return { result: { verified: false, reason: String(failure.message).slice(0,300), notSubmitted: true }, state: mutateState(current => recordAutomationError(current, jobId, failure)) };
    const state = mutateState(current => recordAutomationError(markScheduleUnknown(current, jobId, failure.message), jobId, failure));
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
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { state: statusState(), registry: loadRegistry(), connectors: loadConnectors(), settings: loadSettings(), codexModels: codexModelOptions(loadSettings().codexImageModel), postingAccounts: postingAccounts() });
    if (req.method === 'GET' && url.pathname === '/api/discover') return json(res, 200, discover(url.searchParams.get('workspace') || process.cwd(), { query: url.searchParams.get('query') || '' }));
    if (req.method === 'GET' && url.pathname === '/api/activity') return json(res, 200, { activities: activity.list() });
    if (req.method !== 'POST' || req.headers.origin !== origin) return json(res, 404, { error: 'Not found' });
    const input = await inputJson(req);
    if (TRACKED_ROUTES[url.pathname]) res.activityId = activity.start({ route: url.pathname, label: TRACKED_ROUTES[url.pathname], ...activitySubject(input) });
    if (url.pathname === '/api/retention/restore') return json(res, 200, { state: mutateState(current => restoreRetainedSources(current, input.jobId)) });
    if (url.pathname === '/api/account') return json(res, 200, { registry: mutateRegistry(current => addAccount(current, input)) });
    if (url.pathname === '/api/account/posting-url') {
      const account = loadRegistry().accounts.find(item => item.id === input.accountId);
      if (!account) throw new Error('Unknown account');
      const postingUrl = String(input.postingUrl || '').trim() ? validatePostingUrl(account, input.postingUrl) : null;
      return json(res, 200, { registry: mutateRegistry(current => setPostingUrl(current, account.id, postingUrl)), postingAccounts: postingAccounts() });
    }
    if (url.pathname === '/api/login-status') return json(res, 200, { statuses: await checkLoginStatus(loadRegistry().accounts) });
    if (url.pathname === '/api/login-open') {
      const account = loadRegistry().accounts.find(item => item.id === input.accountId);
      if (!account) throw new Error('Unknown account');
      // Logged in: open the posting page itself. Otherwise the login page, which returns to the posting page.
      const target = input.loggedIn ? postingUrlFor(account) : loginUrlFor(account);
      try { return json(res, 200, { ...(await openInPostingBrowser(target)), url: target }); }
      catch (error) { return json(res, 200, { opened: false, url: target, reason: error.message }); }
    }
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
      if (!['codex', 'claude'].includes(input.model || 'codex')) throw new Error('Codex or Claude Code subscription is required');
      if (!['manual', 'codex'].includes(input.imageProvider || 'manual')) throw new Error('Select manual or Codex image generation');
      const ids = Array.isArray(input.accountIds) ? input.accountIds : [input.accountId];
      const accounts = ids.map(id => loadRegistry().accounts.find(item => item.id === id));
      if (!accounts.length || accounts.some(account => !account)) throw new Error('Select registered accounts');
      const sources = await collectSelected(input.sources, { workspace: input.workspace || process.cwd(), connectedReader: async spec => {
        const connector = loadConnectors().servers.find(item => item.id === spec.connectorId);
        if (!connector) throw new Error('Unknown connected source server');
        return readConnectedSource(connector, spec.toolName, spec.args || {});
      } });
      const state = mutateState(current => createCampaign(current, { accounts: accounts.map(account => ({ id: account.id, handle: account.handle, goal: account.defaultGoal })), audience: input.audience, sources, model: input.model || 'codex', imageProvider: input.imageProvider || 'manual', projectName: input.projectName?.trim() || null }));
      return json(res, 200, { state });
    }
    if (url.pathname === '/api/generate') {
      const { state, usageEntries } = await generateJobDraft(input.jobId, { provider: input.provider, model: input.model });
      const usage = summarizeUsage(usageEntries);
      return json(res, 200, { state, usage: { ...usage, text: describeUsage(usage) } });
    }
    if (url.pathname === '/api/evaluate') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      if (job?.status !== 'draft' || !job.draft?.standard?.sha256) throw new Error('Draft with applied standard is required for evaluation');
      const registry = loadRegistry(), account = registry.accounts.find(item => item.id === job.accountId);
      if (!account) throw new Error('Account no longer exists');
      const standard = await loadAssetsStandard({ channel: account.channel, task: standardTask(account.channel, job.plan?.angle || job.audience) });
      if (!standard || standard.sha256 !== job.draft.standard.sha256) throw new Error('Assets Manager standard changed; regenerate the draft before evaluation');
      const sample = resolveAccount(registry, account.channel, account.handle).sample;
      const modelOptions = { provider: input.provider || job.model, model: input.model };
      let evaluated; try { evaluated = await evaluateDraft({ draft: job.draft, sample, audience: job.audience, goal: job.goal, sources: job.sources, standardChecks: standard.checks, standardText: standard.text }, modelOptions); } catch (error) { mutateState(latest => recordModelUsage(latest, job.id, 'evaluation', error.usage)); throw error; }
      mutateState(latest => recordModelUsage(latest, job.id, 'evaluation', evaluated.usage));
      const state = mutateState(latest => setDraftEvaluation(latest, job.id, evaluated.evaluation));
      const usage = summarizeUsage([{ step: 'evaluation', usage: evaluated.usage }]);
      return json(res, 200, { state, usage: { ...usage, text: describeUsage(usage) } });
    }
    if (url.pathname === '/api/images/request') {
      // ImageGen request in the Assets Manager format: the standard's template with this position and scene,
      // plus absolute paths of the reference originals to attach in ChatGPT.
      const job = loadState().jobs.find(item => item.id === input.jobId);
      const image = job?.draft?.images.find(item => item.id === input.imageId);
      if (!image) throw new Error('Unknown image');
      return json(res, 200, { request: imageRequest(job.draft.standard, { position: `본문 ${image.afterParagraph}번째 문단 뒤`, scene: image.description, kind: image.kind }) });
    }
    if (url.pathname === '/api/draft/lock') return json(res, 200, { lock: acquireDraftLock(input.jobId) });
    if (url.pathname === '/api/draft/unlock') return json(res, 200, { released: releaseDraftLock(input.jobId, input.token) });
    if (url.pathname === '/api/draft') {
      const existingJob = loadState().jobs.find(item => item.id === input.jobId);
      if (!existingJob) throw new Error('Unknown job');
      if (existingJob.status !== 'draft') throw new Error('Only an existing draft can be edited');
      if (existingJob.status === 'draft' && (!input.lockToken || !Number.isInteger(input.expectedDraftRevision))) throw new Error('Draft edit lock and revision required');
      const options = existingJob.status === 'draft' ? { draftLockToken: input.lockToken, expectedDraftRevision: input.expectedDraftRevision } : undefined;
      const account = loadRegistry().accounts.find(item => item.id === existingJob.accountId);
      if (!account) throw new Error('Account no longer exists');
      return json(res, 200, { state: mutateState(current => setDraft(current, input.jobId, { ...input.draft, standard: existingJob.draft?.standard || null }, input.diagnostics || [], { channel: account.channel }), options) });
    }
    if (url.pathname === '/api/images/approve-plan') {
      if (input.assetId && !loadRegistry().assets?.some(asset => asset.id === input.assetId && asset.accountId === loadState().jobs.find(job => job.id === input.jobId)?.accountId)) throw new Error('Asset belongs to another account');
      return json(res, 200, { state: mutateState(current => approveImagePlan(current, input.jobId, input.assetId || null)) });
    }
    if (url.pathname === '/api/images/provider') return json(res, 200, { state: mutateState(current => setImageProvider(current, input.jobId, input.provider)) });
    if (url.pathname === '/api/images/position') return json(res, 200, { state: mutateState(current => setImagePosition(current, input.jobId, input.imageId, input.afterParagraph)) });
    if (url.pathname === '/api/images/remove') return json(res, 200, { state: mutateState(current => removeImageSuggestion(current, input.jobId, input.imageId)) });
    if (url.pathname === '/api/images/generate') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      const image = job?.draft?.images.find(item => item.id === input.imageId);
      if (job?.status !== 'draft' || job.imageProvider !== 'codex' || !job.draft.imagePlanApproved || !image || image.generatedPath || image.pendingPath) throw new Error('Codex image is not ready for generation');
      const settings = loadSettings();
      const remaining = settings.maxImageGenerations - (image.generationAttempts || 0);
      if (remaining <= 0) throw new Error('Image generation attempt limit reached');
      const asset = image.assetId ? loadRegistry().assets?.find(item => item.id === image.assetId && item.accountId === job.accountId) : null;
      if (image.assetId && !asset) throw new Error('Selected asset unavailable');
      const request = imageRequest(job.draft.standard, { position: `본문 ${image.afterParagraph}번째 문단 뒤`, scene: image.description, kind: image.kind });
      const result = await runImageAttempts({ request, referencePaths: [...(request?.referencePaths || []), ...(asset ? [asset.storedPath] : [])], scene: image.description, model: settings.codexImageModel }, { remaining, autoCheck: settings.autoImageCheck });
      let state;
      try { state = mutateState(current => recordImageCandidate(current, job.id, image.id, result.storedPath, result.attempts)); }
      catch (error) { await discardGeneratedImage(result.storedPath); throw error; }
      const last = result.attempts.at(-1);
      return json(res, 200, { state, usage: last.usage, imageUsage: last.imageUsage, check: last.check, attempts: result.attempts.length });
    }
    if (url.pathname === '/api/images/regenerate') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      const image = job?.draft?.images.find(item => item.id === input.imageId);
      const previousPath = image?.pendingPath || image?.generatedPath;
      const instructions = input.instructions?.trim();
      if (job?.status !== 'draft' || job.imageProvider !== 'codex' || !job.draft.imagePlanApproved || !previousPath || previousPath !== input.previousPath) throw new Error('Image changed; preview it again');
      if (typeof instructions !== 'string' || !instructions || instructions.length > 2000) throw new Error('Enter image changes in 2,000 characters or less');
      const settings = loadSettings();
      const remaining = settings.maxImageGenerations - (image.generationAttempts || 0);
      if (remaining <= 0) throw new Error('Image generation attempt limit reached');
      const asset = image.assetId ? loadRegistry().assets?.find(item => item.id === image.assetId && item.accountId === job.accountId) : null;
      if (image.assetId && !asset) throw new Error('Selected asset unavailable');
      const request = imageRequest(job.draft.standard, { position: `본문 ${image.afterParagraph}번째 문단 뒤`, scene: image.description, kind: image.kind });
      const referencePaths = [...(request?.referencePaths || []), ...(asset ? [asset.storedPath] : [])];
      if (new Set([...referencePaths, previousPath]).size > 5) throw new Error('Image attachments exceed the five-image host limit');
      const result = await runImageAttempts({ request, referencePaths, scene: image.description, previousImagePath: previousPath, revisionInstructions: instructions, model: settings.codexImageModel }, { remaining, autoCheck: settings.autoImageCheck });
      let state;
      const attempts = result.attempts.map(attempt => ({ ...attempt, revisionInstructions: instructions }));
      try { state = mutateState(current => recordReplacementCandidate(current, job.id, image.id, previousPath, result.storedPath, attempts)); }
      catch (error) { await discardGeneratedImage(result.storedPath); throw error; }
      if (image.pendingPath && (image.generatedPath || image.previousPendingPath)) await discardGeneratedImage(image.pendingPath).catch(error => console.warn(`Superseded image cleanup failed: ${error.message}`));
      const last = result.attempts.at(-1);
      return json(res, 200, { state, usage: last.usage, imageUsage: last.imageUsage, check: last.check, attempts: result.attempts.length });
    }
    if (url.pathname === '/api/images/preview') {
      const image = loadState().jobs.find(item => item.id === input.jobId)?.draft?.images.find(item => item.id === input.imageId);
      const imagePath = image?.pendingPath || image?.generatedPath;
      if (!imagePath) throw new Error('No image to preview');
      return json(res, 200, { dataUrl: await previewGeneratedImage(imagePath) });
    }
    if (url.pathname === '/api/images/confirm') {
      if (input.reviewed !== true) throw new Error('Visual review is required before connecting an image');
      return json(res, 200, { state: mutateState(current => confirmImageCandidate(current, input.jobId, input.imageId, input.candidatePath)) });
    }
    if (url.pathname === '/api/images/discard') {
      const image = loadState().jobs.find(item => item.id === input.jobId)?.draft?.images.find(item => item.id === input.imageId);
      if (!image?.pendingPath) throw new Error('No image candidate to discard');
      const state = mutateState(current => discardImageCandidate(current, input.jobId, input.imageId, input.candidatePath));
      await discardGeneratedImage(image.pendingPath);
      return json(res, 200, { state });
    }
    if (url.pathname === '/api/images/import') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      const image = job?.draft?.images.find(item => item.id === input.imageId);
      if (job?.status !== 'draft' || !job.draft.imagePlanApproved || !image || image.generatedPath || image.pendingPath) throw new Error('Image is not ready for import; discard a pending candidate first');
      if (input.reviewed !== true) throw new Error('Review the generated image before importing it');
      const storedPath = await importGeneratedImage(input.path);
      const check = { passed: true, reason: '호스트 생성 이미지 사용자 시각 검수', attempts: 1 };
      const state = mutateState(current => attachGeneratedImage(current, job.id, image.id, storedPath, check));
      return json(res, 200, { state, usage: { ...normalizeUsage(job.model, null), subscriptionReason: '호스트 이미지 작업 사용량을 전달받지 못했습니다.' }, check });
    }
    if (url.pathname === '/api/images/accept-check') return json(res, 200, { state: mutateState(current => acceptImageCheck(current, input.jobId, input.imageId)) });
    if (url.pathname === '/api/approve') return json(res, 200, { state: mutateState(current => approveDraft(current, input.jobId, { conflictAcknowledged: input.conflictAcknowledged === true })) });
    if (url.pathname === '/api/publish-reservation') return json(res, 200, { state: mutateState(current => publishDraftReservation(current, input.jobId, input.at, { conflictAcknowledged: input.conflictAcknowledged === true, standardUnverifiedAcknowledged: input.standardUnverifiedAcknowledged === true })) });
    if (url.pathname === '/api/draft/review') return json(res, 200, { state: mutateState(current => reviewDraft(current, input.jobId, input.decision, input.note)) });
    if (url.pathname === '/api/schedule') return json(res, 200, { state: mutateState(current => scheduleJob(current, input.jobId, input.at)) });
    if (url.pathname === '/api/reschedule') return json(res, 200, { state: mutateState(current => rescheduleExpired(current, input.jobId, input.at, { factsAndLinksReviewed: input.factsAndLinksReviewed === true })) });
    if (url.pathname === '/api/start') return json(res, 200, { state: mutateState(current => startPreparation(current, input.jobId)) });
    if (url.pathname === '/api/prepare-mcp') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      if (job?.status !== 'preparing') throw new Error('Job is not preparing');
      const account = loadRegistry().accounts.find(item => item.id === job.accountId);
      if (tagsNeedBrowser(account?.channel, job.draft.tags)) throw new Error('Blog posts with tags require browser preparation');
      const connector = loadConnectors().servers.find(item => item.id === input.connectorId);
      if (!connector) throw new Error('Unknown MCP connector');
      return json(res, 200, { result: await prepareWithMcp(connector, input.toolName, job) });
    }
    if (url.pathname === '/api/prepare-browser') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      const account = loadRegistry().accounts.find(item => item.id === job?.accountId);
      if (job?.status !== 'preparing' || !account) throw new Error('Job is not preparing');
      const result = await withAutomationRecord(job.id, 'prepare-browser', () => openEditor({ ...job, channel: account.channel }, input.editorUrl || editorUrlFor(account), input.mapping || null));
      if (result.loginRequired) return json(res, 200, result);
      const state = mutateState(current => reviewPreparation(current, job.id, result.editor));
      return json(res, 200, { ...result, state });
    }
    if (url.pathname === '/api/prepare-browser/resume') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      const account = loadRegistry().accounts.find(item => item.id === job?.accountId);
      if (job?.status !== 'preparing' || !account) throw new Error('Job is not preparing');
      const result = await withAutomationRecord(job.id, 'prepare-browser', () => resumeEditorSession(input.sessionId, { ...job, channel: account.channel }));
      const state = mutateState(current => reviewPreparation(current, job.id, result.editor));
      return json(res, 200, { ...result, state });
    }
    if (url.pathname === '/api/registration/browser') return json(res, 200, await registerBrowserReservation(input.jobId, input.sessionId));
    if (url.pathname === '/api/registration/recheck') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      const account = loadRegistry().accounts.find(item => item.id === job?.accountId);
      if (job?.status !== 'unknown' || !account) throw new Error('Only an uncertain reservation can be re-checked');
      const result = await recheckPlatformReservation({ ...job, channel: account.channel });
      return json(res, 200, { result, state: result.verified ? mutateState(current => confirmUnknownSchedule(current, job.id, result)) : loadState() });
    }
    if (url.pathname === '/api/registration/mcp') {
      const job = loadState().jobs.find(item => item.id === input.jobId);
      const connector = loadConnectors().servers.find(item => item.id === input.connectorId);
      if (job?.status !== 'ready_to_register' || !connector) throw new Error('Approved MCP reservation is not ready');
      const account = loadRegistry().accounts.find(item => item.id === job.accountId);
      if (tagsNeedBrowser(account?.channel, job.draft.tags)) throw new Error('Blog posts with tags require browser registration to verify tags before publishing');
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
    if (url.pathname === '/api/publication/manual') return json(res, 200, { state: mutateState(current => markManualPublication(current, input.jobId)) });
    if (url.pathname === '/api/publication/implicit/undo') return json(res, 200, { state: mutateState(current => declineImplicitPublication(current, input.jobId)) });
    if (url.pathname === '/api/publication/manual/undo') return json(res, 200, { state: mutateState(current => unmarkManualPublication(current, input.jobId)) });
    if (url.pathname === '/api/cancel') return json(res, 200, { state: mutateState(current => cancelJob(current, input.jobId)) });
    if (url.pathname === '/api/publication/republish') return json(res, 200, { state: mutateState(current => republishJob(current, input.jobId, input.at, { platformChecked: input.platformChecked === true })) });
    if (url.pathname === '/api/publication/retry') return json(res, 200, { state: mutateState(current => retryPublication(current, input.jobId)) });
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
