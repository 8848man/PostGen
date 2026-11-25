// Dry run of Tistory HTML input against a stand-in editor (TinyMCE API + iframe), no network.
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fillNativeEditorPage, readTistoryBlocks } from '../next/browser-adapter.mjs';

const editorPage = `<!doctype html><meta charset="utf-8">
<input id="post-title-inp">
<button id="mceu_0-open" onclick="document.querySelector('#attach-image').hidden=false">첨부</button>
<button id="attach-image" hidden onclick="document.querySelector('#file').click()">사진</button>
<input id="file" type="file" hidden>
<iframe id="editor-tistory_ifr" srcdoc="<body><div id='tinymce' contenteditable='true'><p><br></p></div></body>"></iframe>
<script>
  const doc = () => document.querySelector('#editor-tistory_ifr').contentDocument;
  // Like TinyMCE, store <b> as <strong>.
  const editor = { setContent(html) { doc().querySelector('#tinymce').innerHTML = html.replace(/<b>/g, '<strong>').replace(/<\\/b>/g, '</strong>'); }, undoManager: { add() {} }, nodeChanged() {}, fire() {} };
  window.tinymce = { get: id => id === 'editor-tistory' ? editor : null, activeEditor: editor };
  document.querySelector('#file').addEventListener('change', () => {
    const selected = doc().getSelection().anchorNode;
    const target = (selected.nodeType === 1 ? selected : selected.parentElement).closest('p, h2, h3, li');
    const figure = doc().createElement('figure');
    figure.innerHTML = '<img src="https://blog.kakaocdn.net/test-' + Date.now() + '.png">';
    target.after(figure);
  });
</script>`;

const body = ['도입 문단입니다.', '', '목차', '1. 첫째 방법', '2. 둘째 방법', '', '1. 첫째 방법', '① 작은 항목', '설명 문단입니다.', '- 횟수: 하루 한 번', '✔ 정리 방법: 오늘 해 보세요.', '2. 둘째 방법', 'Q1. 매일 해야 하나요?', '네, 짧게라도 좋습니다.'].join('\n');
const headings = ['1. 첫째 방법', '① 작은 항목', '2. 둘째 방법'];
const imagePath = path.resolve('tests/fixtures/postgen-editor-test.png');
const job = (images) => ({ channel: 'tistory', accountHandle: 'me', draft: { title: '제목', body, headings, images } });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const open = async () => {
    const page = await browser.newPage();
    await page.route('https://me.tistory.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: editorPage }));
    await page.goto('https://me.tistory.com/manage/newpost');
    return page;
  };
  const page = await open();
  // Image after block 5, which is the first big heading.
  const result = await fillNativeEditorPage(page, job([{ id: 'image-1', generatedPath: imagePath, afterParagraph: 5 }]));
  if (result.body !== body.trim() || result.uploadedImages.join() !== 'image-1') throw new Error(`Fill result differs: ${JSON.stringify(result)}`);
  const blocks = await readTistoryBlocks(page);
  const tags = blocks.map(block => block.tag).join(',');
  if (tags !== 'p,p,li,li,h2,h3,p,li,p,h2,p,p') throw new Error(`Block tags differ: ${tags}`);
  if (blocks[7].bold !== '횟수:' || !blocks[8].colored || blocks[8].bold !== '✔ 정리 방법:') throw new Error(`Emphasis differs: ${JSON.stringify(blocks.slice(7, 9))}`);
  const order = await page.frameLocator('#editor-tistory_ifr').locator('#tinymce').evaluate(root => [...root.children].map(child => child.tagName).join(','));
  if (!order.startsWith('P,P,UL,H2,FIGURE,H3')) throw new Error(`Image is not right under the first heading: ${order}`);

  const listPage = await open();
  let rejected = false;
  try { await fillNativeEditorPage(listPage, job([{ id: 'image-2', generatedPath: imagePath, afterParagraph: 8 }])); }
  catch (error) { rejected = /inside a list/.test(error.message); }
  if (!rejected) throw new Error('Image inside a list was not rejected');
  process.stdout.write('Tistory HTML input, readback and image position dry run passed\n');
} finally { await browser.close(); }
