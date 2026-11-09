import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { emptyRegistry, addAccount, addSample, approveSample, setDefaultSample, resolveAccount, loadRegistry, saveRegistry } from '../skill/postgen/scripts/account-registry.mjs';

test('golden sample requires approval and stays within its account', () => {
  let registry = addAccount(emptyRegistry(), { channel: 'naver', handle: 'first', defaultGoal: '설명' });
  registry = addAccount(registry, { channel: 'naver', handle: 'second', defaultGoal: '기록' });
  const [first, second] = registry.accounts;
  registry = addSample(registry, { accountId: first.id, sourceType: 'url', sourceRef: 'https://example.com/post', rights: 'public_style' });
  const sampleId = registry.samples[0].id;
  assert.throws(() => setDefaultSample(registry, first.id, sampleId), /approved/);
  registry = approveSample(registry, sampleId, [{ key: 'paragraph', value: '짧은 문단', priority: 'required' }]);
  assert.throws(() => setDefaultSample(registry, second.id, sampleId), /this account/);
  registry = setDefaultSample(registry, first.id, sampleId);
  assert.equal(registry.accounts[0].defaultSampleId, sampleId);
  assert.equal(registry.accounts[1].defaultSampleId, null);
  assert.equal(resolveAccount(registry, 'naver', 'first').sample.id, sampleId);
  assert.equal(resolveAccount(registry, 'naver', 'second').sample, null);
});

test('registry persists and rejects stale revisions', () => {
  const testRoot = path.resolve('tests');
  const dir = fs.mkdtempSync(path.join(testRoot, '.postgen-accounts-'));
  const previous = process.env.POSTGEN_DATA_DIR;
  process.env.POSTGEN_DATA_DIR = dir;
  try {
    const first = loadRegistry();
    const next = addAccount(first, { channel: 'tistory', handle: 'my-blog', defaultGoal: '분석' });
    saveRegistry(next, first.revision);
    assert.equal(loadRegistry().accounts[0].handle, 'my-blog');
    assert.throws(() => saveRegistry(next, first.revision), /changed/);
  } finally {
    if (previous === undefined) delete process.env.POSTGEN_DATA_DIR;
    else process.env.POSTGEN_DATA_DIR = previous;
    if (!path.resolve(dir).startsWith(testRoot + path.sep)) throw new Error('Test directory escaped workspace');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid sample rule and duplicate account are rejected', () => {
  const initial = addAccount(emptyRegistry(), { channel: 'naver', handle: 'same', defaultGoal: '정보 전달' });
  assert.throws(() => addAccount(initial, { channel: 'naver', handle: 'same', defaultGoal: '다른 목표' }), /already exists/);
  const withSample = addSample(initial, { accountId: initial.accounts[0].id, sourceType: 'text', sourceRef: 'sample.txt', rights: 'owned' });
  assert.throws(() => approveSample(withSample, withSample.samples[0].id, [{ key: 'tone', value: '차분함', priority: 'unknown' }]), /Invalid golden sample rule/);
});
