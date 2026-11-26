// The Tistory editor inserts an uploaded image at the caret. A long paragraph wraps over several lines, so clicking it
// and pressing End only reached the end of the clicked line and the image split the paragraph ("block N text differs").
// This editor stand-in inserts at the caret like TinyMCE and is narrow enough to wrap the paragraph.
import { chromium } from 'playwright-core';
import path from 'node:path';
import { uploadTistoryImages } from '../next/browser-adapter.mjs';

const longText = '긴 문단입니다. '.repeat(40).trim();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  const imagePath = path.resolve('tests/fixtures/postgen-editor-test.png');
  await page.setContent(`<button id="mceu_0-open" onclick="document.querySelector('#attach-image').hidden=false">첨부</button><button id="attach-image" hidden onclick="document.querySelector('#file').click()">사진</button><input id="file" type="file" hidden><iframe id="editor-tistory_ifr" style="width:260px;height:600px"></iframe>`);
  await page.locator('#editor-tistory_ifr').evaluate((frame, text) => {
    frame.srcdoc = `<body style="margin:0;font-size:16px"><div id="tinymce" contenteditable="true"><p>짧은 소제목 앞 문단</p><p>${text}</p><p>마지막 문단</p></div></body>`;
  }, longText);
  await page.frameLocator('#editor-tistory_ifr').locator('#tinymce > p').nth(2).waitFor();
  await page.locator('#file').evaluate(input => {
    input.addEventListener('change', () => {
      const doc = document.querySelector('#editor-tistory_ifr').contentDocument;
      const selection = doc.getSelection();
      const range = selection.rangeCount ? selection.getRangeAt(0) : null;
      const image = doc.createElement('img');
      image.src = 'https://blog.kakaocdn.net/test-uploaded-image.png';
      // Like TinyMCE: at the caret, splitting the paragraph when the caret is inside it.
      if (!range) return doc.querySelector('#tinymce').append(image);
      range.collapse(true);
      range.insertNode(image);
    });
  });
  const lines = await page.frameLocator('#editor-tistory_ifr').locator('#tinymce > p').nth(1).evaluate(element => Math.round(element.getBoundingClientRect().height / (parseFloat(getComputedStyle(element).fontSize) * 1.2)));
  if (!(lines > 3)) throw new Error(`The long paragraph must wrap for this test (lines: ${lines})`);
  await uploadTistoryImages(page, [{ id: 'image-1', generatedPath: imagePath, afterParagraph: 2 }]);
  const paragraph = await page.frameLocator('#editor-tistory_ifr').locator('#tinymce > p').nth(1).evaluate(element => ({ text: element.textContent, imageAtEnd: element.lastChild?.nodeName === 'IMG' || element.nextSibling?.nodeName === 'IMG' }));
  if (paragraph.text !== longText) throw new Error('The image split the long paragraph');
  if (!paragraph.imageAtEnd) throw new Error('The image is not at the end of the long paragraph');
  process.stdout.write('Tistory image caret dry run passed: the image goes after a wrapped paragraph without splitting it\n');
} finally { await browser.close(); }
