import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from '../skill/postgen/scripts/profile.mjs';
import { withMcpServer } from './mcp-client.mjs';

const file = () => path.join(process.env.POSTGEN_NEXT_DIR || path.join(dataDir(), 'next'), 'connectors.json');
export function loadConnectors() {
  if (!fs.existsSync(file())) return { schemaVersion: 'connectors/v1', revision: 0, servers: [] };
  const value = JSON.parse(fs.readFileSync(file(), 'utf8'));
  if (value.schemaVersion !== 'connectors/v1' || !Array.isArray(value.servers)) throw new Error('Invalid connectors');
  return value;
}
function save(next, expected) {
  if (loadConnectors().revision !== expected) throw new Error('Connectors changed; reload');
  const dir = path.dirname(file()); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.connectors-${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file()); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return next;
}
export function registerConnector({ name, command, args = [] }) {
  if (typeof name !== 'string' || !name.trim() || typeof command !== 'string' || !command.trim() || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('Invalid MCP connector');
  const current = loadConnectors(), next = structuredClone(current);
  next.servers.push({ id: crypto.randomUUID(), name, command, args, approvedFingerprint: null, approvedAt: null });
  next.revision++;
  return save(next, current.revision);
}
export async function inspectConnector(id) {
  const server = loadConnectors().servers.find(item => item.id === id);
  if (!server) throw new Error('Unknown MCP connector');
  return withMcpServer(server, async client => ({ tools: client.tools, fingerprint: client.fingerprint }));
}
export function approveConnector(id, fingerprint) {
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid MCP fingerprint');
  const current = loadConnectors(), next = structuredClone(current);
  const server = next.servers.find(item => item.id === id);
  if (!server) throw new Error('Unknown MCP connector');
  server.approvedFingerprint = fingerprint; server.approvedAt = new Date().toISOString();
  next.revision++;
  return save(next, current.revision);
}
