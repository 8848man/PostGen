import { chromium } from 'playwright-core';
import path from 'node:path';
import { uploadNaverImages } from '../next/browser-adapter.mjs';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<iframe id="mainFrame"></iframe>');
  await page.locator('#mainFrame').evaluate(frame => {
    frame.srcdoc = '<button id="photo" onclick="document.querySelector(\'#file\').click()">사진 추가</button><input id="file" type="file" hidden><article><div class="se-component" data-a11y-title="본문"><p class="se-text-paragraph"><span class="__se-node">첫 문단</span></p></div><div class="se-component" data-a11y-title="본문"><p class="se-text-paragraph"><span class="__se-node">둘째 문단</span></p></div></article>';
  });
  await page.frameLocator('#mainFrame').locator('#file').evaluate(input => {
    input.addEventListener('change', () => {
      const doc = input.ownerDocument;
      const image = doc.createElement('img');
      image.className = 'se-image-resource';
      image.src = 'https://blogfiles.pstatic.net/test-uploaded-image.png';
      const wrapper = doc.createElement('div');
      wrapper.className = 'se-image';
      wrapper.append(image);
      doc.querySelector('.se-component[data-a11y-title="본문"]').after(wrapper);
    });
  });
  const uploaded = await uploadNaverImages(page, [{ id: 'image-1', afterParagraph: 1, generatedPath: path.resolve('tests/fixtures/postgen-editor-test.png') }]);
  if (uploaded.join() !== 'image-1') throw new Error('Naver image result differs');
  process.stdout.write('Naver image upload and paragraph position dry run passed\n');
} finally { await browser.close(); }
