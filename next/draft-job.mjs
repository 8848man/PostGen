// Standard-based draft generation for one job, shared by the review screen (/api/generate) and next-cli `generate`.
// The Assets Manager standard is loaded here and passed into the model prompt, so a draft saved by this path
// carries a standard record that really wrote it. Callers never supply the standard record themselves.
import { loadRegistry, resolveAccount } from '../skill/postgen/scripts/account-registry.mjs';
import { loadState, saveState, recordModelUsage, setCampaignPlan, setDraft } from '../skill/postgen/scripts/next-core.mjs';
import { generateDraft, generatePlan } from './generate.mjs';
import { projectNameForSources } from './post-metadata.mjs';
import { assetsStandardConfig, loadAssetsStandard, standardRecord, standardTask } from './assets-standard.mjs';
import { checkLengthFloor, lengthFloorMessage } from '../skill/postgen/scripts/length-rule.mjs';

function mutateState(fn) {
  const current = loadState();
  const next = fn(current);
  saveState(next, current.revision);
  return next;
}

export async function generateJobDraft(jobId, { provider, model } = {}, deps = {}) {
  const { draft: writeDraft = generateDraft, plan: writePlan = generatePlan, standard: readStandard = loadAssetsStandard, config = assetsStandardConfig() } = deps;
  const current = loadState(); let job = current.jobs.find(item => item.id === jobId);
  if (!job || !['selected','draft'].includes(job.status)) throw new Error('Job is not ready for generation');
  if (job.sources.some(source => source.expired)) throw new Error('Source copy expired; restore it or create a new job');
  const registry = loadRegistry(), account = registry.accounts.find(item => item.id === job.accountId);
  if (!account) throw new Error('Account no longer exists');
  const sample = resolveAccount(registry, account.channel, account.handle).sample;
  const modelOptions = { provider: provider || job.model, model };
  if (!['codex', 'claude'].includes(modelOptions.provider)) throw new Error('Direct API generation is disabled; use Codex or Claude Code');
  if (!config.cli || !config.sets[account.channel]) throw new Error('Configure POSTGEN_ASSETS_CLI and an Assets Manager set before generating a reviewable draft');
  const usageEntries = [];
  const shared = current.jobs.filter(item => item.campaignId === job.campaignId).length > 1;
  if (shared && !job.plan) {
    let planned;
    try { planned = await writePlan(job.sources, modelOptions); }
    catch (error) { mutateState(latest => recordModelUsage(latest, job.id, 'shared-plan', error.usage, { campaign: true })); throw error; }
    usageEntries.push({ step: 'shared-plan', usage: planned.usage });
    mutateState(latest => recordModelUsage(latest, job.id, 'shared-plan', planned.usage, { campaign: true }));
    job = mutateState(latest => setCampaignPlan(latest, job.campaignId, planned.plan)).jobs.find(item => item.id === jobId);
  }
  // The task is the shared plan's angle, so the library can also pick related past outputs as examples.
  const standard = await readStandard({ channel: account.channel, task: standardTask(account.channel, job.plan?.angle || job.audience) }, config);
  const revisionRequest = job.review && job.draft ? { decision: job.review.decision, note: job.review.note, previousTitle: job.draft.title, previousBody: job.draft.body.slice(0, 12_000), previousBodyTruncated: job.draft.body.length > 12_000 } : null;
  const generationInput = { sources: job.sources, account, sample, audience: job.audience, goal: job.goal, plan: job.plan, standard, revisionRequest, projectName: job.projectName || projectNameForSources(job.sources) };
  const step = shared ? 'draft' : 'plan-and-draft';
  let output;
  try { output = await writeDraft(generationInput, modelOptions); }
  catch (error) { mutateState(latest => recordModelUsage(latest, job.id, step, error.usage)); throw error; }
  output.draft.standard = standardRecord(standard);
  // Reported at generation too (next-cli `generate` prints diagnostics); the review screen reads draft.lengthCheck.
  const length = checkLengthFloor(output.draft.body, output.draft.standard?.length);
  if (length?.below) output.diagnostics.push({ code: 'length_below_standard', message: lengthFloorMessage(length) });
  usageEntries.push({ step, usage: output.usage });
  mutateState(latest => recordModelUsage(latest, job.id, step, output.usage));
  const state = mutateState(latest => setDraft(latest, job.id, output.draft, output.diagnostics, { channel: account.channel }));
  return { state, usageEntries };
}
