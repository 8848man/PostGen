import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageRunResult, generateHostImage } from '../next/host-image.mjs';
import { createJob, emptyState, setDraft, approveImagePlan, recordImageCandidate, confirmImageCandidate } from '../next/core.mjs';

test('Codex image output is accepted only from the completed run thread', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-codex-image-'));
  try {
    const thread = 'test-thread', dir = path.join(home, 'generated_images', thread);
    fs.mkdirSync(dir, { recursive: true });
    const generatedPath = path.join(dir, 'created.png');
    fs.writeFileSync(generatedPath, Buffer.from('89504e470d0a1a0a', 'hex'));
    const events = [
      { type: 'thread.started', thread_id: thread },
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ generatedPath, toolAvailable: true }) } },
      { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } }
    ].map(event => JSON.stringify(event)).join('\n');
    const result = imageRunResult(events, { codexHome: home });
    assert.equal(result.path, generatedPath);
    assert.equal(result.usage.totalTokens, 16);
    assert.equal(result.imageUsage.known, false);
    const reference = path.join(home, 'reference.png');
    fs.writeFileSync(reference, Buffer.from('89504e470d0a1a0a', 'hex'));
    let argumentsSeen;
    await generateHostImage({ request: { text: 'ImageGen request: scene' }, referencePaths: [reference], scene: 'scene' }, {
      binary: 'codex.exe', codexHome: home,
      run: async (_, args) => { argumentsSeen = args; return { code: 1, stdout: events, stderr: 'unrelated tool warning' }; }
    });
    assert.deepEqual(argumentsSeen.slice(argumentsSeen.indexOf('--image') + 1, argumentsSeen.indexOf('--image') + 2), [reference]);
    assert.equal(argumentsSeen.at(-1), '-');
    const outside = path.join(home, 'outside.png');
    fs.writeFileSync(outside, Buffer.from('89504e470d0a1a0a', 'hex'));
    const outsideEvents = [
      { type: 'thread.started', thread_id: thread },
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ generatedPath: outside, toolAvailable: true }) } },
      { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } }
    ].map(event => JSON.stringify(event)).join('\n');
    assert.throws(() => imageRunResult(outsideEvents, { codexHome: home }), /unexpected image path/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('generated image remains a candidate until a person confirms it', () => {
  const source = { id: 's1', type: 'text', ref: 'selected', text: 'fact' };
  let state = createJob(emptyState(), { accountId: 'a1', audience: 'reader', goal: 'explain', sources: [source], model: 'claude', imageProvider: 'codex' });
  const id = state.jobs[0].id;
  state = setDraft(state, id, { title: 'title', body: 'body', images: [{ id: 'i1', afterParagraph: 1, description: 'scene' }] });
  state = approveImagePlan(state, id);
  state = recordImageCandidate(state, id, 'i1', 'C:/managed/candidate.png', { provider: 'codex', known: true, inputTokens: 1, outputTokens: 1 });
  assert.equal(state.jobs[0].draft.images[0].generatedPath, undefined);
  assert.equal(state.jobs[0].draft.images[0].generationHistory.length, 1);
  assert.throws(() => confirmImageCandidate(state, id, 'i1', 'C:/managed/other.png'), /candidate changed/);
  state = confirmImageCandidate(state, id, 'i1', 'C:/managed/candidate.png');
  assert.equal(state.jobs[0].draft.images[0].generatedPath, 'C:/managed/candidate.png');
  assert.equal(state.jobs[0].draft.images[0].afterParagraph, 1);
});
