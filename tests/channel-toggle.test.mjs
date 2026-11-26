import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { emptyRegistry, addAccount, saveRegistry } from '../skill/postgen/scripts/account-registry.mjs';

test('channels are on by default, saved switches merge, and unknown channels or values are refused', async () => {
  const dir = fs.mkdtempSync(path.join(path.resolve('tests'), '.postgen-toggle-'));
  const previous = process.env.POSTGEN_NEXT_DIR;
  process.env.POSTGEN_NEXT_DIR = dir;
  try {
    const { loadSettings, updateSettings, channelEnabled } = await import(`../next/settings.mjs?${Date.now()}`);
    assert.equal(channelEnabled(loadSettings(), 'tistory'), true);
    updateSettings({ channels: { tistory: false } });
    updateSettings({ retentionMonths: 2 });
    const saved = loadSettings();
    assert.equal(saved.channels.tistory, false, 'other settings forms keep the channel switches');
    assert.equal(saved.channels.naver, true);
    assert.equal(channelEnabled(saved, 'mcp:custom'), true, 'channels without a switch count as on');
    assert.throws(() => updateSettings({ channels: { myspace: true } }), /Invalid next settings/);
    assert.throws(() => updateSettings({ channels: { naver: 'yes' } }), /Invalid next settings/);
  } finally {
    if (previous === undefined) delete process.env.POSTGEN_NEXT_DIR; else process.env.POSTGEN_NEXT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vault campaigns for all registered accounts skip accounts on channels that are off', () => {
  const dir = fs.mkdtempSync(path.join(path.resolve('tests'), '.postgen-toggle-cli-'));
  const env = { ...process.env, POSTGEN_DATA_DIR: dir, POSTGEN_NEXT_DIR: path.join(dir, 'next') };
  const previousData = process.env.POSTGEN_DATA_DIR;
  process.env.POSTGEN_DATA_DIR = dir;
  const cli = (args, input = '') => { const result = spawnSync(process.execPath, [path.resolve('skill/postgen/scripts/next-cli.mjs'), ...args], { env, input, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  try {
    let registry = addAccount(emptyRegistry(), { channel: 'naver', handle: 'n', defaultGoal: 'explain' });
    saveRegistry(registry, 0);
    const revision = registry.revision;
    registry = addAccount(registry, { channel: 'tistory', handle: 't', defaultGoal: 'inform' });
    saveRegistry(registry, revision);
    fs.mkdirSync(env.POSTGEN_NEXT_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.POSTGEN_NEXT_DIR, 'settings.json'), JSON.stringify({ schemaVersion: 'next-settings/v1', revision: 1, channels: { tistory: false } }));
    const created = cli(['create'], JSON.stringify({ allRegisteredAccounts: true, audience: 'reader', sources: [{ id: 's', type: 'text', ref: 'posts/postgen/a.md', text: 'source' }] }));
    assert.deepEqual(created.map(item => item.accountId), [registry.accounts[0].id]);
    assert.deepEqual(cli(['complete-accounts', created[0].id]), [], 'an off channel is not added later either');
  } finally {
    if (previousData === undefined) delete process.env.POSTGEN_DATA_DIR; else process.env.POSTGEN_DATA_DIR = previousData;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
