import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withMcpServer, readConnectedSource, prepareWithMcp, registerScheduledWithMcp } from '../next/mcp-client.mjs';

const command = { command: process.execPath, args: [path.resolve('tests/fixtures/mcp-echo.mjs')] };
test('MCP tool list approval gates source reads and draft preparation', async () => {
  const fingerprint = await withMcpServer(command, client => client.fingerprint);
  const config = { ...command, approvedFingerprint: fingerprint };
  assert.equal(await readConnectedSource(config, 'read_document', { id: '1' }), '연결 문서의 내용');
  const prepared = await prepareWithMcp(config, 'prepare_draft', { accountId: 'a', draft: { title: 't', body: 'b', images: [] } });
  assert.equal(prepared.content[0].text, '초안 준비됨');
  await assert.rejects(readConnectedSource({ ...config, approvedFingerprint: 'stale' }, 'read_document', { id: '1' }), /changed/);
  await assert.rejects(prepareWithMcp(config, 'publish_now', { accountId: 'a', draft: { title: 't', body: 'b', images: [] } }), /publishing is not automatic/);
  const job = { accountHandle: 'a', draft: { title: 't', body: 'b', images: [] }, schedule: { at: '2026-11-08T01:00:00.000Z' } };
  const receipt = await registerScheduledWithMcp(config, 'schedule_post', job);
  assert.equal(receipt.remoteId, 'fixture-reservation');
  await assert.rejects(registerScheduledWithMcp(config, 'publish_now', job), /explicit scheduling tool/);
});
