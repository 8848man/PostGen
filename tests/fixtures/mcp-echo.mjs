import readline from 'node:readline';
const tools = [{ name: 'read_document', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }, { name: 'prepare_draft', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }, { name: 'schedule_post', inputSchema: { type: 'object', properties: { account: { type: 'string' }, publishAt: { type: 'string' } } } }];
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const request = JSON.parse(line);
  if (!request.id) continue;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools };
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: request.params.name === 'read_document' ? '연결 문서의 내용' : request.params.name === 'schedule_post' ? JSON.stringify({ status: 'scheduled', account: request.params.arguments.account, publishAt: request.params.arguments.publishAt, remoteId: 'fixture-reservation' }) : '초안 준비됨' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
