import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const READ_CHUNK_BYTES = 1 << 18;
const PREVIEW_CHARS = 140;
export const sourceId = (provider, id) => crypto.createHash('sha256').update(`${provider}:${id}`).digest('hex').slice(0, 16);
export function normalizeWorkspace(value) {
  const absolute = path.resolve(value);
  let canonical = absolute;
  try { canonical = fs.realpathSync.native(absolute); } catch { /* Older session path may be gone. */ }
  return canonical.replace(/[\\/]+$/, '').toLowerCase();
}
function* filesUnder(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(file);
    else if (entry.isFile() && file.endsWith('.jsonl')) yield file;
  }
}
const matchingWorkspace = (cwd, workspace) => typeof cwd === 'string' && normalizeWorkspace(cwd) === normalizeWorkspace(workspace);
// Session lines repeat the same cwd, so each distinct value is resolved on disk once per scan.
export function workspaceMatcher(workspace) {
  const target = normalizeWorkspace(workspace), seen = new Map();
  return cwd => {
    if (typeof cwd !== 'string') return false;
    if (!seen.has(cwd)) seen.set(cwd, normalizeWorkspace(cwd) === target);
    return seen.get(cwd);
  };
}
const contentText = (content, blockType) => Array.isArray(content)
  ? content.filter(part => part?.type === blockType && typeof part.text === 'string').map(part => part.text).join('\n')
  : typeof content === 'string' ? content : '';

// Yields the same lines as split(/\r?\n/) without holding the whole file in memory.
export function* readLines(file) {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES), decoder = new StringDecoder('utf8');
  let pending = '';
  try {
    for (let bytes; (bytes = fs.readSync(fd, buffer, 0, READ_CHUNK_BYTES, null)) > 0;) {
      const text = decoder.write(buffer.subarray(0, bytes));
      let start = 0;
      for (let end; (end = text.indexOf('\n', start)) !== -1; start = end + 1) {
        const line = pending + text.slice(start, end); pending = '';
        yield line.endsWith('\r') ? line.slice(0, -1) : line;
      }
      pending += text.slice(start);
    }
    yield pending + decoder.end();
  } finally { fs.closeSync(fd); }
}

function catalogEntry(role, content, terms) {
  const lower = terms.length ? content.toLowerCase() : '';
  let hits = terms.length > 31 ? [] : 0;
  for (let i = 0; i < terms.length; i++) if (lower.includes(terms[i])) {
    if (Array.isArray(hits)) hits.push(i);
    else hits |= 1 << i;
  }
  return { role, length: content.length, preview: content.slice(0, PREVIEW_CHARS),
    hits };
}

function catalogSummary(entries, terms) {
  const first = entries.find(entry => entry.role === 'user') || entries[0];
  const hits = terms.length > 31
    ? new Set(entries.flatMap(entry => entry.hits))
    : entries.reduce((bits, entry) => bits | entry.hits, 0);
  return { messageCount: entries.length, characterCount: entries.reduce((sum, entry) => sum + entry.length, 0),
    preview: first?.preview || '',
    score: terms.reduce((score, _, index) => score + (hits instanceof Set ? Number(hits.has(index)) : ((hits >>> index) & 1)), 0) };
}

export function parseCodexSession(file, workspace, matches = workspaceMatcher(workspace), catalogTerms = null) {
  const lines = readLines(file);
  const header = lines.next().value ?? ''; // Unreadable files still throw to the provider diagnostic.
  let meta;
  try { const first = JSON.parse(header); if (first.type === 'session_meta') meta = first.payload; }
  catch { lines.return(); return null; }
  if (meta?.source?.subagent?.other === 'guardian') { lines.return(); return null; } // Internal approval review, not user work.
  if (!matches(meta?.cwd)) { lines.return(); return null; } // Other workspaces stop after the first line.
  const sessionId = String(meta.id || meta.session_id || sourceId('codex-file', file));
  const messages = []; let pending = []; let malformed = 0; let index = 0; let lineNumber = 1;
  for (const line of lines) {
    lineNumber++;
    if (!line.trim()) continue;
    let item; try { item = JSON.parse(line); } catch { malformed++; continue; }
    if (item.type !== 'response_item' || item.payload?.type !== 'message') continue;
    const message = item.payload;
    if (message.role === 'user') {
      const content = contentText(message.content, 'input_text');
      if (content) pending.push(catalogTerms ? catalogEntry('user', content, catalogTerms)
        : { role: 'user', content, locator: { line: lineNumber, messageIndex: ++index } });
    } else if (message.role === 'assistant' && message.phase === 'final_answer') {
      const content = contentText(message.content, 'output_text');
      if (content) {
        pending.push(catalogTerms ? catalogEntry('assistant', content, catalogTerms)
          : { role: 'assistant', content, locator: { line: lineNumber, messageIndex: ++index } });
        messages.push(...pending); pending = [];
      }
    }
  }
  return catalogTerms ? { sourceId: sourceId('codex', sessionId), provider: 'codex-jsonl',
    sessionId, capturedAt: meta.timestamp || null, ...catalogSummary(messages, catalogTerms) }
    : { sourceId: sourceId('codex', sessionId), provider: 'codex-jsonl', sessionId,
      capturedAt: meta.timestamp || null, messages,
      diagnostics: malformed ? [`${malformed} malformed lines skipped`] : [] };
}

// Skip full JSON parsing for lines whose cwd literals cannot name this workspace.
// The parsed top-level cwd remains authoritative when a nested key happens to match.
const CWD_FIELD = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/g;
function mayMatchWorkspace(line, matches, literalMatches, hint) {
  if (hint.pattern && line.includes(hint.pattern)) {
    if (hint.matched) return true;
    const first = line.indexOf('"cwd"');
    if (line.indexOf('"cwd"', first + 5) === -1) return false;
  }
  CWD_FIELD.lastIndex = 0;
  let found = false;
  for (let match; (match = CWD_FIELD.exec(line));) {
    found = true;
    const literal = match[1];
    if (!literalMatches.has(literal)) {
      let matched = false;
      try { matched = matches(JSON.parse(literal)); } catch { /* Invalid JSON is counted below. */ }
      literalMatches.set(literal, matched);
    }
    if (!hint.pattern) { hint.pattern = `"cwd":${literal}`; hint.matched = literalMatches.get(literal); }
    if (literalMatches.get(literal)) return true;
  }
  return !found;
}

export function parseClaudeSession(file, workspace, matches = workspaceMatcher(workspace), catalogTerms = null) {
  const entries = []; let sessionId; let capturedAt; let matched = false; let malformed = 0; let lineNumber = 0;
  const assistantById = new Map(), literalMatches = new Map(), hint = {};
  for (const line of readLines(file)) {
    lineNumber++;
    if (!line.trim()) continue;
    if (catalogTerms && !mayMatchWorkspace(line, matches, literalMatches, hint)) continue;
    let item; try { item = JSON.parse(line); } catch { malformed++; continue; }
    if (matches(item.cwd)) matched = true;
    if (!sessionId && item.sessionId) sessionId = String(item.sessionId);
    if (item.timestamp && (!capturedAt || item.timestamp > capturedAt)) capturedAt = item.timestamp;
    if (item.type !== 'user' && item.type !== 'assistant') continue;
    const role = item.type;
    const content = contentText(item.message?.content, 'text');
    if (!content) continue; // Tool results and tool calls are not conversation evidence.
    const entry = { ...(catalogTerms ? catalogEntry(role, content, catalogTerms)
      : { role, content, locator: { line: lineNumber, messageIndex: entries.length + 1 } }),
      complete: role === 'user' || item.message?.stop_reason === 'end_turn' };
    const id = role === 'assistant' && item.message?.id;
    if (id && assistantById.has(id)) entries[assistantById.get(id)] = entry;
    else { if (id) assistantById.set(id, entries.length); entries.push(entry); }
  }
  if (!matched) return null;
  const messages = []; let pending = [];
  for (const entry of entries) {
    if (entry.role === 'user') pending.push(entry);
    else if (entry.complete) {
      pending.push(entry);
      messages.push(...pending.map(({ complete, ...message }) => message));
      pending = [];
    }
  }
  return catalogTerms ? { sourceId: sourceId('claude-code', sessionId || file), provider: 'claude-code-jsonl',
    sessionId: sessionId || null, capturedAt: capturedAt || null, ...catalogSummary(messages, catalogTerms) }
    : { sourceId: sourceId('claude-code', sessionId || file), provider: 'claude-code-jsonl',
      sessionId: sessionId || null, capturedAt: capturedAt || null, messages,
      diagnostics: malformed ? [`${malformed} malformed lines skipped`] : [] };
}

function fileSource(file) {
  const absolute = fs.realpathSync.native(path.resolve(file));
  if (!fs.statSync(absolute).isFile()) throw new Error('not_a_file');
  if (fs.statSync(absolute).size > 2_000_000) throw new Error('file_too_large');
  const content = fs.readFileSync(absolute, 'utf8');
  if (content.includes('\0')) throw new Error('binary_input_unsupported');
  const lines = content.split(/\r?\n/);
  const messages = [];
  for (let start = 0; start < lines.length; start += 40) {
    const chunk = lines.slice(start, start + 40).join('\n');
    if (chunk.trim()) messages.push({ role: 'artifact', content: chunk,
      locator: { line: start + 1, messageIndex: messages.length + 1 } });
  }
  const stat = fs.statSync(absolute);
  return { sourceId: sourceId('file', absolute), provider: 'explicit-file', sessionId: null,
    capturedAt: stat.mtime.toISOString(), messages, diagnostics: [], label: path.basename(absolute) };
}

function gitSources(workspace, diagnostics) {
  let root;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return []; }
  if (!matchingWorkspace(root, workspace)) return []; // Never silently widen to a parent repository.
  try {
    const output = execFileSync('git', ['log', '-30', '--format=%H%x00%aI%x00%s%x00'],
      { cwd: root, encoding: 'utf8', maxBuffer: 1_000_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return output.split('\n').filter(Boolean).map(line => {
      const [commit, capturedAt, subject] = line.split('\0');
      return { sourceId: sourceId('git', `${root}:${commit}`), provider: 'git-commit', sessionId: commit,
        capturedAt, messages: [], diagnostics: [], label: subject, gitRoot: root };
    }).filter(doc => /^[0-9a-f]{40,64}$/.test(doc.sessionId));
  } catch { diagnostics.push({ code: 'source_unavailable', provider: 'git-commit' }); return []; }
}

// Discovery keeps only catalog metadata and relevance; message bodies are dropped per file
// and parsed again only for the sources a reader selects.
export function summarizeDocument(document, terms = []) {
  const { messages, diagnostics, ...metadata } = document;
  const preview = document.label?.slice(0, PREVIEW_CHARS) || messages.find(message => message.role === 'user')?.content.slice(0, PREVIEW_CHARS)
    || messages[0]?.content.slice(0, PREVIEW_CHARS) || '';
  const lowered = terms.length ? [preview, ...messages.map(message => message.content)].map(text => text.toLowerCase()) : [];
  return { ...metadata, messageCount: messages.length,
    characterCount: messages.reduce((size, message) => size + message.content.length, 0), preview,
    score: terms.reduce((score, term) => score + (lowered.some(text => text.includes(term)) ? 1 : 0), 0) };
}

function scanJsonl(provider, dir, parse, workspace, options, diagnostics) {
  const candidates = [];
  try {
    for (const file of filesUnder(dir)) {
      try { const doc = parse(file, workspace, options.matches, options.terms); if (doc?.messageCount) candidates.push({ ...doc, file }); }
      catch { diagnostics.push({ code: 'source_unavailable', provider }); }
    }
  } catch { diagnostics.push({ code: 'source_unavailable', provider }); }
  return candidates;
}

function rereadJsonl(parse, candidate, workspace) {
  const document = parse(candidate.file, workspace);
  if (document?.sourceId !== candidate.sourceId) throw new Error('source_changed');
  return document;
}

export function readGitCommit(document) {
  const content = execFileSync('git', ['show', '--format=%H%n%aI%n%B', '--no-ext-diff', '--no-textconv', document.sessionId],
    { cwd: document.gitRoot, encoding: 'utf8', maxBuffer: 4_000_000, stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = content.split(/\r?\n/);
  const messages = [];
  for (let start = 0; start < lines.length; start += 40) {
    const chunk = lines.slice(start, start + 40).join('\n');
    if (chunk.trim()) messages.push({ role: 'artifact', content: chunk,
      locator: { line: start + 1, messageIndex: messages.length + 1 } });
  }
  const { sourceId, provider, sessionId, capturedAt, label, gitRoot } = document;
  return { sourceId, provider, sessionId, capturedAt, messages, diagnostics: [], label, gitRoot };
}

// Each provider discovers lightweight candidates and can expand one selected candidate.
// A new AI source only needs to implement this pair and return the shared document shape from read.
export const SOURCE_PROVIDERS = Object.freeze([
  { id: 'codex-jsonl', discover: (workspace, options, diagnostics) => scanJsonl('codex-jsonl',
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'), parseCodexSession, workspace, options, diagnostics),
    read: (candidate, workspace) => rereadJsonl(parseCodexSession, candidate, workspace) },
  { id: 'claude-code-jsonl', discover: (workspace, options, diagnostics) => scanJsonl('claude-code-jsonl',
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'), parseClaudeSession, workspace, options, diagnostics),
    read: (candidate, workspace) => rereadJsonl(parseClaudeSession, candidate, workspace) },
  { id: 'explicit-file', discover: (workspace, options, diagnostics) => (options.inputs || []).flatMap(file => {
    try { const doc = fileSource(file); return [{ ...summarizeDocument(doc, options.terms), file }]; }
    catch (error) { diagnostics.push({ code: 'source_unavailable', provider: 'explicit-file', detail: error.message }); return []; }
  }), read: candidate => fileSource(candidate.file) },
  { id: 'git-commit', discover: (workspace, options, diagnostics) => options.includeGit === false ? []
    : gitSources(workspace, diagnostics).map(doc => summarizeDocument(doc, options.terms)),
    read: readGitCommit }
]);

export function discoverProviders(workspace, inputs = [], options = {}) {
  const diagnostics = [], documents = [];
  const shared = { ...options, inputs, terms: options.terms || [], matches: workspaceMatcher(workspace) };
  for (const provider of SOURCE_PROVIDERS) documents.push(...provider.discover(workspace, shared, diagnostics));
  return { documents, diagnostics };
}

export function readProvider(candidate, workspace) {
  const provider = SOURCE_PROVIDERS.find(entry => entry.id === candidate.provider);
  if (!provider) throw new Error('unsupported_provider');
  return provider.read(candidate, workspace);
}
