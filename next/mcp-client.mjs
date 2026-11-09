import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

export function toolFingerprint(tools) {
  return crypto.createHash('sha256').update(JSON.stringify(tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })).sort((a,b) => a.name.localeCompare(b.name)))).digest('hex');
}

export async function withMcpServer(config, run) {
  if (!config || typeof config.command !== 'string' || !config.command || !Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string')) throw new Error('Invalid MCP command');
  const inherited = Object.fromEntries(['PATH','Path','SystemRoot','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TMP','TEMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const child = spawn(config.command, config.args, { shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'], env: { ...inherited, ...(config.env || {}) } });
  let seq = 0, buffer = '', closed = false;
  const pending = new Map();
  const failAll = error => { closed = true; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 5_000_000) { child.kill(); failAll(new Error('MCP output too large')); return; }
    for (let pos; (pos = buffer.indexOf('\n')) !== -1;) {
      const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (!pending.has(message.id)) continue;
      const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(String(message.error.message || 'MCP error')));
      else item.resolve(message.result);
    }
  });
  child.on('error', failAll);
  child.on('close', code => failAll(new Error(`MCP server closed (${code})`)));
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('MCP server closed'));
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out`)); child.kill(); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'postgen', version: '0.1.0' } });
    if (!initialized?.protocolVersion) throw new Error('MCP initialization failed');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listing = await request('tools/list');
    const tools = listing?.tools || [];
    if (!Array.isArray(tools)) throw new Error('Invalid MCP tool list');
    return await run({ tools, fingerprint: toolFingerprint(tools), callTool: (name, args) => request('tools/call', { name, arguments: args }) });
  } finally { child.stdin.end(); child.kill(); }
}

export async function readConnectedSource(config, toolName, args) {
  if (!config.approvedFingerprint) throw new Error('MCP server has not been approved');
  return withMcpServer(config, async client => {
    if (client.fingerprint !== config.approvedFingerprint) throw new Error('MCP tool list changed; reapprove server');
    if (!client.tools.some(tool => tool.name === toolName)) throw new Error('Unknown MCP source tool');
    const result = await client.callTool(toolName, args);
    if (result?.isError) throw new Error('MCP source tool failed');
    const text = result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '';
    if (!text.trim()) throw new Error('MCP source returned no text');
    return text;
  });
}

export async function prepareWithMcp(config, toolName, job) {
  if (!config.approvedFingerprint) throw new Error('MCP server has not been approved');
  return withMcpServer(config, async client => {
    if (client.fingerprint !== config.approvedFingerprint) throw new Error('MCP tool list changed; reapprove server');
    const tool = client.tools.find(item => item.name === toolName);
    if (!tool || /publish|post_now|send/i.test(tool.name)) throw new Error('Draft preparation tool required; publishing is not automatic');
    const args = { account: job.accountHandle || job.accountId, title: job.draft.title, body: job.draft.body, images: job.draft.images };
    const result = await client.callTool(toolName, args);
    if (result?.isError) throw new Error('MCP preparation failed');
    return result;
  });
}

export async function registerScheduledWithMcp(config, toolName, job) {
  if (!config.approvedFingerprint) throw new Error('MCP server has not been approved');
  return withMcpServer(config, async client => {
    if (client.fingerprint !== config.approvedFingerprint) throw new Error('MCP tool list changed; reapprove server');
    const tool = client.tools.find(item => item.name === toolName);
    if (!tool || !/schedule|reserv|예약/i.test(tool.name) || /post_now|publish_now|send_now|즉시/i.test(tool.name)) throw new Error('An explicit scheduling tool is required');
    const args = { mode: 'scheduled', account: job.accountHandle, title: job.draft.title, body: job.draft.body, images: job.draft.images, publishAt: job.schedule.at };
    const response = await client.callTool(toolName, args);
    if (response?.isError) throw new Error('MCP reservation call failed');
    const text = response?.content?.find(item => item.type === 'text')?.text;
    let result; try { result = JSON.parse(text); } catch { throw new Error('MCP reservation returned no structured receipt'); }
    if (result.status !== 'scheduled' || result.account !== job.accountHandle || !Number.isFinite(Date.parse(result.publishAt)) || new Date(result.publishAt).toISOString() !== job.schedule.at || !result.remoteId && !result.reservationUrl) throw new Error('MCP reservation receipt does not match approved account and time');
    return { verified: true, accountHandle: job.accountHandle, publishAt: job.schedule.at, evidence: 'Approved MCP scheduling tool returned matching receipt', remoteId: result.remoteId || null, reservationUrl: result.reservationUrl || null };
  });
}
