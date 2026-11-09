import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import { read } from '../skill/postgen/scripts/collect.mjs';

const MAX_SOURCE_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 120_000;
const privateIp = ip => {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80') || ip.startsWith('::ffff:127.');
};
function plainHtml(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(?:p|div|h[1-6]|li|section|article)>/gi, '\n').replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}
function snapshot(type, ref, text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Empty selected source');
  if (text.length > MAX_TEXT_CHARS) throw new Error('Selected source too large');
  return { id: crypto.randomUUID(), type, ref, text, capturedAt: new Date().toISOString(), sha256: crypto.createHash('sha256').update(text).digest('hex') };
}
async function publicUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only public HTTPS URLs are supported');
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => privateIp(item.address))) throw new Error('Private or unresolved URL is not allowed');
  return { url, address: addresses[0] };
}
function requestPinned(url, address) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15_000, lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family), headers: { Accept: 'text/html, text/plain' } }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_SOURCE_BYTES) { req.destroy(new Error('URL response too large')); return; } chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('URL fetch timed out')));
    req.on('error', reject);
  });
}
async function fetchPublicText(input) {
  let target = await publicUrl(input);
  for (let redirect = 0; redirect < 4; redirect++) {
    const response = await requestPinned(target.url, target.address);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location) throw new Error('Redirect without location');
      target = await publicUrl(new URL(location, target.url).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Source URL returned ${response.status}`);
    const mime = response.headers['content-type'] || '';
    if (!/text\/html|text\/plain/i.test(mime)) throw new Error('URL must return HTML or plain text');
    const length = Number(response.headers['content-length'] || 0);
    if (length > MAX_SOURCE_BYTES) throw new Error('URL response too large');
    return snapshot('url', target.url.toString(), /text\/html/i.test(mime) ? plainHtml(response.body) : response.body);
  }
  throw new Error('Too many redirects');
}

export async function collectSelected(specs, { workspace = process.cwd(), connectedReader } = {}) {
  if (!Array.isArray(specs) || specs.length < 1 || specs.length > 20) throw new Error('Choose 1–20 sources');
  const result = [];
  for (const spec of specs) {
    if (spec?.type === 'text') result.push(snapshot('text', spec.ref || 'user-input', spec.text));
    else if (spec?.type === 'file') {
      const file = await fs.realpath(path.resolve(spec.path));
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error('Selected file must be under 2 MB');
      result.push(snapshot('file', file, await fs.readFile(file, 'utf8')));
    } else if (spec?.type === 'url') result.push(await fetchPublicText(spec.url));
    else if (spec?.type === 'ai-record') {
      if (typeof spec.sourceId !== 'string' || !spec.sourceId) throw new Error('AI record source ID required');
      const bundle = read(workspace, { sourceIds: [spec.sourceId] });
      const document = bundle.sourceDocuments[0];
      if (!document) throw new Error('Selected AI record unavailable');
      result.push(snapshot('ai-record', spec.sourceId, document.messages.map(message => `[${message.role} line ${message.locator?.line || '?'}]\n${message.content}`).join('\n\n')));
    } else if (spec?.type === 'connected') {
      if (typeof connectedReader !== 'function') throw new Error('Connected source adapter unavailable');
      const text = await connectedReader(spec);
      result.push(snapshot('connected', String(spec.ref || ''), text));
    } else throw new Error('Unsupported selected source');
  }
  return result;
}
