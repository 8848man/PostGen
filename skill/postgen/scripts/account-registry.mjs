import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './profile.mjs';

const CHANNELS = new Set(['naver', 'tistory', 'x', 'threads']);
const SOURCE_TYPES = new Set(['text', 'file', 'url', 'screenshot']);
const RIGHTS = new Set(['owned', 'licensed', 'public_style']);
const PRIORITIES = new Set(['required', 'preferred']);

export function registryPath() { return path.join(dataDir(), 'account-registry.json'); }
export function emptyRegistry() { return { schemaVersion: 'account-registry/v1', revision: 0, updatedAt: null, accounts: [], samples: [], assets: [] }; }

function nonempty(value, max = 500) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function validId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value); }

export function validateRegistry(registry) {
  if (!registry || registry.schemaVersion !== 'account-registry/v1' || !Number.isInteger(registry.revision) || registry.revision < 0 || !Array.isArray(registry.accounts) || !Array.isArray(registry.samples) || (registry.assets !== undefined && !Array.isArray(registry.assets))) throw new Error('Invalid account registry');
  const accountIds = new Set();
  for (const account of registry.accounts) {
    if (account.schemaVersion !== 'account-profile/v1' || !validId(account.id) || accountIds.has(account.id) || !Number.isInteger(account.revision) || account.revision < 0 || !nonempty(account.createdAt, 40) || !nonempty(account.updatedAt, 40) || !nonempty(account.channel, 100) || !nonempty(account.handle, 200) || !nonempty(account.defaultGoal) || !(account.defaultSampleId === null || validId(account.defaultSampleId))) throw new Error('Invalid account');
    accountIds.add(account.id);
  }
  const assetIds = new Set();
  for (const asset of registry.assets || []) {
    if (asset.schemaVersion !== 'visual-asset/v1' || !validId(asset.id) || assetIds.has(asset.id) || !accountIds.has(asset.accountId) || !['character','object','background'].includes(asset.kind) || !['owned','licensed'].includes(asset.rights) || !nonempty(asset.storedPath, 2048) || !nonempty(asset.features, 1000)) throw new Error('Invalid visual asset');
    assetIds.add(asset.id);
  }
  const sampleIds = new Set();
  for (const sample of registry.samples) {
    if (sample.schemaVersion !== 'golden-sample/v1' || !validId(sample.id) || sampleIds.has(sample.id) || !Number.isInteger(sample.revision) || sample.revision < 0 || !nonempty(sample.createdAt, 40) || !nonempty(sample.updatedAt, 40) || !accountIds.has(sample.accountId) || !SOURCE_TYPES.has(sample.sourceType) || !nonempty(sample.sourceRef, 20_000) || !RIGHTS.has(sample.rights) || !['proposed', 'approved'].includes(sample.status) || !Array.isArray(sample.rules)) throw new Error('Invalid golden sample');
    if (sample.rules.some(rule => !nonempty(rule.key, 100) || !nonempty(rule.value, 1000) || !PRIORITIES.has(rule.priority))) throw new Error('Invalid golden sample rule');
    if (sample.status === 'approved' && sample.rules.length === 0) throw new Error('Approved sample needs rules');
    sampleIds.add(sample.id);
  }
  for (const account of registry.accounts) {
    if (account.defaultSampleId !== null && !registry.samples.some(sample => sample.id === account.defaultSampleId && sample.accountId === account.id && sample.status === 'approved')) throw new Error('Default sample must be approved for its account');
  }
  return registry;
}

export function loadRegistry() {
  const file = registryPath();
  if (!fs.existsSync(file)) return emptyRegistry();
  return validateRegistry(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function saveRegistry(next, expectedRevision) {
  validateRegistry(next);
  const current = loadRegistry();
  if (current.revision !== expectedRevision || next.revision !== expectedRevision + 1) throw new Error('Account registry changed; reload and retry');
  const file = registryPath(), dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.account-registry-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return next;
}

function advance(current, mutate) {
  validateRegistry(current);
  const next = structuredClone(current);
  mutate(next);
  next.revision = current.revision + 1;
  next.updatedAt = new Date().toISOString();
  validateRegistry(next);
  return next;
}

export function addAccount(current, { channel, handle, defaultGoal }) {
  if (!nonempty(channel, 100) || !nonempty(handle, 200) || !nonempty(defaultGoal)) throw new Error('Channel, handle, and goal are required');
  if (!CHANNELS.has(channel) && !channel.startsWith('mcp:')) throw new Error('Unsupported channel');
  if (current.accounts.some(account => account.channel === channel && account.handle === handle)) throw new Error('Account already exists');
  return advance(current, next => { const now = new Date().toISOString(); next.accounts.push({ schemaVersion: 'account-profile/v1', id: crypto.randomUUID(), revision: 0, createdAt: now, updatedAt: now, channel, handle, defaultGoal, defaultSampleId: null }); });
}

export function addSample(current, { accountId, sourceType, sourceRef, rights, rules = [] }) {
  if (!current.accounts.some(account => account.id === accountId)) throw new Error('Unknown account');
  if (!SOURCE_TYPES.has(sourceType) || !nonempty(sourceRef, 20_000) || !RIGHTS.has(rights)) throw new Error('Invalid sample source or rights');
  return advance(current, next => { const now = new Date().toISOString(); next.samples.push({ schemaVersion: 'golden-sample/v1', id: crypto.randomUUID(), revision: 0, createdAt: now, updatedAt: now, accountId, sourceType, sourceRef, rights, status: 'proposed', rules }); });
}

export function approveSample(current, sampleId, rules) {
  if (!Array.isArray(rules) || rules.length === 0) throw new Error('Approved sample needs rules');
  if (!current.samples.some(sample => sample.id === sampleId)) throw new Error('Unknown sample');
  return advance(current, next => {
    const sample = next.samples.find(item => item.id === sampleId);
    sample.rules = rules;
    sample.status = 'approved';
    sample.revision++;
    sample.updatedAt = new Date().toISOString();
  });
}

export function setDefaultSample(current, accountId, sampleId) {
  if (!current.accounts.some(account => account.id === accountId)) throw new Error('Unknown account');
  if (!current.samples.some(sample => sample.id === sampleId && sample.accountId === accountId && sample.status === 'approved')) throw new Error('Sample must be approved for this account');
  return advance(current, next => { const account = next.accounts.find(item => item.id === accountId); account.defaultSampleId = sampleId; account.revision++; account.updatedAt = new Date().toISOString(); });
}

export function resolveAccount(current, channel, handle) {
  validateRegistry(current);
  const account = current.accounts.find(item => item.channel === channel && item.handle === handle);
  if (!account) throw new Error('Unknown account');
  const sample = account.defaultSampleId ? current.samples.find(item => item.id === account.defaultSampleId && item.accountId === account.id && item.status === 'approved') : null;
  return { account, sample: sample || null };
}

export function addAsset(current, { accountId, kind, rights, storedPath, features }) {
  if (!current.accounts.some(account => account.id === accountId)) throw new Error('Unknown account');
  return advance(current, next => {
    if (!next.assets) next.assets = [];
    next.assets.push({ schemaVersion: 'visual-asset/v1', id: crypto.randomUUID(), accountId, kind, rights, storedPath, features, createdAt: new Date().toISOString() });
  });
}
