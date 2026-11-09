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
  const basis = '입력 문자 수 ÷ 4로 토큰을 근사하고 예상 출력 토큰과 사용자 가격표 단가를 곱합니다.';
  const limitation = '실제 토큰·모델 호출 횟수와 별도 품질 평가 비용은 달라질 수 있습니다.';
  if (!rate || !Number.isFinite(rate.inputPerMillion) || !Number.isFinite(rate.outputPerMillion)) return { known: false, reason: 'No verified price entry', limitUsd: limit || null, basis, limitation, priceKey: key };
  const inputTokens = Math.ceil(promptChars / 4);
  const estimatedUsd = (inputTokens * rate.inputPerMillion + outputTokens * rate.outputPerMillion) / 1_000_000;
  return { known: true, estimatedUsd, inputTokens, outputTokens, limitUsd: limit || null, priceKey: key, basis, limitation };
}

export function estimateImageRequest({ model, hasAsset = false, attempts = 1, autoCheck = false }) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error('Invalid image attempt count');
  const priceKey = `image:openai:${model}:${hasAsset ? 'edit' : 'generation'}`;
  const rate = table()[priceKey];
  const limit = Number(process.env.POSTGEN_COST_LIMIT_USD || 0);
  const generationKnown = rate?.verified === true && Number.isFinite(rate?.perImageUsd) && rate.perImageUsd > 0 &&
    typeof rate.sourceUrl === 'string' && /^https:\/\//.test(rate.sourceUrl) &&
    typeof rate.verifiedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rate.verifiedAt) && Number.isFinite(Date.parse(rate.verifiedAt));
  const generationEstimatedUsd = generationKnown ? rate.perImageUsd * attempts : null;
  const known = generationKnown && !autoCheck;
  return {
    known, estimatedUsd: known ? generationEstimatedUsd : null, generationEstimatedUsd,
    generationKnown, attempts, limitUsd: limit || null, priceKey,
    priceSourceUrl: generationKnown ? rate.sourceUrl : null, priceVerifiedAt: generationKnown ? rate.verifiedAt : null,
    basis: '가격표의 이미지 1회 단가 × 최대 생성 횟수',
    limitation: autoCheck ? '자동 이미지 점검의 별도 모델 호출 비용은 포함하지 못합니다. 실제 생성 횟수·이미지 크기·품질과 청구액은 달라질 수 있습니다.' : '실제 생성 횟수·이미지 크기·품질과 청구액은 달라질 수 있습니다.',
    reason: !generationKnown ? 'No verified image price entry' : autoCheck ? 'Image check cost cannot be estimated before the request' : null
  };
}

export function requireCostAcknowledgement(estimate, acknowledged) {
  if ((!estimate.known || (estimate.limitUsd !== null && estimate.estimatedUsd > estimate.limitUsd)) && !acknowledged) throw new Error('Cost estimate needs confirmation');
}
