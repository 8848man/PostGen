#!/usr/bin/env node
// Runs next-cli against the review screen's data folder, so agents need no environment variable prefix.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from './open-review.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolveDataDir();
if (!dataDir) {
  console.error('Review screen data folder not found. Set POSTGEN_DATA_DIR or check the posting Chrome data folder.');
  process.exit(1);
}
const result = spawnSync(process.execPath, [path.join(projectRoot, 'skill', 'postgen', 'scripts', 'next-cli.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, POSTGEN_DATA_DIR: dataDir },
});
process.exit(result.status ?? 1);
