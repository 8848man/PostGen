// How long one Codex image takes, so the activity panel can fill a progress bar while an image is being made.
// Keeps the last 20 successful image durations next to jobs.json; a missing or broken file falls back to the default.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../skill/postgen/scripts/profile.mjs';

export const DEFAULT_IMAGE_MS = 90_000;
const KEEP = 20;
const file = () => path.join(process.env.POSTGEN_NEXT_DIR || path.join(dataDir(), 'next'), 'image-timing.json');

function load() {
  try {
    const value = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(value?.durationsMs) ? value.durationsMs.filter(ms => Number.isFinite(ms) && ms > 0 && ms < 3_600_000) : [];
  } catch { return []; }
}

export function averageImageMs() {
  const durations = load();
  return durations.length ? Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length) : DEFAULT_IMAGE_MS;
}

export function recordImageDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const durations = [...load(), Math.round(ms)].slice(-KEEP);
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file(), JSON.stringify({ durationsMs: durations }), { mode: 0o600 });
  } catch { /* timing is only a display hint */ }
}
