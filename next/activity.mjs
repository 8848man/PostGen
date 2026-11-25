// In-progress work the review screen can show: long-running requests (draft generation, image generation,
// browser input, ...) run inside the server, often in hidden child processes, so the page alone cannot tell
// what is still running after a reload or from another tab. Kept in memory: a server restart ends that work too.
import crypto from 'node:crypto';

export const TRACKED_ROUTES = {
  '/api/job': '작업 만들기(자료 수집)',
  '/api/generate': '초안 생성',
  '/api/evaluate': '초안 평가',
  '/api/images/generate': '이미지 생성',
  '/api/images/regenerate': '이미지 재생성',
  '/api/sample/analyze': '골든 샘플 분석',
  '/api/connector/inspect': 'MCP 서버 확인',
  '/api/prepare-mcp': 'MCP 초안 입력',
  '/api/prepare-browser': '편집기 자동 입력',
  '/api/prepare-browser/resume': '편집기 자동 입력 재개',
  '/api/registration/browser': '플랫폼 예약 등록',
  '/api/registration/mcp': 'MCP 예약 등록',
  '/api/registration/recheck': '예약 목록 다시 확인'
};

const KEEP_FINISHED_MS = 10 * 60_000;
const MAX_FINISHED = 20;

export function createActivityLog(now = () => Date.now()) {
  const entries = new Map();
  const prune = () => {
    const finished = [...entries.values()].filter(entry => entry.status !== 'running').sort((a, b) => b.finishedAt - a.finishedAt);
    finished.forEach((entry, index) => { if (index >= MAX_FINISHED || now() - entry.finishedAt > KEEP_FINISHED_MS) entries.delete(entry.id); });
  };
  return {
    // Same task on the same job and image cannot run twice (two tabs, double clicks).
    start({ route, label, jobId = null, imageId = null, title = null, detail = null }) {
      const duplicate = [...entries.values()].find(entry => entry.status === 'running' && entry.route === route && entry.jobId === jobId && entry.imageId === imageId && jobId);
      if (duplicate) throw new Error(`${label} is already running for this item; wait for it to finish`);
      const entry = { id: crypto.randomUUID(), route, label, jobId, imageId, title, detail, status: 'running', startedAt: now(), finishedAt: null, error: null };
      entries.set(entry.id, entry);
      return entry.id;
    },
    finish(id, error = null) {
      const entry = entries.get(id);
      if (!entry || entry.status !== 'running') return;
      entry.status = error ? 'failed' : 'done';
      entry.error = error ? String(error).slice(0, 300) : null;
      entry.finishedAt = now();
      prune();
    },
    list() {
      prune();
      const at = now();
      return [...entries.values()]
        .sort((a, b) => (a.status === 'running') === (b.status === 'running') ? b.startedAt - a.startedAt : a.status === 'running' ? -1 : 1)
        .map(entry => ({ ...entry, startedAt: new Date(entry.startedAt).toISOString(), finishedAt: entry.finishedAt ? new Date(entry.finishedAt).toISOString() : null, elapsedMs: (entry.finishedAt || at) - entry.startedAt }));
    }
  };
}
