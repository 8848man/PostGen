import fs from 'node:fs';

function table() {
  const file = process.env.POSTGEN_PRICE_TABLE;
  if (!file) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid price table');
  return parsed;
}

export function estimateTextRequest({ provider, model, promptChars, outputTokens = 4000 }) {
  const key = `${provider}:${model || 'default'}`;
  const rate = table()[key];
  const limit = Number(process.env.POSTGEN_COST_LIMIT_USD || 0);
  if (!rate || !Number.isFinite(rate.inputPerMillion) || !Number.isFinite(rate.outputPerMillion)) return { known: false, reason: 'No verified price entry', limitUsd: limit || null };
  const inputTokens = Math.ceil(promptChars / 4);
  const estimatedUsd = (inputTokens * rate.inputPerMillion + outputTokens * rate.outputPerMillion) / 1_000_000;
  return { known: true, estimatedUsd, inputTokens, outputTokens, limitUsd: limit || null, priceKey: key };
}

export function requireCostAcknowledgement(estimate, acknowledged) {
  if ((!estimate.known || (estimate.limitUsd !== null && estimate.estimatedUsd > estimate.limitUsd)) && !acknowledged) throw new Error('Cost estimate needs confirmation');
}
