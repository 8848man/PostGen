import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { emptyRegistry, addAccount, saveRegistry } from '../skill/postgen/scripts/account-registry.mjs';
import { loadState } from '../next/core.mjs';

test('installed Skill CLI and local UI core use the same account drafts', () => {
  const dir = fs.mkdtempSync(path.join(path.resolve('tests'), '.postgen-cli-'));
  const previousData = process.env.POSTGEN_DATA_DIR, previousNext = process.env.POSTGEN_NEXT_DIR;
  const env = { ...process.env, POSTGEN_DATA_DIR: dir, POSTGEN_NEXT_DIR: path.join(dir, 'next') };
  process.env.POSTGEN_DATA_DIR = dir; process.env.POSTGEN_NEXT_DIR = env.POSTGEN_NEXT_DIR;
  function cli(args, input = '') {
    const result = spawnSync(process.execPath, [path.resolve('skill/postgen/scripts/next-cli.mjs'), ...args], { env, input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  try {
    const registry = addAccount(emptyRegistry(), { channel: 'naver', handle: 'account', defaultGoal: 'explain' });
    saveRegistry(registry, 0);
    const [created] = cli(['create'], JSON.stringify({ accountIds: [registry.accounts[0].id], audience: 'reader', sources: [{ id: 's1', type: 'text', ref: 'user', text: 'source fact' }] }));
    const draftResult = spawnSync(process.execPath, [path.resolve('skill/postgen/scripts/next-cli.mjs'), 'draft', created.id], {
      env, input: JSON.stringify({ title: 'Shared title', body: 'Shared body', claims: [], images: [] }), encoding: 'utf8'
    });
    assert.equal(draftResult.status, 0, draftResult.stderr);
    assert.match(draftResult.stderr, /no image scene suggestions/);
    assert.equal(loadState().jobs[0].draft.title, 'Shared title');
    assert.equal(cli(['show', created.id]).draft.body, 'Shared body');
  } finally {
    if (previousData === undefined) delete process.env.POSTGEN_DATA_DIR; else process.env.POSTGEN_DATA_DIR = previousData;
    if (previousNext === undefined) delete process.env.POSTGEN_NEXT_DIR; else process.env.POSTGEN_NEXT_DIR = previousNext;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vault post campaigns cover every registered account and add only missing accounts', () => {
  const dir = fs.mkdtempSync(path.join(path.resolve('tests'), '.postgen-channels-'));
  const previousData = process.env.POSTGEN_DATA_DIR, previousNext = process.env.POSTGEN_NEXT_DIR;
  const env = { ...process.env, POSTGEN_DATA_DIR: dir, POSTGEN_NEXT_DIR: path.join(dir, 'next') };
  process.env.POSTGEN_DATA_DIR = dir; process.env.POSTGEN_NEXT_DIR = env.POSTGEN_NEXT_DIR;
  const cli = (args, input = '') => {
    const result = spawnSync(process.execPath, [path.resolve('skill/postgen/scripts/next-cli.mjs'), ...args], { env, input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    let registry = addAccount(emptyRegistry(), { channel: 'naver', handle: 'naver-account', defaultGoal: 'explain' });
    saveRegistry(registry, 0);
    const previousRevision = registry.revision;
    registry = addAccount(registry, { channel: 'tistory', handle: 'tistory-account', defaultGoal: 'inform' });
    saveRegistry(registry, previousRevision);
    const sources = [{ id: 'vault-source', type: 'text', ref: 'posts/postgen/example.md', text: 'A selected vault post' }];
    const all = cli(['create'], JSON.stringify({ allRegisteredAccounts: true, audience: 'reader', sources }));
    assert.equal(all.length, 2);
    assert.equal(new Set(all.map(item => item.campaignId)).size, 1);
    assert.deepEqual(new Set(all.map(item => item.accountId)), new Set(registry.accounts.map(item => item.id)));
    const [legacy] = cli(['create'], JSON.stringify({ accountIds: [registry.accounts[0].id], audience: 'reader', sources }));
    cli(['plan', legacy.id], JSON.stringify({ angle: 'Shared evidence', keyClaims: [], conflicts: [] }));
    cli(['draft', legacy.id], JSON.stringify({ title: 'Existing draft', body: 'Body', claims: [], images: [] }));
    const [added] = cli(['complete-accounts', legacy.id]);
    assert.equal(added.accountId, registry.accounts[1].id);
    assert.equal(added.campaignId, legacy.campaignId);
    assert.deepEqual(cli(['complete-accounts', legacy.id]), []);
    const coverage = cli(['coverage', legacy.id]);
    assert.deepEqual(coverage.map(item => item.status), ['draft', 'selected']);
    const jobs = loadState().jobs.filter(item => item.campaignId === legacy.campaignId);
    assert.equal(jobs[0].draft.title, '[PostGen] Existing draft');
    assert.deepEqual(jobs[1].sources, jobs[0].sources);
    assert.deepEqual(jobs[1].plan, jobs[0].plan);
  } finally {
    if (previousData === undefined) delete process.env.POSTGEN_DATA_DIR; else process.env.POSTGEN_DATA_DIR = previousData;
    if (previousNext === undefined) delete process.env.POSTGEN_NEXT_DIR; else process.env.POSTGEN_NEXT_DIR = previousNext;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
