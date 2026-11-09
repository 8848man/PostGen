import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, installPath } from '../install.mjs';

function removeFixture(root) {
  const base = path.resolve(os.tmpdir()) + path.sep;
  const target = path.resolve(root);
  if (!target.startsWith(base)) throw new Error('Refusing to remove a path outside the test temp directory');
  fs.rmSync(target, { recursive: true, force: true });
}

test('one command installer copies the complete skill and updates an existing Postgen installation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-install-'));
  try {
    const destination = installPath(root, path.join(root, '.codex'));
    assert.equal(destination, path.join(root, '.agents', 'skills', 'postgen'));
    const first = install({ destination });
    assert.ok(first.files >= 10);
    assert.ok(fs.existsSync(path.join(destination, 'scripts', 'collect.mjs')));
    assert.ok(fs.existsSync(path.join(destination, 'web', 'index.html')));
    fs.writeFileSync(path.join(destination, 'scripts', 'collect.mjs'), 'old version');
    install({ destination });
    assert.notEqual(fs.readFileSync(path.join(destination, 'scripts', 'collect.mjs'), 'utf8'), 'old version');
  } finally { removeFixture(root); }
});

test('installer preserves an unrelated existing skill and reuses a legacy Postgen path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-install-'));
  try {
    const legacy = path.join(root, '.codex', 'skills', 'postgen');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'SKILL.md'), '---\nname: other\n---\n');
    assert.equal(installPath(root, path.join(root, '.codex')), legacy);
    assert.throws(() => install({ destination: legacy }), /different skill/);
    assert.equal(fs.readFileSync(path.join(legacy, 'SKILL.md'), 'utf8'), '---\nname: other\n---\n');
  } finally { removeFixture(root); }
});
