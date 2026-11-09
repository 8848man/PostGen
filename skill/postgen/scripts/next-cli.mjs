#!/usr/bin/env node
import fs from 'node:fs';
import { loadState, saveState, createCampaign, setCampaignPlan, setDraft, approveDraft, scheduleJob } from './next-core.mjs';
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
function run(args) {
  const [command, id] = args;
  if (command === 'list') return loadState().jobs.map(item => ({ id: item.id, campaignId: item.campaignId, accountId: item.accountId, accountHandle: item.accountHandle, status: item.status, title: item.draft?.title || null, revision: item.draft?.revision || 0 }));
  if (command === 'show') return job(loadState(), id);
  if (command === 'create') {
    const spec = input(), registry = loadRegistry();
    if (!Array.isArray(spec.accountIds) || !spec.accountIds.length) throw new Error('Select account IDs');
    const accounts = spec.accountIds.map(accountId => registry.accounts.find(item => item.id === accountId));
    if (accounts.some(account => !account)) throw new Error('Unknown account');
    let created = [];
    update(current => {
      const next = createCampaign(current, { accounts: accounts.map(account => ({ id: account.id, handle: account.handle, goal: account.defaultGoal })), audience: spec.audience, sources: spec.sources, model: spec.model || 'codex' });
      created = next.jobs.slice(current.jobs.length).map(item => ({ id: item.id, campaignId: item.campaignId, accountId: item.accountId }));
      return next;
    });
    return created;
  }
  if (command === 'plan') { const plan = input(); const current = loadState(); return update(state => setCampaignPlan(state, job(current, id).campaignId, plan)).jobs.filter(item => item.campaignId === job(current, id).campaignId).map(item => item.id); }
  if (command === 'draft') return job(update(state => setDraft(state, id, input())), id);
  if (command === 'approve') return job(update(state => approveDraft(state, id, { conflictAcknowledged: args.includes('--conflicts-reviewed') })), id);
  if (command === 'schedule') return job(update(state => scheduleJob(state, id, args[2])), id);
  throw new Error('Usage: next-cli.mjs list|show ID|create < JSON|plan ID < JSON|draft ID < JSON|approve ID [--conflicts-reviewed]|schedule ID ISO_TIME');
}
try { process.stdout.write(JSON.stringify(run(process.argv.slice(2)), null, 2) + '\n'); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
