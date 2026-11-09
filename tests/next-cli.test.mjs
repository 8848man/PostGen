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
    cli(['draft', created.id], JSON.stringify({ title: 'Shared title', body: 'Shared body', claims: [], images: [] }));
    assert.equal(loadState().jobs[0].draft.title, 'Shared title');
    assert.equal(cli(['show', created.id]).draft.body, 'Shared body');
  } finally {
    if (previousData === undefined) delete process.env.POSTGEN_DATA_DIR; else process.env.POSTGEN_DATA_DIR = previousData;
    if (previousNext === undefined) delete process.env.POSTGEN_NEXT_DIR; else process.env.POSTGEN_NEXT_DIR = previousNext;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
