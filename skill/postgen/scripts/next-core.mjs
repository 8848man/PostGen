import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './profile.mjs';

const VERSION = 'postgen-next/v1';
const DAY = 86_400_000;
export const nextPath = () => path.join(process.env.POSTGEN_NEXT_DIR || path.join(dataDir(), 'next'), 'jobs.json');
export const emptyState = () => ({ schemaVersion: VERSION, revision: 0, jobs: [] });
const nonempty = (value, max = 100_000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function validateState(state) {
  if (state?.schemaVersion !== VERSION || !Number.isInteger(state.revision) || state.revision < 0 || !Array.isArray(state.jobs)) throw new Error('Invalid next state');
  const ids = new Set();
  for (const job of state.jobs) {
    if (!nonempty(job.id, 80) || ids.has(job.id) || !nonempty(job.accountId, 80) || !nonempty(job.audience, 500) || !Array.isArray(job.sources) || !job.sources.length || !['selected','draft','approved','scheduled','due','awaiting_registration','preparing','review_required','ready_to_register','submitting','registered','verification_due','published','expired','cancelled','failed','unknown'].includes(job.status)) throw new Error('Invalid job');
    if (job.sources.some(source => !nonempty(source.id, 80) || !nonempty(source.type, 40) || !nonempty(source.ref, 2048) || !(source.expired === true ? source.text === null : nonempty(source.text, 120_000)))) throw new Error('Invalid source snapshot');
    if (job.draft && (!nonempty(job.draft.title, 300) || !nonempty(job.draft.body) || !Array.isArray(job.draft.claims) || !Array.isArray(job.draft.images))) throw new Error('Invalid draft');
    if (['approved','scheduled','due','awaiting_registration','preparing','review_required','ready_to_register','submitting','registered','verification_due','published','expired'].includes(job.status) && (!job.approval?.at || !job.draft)) throw new Error('Approved job needs a draft');
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

export function saveState(next, expectedRevision, file = nextPath()) {
  validateState(next);
  const current = loadState(file);
  if (current.revision !== expectedRevision || next.revision !== expectedRevision + 1) throw new Error('State changed; reload and retry');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.jobs-${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return next;
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

export function createJob(state, { accountId, accountHandle = accountId, audience, goal, sources, model = 'codex' }) {
  if (!nonempty(accountId, 80) || !nonempty(audience, 500) || !nonempty(goal, 500) || !Array.isArray(sources) || !sources.length) throw new Error('Account, audience, goal, and selected sources are required');
  const next = structuredClone(validateState(state));
  const now = new Date().toISOString();
  next.jobs.push({ id: crypto.randomUUID(), campaignId: crypto.randomUUID(), accountId, accountHandle, audience, goal, model, sources, plan: null, status: 'selected', draft: null, approval: null, schedule: null, diagnostics: [], createdAt: now, updatedAt: now });
  next.revision++;
  return validateState(next);
}

export function createCampaign(state, { accounts, audience, sources, model = 'codex' }) {
  if (!Array.isArray(accounts) || !accounts.length || !Array.isArray(sources) || !sources.length || !nonempty(audience, 500)) throw new Error('Select accounts, audience, and sources');
  const next = structuredClone(validateState(state)), now = new Date().toISOString(), campaignId = crypto.randomUUID();
  const uniqueAccounts = new Set();
  for (const account of accounts) {
    if (!nonempty(account.id, 80) || !nonempty(account.handle, 200) || !nonempty(account.goal, 500) || uniqueAccounts.has(account.id)) throw new Error('Invalid campaign account');
    uniqueAccounts.add(account.id);
    next.jobs.push({ id: crypto.randomUUID(), campaignId, accountId: account.id, accountHandle: account.handle, audience, goal: account.goal, model, sources: structuredClone(sources), plan: null, status: 'selected', draft: null, approval: null, schedule: null, diagnostics: [], createdAt: now, updatedAt: now });
  }
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

export function setDraft(state, id, draft, diagnostics = []) {
  return change(state, id, ['selected','draft'], job => {
    job.draft = { title: draft.title, body: draft.body, claims: draft.claims || [], images: draft.images || [], imagePlanApproved: draft.imagePlanApproved || false, evaluation: draft.evaluation || null, revision: (job.draft?.revision || 0) + 1 };
    job.diagnostics = diagnostics;
    job.approval = null;
    job.status = 'draft';
  });
}

export function approveDraft(state, id, { conflictAcknowledged = false } = {}) {
  return change(state, id, ['draft'], job => {
    if (!job.draft) throw new Error('Missing draft');
    const imageIds = new Set();
    for (const image of job.draft.images) { if (!nonempty(image.id, 80) || imageIds.has(image.id) || !Number.isInteger(image.afterParagraph) || image.afterParagraph < 1 || !nonempty(image.description, 2000)) throw new Error('Image suggestions need unique IDs and paragraph positions'); imageIds.add(image.id); }
    if (job.draft.images.length && (!job.draft.imagePlanApproved || job.draft.images.some(image => !image.generatedPath || (image.check?.passed === false && !image.check.manualAccepted)))) throw new Error('Generate images and review failed image checks before approval');
    if (job.diagnostics.some(item => item.code === 'source_conflict') && !conflictAcknowledged) throw new Error('Source conflict needs explicit acknowledgement');
    job.approval = { at: new Date().toISOString(), draftRevision: job.draft.revision, conflictAcknowledged };
    job.status = 'approved';
  });
}

export function approveImagePlan(state, id, assetId = null) {
  return change(state, id, ['draft'], job => {
    job.draft.imagePlanApproved = true;
    job.draft.images = job.draft.images.map(image => ({ ...image, assetId }));
  });
}
export function attachGeneratedImage(state, id, imageId, generatedPath, check = null) {
  return change(state, id, ['draft'], job => {
    if (!job.draft.imagePlanApproved) throw new Error('Image plan needs approval');
    const image = job.draft.images.find(item => item.id === imageId);
    if (!image || !nonempty(generatedPath, 2048)) throw new Error('Unknown image or path');
    image.generatedPath = generatedPath;
    image.check = check;
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
    if (!iso(at) || Date.parse(at) <= now.getTime() + 10 * 60_000) throw new Error('Schedule must be at least ten minutes in the future');
    job.schedule = { at: new Date(at).toISOString(), expiresAt: new Date(Math.min(Date.parse(at), now.getTime() + 7 * DAY)).toISOString() };
    job.registration = null;
    job.status = 'awaiting_registration';
  });
}

export function rescheduleExpired(state, id, at, { factsAndLinksReviewed = false } = {}, now = new Date()) {
  return change(state, id, ['expired'], job => {
    if (!factsAndLinksReviewed) throw new Error('Facts and links need a new review');
    if (!iso(at) || Date.parse(at) <= now.getTime() + 10 * 60_000) throw new Error('Schedule must be at least ten minutes in the future');
    job.approval = { at: now.toISOString(), draftRevision: job.draft.revision, factsAndLinksReviewed: true, conflictAcknowledged: job.approval.conflictAcknowledged };
    job.schedule = { at: new Date(at).toISOString(), expiresAt: new Date(Math.min(Date.parse(at), now.getTime() + 7 * DAY)).toISOString() };
    job.registration = null;
    job.status = 'awaiting_registration';
  });
}

export function refreshDue(state, now = new Date()) {
  const next = structuredClone(validateState(state));
  let changed = false;
  for (const job of next.jobs) {
    if (!['scheduled','due','awaiting_registration','registered'].includes(job.status)) continue;
    let updated = false;
    if (['scheduled','due'].includes(job.status)) { job.status = 'expired'; updated = true; }
    else if (job.status === 'registered' && now.getTime() >= Date.parse(job.schedule.at)) { job.status = 'verification_due'; updated = true; }
    else if (job.status === 'awaiting_registration' && now.getTime() >= Date.parse(job.schedule.expiresAt)) { job.status = 'expired'; updated = true; }
    if (updated) { job.updatedAt = now.toISOString(); changed = true; }
  }
  if (changed) next.revision++;
  return validateState(next);
}

export function startPreparation(state, id, now = new Date()) { return change(state, id, ['awaiting_registration','due'], job => { if (now.getTime() >= Date.parse(job.schedule.expiresAt)) throw new Error('Reservation registration deadline passed'); job.status = 'preparing'; }); }
export function reviewPreparation(state, id, { editorUrl, visibleAccount, title, body, uploadedImages = [] }) {
  return change(state, id, ['preparing'], job => {
    if (!nonempty(editorUrl, 2048) || !nonempty(visibleAccount, 200) || !nonempty(title, 300) || !nonempty(body)) throw new Error('Editor state incomplete');
    if (visibleAccount !== job.accountHandle) throw new Error('Account mismatch');
    const expected = job.draft.images.map(image => image.id);
    if (expected.some(imageId => !uploadedImages.includes(imageId))) throw new Error('Image upload or position unverified');
    job.editor = { editorUrl, visibleAccount, title, body, uploadedImages, checkedAt: new Date().toISOString() };
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
export function confirmPlatformSchedule(state, id, { accountHandle, publishAt, evidence, remoteId = null, reservationUrl = null, verified = false }) {
  return change(state, id, ['submitting'], job => {
    if (!verified || accountHandle !== job.accountHandle || !iso(publishAt) || new Date(publishAt).toISOString() !== job.schedule.at || !nonempty(evidence, 1000) || (!nonempty(remoteId, 200) && !nonempty(reservationUrl, 2048))) throw new Error('Platform reservation account, time, and receipt must be verified');
    job.registration = { accountHandle, publishAt: job.schedule.at, evidence, remoteId, reservationUrl, verified: true, registeredAt: new Date().toISOString() };
    job.submission = { ...job.submission, outcome: 'registered' };
    job.status = 'registered';
  });
}
export function recordPublication(state, id, { postUrl, finalTitle, finalBody, source = 'user', finalTextSource = 'user', changedClaimsReviewed = false }, now = new Date()) {
  return change(state, id, ['verification_due','registered','unknown'], job => {
    if (job.schedule && now.getTime() < Date.parse(job.schedule.at)) throw new Error('Scheduled publication time has not passed');
    if (!nonempty(postUrl, 2048) || !/^https:\/\//i.test(postUrl)) throw new Error('Verified post URL required');
    if (finalBody && finalBody !== job.editor?.body && !changedClaimsReviewed) throw new Error('Changed editor claims need review');
    if (postUrl === job.editor?.editorUrl) throw new Error('Editor URL is not a published post URL');
    job.publication = { postUrl, finalTitle: finalTitle || job.editor?.title || job.draft.title, finalBody: finalBody || job.editor?.body || job.draft.body, source, finalTextSource, at: new Date().toISOString() };
    job.status = 'published';
  });
}
export function cancelJob(state, id) { return change(state, id, ['selected','draft','approved','scheduled','due','preparing','review_required','expired'], job => { job.status = 'cancelled'; }); }

export function pruneOldSources(state, months = 3, now = new Date()) {
  if (!Number.isInteger(months) || months < 1 || months > 3) throw new Error('Retention must be 1–3 months');
  const next = structuredClone(validateState(state));
  const cutoff = new Date(now); cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  let changed = false;
  for (const job of next.jobs) {
    if (!['published','cancelled'].includes(job.status) || Date.parse(job.createdAt) >= cutoff.getTime()) continue;
    for (const source of job.sources) if (!source.expired) { source.text = null; source.expired = true; changed = true; }
    if (job.diagnostics.length) { job.diagnostics = []; changed = true; }
  }
  if (changed) next.revision++;
  return validateState(next);
}

