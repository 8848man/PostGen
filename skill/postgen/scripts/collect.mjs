import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProviders, normalizeWorkspace, parseCodexSession, readProvider, sourceId } from './source-providers.mjs';

const DEFAULT_READ_CHARS = 36_000;
const DEFAULT_LIST_LIMIT = 40;
export const parseSession = parseCodexSession;

const keywords = query => String(query || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
// Candidates carry a precomputed relevance score instead of message bodies.
function candidates(workspace, options) {
  const result = discoverProviders(workspace, options.inputs || [], { includeGit: options.includeGit, terms: keywords(options.query) });
  result.documents.sort((a, b) => b.score - a.score
    || String(b.capturedAt || '').localeCompare(String(a.capturedAt || '')));
  return result;
}

export function discover(workspace = process.cwd(), options = {}) {
  const { documents, diagnostics } = candidates(workspace, options);
  const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_LIST_LIMIT, 1), 100);
  const offset = Math.max(Number(options.offset) || 0, 0);
  return { schemaVersion: 'source-catalog/v1', workspaceRef: sourceId('workspace', normalizeWorkspace(workspace)),
    total: documents.length, offset, sources: documents.slice(offset, offset + limit).map(document => ({
      sourceId: document.sourceId, provider: document.provider, capturedAt: document.capturedAt,
      messageCount: document.provider === 'git-commit' ? null : document.messageCount,
      characterCount: document.provider === 'git-commit' ? null : document.characterCount, preview: document.preview
    })), diagnostics };
}

function fitMessages(messages, budget) {
  const total = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (total <= budget) return { messages, truncated: false };
  const head = Math.floor(budget / 2), tail = budget - head;
  const result = []; let used = 0;
  for (const message of messages) {
    if (used >= head) break;
    const content = message.content.slice(0, head - used);
    if (content) result.push({ ...message, content, excerpt: 'start' });
    used += content.length;
  }
  const ending = []; used = 0;
  for (let i = messages.length - 1; i >= 0 && used < tail; i--) {
    const message = messages[i];
    const content = message.content.slice(-Math.min(message.content.length, tail - used));
    if (content) ending.unshift({ ...message, content, excerpt: 'end' });
    used += content.length;
  }
  return { messages: [...result, ...ending], truncated: true };
}

export function read(workspace = process.cwd(), options = {}) {
  const { documents, diagnostics } = candidates(workspace, options);
  const workspaceRef = sourceId('workspace', normalizeWorkspace(workspace));
  const ids = new Set(options.sourceIds || []);
  const chosen = ids.size ? documents.filter(document => ids.has(document.sourceId)) : documents;
  const budget = Math.min(Math.max(Number(options.maxChars) || DEFAULT_READ_CHARS, 1000), 120_000);
  const sourceDocuments = []; let remaining = budget;
  for (const candidate of chosen) {
    if (remaining < 1000) { diagnostics.push({ code: 'budget_exhausted', sourceId: candidate.sourceId }); break; }
    let document;
    try { document = readProvider(candidate, workspace); }
    catch { diagnostics.push({ code: 'source_unavailable', provider: candidate.provider, sourceId: candidate.sourceId }); continue; }
    const fitted = fitMessages(document.messages, remaining);
    const { gitRoot, label, ...safeDocument } = document;
    sourceDocuments.push({ ...safeDocument, workspaceRef, messages: fitted.messages });
    remaining -= fitted.messages.reduce((sum, message) => sum + message.content.length, 0);
    if (fitted.truncated) diagnostics.push({ code: 'truncated', sourceId: document.sourceId });
  }
  for (const id of ids) if (!documents.some(document => document.sourceId === id)) diagnostics.push({ code: 'source_unavailable', sourceId: id });
  if (!sourceDocuments.length) diagnostics.push({ code: 'insufficient_sources' });
  return { schemaVersion: 'source-bundle/v1', workspaceRef,
    sessionCount: sourceDocuments.length, characterBudget: budget, sourceDocuments, diagnostics };
}

export const collect = read;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const values = name => args.flatMap((arg, index) => arg === name && args[index + 1] ? [args[index + 1]] : []);
  const value = (name, fallback) => values(name).at(-1) || fallback;
  const workspace = value('--workspace', process.cwd());
  const options = { inputs: values('--input'), sourceIds: values('--source-id'), query: value('--query', ''),
    limit: value('--limit', DEFAULT_LIST_LIMIT), offset: value('--offset', 0), maxChars: value('--max-chars', DEFAULT_READ_CHARS),
    includeGit: !args.includes('--no-git') };
  const mode = value('--mode', 'discover');
  const result = mode === 'read' && !options.sourceIds.length
    ? { schemaVersion: 'source-bundle/v1', sourceDocuments: [], diagnostics: [{ code: 'selection_required' }] }
    : mode === 'read' ? read(workspace, options) : discover(workspace, options);
  console.log(JSON.stringify(result));
}
