// Fill the composer of X, LinkedIn, Instagram or Reddit in the posting Chrome and read it back. PostGen never presses
// the platform's post button: the user checks the filled composer and posts it (platform terms restrict automated
// posting). Selectors follow each site's web composer as described on 2026-11-26 and are not yet confirmed against
// real accounts: when an expected element is missing the step stops with its name instead of guessing.
import fs from 'node:fs';
import { socialPostText } from '../skill/postgen/scripts/channel-rules.mjs';

const TIMEOUT = 15_000;

class ComposerError extends Error {}
const fail = message => { throw new ComposerError(message); };

// The first of several candidate selectors that is visible on the page.
async function firstVisible(scope, selectors, label, timeout = TIMEOUT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const candidate = scope.locator(selector).filter({ visible: true });
      const count = await candidate.count().catch(() => 0);
      if (count === 1) return candidate;
      if (count > 1) return candidate.first();
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return fail(`${label} was not found; check that the composer is open and signed in`);
}

// Rich-text composers ignore fill(); type line by line so paragraphs become real line breaks.
async function typeText(page, editor, text) {
  await editor.click();
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line) await page.keyboard.insertText(line);
    if (index < lines.length - 1) await page.keyboard.press('Enter');
  }
}

export const normalizeComposerText = text => String(text || '').replace(/[​‌‍﻿]/g, '').replace(/ /g, ' ').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

async function readBack(editor, expected, label) {
  const actual = normalizeComposerText(await editor.innerText());
  if (actual !== normalizeComposerText(expected)) fail(`${label} text differs from the approved draft after input`);
}

const imagePaths = job => job.draft.images.slice().sort((a, b) => a.afterParagraph - b.afterParagraph).map(image => {
  if (!image.generatedPath || !fs.existsSync(image.generatedPath)) fail('Approved image file is missing; make the image again before publishing');
  return image.generatedPath;
});

async function chooseFiles(page, trigger, paths) {
  const chooser = page.waitForEvent('filechooser', { timeout: TIMEOUT });
  await trigger.click();
  await (await chooser).setFiles(paths);
}

async function waitForCount(locator, expected, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await locator.count() >= expected) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  fail(`${label}: ${expected} image(s) did not appear in the composer`);
}

const composers = {
  async x(page, job, text, paths) {
    const editor = await firstVisible(page, ['[data-testid="tweetTextarea_0"]', 'div[role="textbox"][data-testid^="tweetTextarea"]'], 'X post box');
    const switcher = page.locator('[data-testid="SideNav_AccountSwitcher_Button"]');
    const visible = (await switcher.count()) ? (await switcher.first().innerText().catch(() => '')) : '';
    const accountVerified = visible ? visible.toLowerCase().includes(`@${job.accountHandle.toLowerCase()}`) : null;
    if (accountVerified === false) fail(`X is signed in to a different account than @${job.accountHandle}`);
    if (paths.length) {
      await page.locator('input[data-testid="fileInput"]').first().setInputFiles(paths);
      await waitForCount(page.locator('[data-testid="attachments"] img, [data-testid="attachments"] [data-testid="tweetPhoto"]'), paths.length, 'X images');
    }
    await typeText(page, editor, text);
    await readBack(editor, text, 'X post');
    return { accountVerified: accountVerified === true };
  },
  async linkedin(page, job, text, paths) {
    const start = await firstVisible(page, ['button.share-box-feed-entry__trigger', 'button:has-text("Start a post")', 'button:has-text("게시물 시작")'], 'LinkedIn "Start a post" button');
    await start.click();
    const dialog = await firstVisible(page, ['div[role="dialog"]:has(.ql-editor)', 'div[role="dialog"]'], 'LinkedIn post dialog');
    if (paths.length) {
      const media = await firstVisible(dialog, ['button[aria-label*="media" i]', 'button[aria-label*="사진"]', 'button[aria-label*="미디어"]'], 'LinkedIn media button');
      await chooseFiles(page, media, paths);
      const next = await firstVisible(page, ['div[role="dialog"] button:has-text("Next")', 'div[role="dialog"] button:has-text("다음")', 'div[role="dialog"] button:has-text("Done")', 'div[role="dialog"] button:has-text("완료")'], 'LinkedIn media "Next" button', 60_000);
      await next.click();
    }
    const editor = await firstVisible(page, ['div[role="dialog"] .ql-editor[contenteditable="true"]', 'div[role="dialog"] div[role="textbox"][contenteditable="true"]'], 'LinkedIn post editor');
    await typeText(page, editor, text);
    await readBack(editor, text, 'LinkedIn post');
    if (paths.length) await waitForCount(page.locator('div[role="dialog"] img[src^="blob:"], div[role="dialog"] .share-media img, div[role="dialog"] [class*="image"] img'), paths.length, 'LinkedIn images');
    return { accountVerified: false };
  },
  async instagram(page, job, text, paths) {
    if (!paths.length) fail('Instagram posts need at least one image');
    const profile = page.locator(`a[href="/${job.accountHandle}/"]`);
    const accountVerified = (await profile.count()) > 0;
    const create = await firstVisible(page, ['svg[aria-label="New post"]', 'svg[aria-label="새로운 게시물"]', 'svg[aria-label="만들기"]', 'svg[aria-label="Create"]'], 'Instagram "Create" button');
    await create.click();
    const postItem = page.locator('a:has(svg[aria-label="Post"]), a:has(svg[aria-label="게시물"]), span:text-is("Post"), span:text-is("게시물")').filter({ visible: true });
    if (await postItem.count()) await postItem.first().click();
    const select = await firstVisible(page, ['div[role="dialog"] button:has-text("Select from computer")', 'div[role="dialog"] button:has-text("컴퓨터에서 선택")'], 'Instagram "Select from computer" button');
    await chooseFiles(page, select, paths);
    for (let step = 0; step < 2; step++) {
      const next = await firstVisible(page, ['div[role="dialog"] div[role="button"]:text-is("Next")', 'div[role="dialog"] div[role="button"]:text-is("다음")'], 'Instagram "Next" button', 60_000);
      await next.click();
    }
    const editor = await firstVisible(page, ['div[role="dialog"] div[aria-label="Write a caption..."]', 'div[role="dialog"] div[aria-label="문구를 입력하세요..."]', 'div[role="dialog"] div[role="textbox"][contenteditable="true"]'], 'Instagram caption box');
    await typeText(page, editor, text);
    await readBack(editor, text, 'Instagram caption');
    return { accountVerified };
  },
  async reddit(page, job, text, paths) {
    if (paths.length) fail('Reddit posts are text only; remove the image suggestions');
    const title = await firstVisible(page, ['textarea[name="title"]', 'input[name="title"]', 'faceplate-textarea-input[name="title"] textarea'], 'Reddit title box');
    await title.fill(job.draft.title);
    if ((await title.inputValue()).trim() !== job.draft.title.trim()) fail('Reddit title differs from the approved draft after input');
    const editor = await firstVisible(page, ['div[name="body"][contenteditable="true"]', 'shreddit-composer div[contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]'], 'Reddit body box');
    await typeText(page, editor, text);
    await readBack(editor, text, 'Reddit post');
    return { accountVerified: false };
  }
};

// Fills the composer and returns the editor record for reviewPreparation. The text compared is the draft body plus the
// hashtag line; the record keeps the draft's own title and body so an exact match means "as approved".
export async function fillSocialComposer(page, job) {
  const compose = composers[job.channel];
  if (!compose) throw new Error('No composer for this channel');
  const text = socialPostText(job.channel, job.draft.body, job.draft.tags || []);
  const paths = imagePaths(job);
  try {
    const { accountVerified } = await compose(page, job, text, paths);
    return { editorUrl: page.url(), visibleAccount: job.accountHandle, accountVerified, title: job.draft.title, body: job.draft.body, uploadedImages: job.draft.images.map(image => image.id), verification: 'browser-readback', postedBy: 'user' };
  } catch (error) {
    if (error instanceof ComposerError) error.stage = '작성 창 입력';
    throw error;
  }
}

// Signed in when the platform's session cookie is present in the posting Chrome (same signal as the settings check).
const SESSION_COOKIES = { x: ['https://x.com', 'auth_token'], linkedin: ['https://www.linkedin.com', 'li_at'], instagram: ['https://www.instagram.com', 'sessionid'], reddit: ['https://www.reddit.com', 'reddit_session'] };
export async function socialSignedIn(page, channel) {
  const [url, name] = SESSION_COOKIES[channel] || [];
  if (!url) return false;
  return (await page.context().cookies(url)).some(cookie => cookie.name === name && cookie.value);
}
