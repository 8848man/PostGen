import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeCdpEndpoint, connectExistingEdge } from '../next/browser-adapter.mjs';

test('existing Edge connection accepts only local debugging endpoints', () => {
  assert.equal(edgeCdpEndpoint('msedge'), 'msedge');
  assert.equal(edgeCdpEndpoint('http://127.0.0.1:9222'), 'http://127.0.0.1:9222');
  assert.equal(edgeCdpEndpoint('http://localhost:9222/'), 'http://localhost:9222');
  for (const endpoint of ['https://127.0.0.1:9222', 'http://192.168.1.1:9222', 'http://user@localhost:9222', 'http://localhost:9222/json', 'ws://localhost:9222']) {
    assert.throws(() => edgeCdpEndpoint(endpoint));
  }
});

test('existing Edge connection uses its default profile without launching another browser', async () => {
  const defaultContext = { id: 'default' };
  let received;
  const connect = async (endpoint, options) => {
    received = { endpoint, options };
    return { contexts: () => [defaultContext] };
  };
  const connected = await connectExistingEdge('http://127.0.0.1:9222', connect, async () => ({ Browser: 'Edg/140.0.0.0' }));
  assert.equal(connected.context, defaultContext);
  assert.equal(received.endpoint, 'http://127.0.0.1:9222');
  assert.equal(received.options.noDefaults, true);
  await assert.rejects(connectExistingEdge('http://127.0.0.1:9222', connect, async () => ({ Browser: 'Chrome/140.0.0.0' })), /not Microsoft Edge/);
});
