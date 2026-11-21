import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recommendedCodexImageModel, validCodexModel } from './settings.mjs';

// Codex keeps the models offered to this account in models_cache.json. Only listed models that accept images are offered.
export function codexModelOptions(current = recommendedCodexImageModel, { codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
  let models = [];
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(codexHome, 'models_cache.json'), 'utf8'));
    models = (Array.isArray(cache?.models) ? cache.models : [])
      .filter(model => model?.visibility === 'list' && validCodexModel(model.slug) && model.slug && (!Array.isArray(model.input_modalities) || model.input_modalities.includes('image')))
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map(model => ({ id: model.slug, label: String(model.display_name || model.slug).slice(0, 80) }));
  } catch { /* No cache yet: offer the recommended model and the CLI default. */ }
  for (const id of [recommendedCodexImageModel, current]) if (id && !models.some(model => model.id === id)) models.push({ id, label: id });
  return [
    ...models.map(model => ({ ...model, recommended: model.id === recommendedCodexImageModel })),
    { id: '', label: 'Codex CLI 기본값', recommended: false }
  ];
}
