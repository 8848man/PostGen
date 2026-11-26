#!/usr/bin/env node
import fs from 'node:fs';
import { loadState, saveState, createCampaign, addCampaignAccounts, setCampaignPlan, setDraft, approveDraft, scheduleJob } from './next-core.mjs';
import { loadRegistry } from './account-registry.mjs';

function input() {
  const value = fs.readFileSync(0, 'utf8');
  if (value.length > 1_000_000) throw new Error('Input too large');
  return JSON.parse(value);
}
function update(fn) {
  const current = loadState();
  const next = fn(current);
  saveState(next, current.revision);
  return next;
}
function job(state, id) {
  const found = state.jobs.find(item => item.id === id);
  if (!found) throw new Error('Unknown job');
  return found;
}
// Accounts on channels that are on in the review screen's 채널 설정 (settings.json next to jobs.json).
async function enabledAccounts(accounts) {
  const { loadSettings, channelEnabled } = await import('../../../next/settings.mjs');
  const settings = loadSettings();
  return accounts.filter(account => channelEnabled(settings, account.channel));
}
const vaultSources = sources => Array.isArray(sources) && sources.length > 0 && sources.every(source => typeof source.ref === 'string' && source.ref.startsWith('posts/'));
const campaignJobs = (state, id) => state.jobs.filter(item => item.campaignId === job(state, id).campaignId);
async function run(args) {
  const [command, id] = args;
  if (command === 'list') return loadState().jobs.map(item => ({ id: item.id, campaignId: item.campaignId, accountId: item.accountId, accountHandle: item.accountHandle, status: item.status, title: item.draft?.title || null, revision: item.draft?.revision || 0 }));
  if (command === 'show') return job(loadState(), id);
  if (command === 'create') {
    const spec = input(), registry = loadRegistry();
    if (spec.allRegisteredAccounts && (!vaultSources(spec.sources) || spec.accountIds !== undefined)) throw new Error('All registered accounts require vault post sources and no accountIds');
    const ids = spec.allRegisteredAccounts ? (await enabledAccounts(registry.accounts)).map(account => account.id) : spec.accountIds;
    if (!Array.isArray(ids) || !ids.length) throw new Error('Select account IDs');
    const accounts = ids.map(accountId => registry.accounts.find(item => item.id === accountId));
    if (accounts.some(account => !account)) throw new Error('Unknown account');
    let created = [];
    update(current => {
      const next = createCampaign(current, { accounts: accounts.map(account => ({ id: account.id, handle: account.handle, goal: account.defaultGoal })), audience: spec.audience, sources: spec.sources, model: spec.model || 'codex', imageProvider: spec.imageProvider || 'manual', projectName: spec.projectName || null });
      created = next.jobs.slice(current.jobs.length).map(item => ({ id: item.id, campaignId: item.campaignId, accountId: item.accountId }));
      return next;
    });
    return created;
  }
  if (command === 'complete-accounts') {
    const registry = loadRegistry(), current = loadState(), siblings = campaignJobs(current, id);
    if (!vaultSources(siblings[0].sources)) throw new Error('Only vault post campaigns can add all registered accounts');
    const existing = new Set(siblings.map(item => item.accountId));
    const missing = (await enabledAccounts(registry.accounts)).filter(account => !existing.has(account.id));
    if (!missing.length) return [];
    const next = update(state => addCampaignAccounts(state, siblings[0].campaignId, missing.map(account => ({ id: account.id, handle: account.handle, goal: account.defaultGoal }))));
    return next.jobs.filter(item => item.campaignId === siblings[0].campaignId && !existing.has(item.accountId)).map(item => ({ id: item.id, campaignId: item.campaignId, accountId: item.accountId }));
  }
  if (command === 'coverage') {
    const registry = loadRegistry(), current = loadState(), siblings = campaignJobs(current, id);
    return registry.accounts.map(account => ({ accountId: account.id, channel: account.channel, jobId: siblings.find(item => item.accountId === account.id)?.id || null, status: siblings.find(item => item.accountId === account.id)?.status || 'missing' }));
  }
  if (command === 'plan') { const plan = input(); const current = loadState(); return update(state => setCampaignPlan(state, job(current, id).campaignId, plan)).jobs.filter(item => item.campaignId === job(current, id).campaignId).map(item => item.id); }
  if (command === 'draft') {
    const registry = loadRegistry(), current = loadState(), target = job(current, id);
    const account = registry.accounts.find(item => item.id === target.accountId);
    const draft = input();
    if (!Array.isArray(draft.images) || draft.images.length === 0) {
      process.stderr.write('Warning: draft has no image scene suggestions; review images before approving.\n');
    }
    // A host-written draft did not go through the standard prompt, so a supplied standard record is dropped: the draft
    // stays "standard unverified" until it is regenerated with `generate` (or the user confirms it at publication).
    process.stderr.write(draft.standard ? 'Warning: ignored the supplied standard record; host-written drafts stay standard-unverified. Use `generate <jobId>` for a standard-based draft.\n' : 'Note: host-written draft is standard-unverified. Use `generate <jobId>` for a standard-based draft.\n');
    return job(update(state => setDraft(state, id, { ...draft, standard: null }, [], { channel: account?.channel || null })), id);
  }
  if (command === 'generate') {
    const provider = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : undefined;
    const { generateJobDraft } = await import('../../../next/draft-job.mjs');
    return job((await generateJobDraft(id, { provider })).state, id);
  }
  if (command === 'approve') return job(update(state => approveDraft(state, id, { conflictAcknowledged: args.includes('--conflicts-reviewed') })), id);
  if (command === 'schedule') return job(update(state => scheduleJob(state, id, args[2])), id);
  throw new Error('Usage: next-cli.mjs list|show ID|create < JSON|complete-accounts ID|coverage ID|plan ID < JSON|draft ID < JSON|generate ID [--provider codex|claude]|approve ID [--conflicts-reviewed]|schedule ID ISO_TIME');
}
try { process.stdout.write(JSON.stringify(await run(process.argv.slice(2)), null, 2) + '\n'); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
