import fs from 'node:fs';

function table() {
  const file = process.env.POSTGEN_PRICE_TABLE;
  if (!file) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid price table');
  return parsed;
}

// 한글·한자·가나 등 CJK 문자는 대부분의 토크나이저에서 문자당 약 1토큰 이상이므로 1토큰으로,
// 그 밖의 문자는 4자당 1토큰으로 근사한다. 실제 토크나이저 결과와는 다를 수 있다.
const CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿]/u;

export function approximateTokens(text) {
  let cjk = 0, other = 0;
  for (const char of String(text ?? '')) { if (CJK.test(char)) cjk += 1; else other += 1; }
  return cjk + Math.ceil(other / 4);
}

export function estimateTextRequest({ provider, model, promptText, promptChars, calls = 1, outputTokens = 4000 }) {
  if (!Number.isInteger(calls) || calls < 1) throw new Error('Invalid model call count');
  const key = `${provider}:${model || 'default'}`;
  const rate = table()[key];
  const limit = Number(process.env.POSTGEN_COST_LIMIT_USD || 0);
  const basis = promptText === undefined
    ? '입력 문자 수 ÷ 4로 토큰을 근사하고 예상 출력 토큰과 사용자 가격표 단가를 곱합니다.'
    : `입력 토큰을 한글·한자 등 CJK 문자 1자당 1토큰, 그 밖의 문자 4자당 1토큰으로 근사해 모델 호출 ${calls}회분을 합산하고, 예상 출력 토큰과 사용자 가격표 단가를 곱합니다.`;
  const limitation = '실제 토큰 수는 모델별 토크나이저에 따라 다르며, 실제 모델 호출 횟수와 재시도 비용은 달라질 수 있습니다.';
  if (!rate || !Number.isFinite(rate.inputPerMillion) || !Number.isFinite(rate.outputPerMillion)) return { known: false, reason: 'No verified price entry', limitUsd: limit || null, basis, limitation, priceKey: key };
  const inputTokens = promptText === undefined ? Math.ceil(promptChars / 4) : approximateTokens(promptText) * calls;
  const estimatedUsd = (inputTokens * rate.inputPerMillion + outputTokens * rate.outputPerMillion) / 1_000_000;
  return { known: true, estimatedUsd, inputTokens, outputTokens, calls, limitUsd: limit || null, priceKey: key, basis, limitation };
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
