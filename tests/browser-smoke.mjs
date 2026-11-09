import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { fillEditorPage } from '../next/browser-adapter.mjs';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const imagePath = path.resolve('tests/.browser-smoke-image.png');
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.resolve('tests/fixtures/editor.html')).href);
  const editor = await fillEditorPage(page, { accountSelector: '#account', titleSelector: '#title', bodySelector: '#body' }, { accountHandle: 'test-account', draft: { title: '검증 제목', body: '검증 본문', images: [] } });
  fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64'));
  await page.goto(pathToFileURL(path.resolve('tests/fixtures/image-editor.html')).href);
  const imageJob = { accountHandle: 'test-account', draft: { title: '검증 제목', body: '검증 본문', images: [{ id: 'image-1', afterParagraph: 1, generatedPath: imagePath }] } };
  const withImage = await fillEditorPage(page, { accountSelector: '#account', titleSelector: '#title', bodySelector: '#body', imageSlots: [{ fileInputSelector: '#image', renderedImageSelector: '#inserted', paragraphSelector: '.paragraph', afterParagraph: 1 }] }, imageJob);
  if (withImage.uploadedImages[0] !== 'image-1') throw new Error('Image position verification failed');
  process.stdout.write(JSON.stringify({ title: editor.title, body: editor.body, verification: editor.verification }) + '\n');
} finally { await browser.close(); if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath); }
