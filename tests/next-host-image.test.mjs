import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageRunResult, generateHostImage } from '../next/host-image.mjs';
import { createJob, emptyState, setDraft, approveImagePlan, recordImageCandidate, recordReplacementCandidate, confirmImageCandidate, discardImageCandidate, publishDraftReservation } from '../next/core.mjs';

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
    assert.equal(argumentsSeen.includes('-m'), false);
    await generateHostImage({ request: { text: 'scene' }, scene: 'scene', model: 'gpt-6-sol' }, {
      binary: 'codex.exe', codexHome: home,
      run: async (_, args) => { argumentsSeen = args; return { code: 0, stdout: events }; }
    });
    assert.equal(argumentsSeen[argumentsSeen.indexOf('-m') + 1], 'gpt-6-sol');
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
  state = recordImageCandidate(state, id, 'i1', 'C:/managed/candidate.png', [{ usage: { provider: 'codex', known: true, inputTokens: 1, outputTokens: 1 }, imageUsage: { known: false }, check: null, checkUsage: null }]);
  assert.equal(state.jobs[0].draft.images[0].generatedPath, undefined);
  assert.equal(state.jobs[0].draft.images[0].generationHistory.length, 1);
  assert.throws(() => confirmImageCandidate(state, id, 'i1', 'C:/managed/other.png'), /candidate changed/);
  state = confirmImageCandidate(state, id, 'i1', 'C:/managed/candidate.png');
  assert.equal(state.jobs[0].draft.images[0].generatedPath, 'C:/managed/candidate.png');
  assert.equal(state.jobs[0].draft.images[0].afterParagraph, 1);
});

test('regeneration attaches the previous image and keeps it until the new candidate is selected', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-image-revision-'));
  try {
    const thread = 'revision-thread', outputDir = path.join(home, 'generated_images', thread);
    fs.mkdirSync(outputDir, { recursive: true });
    const previous = path.join(home, 'previous.png'), style = path.join(home, 'style.png'), created = path.join(outputDir, 'created.png');
    for (const file of [previous, style, created]) fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    const events = [
      { type: 'thread.started', thread_id: thread },
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ generatedPath: created, toolAvailable: true }) } },
      { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } }
    ].map(event => JSON.stringify(event)).join('\n');
    let argsSeen, promptSeen;
    await generateHostImage({ request: { text: '표준 이미지 요청' }, referencePaths: [style], previousImagePath: previous, revisionInstructions: '인물의 자세를 바꿔 주세요', scene: '인물' }, {
      binary: 'codex.exe', codexHome: home,
      run: async (_, args, prompt) => { argsSeen = args; promptSeen = prompt; return { code: 0, stdout: events }; }
    });
    assert.deepEqual(argsSeen.flatMap((arg, index) => arg === '--image' ? [argsSeen[index + 1]] : []), [style, previous]);
    assert.match(promptSeen, /final attached image is the previously generated result/);
    assert.match(promptSeen, /인물의 자세를 바꿔 주세요/);
    const source = { id: 's1', type: 'text', ref: 'selected', text: 'fact' };
    let state = createJob(emptyState(), { accountId: 'a1', audience: 'reader', goal: 'explain', sources: [source], imageProvider: 'codex' });
    const id = state.jobs[0].id;
    state = setDraft(state, id, { title: 'title', body: 'body', images: [{ id: 'i1', afterParagraph: 1, description: 'scene' }], standard: { set: 'naver-blog-post', sha256: 'a'.repeat(64) } });
    state = approveImagePlan(state, id);
    state = recordImageCandidate(state, id, 'i1', previous, [{ usage: { known: true, totalTokens: 2 } }]);
    state = confirmImageCandidate(state, id, 'i1', previous);
    state = recordReplacementCandidate(state, id, 'i1', previous, created, [{ usage: { known: true, totalTokens: 3 }, revisionInstructions: '인물의 자세를 바꿔 주세요' }]);
    assert.equal(state.jobs[0].draft.images[0].generatedPath, previous);
    assert.equal(state.jobs[0].draft.images[0].pendingPath, created);
    assert.equal(state.jobs[0].draft.images[0].generationHistory.length, 2);
    assert.throws(() => recordReplacementCandidate(state, id, 'i1', previous, style, [{}]), /Image changed/);
    const discarded = discardImageCandidate(state, id, 'i1', created);
    assert.equal(discarded.jobs[0].draft.images[0].generatedPath, previous);
    assert.equal(discarded.jobs[0].draft.images[0].pendingPath, undefined);
    const confirmed = confirmImageCandidate(state, id, 'i1', created);
    assert.equal(confirmed.jobs[0].draft.images[0].generatedPath, created);
    const published = publishDraftReservation(state, id, '2026-11-21T00:00:00Z', {}, new Date('2026-11-19T00:00:00Z'));
    assert.equal(published.jobs[0].draft.images[0].generatedPath, created);
    let pending = createJob(emptyState(), { accountId: 'a1', audience: 'reader', goal: 'explain', sources: [source], imageProvider: 'codex' });
    const pendingId = pending.jobs[0].id;
    pending = setDraft(pending, pendingId, { title: 'title', body: 'body', images: [{ id: 'i1', afterParagraph: 1, description: 'scene' }] });
    pending = approveImagePlan(pending, pendingId);
    pending = recordImageCandidate(pending, pendingId, 'i1', previous, [{ usage: { known: true, totalTokens: 2 }, check: { passed: true } }]);
    pending = recordReplacementCandidate(pending, pendingId, 'i1', previous, created, [{ usage: { known: true, totalTokens: 3 } }]);
    const restored = discardImageCandidate(pending, pendingId, 'i1', created).jobs[0].draft.images[0];
    assert.equal(restored.pendingPath, previous);
    assert.equal(restored.pendingUsage.totalTokens, 2);
    assert.equal(restored.pendingCheck.passed, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
