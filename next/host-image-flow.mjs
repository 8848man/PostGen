import { generateHostImage } from './host-image.mjs';
import { checkHostImage } from './host-image-check.mjs';
import { importGeneratedImage, discardGeneratedImage } from './images.mjs';

export async function runImageAttempts(input, { remaining, autoCheck }, deps = {}) {
  const generate = deps.generate || generateHostImage;
  const check = deps.check || checkHostImage;
  const importImage = deps.importImage || importGeneratedImage;
  const discard = deps.discard || discardGeneratedImage;
  const attempts = [];
  let feedback = '';
  for (let index = 0; index < remaining; index++) {
    const generated = await generate({ ...input, feedback });
    const storedPath = await importImage(generated.path);
    let verdict = null;
    let checkUsage = null;
    if (autoCheck) {
      try {
        const checked = await check({ generatedPath: storedPath, referencePaths: input.referencePaths, scene: input.scene, request: input.request });
        verdict = checked.check;
        checkUsage = checked.usage;
      } catch (error) {
        verdict = { passed: false, reason: `자동 점검 오류: ${String(error.message).slice(0, 400)}` };
      }
    }
    attempts.push({ usage: generated.usage, imageUsage: generated.imageUsage, check: verdict, checkUsage });
    if (!autoCheck || verdict.passed || index === remaining - 1) return { storedPath, attempts };
    feedback = verdict.reason;
    await discard(storedPath);
  }
  throw new Error('No image candidate was generated');
}
