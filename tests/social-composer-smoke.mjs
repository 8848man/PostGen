// Composer filling for X, LinkedIn, Instagram and Reddit on stand-in pages that use the same selectors as the sites.
// Each page has a post button that records clicks: PostGen must never press it.
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { fillSocialComposer } from '../next/social-composer.mjs';
import { socialPostText } from '../skill/postgen/scripts/channel-rules.mjs';

const image = path.resolve('tests/fixtures/postgen-editor-test.png');
const draft = (overrides = {}) => ({ title: '[PostGen] 내부 제목', body: '첫 문단입니다.\n\n둘째 문단입니다.', tags: ['AI 협업', 'PostGen'], images: [{ id: 'img-1', afterParagraph: 1, generatedPath: image }], ...overrides });
const job = (channel, overrides) => ({ id: 'job', channel, accountHandle: 'me', draft: draft(overrides) });

// File inputs add a thumbnail; a "post" button counts clicks.
const common = `<script>
window.postClicks = 0;
function thumbs(input, target) { input.addEventListener('change', () => { for (const file of input.files) { const img = document.createElement('img'); img.src = 'blob:local/' + file.name; document.querySelector(target).append(img); } }); }
</script>`;
const pages = {
  x: `${common}<nav><button data-testid="SideNav_AccountSwitcher_Button">Me @me</button></nav>
    <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" style="min-height:40px"></div>
    <input type="file" data-testid="fileInput" multiple hidden><div data-testid="attachments"></div>
    <button data-testid="tweetButton" onclick="postClicks++">Post</button>
    <script>thumbs(document.querySelector('[data-testid=fileInput]'), '[data-testid=attachments]')</script>`,
  linkedin: `${common}<button class="share-box-feed-entry__trigger" onclick="document.querySelector('#dialog').hidden=false">Start a post</button>
    <div id="dialog" role="dialog" hidden>
      <div class="ql-editor" contenteditable="true" style="min-height:40px"></div>
      <button aria-label="Add media" onclick="document.querySelector('#file').click()">media</button><input id="file" type="file" multiple hidden>
      <div class="share-media"></div><button onclick="this.hidden=true">Next</button>
      <button class="share-actions__primary-action" onclick="postClicks++">Post</button>
    </div><script>thumbs(document.querySelector('#file'), '.share-media')</script>`,
  instagram: `${common}<a href="/me/">profile</a><a href="#" onclick="document.querySelector('#dialog').hidden=false"><svg aria-label="New post" width="20" height="20"><rect width="20" height="20"/></svg></a>
    <div id="dialog" role="dialog" hidden>
      <button onclick="document.querySelector('#file').click()">Select from computer</button><input id="file" type="file" multiple hidden>
      <div id="steps"></div>
      <div aria-label="Write a caption..." role="textbox" contenteditable="true" style="min-height:40px"></div>
      <div role="button" onclick="postClicks++">Share</div>
    </div>
    <script>document.querySelector('#file').addEventListener('change', () => { const steps = document.querySelector('#steps'); for (let i = 0; i < 2; i++) { const next = document.createElement('div'); next.setAttribute('role', 'button'); next.textContent = 'Next'; next.onclick = () => next.remove(); steps.append(next); } });</script>`,
  reddit: `${common}<textarea name="title"></textarea><div name="body" contenteditable="true" style="min-height:40px"></div><button onclick="postClicks++">Post</button>`
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const channel of ['x', 'linkedin', 'instagram', 'reddit']) {
    const page = await browser.newPage();
    await page.setContent(pages[channel]);
    const target = job(channel, channel === 'reddit' ? { images: [] } : {});
    const editor = await fillSocialComposer(page, target);
    assert.equal(editor.body, target.draft.body, `${channel}: the record keeps the approved body`);
    assert.equal(editor.postedBy, 'user');
    assert.deepEqual(editor.uploadedImages, target.draft.images.map(item => item.id));
    assert.equal(await page.evaluate(() => window.postClicks), 0, `${channel}: the post button must not be pressed`);
    if (channel === 'x') assert.equal(editor.accountVerified, true);
    if (channel === 'reddit') {
      assert.equal(await page.locator('textarea[name=title]').inputValue(), target.draft.title);
      assert.ok(!(await page.locator('div[name=body]').innerText()).includes('#'), 'Reddit has no hashtags');
    }
    const typed = await page.locator('[contenteditable="true"]').first().innerText();
    assert.ok(typed.replace(/\n+/g, '\n').includes(socialPostText(channel, target.draft.body, target.draft.tags).split('\n\n').at(-1)), `${channel}: text with hashtags typed`);
    await page.close();
  }

  // A different signed-in X account stops before typing.
  const other = await browser.newPage();
  await other.setContent(pages.x.replace('@me', '@someone'));
  await assert.rejects(fillSocialComposer(other, job('x')), /different account/);
  // A missing composer stops with its name.
  const empty = await browser.newPage();
  await empty.setContent('<p>signed out</p>');
  const started = Date.now();
  await assert.rejects(fillSocialComposer(empty, job('reddit', { images: [] })), /Reddit title box was not found/);
  assert.ok(Date.now() - started < 30_000);
  // Reddit with images and Instagram without images are refused before touching the page.
  await assert.rejects(fillSocialComposer(empty, job('reddit')), /text only/);
  await assert.rejects(fillSocialComposer(empty, job('instagram', { images: [] })), /at least one image/);
  console.log('Social composer smoke passed: X, LinkedIn, Instagram and Reddit filled and read back, post buttons untouched');
} finally { await browser.close(); }
