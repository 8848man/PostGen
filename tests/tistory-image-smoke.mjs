import { chromium } from 'playwright-core';
import path from 'node:path';
import { uploadTistoryImages } from '../next/browser-adapter.mjs';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  const imagePath = path.resolve('tests/fixtures/postgen-editor-test.png');
  await page.setContent(`<button id="mceu_0-open" onclick="document.querySelector('#attach-image').hidden=false">첨부</button><button id="attach-image" hidden onclick="document.querySelector('#file').click()">사진</button><input id="file" type="file" hidden><iframe id="editor-tistory_ifr"></iframe>`);
  await page.locator('#editor-tistory_ifr').evaluate(frame => {
    frame.srcdoc = '<body><div id="tinymce" contenteditable="true"><p>첫 문단</p><p>둘째 문단</p></div></body>';
  });
  const editor = page.frameLocator('#editor-tistory_ifr').locator('#tinymce');
  await editor.fill('첫 문단\n\n둘째 문단');
  const paragraphsAfterFill = await editor.locator(':scope > p').allTextContents();
  if (paragraphsAfterFill.filter(text => text.trim()).length !== 2) throw new Error(`Contenteditable fill did not retain two text paragraphs: ${JSON.stringify(paragraphsAfterFill)}`);
  await page.locator('#file').evaluate(input => {
    input.addEventListener('change', () => {
      const doc = document.querySelector('#editor-tistory_ifr').contentDocument;
      const selected = doc.getSelection().anchorNode?.parentElement?.closest('p') || doc.querySelector('#tinymce > p');
      const image = doc.createElement('img');
      image.src = 'https://blog.kakaocdn.net/test-uploaded-image.png';
      selected.after(image);
    });
  });
  const uploaded = await uploadTistoryImages(page, [{ id: 'image-1', generatedPath: imagePath, afterParagraph: 1 }]);
  if (uploaded.join() !== 'image-1') throw new Error('Image upload result differs');
  const position = await page.frameLocator('#editor-tistory_ifr').locator('#tinymce').evaluate(root => [...root.children].map(child => child.tagName === 'P' && child.textContent.trim() ? 'TEXT' : child.tagName));
  if (!(position.indexOf('TEXT') < position.indexOf('IMG') && position.indexOf('IMG') < position.lastIndexOf('TEXT'))) throw new Error(`Image position differs: ${position}`);
  process.stdout.write('Tistory image upload and paragraph position dry run passed\n');
} finally { await browser.close(); }
