import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexModelOptions } from '../next/codex-models.mjs';
import { checkHostImage } from '../next/host-image-check.mjs';

test('Codex model options come from the listed cache and mark the recommended model', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-codex-models-'));
  try {
    const empty = codexModelOptions('gpt-6-sol', { codexHome: home });
    assert.deepEqual(empty.map(model => model.id), ['gpt-6-sol', '']);
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', priority: 7, input_modalities: ['text', 'image'] },
      { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', visibility: 'list', priority: 1, input_modalities: ['text', 'image'] },
      { slug: 'gpt-reserve', display_name: 'Hidden', visibility: 'hide', priority: 2 },
      { slug: 'text-only', display_name: 'Text', visibility: 'list', priority: 3, input_modalities: ['text'] }
    ] }));
    const options = codexModelOptions('gpt-6-sol', { codexHome: home });
    assert.deepEqual(options.map(model => model.id), ['gpt-6.2-sol', 'gpt-6-sol', '']);
    assert.deepEqual(options.filter(model => model.recommended).map(model => model.id), ['gpt-6-sol']);
    assert.ok(codexModelOptions('custom-model', { codexHome: home }).some(model => model.id === 'custom-model'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('image check forwards the selected Codex model', async () => {
  let options;
  await checkHostImage({ generatedPath: 'a.png', scene: 'scene', model: 'gpt-6-sol' }, async (_, __, opts) => { options = opts; return { result: { passed: true, reason: 'ok' }, usage: null }; });
  assert.equal(options.model, 'gpt-6-sol');
});
