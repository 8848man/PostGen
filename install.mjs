import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(root, 'skill', 'postgen');

export function installPath(home = os.homedir(), codexHome = process.env.CODEX_HOME) {
  const standard = path.join(home, '.agents', 'skills', 'postgen');
  const existingCodex = path.join(codexHome || path.join(home, '.codex'), 'skills', 'postgen');
  if (fs.existsSync(standard)) return standard;
  if (fs.existsSync(existingCodex)) return existingCodex;
  return standard;
}

function filesUnder(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Cannot install a linked file: ${relative}`);
    if (entry.isDirectory()) return filesUnder(path.join(directory, entry.name), relative);
    return entry.isFile() ? [relative] : [];
  });
}

export function install({ destination = installPath(), skillSource = source } = {}) {
  const manifest = path.join(skillSource, 'SKILL.md');
  if (!fs.existsSync(manifest)) throw new Error('Postgen source SKILL.md is missing');
  if (fs.existsSync(destination)) {
    if (fs.lstatSync(destination).isSymbolicLink()) throw new Error('Install destination cannot be a link');
    if (!fs.statSync(destination).isDirectory()) throw new Error('Install destination is not a directory');
    const existingManifest = path.join(destination, 'SKILL.md');
    if (!fs.existsSync(existingManifest) || !/^name:\s*postgen\s*$/m.test(fs.readFileSync(existingManifest, 'utf8')))
      throw new Error('Install destination contains a different skill');
  }
  const files = filesUnder(skillSource);
  // Check every existing path before copying, so a link cannot redirect writes outside the skill.
  for (const relative of files) {
    let current = destination;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
        throw new Error(`Install destination contains a linked path: ${relative}`);
    }
  }
  for (const relative of files) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(skillSource, relative), target);
  }
  if (!fs.existsSync(path.join(destination, 'scripts', 'collect.mjs')))
    throw new Error('Installed skill is incomplete');
  return { destination, files: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required');
    const result = install();
    console.log(`Postgen installed: ${result.destination}`);
    console.log('Open Codex in a project folder and ask: $postgen으로 이 프로젝트 작업 기록을 블로그 글로 만들어줘');
  } catch (error) {
    console.error(`Postgen install failed: ${error.message}`);
    process.exitCode = 1;
  }
}
