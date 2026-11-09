import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { emptyState, createJob, setDraft, saveState, loadState, acquireDraftLock, releaseDraftLock } from '../next/core.mjs';

test('UI draft lock prevents Skill CLI edits and requires the current draft revision', () => {
  const dir = fs.mkdtempSync(path.join(path.resolve('tests'), '.postgen-lock-'));
  const file = path.join(dir, 'jobs.json');
  const env = { ...process.env, POSTGEN_NEXT_DIR: dir };
  const source = { id: 's1', type: 'text', ref: 'input', text: 'fact' };
  const initial = createJob(emptyState(), { accountId: 'a', audience: 'reader', goal: 'explain', sources: [source] });
  const id = initial.jobs[0].id;
  const draft = { title: 'First', body: 'Body', claims: [], images: [] };
  try {
    saveState(initial, 0, file);
    saveState(setDraft(initial, id, draft), 1, file);
    const lock = acquireDraftLock(id, file);
    assert.equal(lock.draftRevision, 1);
    assert.throws(() => acquireDraftLock(id, file), /being edited/);
    const cli = spawnSync(process.execPath, [path.resolve('skill/postgen/scripts/next-cli.mjs'), 'draft', id], { env, input: JSON.stringify({ ...draft, title: 'CLI edit' }), encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /being edited/);
    assert.equal(loadState(file).jobs[0].draft.title, 'First');
    assert.throws(() => saveState(setDraft(loadState(file), id, { ...draft, title: 'Wrong token' }), 2, file, { draftLockToken: 'other', expectedDraftRevision: 1 }), /being edited/);
    assert.throws(() => saveState(setDraft(loadState(file), id, { ...draft, title: 'Stale edit' }), 2, file, { draftLockToken: lock.token, expectedDraftRevision: 0 }), /Draft changed/);
    assert.throws(() => releaseDraftLock(id, 'other', file), /another editor/);
    saveState(setDraft(loadState(file), id, { ...draft, title: 'UI edit' }), 2, file, { draftLockToken: lock.token, expectedDraftRevision: 1 });
    assert.equal(releaseDraftLock(id, lock.token, file), true);
    assert.equal(loadState(file).jobs[0].draft.title, 'UI edit');
    assert.throws(() => saveState(setDraft(initial, id, draft), 1, file), /State changed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
