import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './profile.mjs';
import { cleanTags, projectNameForSources, projectTitle, withNaverTagLine } from './post-metadata.mjs';
import { imagePositionAllowed, settleImagePosition, unmatchedHeadings } from './body-structure.mjs';
import { isSocialChannel, socialDraftProblems } from './channel-rules.mjs';

const VERSION = 'postgen-next/v1';
const DAY = 86_400_000;
const DRAFT_LOCK_MS = 30 * 60_000;
const FILE_LOCK_STALE_MS = 60_000;
export const nextPath = () => path.join(process.env.POSTGEN_NEXT_DIR || path.join(dataDir(), 'next'), 'jobs.json');
export const emptyState = () => ({ schemaVersion: VERSION, revision: 0, jobs: [], retentionTrash: [] });
const nonempty = (value, max = 100_000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export const hasDraftStandard = draft => !!(draft?.standard && nonempty(draft.standard.set, 120) && /^[0-9a-f]{64}$/.test(draft.standard.sha256));

export function validateState(state) {
  if (state?.schemaVersion !== VERSION || !Number.isInteger(state.revision) || state.revision < 0 || !Array.isArray(state.jobs)) throw new Error('Invalid next state');
  if (state.retentionTrash !== undefined && (!Array.isArray(state.retentionTrash) || state.retentionTrash.some(entry => !entry || entry.schemaVersion !== 'retention-trash/v1' || !nonempty(entry.id, 80) || entry.revision !== 1 || !nonempty(entry.jobId, 80) || !iso(entry.createdAt) || !iso(entry.updatedAt) || !iso(entry.removedAt) || !iso(entry.purgeAt) || !Array.isArray(entry.sources) || entry.sources.some(source => !nonempty(source.id, 80) || !nonempty(source.text, 120_000)) || !Array.isArray(entry.diagnostics)))) throw new Error('Invalid retention trash');
  const ids = new Set();
  for (const job of state.jobs) {
    if (!nonempty(job.id, 80) || ids.has(job.id) || !nonempty(job.accountId, 80) || !nonempty(job.audience, 500) || !Array.isArray(job.sources) || !job.sources.length || !['selected','draft','approved','scheduled','due','awaiting_registration','preparing','review_required','ready_to_register','submitting','registered','verification_due','published','expired','cancelled','failed','unknown'].includes(job.status)) throw new Error('Invalid job');
    if (job.sources.some(source => !nonempty(source.id, 80) || !nonempty(source.type, 40) || !nonempty(source.ref, 2048) || !(source.expired === true ? source.text === null : nonempty(source.text, 120_000)))) throw new Error('Invalid source snapshot');
    if (job.projectName !== undefined && job.projectName !== null && !nonempty(job.projectName, 80)) throw new Error('Invalid project name');
    if (job.draft && (!nonempty(job.draft.title, 300) || !nonempty(job.draft.body) || !Array.isArray(job.draft.claims) || !Array.isArray(job.draft.images) || (job.draft.headings !== undefined && (!Array.isArray(job.draft.headings) || job.draft.headings.some(heading => !nonempty(heading, 300)))))) throw new Error('Invalid draft');
    if (job.draft?.tags !== undefined) cleanTags(job.draft.tags);
    if ([job.archivedAt, job.archiveReleasedAt].some(value => value !== undefined && value !== null && !iso(value))) throw new Error('Invalid archive time');
    if (job.review && (!['rejected','improvement_requested'].includes(job.review.decision) || !nonempty(job.review.note, 2000) || !iso(job.review.at))) throw new Error('Invalid draft review');
    if (job.imageProvider !== undefined && !['manual', 'codex'].includes(job.imageProvider)) throw new Error('Invalid image host');
    if ((['approved','scheduled','due','awaiting_registration','preparing','review_required','ready_to_register','submitting','registered','verification_due','expired'].includes(job.status) || job.status === 'published' && job.publication?.source !== 'manual') && (!job.approval?.at || !job.draft)) throw new Error('Approved job needs a draft');
    if (job.status === 'published' && (!job.draft || !iso(job.publication?.at) || (!['manual', 'implicit'].includes(job.publication?.source) && !nonempty(job.publication?.postUrl, 2048)))) throw new Error('Published job needs a draft and publication record');
    if (job.status === 'published' && job.publication?.source === 'implicit' && !job.registration?.verified) throw new Error('Implicit publication needs a verified platform reservation');
    if (['scheduled','due','awaiting_registration','preparing','review_required','ready_to_register','submitting','registered','verification_due','expired'].includes(job.status) && (!iso(job.schedule?.at) || !iso(job.schedule?.expiresAt))) throw new Error('Scheduled job needs a time');
    if ((['registered','verification_due'].includes(job.status) || job.status === 'published' && job.registration) && job.schedule && (!job.registration?.verified || job.registration.publishAt !== job.schedule.at || job.registration.accountHandle !== job.accountHandle)) throw new Error('Platform reservation must be verified');
    ids.add(job.id);
  }
  return state;
}

export function loadState(file = nextPath()) {
  if (!fs.existsSync(file)) return emptyState();
  return validateState(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function withFileLock(file, action) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = `${file}.write.lock`;
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lockPath).mtimeMs > FILE_LOCK_STALE_MS) fs.unlinkSync(lockPath); }
      catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      if (Date.now() >= deadline) throw new Error('State is busy; retry');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return action(); }
  finally { fs.rmSync(lockPath, { force: true }); }
}

function draftLockPath(file, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid job ID');
  return path.join(path.dirname(file), '.draft-locks', `${id}.json`);
}

function activeDraftLock(file, id) {
  const lockPath = draftLockPath(file, id);
  if (!fs.existsSync(lockPath)) return null;
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (Date.parse(lock.expiresAt) > Date.now()) return lock;
  fs.unlinkSync(lockPath);
  return null;
}

export function acquireDraftLock(id, file = nextPath()) {
  return withFileLock(file, () => {
    const job = loadState(file).jobs.find(item => item.id === id);
    if (!job || job.status !== 'draft') throw new Error('Draft is not editable');
    if (activeDraftLock(file, id)) throw new Error('Draft is being edited; reload later');
    const lockPath = draftLockPath(file, id);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    const lock = { token: crypto.randomUUID(), expiresAt: new Date(Date.now() + DRAFT_LOCK_MS).toISOString(), draftRevision: job.draft.revision };
    fs.writeFileSync(lockPath, JSON.stringify(lock), { flag: 'wx', mode: 0o600 });
    return lock;
  });
}

export function releaseDraftLock(id, token, file = nextPath()) {
  return withFileLock(file, () => {
    const lock = activeDraftLock(file, id);
    if (!lock) return false;
    if (lock.token !== token) throw new Error('Draft lock belongs to another editor');
    fs.unlinkSync(draftLockPath(file, id));
    return true;
  });
}

export function saveState(next, expectedRevision, file = nextPath(), { draftLockToken, expectedDraftRevision } = {}) {
  validateState(next);
  return withFileLock(file, () => {
    const current = loadState(file);
    if (current.revision !== expectedRevision || next.revision !== expectedRevision + 1) throw new Error('State changed; reload and retry');
    for (const job of next.jobs) {
      const before = current.jobs.find(item => item.id === job.id);
      if (!before || JSON.stringify(before) === JSON.stringify(job)) continue;
      const lock = activeDraftLock(file, job.id);
      if (draftLockToken && !lock) throw new Error('Draft edit lock expired; reload and retry');
      if (lock && lock.token !== draftLockToken) throw new Error('Draft is being edited; reload later');
      if (lock && expectedDraftRevision !== undefined && before.draft?.revision !== expectedDraftRevision) throw new Error('Draft changed; reload and retry');
    }
    const dir = path.dirname(file);
    const temp = path.join(dir, `.jobs-${crypto.randomUUID()}.tmp`);
    try { fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return next;
  });
}

function change(state, id, allowed, apply) {
  validateState(state);
  const next = structuredClone(state);
  const job = next.jobs.find(item => item.id === id);
  if (!job) throw new Error('Unknown job');
  if (!allowed.includes(job.status)) throw new Error(`Cannot change ${job.status} job`);
  apply(job);
  job.updatedAt = new Date().toISOString();
  next.revision++;
  return validateState(next);
}

export function createJob(state, { accountId, accountHandle = accountId, audience, goal, sources, model = 'codex', imageProvider = 'manual', projectName = null }) {
  if (!nonempty(accountId, 80) || !nonempty(audience, 500) || !nonempty(goal, 500) || !Array.isArray(sources) || !sources.length) throw new Error('Account, audience, goal, and selected sources are required');
  const next = structuredClone(validateState(state));
  const now = new Date().toISOString();
  next.jobs.push({ id: crypto.randomUUID(), campaignId: crypto.randomUUID(), accountId, accountHandle, audience, goal, model, imageProvider, projectName: projectName || projectNameForSources(sources), sources, plan: null, status: 'selected', draft: null, approval: null, schedule: null, diagnostics: [], createdAt: now, updatedAt: now });
  next.revision++;
  return validateState(next);
}

export function createCampaign(state, { accounts, audience, sources, model = 'codex', imageProvider = 'manual', projectName = null }) {
  if (!Array.isArray(accounts) || !accounts.length || !Array.isArray(sources) || !sources.length || !nonempty(audience, 500)) throw new Error('Select accounts, audience, and sources');
  if (!['manual', 'codex'].includes(imageProvider)) throw new Error('Select a supported image host');
  const next = structuredClone(validateState(state)), now = new Date().toISOString(), campaignId = crypto.randomUUID();
  const uniqueAccounts = new Set();
  for (const account of accounts) {
    if (!nonempty(account.id, 80) || !nonempty(account.handle, 200) || !nonempty(account.goal, 500) || uniqueAccounts.has(account.id)) throw new Error('Invalid campaign account');
    uniqueAccounts.add(account.id);
    next.jobs.push({ id: crypto.randomUUID(), campaignId, accountId: account.id, accountHandle: account.handle, audience, goal: account.goal, model, imageProvider, projectName: projectName || projectNameForSources(sources), sources: structuredClone(sources), plan: null, status: 'selected', draft: null, approval: null, schedule: null, diagnostics: [], createdAt: now, updatedAt: now });
  }
  next.revision++;
  return validateState(next);
}

export function addCampaignAccounts(state, campaignId, accounts) {
  const next = structuredClone(validateState(state));
  const siblings = next.jobs.filter(job => job.campaignId === campaignId);
  if (!siblings.length) throw new Error('Unknown campaign');
  const seed = siblings[0];
  if (seed.sources.some(source => source.expired || !source.text)) throw new Error('Campaign sources are no longer available');
  const existing = new Set(siblings.map(job => job.accountId));
  const now = new Date().toISOString();
  for (const account of accounts) {
    if (!nonempty(account.id, 80) || !nonempty(account.handle, 200) || !nonempty(account.goal, 500)) throw new Error('Invalid campaign account');
    if (existing.has(account.id)) continue;
    existing.add(account.id);
    next.jobs.push({ id: crypto.randomUUID(), campaignId, accountId: account.id, accountHandle: account.handle, audience: seed.audience, goal: account.goal, model: seed.model, imageProvider: seed.imageProvider, projectName: seed.projectName, sources: structuredClone(seed.sources), plan: structuredClone(seed.plan), status: 'selected', draft: null, approval: null, schedule: null, diagnostics: [], createdAt: now, updatedAt: now });
  }
  if (next.jobs.length === state.jobs.length) return state;
  next.revision++;
  return validateState(next);
}

export function setCampaignPlan(state, campaignId, plan) {
  if (!plan || typeof plan.angle !== 'string' || !Array.isArray(plan.keyClaims) || !Array.isArray(plan.conflicts)) throw new Error('Invalid evidence plan');
  const next = structuredClone(validateState(state));
  const jobs = next.jobs.filter(job => job.campaignId === campaignId);
  if (!jobs.length || jobs.some(job => job.status !== 'selected' && job.status !== 'draft')) throw new Error('Campaign is not ready for planning');
  for (const job of jobs) { job.plan = structuredClone(plan); job.updatedAt = new Date().toISOString(); }
  next.revision++;
  return validateState(next);
}

export function recordModelUsage(state, id, step, usage, { campaign = false, callId = crypto.randomUUID() } = {}) {
  if (!['plan-and-draft','shared-plan','draft','evaluation'].includes(step)) throw new Error('Unknown model usage step');
  const next = structuredClone(validateState(state));
  const target = next.jobs.find(job => job.id === id);
  if (!target) throw new Error('Unknown job');
  const jobs = campaign ? next.jobs.filter(job => job.campaignId === target.campaignId) : [target];
  const entry = { id: callId, at: new Date().toISOString(), step, usage: structuredClone(usage || { known: false, subscription: null, subscriptionReason: '사용량을 받지 못했습니다.' }) };
  for (const job of jobs) { job.modelUsage = [...(job.modelUsage || []), structuredClone(entry)]; job.updatedAt = entry.at; }
  next.revision++;
  return validateState(next);
}

export function setDraftEvaluation(state, id, evaluation) {
  return change(state, id, ['draft'], job => {
    if (!hasDraftStandard(job.draft)) throw new Error('Draft standard record is missing; regenerate before evaluation');
    job.draft.evaluation = evaluation;
  });
}

export function setDraft(state, id, draft, diagnostics = [], { channel = null } = {}) {
  return change(state, id, ['selected','draft'], job => {
    if (!nonempty(draft?.title, 300)) throw new Error('Draft title is required');
    const tags = cleanTags(draft.tags || []);
    const tagged = channel === 'naver' ? withNaverTagLine(draft.body, tags, job.draft?.tags || []) : { body: draft.body, paragraphShift: 0 };
    // Positions inside the table of contents or a list move to the subheading / the block before the list.
    const images = (draft.images || []).map(image => ({ ...image, afterParagraph: settleImagePosition(tagged.body, draft.headings || [], image.afterParagraph + tagged.paragraphShift) }));
    job.draft = { title: projectTitle(draft.title, job.projectName || projectNameForSources(job.sources)), tags, body: tagged.body, claims: draft.claims || [], images, headings: draft.headings || [], imagePlanApproved: draft.imagePlanApproved || false, evaluation: draft.evaluation || null, standard: draft.standard || null, revision: (job.draft?.revision || 0) + 1 };
    job.diagnostics = diagnostics;
    job.approval = null;
    job.review = null;
    job.status = 'draft';
  });
}

export function approveDraft(state, id, { conflictAcknowledged = false } = {}) {
  return change(state, id, ['draft'], job => {
    if (!job.draft) throw new Error('Missing draft');
    if (!hasDraftStandard(job.draft)) throw new Error('Draft standard record is missing; regenerate with Assets Manager standard before review');
    const imageIds = new Set();
    const paragraphCount = job.draft.body.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim()).length;
    for (const image of job.draft.images) { if (!nonempty(image.id, 80) || imageIds.has(image.id) || !Number.isInteger(image.afterParagraph) || image.afterParagraph < 1 || image.afterParagraph > paragraphCount || !nonempty(image.description, 2000)) throw new Error('Image suggestions need unique IDs and existing paragraph positions'); imageIds.add(image.id); }
    if (unmatchedHeadings(job.draft.body, job.draft.headings).length) throw new Error('Each heading must match one unique body line');
    if (job.draft.images.length && (!job.draft.imagePlanApproved || job.draft.images.some(image => !image.generatedPath || (image.check?.passed === false && !image.check.manualAccepted)))) throw new Error('Generate images and review failed image checks before approval');
    if (job.diagnostics.some(item => item.code === 'source_conflict') && !conflictAcknowledged) throw new Error('Source conflict needs explicit acknowledgement');
    job.approval = { at: new Date().toISOString(), draftRevision: job.draft.revision, conflictAcknowledged };
    job.review = null;
    job.status = 'approved';
  });
}

export function reviewDraft(state, id, decision, note) {
  if (!['rejected', 'improvement_requested'].includes(decision) || !nonempty(note, 2000)) throw new Error('A review reason is required');
  return change(state, id, ['draft', 'approved'], job => {
    if (!hasDraftStandard(job.draft)) throw new Error('Draft standard record is missing; regenerate with Assets Manager standard before review');
    job.review = { decision, note: note.trim(), at: new Date().toISOString(), draftRevision: job.draft.revision };
    job.approval = null;
    job.status = 'draft';
  });
}

export function approveImagePlan(state, id, assetId = null) {
  return change(state, id, ['draft'], job => {
    job.draft.imagePlanApproved = true;
    job.draft.images = job.draft.images.map(image => ({ ...image, assetId }));
  });
}
export function setImageProvider(state, id, provider) {
  if (!['manual', 'codex'].includes(provider)) throw new Error('Unknown image host');
  return change(state, id, ['draft'], job => {
    if (job.draft.images.some(image => image.pendingPath)) throw new Error('Review pending images before changing the image host');
    job.imageProvider = provider;
  });
}
export function setImagePosition(state, id, imageId, afterParagraph) {
  return change(state, id, ['draft'], job => {
    const image = job.draft?.images.find(item => item.id === imageId);
    const paragraphs = job.draft?.body.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim()).length || 0;
    if (!image || !Number.isInteger(afterParagraph) || afterParagraph < 1 || afterParagraph > paragraphs) throw new Error('Choose a paragraph in this draft');
    if (!imagePositionAllowed(job.draft.body, job.draft.headings || [], afterParagraph)) throw new Error('Images cannot go inside the table of contents or a list; choose a paragraph or subheading');
    image.afterParagraph = afterParagraph;
    job.draft.revision = (job.draft.revision || 0) + 1;
  });
}
export function removeImageSuggestion(state, id, imageId) {
  return change(state, id, ['draft'], job => {
    const image = job.draft?.images.find(item => item.id === imageId);
    if (!image || image.pendingPath || image.generatedPath) throw new Error('Only an ungenerated image suggestion can be removed');
    job.draft.images = job.draft.images.filter(item => item.id !== imageId);
    job.draft.revision = (job.draft.revision || 0) + 1;
  });
}
export function attachGeneratedImage(state, id, imageId, generatedPath, check = null) {
  return change(state, id, ['draft'], job => {
    if (!job.draft.imagePlanApproved) throw new Error('Image plan needs approval');
    const image = job.draft.images.find(item => item.id === imageId);
    if (!image || !nonempty(generatedPath, 2048)) throw new Error('Unknown image or path');
    image.generatedPath = generatedPath;
    image.check = check;
    delete image.pendingPath;
    delete image.pendingUsage;
    delete image.pendingCheck;
  });
}
export function recordImageCandidate(state, id, imageId, pendingPath, attempts) {
  return change(state, id, ['draft'], job => {
    if (!job.draft?.imagePlanApproved || job.imageProvider !== 'codex') throw new Error('Codex image plan is not approved');
    const image = job.draft.images.find(item => item.id === imageId);
    if (!image || image.generatedPath || image.pendingPath || !nonempty(pendingPath, 2048) || !Array.isArray(attempts) || !attempts.length) throw new Error('Image is not ready for generation');
    image.pendingPath = pendingPath;
    image.pendingUsage = attempts.at(-1).usage;
    image.pendingCheck = attempts.at(-1).check;
    image.generationAttempts = (image.generationAttempts || 0) + attempts.length;
    image.generationHistory = [...(image.generationHistory || []), ...attempts.map(attempt => ({ at: new Date().toISOString(), ...attempt }))];
  });
}
export function recordReplacementCandidate(state, id, imageId, previousPath, pendingPath, attempts) {
  return change(state, id, ['draft'], job => {
    if (!job.draft?.imagePlanApproved || job.imageProvider !== 'codex') throw new Error('Codex image plan is not approved');
    const image = job.draft.images.find(item => item.id === imageId);
    if (!image || (image.pendingPath || image.generatedPath) !== previousPath || !nonempty(pendingPath, 2048) || pendingPath === previousPath || !Array.isArray(attempts) || !attempts.length) throw new Error('Image changed; preview it again');
    if (image.pendingPath && !image.generatedPath && !image.previousPendingPath) {
      image.previousPendingPath = image.pendingPath;
      image.previousPendingUsage = image.pendingUsage;
      image.previousPendingCheck = image.pendingCheck;
    }
    image.pendingPath = pendingPath;
    image.pendingUsage = attempts.at(-1).usage;
    image.pendingCheck = attempts.at(-1).check;
    image.generationAttempts = (image.generationAttempts || 0) + attempts.length;
    image.generationHistory = [...(image.generationHistory || []), ...attempts.map(attempt => ({ at: new Date().toISOString(), ...attempt }))];
  });
}
export function confirmImageCandidate(state, id, imageId, expectedPendingPath) {
  return change(state, id, ['draft'], job => {
    const image = job.draft?.images.find(item => item.id === imageId);
    if (!image?.pendingPath || image.pendingPath !== expectedPendingPath) throw new Error('Image candidate changed; preview it again');
    connectImageCandidate(image, '사용자가 이미지를 확인함');
  });
}
function connectImageCandidate(image, reason = '사용자의 최종 발행 선택으로 확인') {
  image.generatedPath = image.pendingPath;
  image.generationUsage = image.pendingUsage;
  image.check = image.pendingCheck ? { ...image.pendingCheck, attempts: image.generationAttempts || 1 } : { passed: true, reason, attempts: image.generationAttempts || 1 };
  delete image.pendingPath;
  delete image.pendingUsage;
  delete image.pendingCheck;
  delete image.previousPendingPath;
  delete image.previousPendingUsage;
  delete image.previousPendingCheck;
}
export function discardImageCandidate(state, id, imageId, expectedPendingPath) {
  return change(state, id, ['draft'], job => {
    const image = job.draft?.images.find(item => item.id === imageId);
    if (!image?.pendingPath || image.pendingPath !== expectedPendingPath) throw new Error('Image candidate changed; reload it before discarding');
    if (image.previousPendingPath) {
      image.pendingPath = image.previousPendingPath;
      image.pendingUsage = image.previousPendingUsage;
      image.pendingCheck = image.previousPendingCheck;
      delete image.previousPendingPath;
      delete image.previousPendingUsage;
      delete image.previousPendingCheck;
    } else {
      delete image.pendingPath;
      delete image.pendingUsage;
      delete image.pendingCheck;
    }
  });
}
export function acceptImageCheck(state, id, imageId) {
  return change(state, id, ['draft'], job => {
    const image = job.draft?.images.find(item => item.id === imageId);
    if (!image?.generatedPath || image.check?.passed !== false) throw new Error('No failed image check to review');
    image.check.manualAccepted = true;
  });
}

export function scheduleJob(state, id, at, now = new Date()) {
  return change(state, id, ['approved'], job => {
    if (!hasDraftStandard(job.draft)) throw new Error('Draft standard record is missing; regenerate before scheduling');
    if (!iso(at) || Date.parse(at) <= now.getTime() + 10 * 60_000) throw new Error('Schedule must be at least ten minutes in the future');
    if (Date.parse(at) % (10 * 60_000) !== 0) throw new Error('Schedule must use ten-minute increments');
    job.schedule = { at: new Date(at).toISOString(), expiresAt: new Date(Math.min(Date.parse(at), now.getTime() + 7 * DAY)).toISOString() };
    job.registration = null;
    job.status = 'awaiting_registration';
  });
}

// One final action accepts visible image candidates, approves the draft, and starts reservation preparation.
// Social channels (X, LinkedIn, Instagram, Reddit) have no reservation: the composer is filled now and the user posts.
export function publishDraftReservation(state, id, at, { conflictAcknowledged = false, standardUnverifiedAcknowledged = false, channel = null } = {}, now = new Date()) {
  const social = isSocialChannel(channel);
  if (social) at = new Date(Math.ceil(now.getTime() / 60_000) * 60_000).toISOString();
  return change(state, id, ['draft'], job => {
    if (!social && (!iso(at) || Date.parse(at) <= now.getTime() + 10 * 60_000)) throw new Error('Schedule must be at least ten minutes in the future');
    if (!social && Date.parse(at) % (10 * 60_000) !== 0) throw new Error('Schedule must use ten-minute increments');
    if (!job.draft) throw new Error('Missing draft');
    const problems = social ? socialDraftProblems(channel, job.draft) : [];
    if (problems.length) throw new Error(problems.join('; '));
    const standardUnverified = !hasDraftStandard(job.draft);
    if (standardUnverified && !standardUnverifiedAcknowledged) throw new Error('Unverified draft standard requires explicit publication confirmation');
    const paragraphs = job.draft.body.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim());
    const imageIds = new Set();
    // Drafts saved before positions were settled: move images out of the table of contents and lists before approval.
    for (const image of job.draft.images) image.afterParagraph = settleImagePosition(job.draft.body, job.draft.headings || [], image.afterParagraph);
    for (const image of job.draft.images) {
      if (!nonempty(image.id, 80) || imageIds.has(image.id) || !Number.isInteger(image.afterParagraph) || image.afterParagraph < 1 || image.afterParagraph > paragraphs.length || !nonempty(image.description, 2000)) throw new Error('Image suggestions need unique IDs and existing paragraph positions');
      if (!fs.existsSync(image.pendingPath || image.generatedPath || '')) throw new Error('Image file is missing; make the image again before publishing');
      if (image.pendingPath) connectImageCandidate(image);
      if (!image.generatedPath) throw new Error('Generate every selected image before publishing');
      if (image.check?.passed === false) image.check.manualAccepted = true;
      imageIds.add(image.id);
    }
    if (job.draft.images.length) job.draft.imagePlanApproved = true;
    if (unmatchedHeadings(job.draft.body, job.draft.headings).length) throw new Error('Each heading must match one unique body line');
    if (job.diagnostics.some(item => item.code === 'source_conflict') && !conflictAcknowledged) throw new Error('Source conflict needs explicit acknowledgement');
    job.approval = { at: now.toISOString(), draftRevision: job.draft.revision, conflictAcknowledged, ...(standardUnverified ? { standardUnverifiedAcknowledged: true } : {}) };
    job.review = null;
    job.schedule = { at: new Date(at).toISOString(), expiresAt: new Date(social ? now.getTime() + 7 * DAY : Math.min(Date.parse(at), now.getTime() + 7 * DAY)).toISOString(), ...(social ? { manualPost: true } : {}) };
    job.registration = null;
    job.status = 'awaiting_registration';
  });
}

export function rescheduleExpired(state, id, at, { factsAndLinksReviewed = false } = {}, now = new Date()) {
  return change(state, id, ['expired'], job => {
    if (!factsAndLinksReviewed) throw new Error('Facts and links need a new review');
    if (!iso(at) || Date.parse(at) <= now.getTime() + 10 * 60_000) throw new Error('Schedule must be at least ten minutes in the future');
    job.approval = { at: now.toISOString(), draftRevision: job.draft.revision, factsAndLinksReviewed: true, conflictAcknowledged: job.approval.conflictAcknowledged, ...(job.approval.standardUnverifiedAcknowledged ? { standardUnverifiedAcknowledged: true } : {}) };
    job.schedule = { at: new Date(at).toISOString(), expiresAt: new Date(Math.min(Date.parse(at), now.getTime() + 7 * DAY)).toISOString() };
    job.registration = null;
    job.status = 'awaiting_registration';
  });
}

export function refreshDue(state, now = new Date()) {
  const next = structuredClone(validateState(state));
  let changed = false;
  for (const job of next.jobs) {
    if (!['scheduled','due','awaiting_registration','registered','verification_due'].includes(job.status)) continue;
    let updated = false;
    if (['scheduled','due'].includes(job.status)) { job.status = 'expired'; updated = true; }
    else if (['registered','verification_due'].includes(job.status) && now.getTime() >= Date.parse(job.schedule.at)) {
      // A verified platform reservation whose time has passed counts as published unless the user said it was not.
      const previous = job.status;
      if (job.registration?.verified && !job.implicitPublicationDeclined) applyImplicitPublication(job, now);
      else job.status = 'verification_due';
      updated = job.status !== previous;
    }
    else if (job.status === 'awaiting_registration' && now.getTime() >= Date.parse(job.schedule.expiresAt)) { job.status = 'expired'; updated = true; }
    if (updated) { job.updatedAt = now.toISOString(); changed = true; }
  }
  if (changed) next.revision++;
  return validateState(next);
}

export function startPreparation(state, id, now = new Date()) { return change(state, id, ['awaiting_registration','due'], job => { if (now.getTime() >= Date.parse(job.schedule.expiresAt)) throw new Error('Reservation registration deadline passed'); job.status = 'preparing'; }); }
export function reviewPreparation(state, id, { editorUrl, visibleAccount, title, body, uploadedImages = [], accountVerified = true, postedBy = null }) {
  return change(state, id, ['preparing'], job => {
    if (!nonempty(editorUrl, 2048) || !nonempty(visibleAccount, 200) || !nonempty(title, 300) || !nonempty(body)) throw new Error('Editor state incomplete');
    if (visibleAccount !== job.accountHandle) throw new Error('Account mismatch');
    const expected = job.draft.images.map(image => image.id);
    if (expected.some(imageId => !uploadedImages.includes(imageId))) throw new Error('Image upload or position unverified');
    // Social composers: the user posts, and some sites do not show which account is signed in (accountVerified false).
    job.editor = { editorUrl, visibleAccount, title, body, uploadedImages, checkedAt: new Date().toISOString(), ...(accountVerified === false ? { accountVerified: false } : {}), ...(postedBy === 'user' ? { postedBy } : {}) };
    delete job.automationError;
    job.status = title.trim() === job.draft.title.trim() && body.trim() === job.draft.body.trim() ? 'ready_to_register' : 'review_required';
  });
}
export function approveEditorChanges(state, id, { factsAndLinksReviewed = false } = {}) {
  return change(state, id, ['review_required'], job => {
    if (!factsAndLinksReviewed) throw new Error('Changed editor content needs a new facts and links review');
    job.draft = { ...job.draft, title: job.editor.title, body: job.editor.body, revision: job.draft.revision + 1 };
    job.approval = { ...job.approval, at: new Date().toISOString(), draftRevision: job.draft.revision, factsAndLinksReviewed: true };
    job.status = 'ready_to_register';
  });
}
export function beginScheduleSubmission(state, id, now = new Date()) {
  return change(state, id, ['ready_to_register'], job => {
    if (now.getTime() >= Date.parse(job.schedule.at) || job.approval.draftRevision !== job.draft.revision) throw new Error('Approved reservation is stale');
    job.submission = { startedAt: new Date().toISOString(), outcome: 'unknown' };
    job.status = 'submitting';
  });
}
export function markScheduleUnknown(state, id, reason) {
  return change(state, id, ['submitting'], job => {
    job.submission = { ...job.submission, outcome: 'unknown', reason: String(reason).slice(0, 500) };
    job.status = 'unknown';
  });
}
function applyVerifiedRegistration(job, { accountHandle, publishAt, evidence, remoteId = null, reservationUrl = null, verified = false }, extra = {}) {
  if (!verified || accountHandle !== job.accountHandle || !iso(publishAt) || new Date(publishAt).toISOString() !== job.schedule?.at || !nonempty(evidence, 1000) || (!nonempty(remoteId, 200) && !nonempty(reservationUrl, 2048))) throw new Error('Platform reservation account, time, and receipt must be verified');
  job.registration = { accountHandle, publishAt: job.schedule.at, evidence, remoteId, reservationUrl, verified: true, registeredAt: new Date().toISOString(), ...extra };
  delete job.implicitPublicationDeclined;
  delete job.automationError;
  job.submission = { ...job.submission, outcome: 'registered' };
  job.status = 'registered';
}
export function confirmPlatformSchedule(state, id, receipt) {
  return change(state, id, ['submitting'], job => applyVerifiedRegistration(job, receipt));
}
// An uncertain submission is never retried; it can only be confirmed by re-reading the platform's reservation list.
export function confirmUnknownSchedule(state, id, receipt) {
  return change(state, id, ['unknown'], job => applyVerifiedRegistration(job, receipt, { recheckedAfterUnknown: true }));
}
function applyImplicitPublication(job, now) {
  job.publication = { postUrl: null, finalTitle: job.editor?.title || job.draft.title, finalBody: job.editor?.body || job.draft.body, source: 'implicit', finalTextSource: 'approved', at: now.toISOString(), previousStatus: job.status };
  job.status = 'published';
}
// Undo an implicit publication when the post did not actually go out; it stays in verification_due until the user acts.
export function declineImplicitPublication(state, id) {
  return change(state, id, ['published'], job => {
    if (job.publication?.source !== 'implicit') throw new Error('Only an implicit publication can be marked as not published');
    job.publication = null;
    job.implicitPublicationDeclined = true;
    job.status = 'verification_due';
  });
}
// Record a failed browser automation step so the reason survives after the on-screen message disappears.
export function recordAutomationError(state, id, { step, stage = null, message }, now = new Date()) {
  validateState(state);
  const next = structuredClone(state);
  const job = next.jobs.find(item => item.id === id);
  if (!job) throw new Error('Unknown job');
  job.automationError = { step: String(step).slice(0, 80), stage: stage ? String(stage).slice(0, 80) : null, message: String(message || 'Unknown error').slice(0, 500), status: job.status, at: now.toISOString() };
  job.updatedAt = now.toISOString();
  next.revision++;
  return validateState(next);
}
export function recordPublication(state, id, { postUrl, finalTitle, finalBody, source = 'user', finalTextSource = 'user', changedClaimsReviewed = false }, now = new Date()) {
  return change(state, id, ['verification_due','registered','unknown','cancelled','published'], job => {
    if (job.status === 'published' && job.publication?.source !== 'implicit') throw new Error('Cannot change published job');
    if (!job.draft) throw new Error('A draft is required to record publication');
    if (job.status !== 'cancelled' && job.schedule && now.getTime() < Date.parse(job.schedule.at)) throw new Error('Scheduled publication time has not passed');
    if (!nonempty(postUrl, 2048) || !/^https:\/\//i.test(postUrl)) throw new Error('Verified post URL required');
    if (finalBody && finalBody !== (job.editor?.body || job.draft.body) && !changedClaimsReviewed) throw new Error('Changed editor claims need review');
    if (postUrl === job.editor?.editorUrl) throw new Error('Editor URL is not a published post URL');
    job.publication = { postUrl, finalTitle: finalTitle || job.editor?.title || job.draft.title, finalBody: finalBody || job.editor?.body || job.draft.body, source: job.status === 'cancelled' ? 'manual' : source, finalTextSource, at: new Date().toISOString() };
    job.status = 'published';
  });
}
const manuallyPublishable = ['draft','approved','awaiting_registration','preparing','review_required','ready_to_register','cancelled','expired','failed'];
export function markManualPublication(state, id, now = new Date()) {
  return change(state, id, manuallyPublishable, job => {
    if (!job.draft) throw new Error('A draft is required to mark manual publication');
    if (job.submission?.startedAt || job.registration) throw new Error('Check the platform reservation before marking manual publication');
    job.publication = { postUrl: null, finalTitle: job.editor?.title || job.draft.title, finalBody: job.editor?.body || job.draft.body, source: 'manual', finalTextSource: 'user', at: now.toISOString(), previousStatus: job.status };
    job.status = 'published';
  });
}
export function unmarkManualPublication(state, id) {
  return change(state, id, ['published'], job => {
    if (job.publication?.source !== 'manual') throw new Error('Only manual publication can be unchecked');
    job.status = job.publication.previousStatus || 'cancelled';
    job.publication = null;
  });
}
export function cancelJob(state, id) { return change(state, id, ['selected','draft','approved','scheduled','due','awaiting_registration','preparing','review_required','ready_to_register','expired'], job => { job.status = 'cancelled'; }); }
export function retryPublication(state, id) {
  return change(state, id, ['cancelled','failed'], job => {
    if (!job.draft) throw new Error('A draft is required to retry publication');
    if (job.submission?.startedAt || job.registration) throw new Error('Check the platform before retrying a submitted reservation');
    job.approval = null;
    job.schedule = null;
    job.editor = null;
    job.submission = null;
    job.registration = null;
    job.review = null;
    job.status = 'draft';
  });
}

// Republish keeps the approved draft and images and starts reservation registration again at a new time.
// A job that may already be on the platform (submission started or reservation verified) needs the user's check first.
export const republishable = ['awaiting_registration','preparing','review_required','ready_to_register','expired','cancelled','failed','unknown','registered','verification_due'];
export const republishNeedsPlatformCheck = job => Boolean(job.submission?.startedAt || job.registration);
export function republishJob(state, id, at, { platformChecked = false, channel = null } = {}, now = new Date()) {
  // Social channels: fill the composer again now; there is no reservation time.
  const social = isSocialChannel(channel);
  if (social) at = new Date(Math.ceil(now.getTime() / 60_000) * 60_000 + 11 * 60_000).toISOString();
  return change(state, id, republishable, job => {
    if (!job.draft || !job.approval?.at) throw new Error('Only an approved draft can be republished; retry from the draft instead');
    if (job.approval.draftRevision !== job.draft.revision) throw new Error('The approved draft changed; review it again before publishing');
    if (republishNeedsPlatformCheck(job) && !platformChecked) throw new Error('Check the platform reservation list and published posts before republishing');
    if (!iso(at) || Date.parse(at) <= now.getTime() + 10 * 60_000) throw new Error('Schedule must be at least ten minutes in the future');
    for (const image of job.draft.images) if (!image.generatedPath || !fs.existsSync(image.generatedPath)) throw new Error('Image file is missing; retry from the draft and make the image again');
    job.republishHistory = [...(job.republishHistory || []), { at: now.toISOString(), previousStatus: job.status, previousScheduleAt: job.schedule?.at || null, reason: job.submission?.reason ? String(job.submission.reason).slice(0, 500) : null, platformChecked: republishNeedsPlatformCheck(job) }].slice(-10);
    job.schedule = social ? { at: now.toISOString(), expiresAt: new Date(now.getTime() + 7 * DAY).toISOString(), manualPost: true } : { at: new Date(at).toISOString(), expiresAt: new Date(Math.min(Date.parse(at), now.getTime() + 7 * DAY)).toISOString() };
    job.editor = null;
    job.submission = null;
    job.registration = null;
    delete job.implicitPublicationDeclined;
    job.status = 'awaiting_registration';
  });
}

export function pruneOldSources(state, months = 3, now = new Date()) {
  if (!Number.isInteger(months) || months < 1 || months > 3) throw new Error('Retention must be 1–3 months');
  const next = structuredClone(validateState(state));
  next.retentionTrash ||= [];
  const cutoff = new Date(now); cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const purgeAt = new Date(now.getTime() + 14 * DAY).toISOString();
  const beforeTrash = next.retentionTrash.length;
  next.retentionTrash = next.retentionTrash.filter(entry => Date.parse(entry.purgeAt) > now.getTime());
  let changed = next.retentionTrash.length !== beforeTrash;
  for (const job of next.jobs) {
    if (Date.parse(job.createdAt) >= cutoff.getTime() || Date.parse(job.retentionRestoredUntil || '') > now.getTime()) continue;
    const sources = job.sources.filter(source => !source.expired).map(source => ({ id: source.id, text: source.text }));
    if (!sources.length && !job.plan && !job.diagnostics.length) continue;
    next.retentionTrash.push({ schemaVersion: 'retention-trash/v1', id: crypto.randomUUID(), revision: 1, jobId: job.id, sources, plan: job.plan, diagnostics: job.diagnostics, createdAt: now.toISOString(), updatedAt: now.toISOString(), removedAt: now.toISOString(), purgeAt });
    for (const source of job.sources) if (!source.expired) { source.text = null; source.expired = true; }
    job.plan = null;
    job.diagnostics = [];
    changed = true;
  }
  if (changed) next.revision++;
  return validateState(next);
}

// Archive (창고): source campaigns whose original was written more than 14 days ago leave the main list.
// The written time is the date at the start of a vault post's file name (2026-11-25-daily-…, Korean time),
// otherwise when the job was registered. Archiving keeps everything; it only hides the campaign from the list.
export const ARCHIVE_AFTER_DAYS = 14;
// A campaign with a reservation still being prepared, registered or checked stays visible.
const ARCHIVE_BLOCKING_STATUSES = ['approved','scheduled','due','awaiting_registration','preparing','review_required','ready_to_register','submitting','registered','verification_due','unknown'];
const campaignKey = job => job.campaignId || job.id;

export function sourceWrittenAt(job) {
  for (const source of job.sources || []) {
    const match = String(source.ref || '').replaceAll('\\', '/').split('/').pop().match(/^(\d{4})-(\d{2})-(\d{2})(?!\d)/);
    if (!match) continue;
    const at = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00+09:00`);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  return job.createdAt;
}

export function archiveStaleCampaigns(state, now = new Date()) {
  const next = structuredClone(validateState(state));
  const groups = new Map();
  for (const job of next.jobs) { const key = campaignKey(job); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(job); }
  const cutoff = now.getTime() - ARCHIVE_AFTER_DAYS * DAY;
  let changed = false;
  for (const group of groups.values()) {
    if (group.some(job => job.archivedAt || job.archiveReleasedAt || ARCHIVE_BLOCKING_STATUSES.includes(job.status))) continue;
    if (Math.max(...group.map(job => Date.parse(sourceWrittenAt(job)))) >= cutoff) continue;
    for (const job of group) job.archivedAt = now.toISOString();
    changed = true;
  }
  if (changed) next.revision++;
  return validateState(next);
}

// Manual move in or out of the archive. Taking a campaign out keeps it out: automatic archiving skips it.
export function setCampaignArchived(state, id, archived, now = new Date()) {
  const next = structuredClone(validateState(state));
  const target = next.jobs.find(job => job.id === id || job.campaignId === id);
  if (!target) throw new Error('Unknown job');
  for (const job of next.jobs.filter(item => campaignKey(item) === campaignKey(target))) {
    if (archived) { job.archivedAt = now.toISOString(); delete job.archiveReleasedAt; }
    else { job.archivedAt = null; job.archiveReleasedAt = now.toISOString(); }
    job.updatedAt = now.toISOString();
  }
  next.revision++;
  return validateState(next);
}

export function restoreRetainedSources(state, id, now = new Date()) {
  const next = structuredClone(validateState(state));
  const index = (next.retentionTrash || []).findIndex(entry => entry.jobId === id && Date.parse(entry.purgeAt) > now.getTime());
  if (index < 0) throw new Error('No restorable source copy');
  const job = next.jobs.find(item => item.id === id);
  if (!job) throw new Error('Unknown job');
  const [entry] = next.retentionTrash.splice(index, 1);
  for (const copy of entry.sources) {
    const source = job.sources.find(item => item.id === copy.id);
    if (source?.expired) { source.text = copy.text; source.expired = false; }
  }
  if (!job.plan) job.plan = entry.plan;
  if (!job.diagnostics.length) job.diagnostics = entry.diagnostics;
  job.retentionRestoredUntil = new Date(now.getTime() + 14 * DAY).toISOString();
  next.revision++;
  return validateState(next);
}
