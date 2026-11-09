import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultSettings, updateSettings, loadSettings } from '../next/settings.mjs';
import { emptyState, createJob, setDraft, approveImagePlan, attachGeneratedImage, acceptImageCheck, approveDraft } from '../next/core.mjs';

test('operating settings enforce one to three months and image attempts', () => {
  const previous = process.env.POSTGEN_NEXT_DIR;
  const dir = fs.mkdtempSync(path.join(path.resolve('tests'), '.postgen-settings-'));
  process.env.POSTGEN_NEXT_DIR = dir;
  try {
    assert.equal(loadSettings().retentionMonths, defaultSettings().retentionMonths);
    const saved = updateSettings({ retentionMonths: 1, backgroundNotifications: true, autoImageCheck: true, maxImageGenerations: 2 });
    assert.equal(loadSettings().revision, saved.revision);
    assert.throws(() => updateSettings({ maxImageGenerations: 4 }), /Invalid next settings/);
    assert.throws(() => updateSettings({ retentionMonths: 0 }), /Invalid next settings/);
  } finally {
    if (previous === undefined) delete process.env.POSTGEN_NEXT_DIR; else process.env.POSTGEN_NEXT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed image check needs review before account approval', () => {
  const source = { id: 'source-1', type: 'text', ref: 'selected', text: 'fact' };
  let state = createJob(emptyState(), { accountId: 'a', audience: 'reader', goal: 'inform', sources: [source] });
  const id = state.jobs[0].id;
  state = setDraft(state, id, { title: 'title', body: 'body', claims: [], images: [{ id: 'image-1', afterParagraph: 1, description: 'scene' }] });
  state = approveImagePlan(state, id);
  state = attachGeneratedImage(state, id, 'image-1', 'C:/image.png', { passed: false, reason: 'artifacts', attempts: 2 });
  assert.throws(() => approveDraft(state, id), /review failed image checks/);
  state = acceptImageCheck(state, id, 'image-1');
  assert.equal(approveDraft(state, id).jobs[0].status, 'approved');
});
