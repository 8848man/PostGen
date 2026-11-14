import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { importGeneratedImage } from '../next/images.mjs';

test('host image import copies a real image and rejects mislabeled content', async () => {
  const dir = fs.mkdtempSync(path.join(path.resolve('tests'), '.host-image-'));
  const previous = process.env.POSTGEN_NEXT_DIR;
  process.env.POSTGEN_NEXT_DIR = dir;
  try {
    const source = path.join(dir, 'source.png');
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(source, image);
    const stored = await importGeneratedImage(source);
    assert.notEqual(stored, source);
    assert.deepEqual(fs.readFileSync(stored), image);
    const invalid = path.join(dir, 'invalid.png');
    fs.writeFileSync(invalid, 'not an image');
    await assert.rejects(importGeneratedImage(invalid), /content does not match/);
  } finally {
    if (previous === undefined) delete process.env.POSTGEN_NEXT_DIR;
    else process.env.POSTGEN_NEXT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
