import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { dataDir } from '../skill/postgen/scripts/profile.mjs';

const sessions = new Map();
let attachedEdge = null;
const profileRoot = () => path.join(process.env.POSTGEN_NEXT_DIR || path.join(dataDir(), 'next'), 'browser-profiles');
const channels = {
  naver: hostname => hostname === 'blog.naver.com' || hostname.endsWith('.blog.naver.com'),
  tistory: hostname => hostname === 'tistory.com' || hostname.endsWith('.tistory.com')
};
export function edgeCdpEndpoint(value) {
  if (value === 'msedge') return value;
  let url;
  try { url = new URL(value); } catch { throw new Error('Edge CDP endpoint must be msedge or a loopback HTTP URL'); }
  const port = Number(url.port);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !Number.isInteger(port) || port < 1 || port > 65535 || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Edge CDP endpoint must use a local HTTP port');
  return url.origin;
}
export async function connectExistingEdge(value, connect = (endpoint, options) => chromium.connectOverCDP(endpoint, options), readVersion = async endpoint => {
  const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Browser debugging endpoint is unavailable');
  return response.json();
}) {
  const endpoint = edgeCdpEndpoint(value);
  if (endpoint !== 'msedge') {
    let version;
    try { version = await readVersion(endpoint); } catch { throw new Error('Browser debugging endpoint is unavailable. Open the posting Chrome shortcut first'); }
    // Edge or Chrome only: a dedicated Chrome profile started with --remote-debugging-port does not ask for approval per connection.
    if (typeof version?.Browser !== 'string' || !/^(Edg|Chrome)\//.test(version.Browser)) throw new Error('The local debugging endpoint is not Microsoft Edge or Google Chrome');
  }
  const browser = await connect(endpoint, { timeout: endpoint === 'msedge' ? 60000 : 10000, noDefaults: true, isLocal: true });
  const context = browser.contexts()[0];
  if (!context) throw new Error('The connected browser has no default profile');
  return { browser, context };
}
// Reuse a connection the caller already holds so Edge does not ask for debugging approval again.
export function adoptExistingEdge(connection) {
  if (!connection?.browser?.isConnected() || !connection.context) throw new Error('Edge connection is not active');
  attachedEdge = connection;
}
async function sharedExistingEdge(endpoint) {
  if (attachedEdge?.browser.isConnected()) return attachedEdge;
  attachedEdge = await connectExistingEdge(endpoint);
  return attachedEdge;
}
async function waitForNaverEditor(page, handle, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find(item => item.name() === 'mainFrame');
    if (frame && new URL(frame.url()).searchParams.get('blogId') === handle) return true;
    await page.waitForTimeout(250);
  }
  return false;
}
function unique(page, selector, label) {
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 300) throw new Error(`Missing ${label} selector`);
  return page.locator(selector);
}
async function one(locator, label) { if (await locator.count() !== 1) throw new Error(`${label} field is not unique`); return locator; }

export async function fillEditorPage(page, mapping, job) {
  if (!job?.draft || !mapping) throw new Error('Draft and editor mapping required');
  const account = await one(unique(page, mapping.accountSelector, 'account'), 'Account');
  const visibleAccount = (await account.innerText()).trim();
  if (visibleAccount !== job.accountHandle) throw new Error(`Editor account mismatch: ${visibleAccount}`);
  const title = await one(unique(page, mapping.titleSelector, 'title'), 'Title');
  const body = await one(unique(page, mapping.bodySelector, 'body'), 'Body');
  await title.fill(job.draft.title);
  await body.fill(job.draft.body);
  if (job.draft.images.length) {
    if (!Array.isArray(mapping.imageSlots) || mapping.imageSlots.length !== job.draft.images.length) throw new Error('Every image needs a verified insertion slot');
    for (let index = 0; index < job.draft.images.length; index++) {
      const image = job.draft.images[index], slot = mapping.imageSlots[index];
      if (!image.generatedPath || !slot?.fileInputSelector || !slot?.renderedImageSelector || !slot?.paragraphSelector || slot.afterParagraph !== image.afterParagraph || !Number.isInteger(image.afterParagraph) || image.afterParagraph < 1) throw new Error('Image file and paragraph placement mapping required');
      const fileInput = await one(unique(page, slot.fileInputSelector, 'image input'), 'Image input');
      if (await page.locator(slot.paragraphSelector).count() < image.afterParagraph) throw new Error('Image target paragraph unavailable');
      const before = await page.locator(slot.renderedImageSelector).count();
      if (before !== 0) throw new Error('Image slot already contains an image');
      await fileInput.setInputFiles(image.generatedPath);
      await page.locator(slot.renderedImageSelector).waitFor({ state: 'visible', timeout: 30_000 });
      const after = await page.locator(slot.renderedImageSelector).count();
      if (after !== 1) throw new Error('Image placement could not be verified');
      const rendered = page.locator(slot.renderedImageSelector);
      const placement = await rendered.evaluate((node, target) => {
        const paragraphs = [...document.querySelectorAll(target.paragraphSelector)];
        const current = paragraphs[target.afterParagraph - 1], next = paragraphs[target.afterParagraph];
        if (!current || !(current.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
        return !next || Boolean(node.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING);
      }, { paragraphSelector: slot.paragraphSelector, afterParagraph: image.afterParagraph });
      if (!placement) throw new Error('Image appeared outside the approved paragraph position');
    }
  }
  const actualTitle = await title.inputValue().catch(() => title.innerText());
  const actualBody = await body.inputValue().catch(() => body.innerText());
  if (actualTitle.trim() !== job.draft.title.trim() || actualBody.trim() !== job.draft.body.trim()) throw new Error('Editor readback differs from approved draft');
  return { editorUrl: page.url(), visibleAccount, title: actualTitle, body: actualBody, uploadedImages: job.draft.images.map(image => image.id), verification: 'browser-readback' };
}

export async function fillNativeEditorPage(page, job) {
  if (job.channel === 'tistory') {
    if (new URL(page.url()).hostname !== `${job.accountHandle}.tistory.com` || !page.url().includes('/manage/newpost')) throw new Error('Tistory editor account mismatch');
    const existingTitle = (await page.locator('#post-title-inp').inputValue()).trim();
    const existingBody = (await page.frameLocator('#editor-tistory_ifr').locator('#tinymce').innerText()).trim();
    if (existingTitle || existingBody) throw new Error('Tistory editor contains an existing draft; open a blank editor before automatic input');
    await page.locator('#post-title-inp').fill(job.draft.title);
    const bodyArea = page.frameLocator('#editor-tistory_ifr').locator('#tinymce');
    const lines = job.draft.body.replace(/\r\n/g, '\n').split('\n');
    await bodyArea.fill(lines[0]);
    for (const line of lines.slice(1)) { await page.keyboard.press('Enter'); if (line) await page.keyboard.insertText(line); }
    const title = await page.locator('#post-title-inp').inputValue();
    const body = await readTistoryBody(page);
    if (title.trim() !== job.draft.title.trim() || body.trim() !== job.draft.body.trim()) throw new Error('Tistory editor readback differs');
    const uploadedImages = await uploadTistoryImages(page, job.draft.images);
    if (await readTistoryBody(page) !== body) throw new Error('Tistory body changed during image upload');
    return { editorUrl: page.url(), visibleAccount: job.accountHandle, title, body, uploadedImages, verification: 'browser-readback' };
  }
  if (job.channel === 'naver') {
    const frameInfo = page.frames().find(frame => frame.name() === 'mainFrame');
    if (!frameInfo || new URL(frameInfo.url()).searchParams.get('blogId') !== job.accountHandle) throw new Error('Naver editor account mismatch');
    const frame = page.frameLocator('iframe#mainFrame');
    const titleArea = frame.locator('.se-title-text .se-text-paragraph');
    await titleArea.waitFor({ state: 'visible', timeout: 30_000 });
    // Naver offers to resume an autosaved draft; decline so input always starts from a blank editor.
    const resumePrompt = frame.locator('.se-popup-alert-confirm').filter({ hasText: '작성 중인 글이 있습니다' });
    if (await resumePrompt.isVisible().catch(() => false)) {
      await resumePrompt.locator('.se-popup-button-cancel').click();
      await resumePrompt.waitFor({ state: 'hidden', timeout: 5000 });
    }
    if (await titleArea.count() !== 1) throw new Error('Naver title field unavailable');
    const existingTitle = await readNaverTitle(page);
    const existingBody = await readNaverBody(page);
    const existingImages = await frame.locator('.se-image img.se-image-resource').count();
    if (existingTitle || existingBody || existingImages) throw new Error('Naver editor contains an existing draft; open a blank editor before automatic input');
    await titleArea.click();
    await page.keyboard.insertText(job.draft.title);
    const bodyArea = frame.locator('.se-component[data-a11y-title="본문"] .se-text-paragraph').first();
    await bodyArea.click();
    const bodyParagraphs = frame.locator('.se-component[data-a11y-title="본문"] .se-text-paragraph');
    for (const [index, line] of job.draft.body.split('\n').entries()) {
      if (index) {
        await page.keyboard.press('Enter');
        // The editor occasionally drops an Enter while typing long bodies; re-press until the paragraph exists.
        for (let attempt = 0; attempt < 3 && await bodyParagraphs.count() < index + 1; attempt++) {
          await page.waitForTimeout(200);
          if (await bodyParagraphs.count() < index + 1) await page.keyboard.press('Enter');
        }
      }
      if (line) await page.keyboard.insertText(line);
    }
    if (job.draft.headings?.length) await formatNaverHeadings(page, job.draft.headings);
    const title = await readNaverTitle(page);
    const body = await readNaverBody(page);
    if (title !== job.draft.title.trim() || body !== job.draft.body.trim()) throw new Error('Naver editor readback differs');
    const uploadedImages = await uploadNaverImages(page, job.draft.images);
    const afterUpload = await readNaverBody(page);
    if (naverTextLines(afterUpload) !== naverTextLines(body)) throw new Error('Naver text changed during image upload');
    if (job.draft.headings?.length) await verifyNaverHeadings(page, job.draft.headings);
    return { editorUrl: frameInfo.url(), visibleAccount: job.accountHandle, title, body, uploadedImages, verification: 'browser-readback' };
  }
  throw new Error('Native channel editor adapter unavailable');
}

async function readTistoryBody(page) {
  return (await page.frameLocator('#editor-tistory_ifr').locator('#tinymce > p').allInnerTexts()).map(text => text.replace(/\u00a0/g, ' ')).join('\n').trim();
}

async function naverParagraphTexts(page, selector) {
  return page.frameLocator('iframe#mainFrame').locator(selector).evaluateAll(paragraphs => paragraphs.map(paragraph => [...paragraph.querySelectorAll('.__se-node')].map(node => node.textContent).join('')));
}

async function readNaverTitle(page) { return (await naverParagraphTexts(page, '.se-title-text .se-text-paragraph')).join('').trim(); }
async function readNaverBody(page) { return (await naverParagraphTexts(page, '.se-component[data-a11y-title="본문"] .se-text-paragraph')).map(text => text.trim()).join('\n').trim(); }
function naverTextLines(text) { return text.replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).join('\n'); }
async function selectNaverParagraph(paragraph, endOnly = false) {
  await paragraph.click();
  await paragraph.evaluate((node, collapse) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    if (collapse) range.collapse(false);
    const selection = node.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, endOnly);
}
async function exactNaverBodyParagraph(page, heading) {
  const selector = '.se-component[data-a11y-title="본문"] .se-text-paragraph';
  const texts = await naverParagraphTexts(page, selector);
  const matches = texts.flatMap((text, index) => text.trim() === heading ? [index] : []);
  if (matches.length !== 1) throw new Error(`Naver heading missing or ambiguous: ${heading} (matches=${matches.length}, paragraphs=${texts.length})`);
  return page.frameLocator('iframe#mainFrame').locator(selector).nth(matches[0]);
}
async function verifyNaverHeadings(page, headings) {
  const frame = page.frameLocator('iframe#mainFrame');
  for (const heading of headings) {
    const paragraph = await exactNaverBodyParagraph(page, heading);
    await selectNaverParagraph(paragraph);
    // The toolbar label updates a moment after selection (slower right after an image upload); poll before judging.
    const sizeButton = frame.locator('.se-property-toolbar-label-select-button.se-font-size-code-toolbar-button');
    let sizeLabel = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      sizeLabel = (await sizeButton.innerText().catch(() => '')).trim();
      if (sizeLabel.startsWith('24')) break;
      await page.waitForTimeout(200);
    }
    const styles = await paragraph.evaluate(node => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const values = [];
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const style = getComputedStyle(walker.currentNode.parentElement);
        values.push({ weight: Number(style.fontWeight) || (style.fontWeight === 'bold' ? 700 : 400) });
      }
      return values;
    });
    if (!sizeLabel.startsWith('24') || !styles.length || styles.some(style => style.weight < 600)) throw new Error(`Naver heading is not size 24 bold: ${heading}`);
  }
}
async function formatNaverHeadings(page, headings) {
  const frame = page.frameLocator('iframe#mainFrame');
  for (const heading of headings) {
    const paragraph = await exactNaverBodyParagraph(page, heading);
    // SmartEditor ignores DOM ranges set by script; select with the keyboard so the editor registers it.
    await paragraph.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await frame.locator('.se-property-toolbar-label-select-button.se-font-size-code-toolbar-button').click();
    const size = frame.locator('.se-toolbar-option-font-size-code-fs24-button').filter({ visible: true }).first();
    await size.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { throw new Error('Naver size 24 option is unavailable'); });
    await size.click();
    await page.keyboard.press('Control+b');
  }
  await verifyNaverHeadings(page, headings);
}

export async function uploadNaverImages(page, images) {
  const frame = page.frameLocator('iframe#mainFrame');
  const uploaded = [];
  for (const image of images.slice().sort((a,b) => a.afterParagraph - b.afterParagraph)) {
    if (!image.generatedPath || !fs.existsSync(image.generatedPath) || !Number.isInteger(image.afterParagraph) || image.afterParagraph < 1) throw new Error('Approved image file and paragraph position required');
    const paragraphSelector = '.se-component[data-a11y-title="본문"] .se-text-paragraph';
    const paragraphs = frame.locator(paragraphSelector);
    const nonemptyIndexes = (await naverParagraphTexts(page, paragraphSelector)).flatMap((text, index) => text.trim() ? [index] : []);
    if (nonemptyIndexes.length < image.afterParagraph) throw new Error('Naver target paragraph unavailable');
    const before = new Set(await frame.locator('.se-image img.se-image-resource').evaluateAll(elements => elements.map(element => element.getAttribute('src'))));
    // SmartEditor only honours real clicks, so click just past the paragraph's last character to put the caret at its end.
    const target = paragraphs.nth(nonemptyIndexes[image.afterParagraph - 1]);
    const endPoint = await target.evaluate(node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
      const last = rects.at(-1), box = node.getBoundingClientRect();
      return last && { x: Math.min(last.right - box.left + 2, box.width - 1), y: last.top + last.height / 2 - box.top };
    });
    if (!endPoint) throw new Error('Naver target paragraph has no visible text');
    await target.click({ position: endPoint });
    await page.keyboard.press('End');
    const chooser = page.waitForEvent('filechooser', { timeout: 10_000 });
    await frame.getByRole('button', { name: '사진 추가' }).click();
    await (await chooser).setFiles(image.generatedPath);
    let newSources = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      newSources = (await frame.locator('.se-image img.se-image-resource').evaluateAll(elements => elements.map(element => element.getAttribute('src')))).filter(source => source && !before.has(source) && /^https:\/\/blogfiles\.pstatic\.net\//.test(source));
      if (newSources.length === 1) break;
      await page.waitForTimeout(500);
    }
    if (newSources.length !== 1) throw new Error('Naver image upload could not be verified');
    const position = await frame.locator('.se-image img.se-image-resource').evaluateAll((elements, args) => {
      const node = elements.find(element => element.getAttribute('src') === args.source);
      const paragraphs = [...document.querySelectorAll('.se-component[data-a11y-title="본문"] .se-text-paragraph')].filter(element => [...element.querySelectorAll('.__se-node')].some(node => node.textContent.trim()));
      const before = paragraphs[args.afterParagraph - 1], after = paragraphs[args.afterParagraph];
      return !!node && !!before && Boolean(before.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) && (!after || Boolean(node.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING));
    }, { source: newSources[0], afterParagraph: image.afterParagraph });
    if (!position) throw new Error('Naver image is outside its approved paragraph position');
    uploaded.push(image.id);
  }
  return uploaded;
}

export async function uploadTistoryImages(page, images) {
  const frame = page.frameLocator('#editor-tistory_ifr');
  const uploaded = [];
  for (const image of images.slice().sort((a,b) => a.afterParagraph - b.afterParagraph)) {
    if (!image.generatedPath || !fs.existsSync(image.generatedPath) || !Number.isInteger(image.afterParagraph) || image.afterParagraph < 1) throw new Error('Approved image file and paragraph position required');
    const paragraphs = frame.locator('#tinymce > p').filter({ hasText: /\S/ });
    if (await paragraphs.count() < image.afterParagraph) throw new Error('Tistory target paragraph unavailable');
    const before = new Set(await frame.locator('#tinymce img').evaluateAll(elements => elements.map(element => element.getAttribute('src'))));
    await paragraphs.nth(image.afterParagraph - 1).click();
    await page.keyboard.press('End');
    await page.locator('#mceu_0-open').click();
    const chooser = page.waitForEvent('filechooser', { timeout: 10_000 });
    await page.locator('#attach-image').click();
    await (await chooser).setFiles(image.generatedPath);
    let newSources = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      newSources = (await frame.locator('#tinymce img').evaluateAll(elements => elements.map(element => element.getAttribute('src')))).filter(source => source && !before.has(source) && /^https:\/\/blog\.kakaocdn\.net\//.test(source));
      if (newSources.length === 1) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (newSources.length !== 1) throw new Error('Tistory image upload could not be verified');
    const position = await frame.locator('#tinymce img').evaluateAll((elements, args) => {
      const imageNode = elements.find(element => element.getAttribute('src') === args.source);
      const paragraphs = [...document.querySelectorAll('#tinymce > p')].filter(element => element.textContent.trim());
      const before = paragraphs[args.afterParagraph - 1], after = paragraphs[args.afterParagraph];
      return !!imageNode && !!before && Boolean(before.compareDocumentPosition(imageNode) & Node.DOCUMENT_POSITION_FOLLOWING) && (!after || Boolean(imageNode.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING));
    }, { source: newSources[0], afterParagraph: image.afterParagraph });
    if (!position) throw new Error('Tistory image is outside its approved paragraph position');
    uploaded.push(image.id);
  }
  return uploaded;
}

export async function openEditor(job, editorUrl, mapping = null) {
  const url = new URL(editorUrl);
  const allowed = channels[job.channel];
  if (!allowed || url.protocol !== 'https:' || !allowed(url.hostname)) throw new Error('Editor URL is not allowed for this channel');
  const cdpEndpoint = process.env.POSTGEN_BROWSER_CDP_ENDPOINT || process.env.POSTGEN_EDGE_CDP_ENDPOINT;
  const attached = Boolean(cdpEndpoint);
  const { context } = attached
    ? await sharedExistingEdge(cdpEndpoint)
    : { context: await chromium.launchPersistentContext(path.join(profileRoot(), job.accountId), { channel: 'msedge', headless: false, acceptDownloads: false }) };
  let sessionId;
  try {
    const page = attached ? await context.newPage() : context.pages()[0] || await context.newPage();
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    sessionId = crypto.randomUUID();
    sessions.set(sessionId, { context, page, attached, mapping, editorUrl: url.toString(), jobId: job.id, channel: job.channel, accountHandle: job.accountHandle });
    const loginMessage = attached ? 'Sign in in the connected browser tab, then resume preparation' : 'Sign in in the opened PostGen Edge profile, then resume preparation';
    if (job.channel === 'naver' && !(await waitForNaverEditor(page, job.accountHandle, 5000))) return { sessionId, loginRequired: true, message: loginMessage };
    if (!allowed(new URL(page.url()).hostname)) return { sessionId, loginRequired: true, message: loginMessage };
    const editor = mapping ? await fillEditorPage(page, mapping, job) : await fillNativeEditorPage(page, job);
    if (!mapping && job.draft.images.length) sessions.get(sessionId).imageSources = await nativeImageSources(page, job.channel);
    if (!mapping && job.channel === 'naver') { sessions.get(sessionId).approvedBody = job.draft.body; sessions.get(sessionId).approvedHeadings = job.draft.headings || []; }
    return { sessionId, editor };
  } catch (error) { if (sessionId) sessions.delete(sessionId); if (!attached) await context.close(); throw error; }
}

export async function resumeEditorSession(sessionId, job) {
  const session = sessions.get(sessionId);
  if (!session || session.jobId !== job.id || session.accountHandle !== job.accountHandle) throw new Error('Unknown editor session');
  const naverReady = job.channel === 'naver' && await waitForNaverEditor(session.page, job.accountHandle, 5000);
  if (!naverReady) await session.page.goto(session.editorUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (job.channel === 'naver' && !(await waitForNaverEditor(session.page, job.accountHandle))) throw new Error('Naver editor did not open for the approved account');
  const editor = session.mapping ? await fillEditorPage(session.page, session.mapping, job) : await fillNativeEditorPage(session.page, job);
  if (!session.mapping && job.draft.images.length) session.imageSources = await nativeImageSources(session.page, job.channel);
  if (!session.mapping && job.channel === 'naver') { session.approvedBody = job.draft.body; session.approvedHeadings = job.draft.headings || []; }
  return { sessionId, editor };
}

async function nativeImageSources(page, channel) {
  if (channel === 'tistory') return page.frameLocator('#editor-tistory_ifr').locator('#tinymce img').evaluateAll(elements => elements.map(element => element.getAttribute('src')));
  return page.frameLocator('iframe#mainFrame').locator('.se-image img.se-image-resource').evaluateAll(elements => elements.map(element => element.getAttribute('src')));
}

export async function readEditorSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Unknown editor session');
  if (!session.mapping) {
    if (session.channel === 'tistory') return { editorUrl: session.page.url(), title: await session.page.locator('#post-title-inp').inputValue(), body: await readTistoryBody(session.page) };
    const actual = await readNaverBody(session.page);
    if (session.approvedHeadings?.length) await verifyNaverHeadings(session.page, session.approvedHeadings);
    const body = session.approvedBody && naverTextLines(actual) === naverTextLines(session.approvedBody) ? session.approvedBody : actual;
    return { editorUrl: session.page.frames().find(item => item.name() === 'mainFrame')?.url(), title: await readNaverTitle(session.page), body };
  }
  const title = await one(unique(session.page, session.mapping.titleSelector, 'title'), 'Title');
  const body = await one(unique(session.page, session.mapping.bodySelector, 'body'), 'Body');
  return { editorUrl: session.page.url(), title: await title.inputValue().catch(() => title.innerText()), body: await body.inputValue().catch(() => body.innerText()) };
}

export function seoulScheduleParts(at) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid publication time');
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: values.hour, minute: values.minute };
}
function monthSteps(currentYear, currentMonth, target) {
  const steps = (target.year - currentYear) * 12 + target.month - currentMonth;
  if (steps < 0 || steps > 12) throw new Error('Publication date must be within the next 12 months');
  return steps;
}
async function naverTagItems(frame) {
  // Read individual text nodes in the tag controls. A substring in another tag is not a confirmed tag.
  return frame.locator('[class*="tag"]').evaluateAll(elements => {
    const values = new Set();
    for (const element of elements) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const value = walker.currentNode.nodeValue.trim().replace(/^#/, '');
        if (value) values.add(value);
      }
    }
    return [...values];
  });
}

export async function enterNaverTags(frame, page, tags) {
  if (!tags.length) return [];
  const candidates = [
    frame.locator('input[placeholder*="태그"]').filter({ visible: true }),
    frame.locator('input[aria-label*="태그"]').filter({ visible: true }),
    frame.locator('[class*="tag"] input').filter({ visible: true })
  ];
  const tagInput = await (async () => {
    for (const candidate of candidates) if (await candidate.count() === 1) return candidate;
    throw new Error('Naver tag field is unavailable or ambiguous; check the publish panel');
  })();
  for (const tag of tags) {
    await tagInput.fill(tag);
    await tagInput.press('Enter');
    let found = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      if ((await naverTagItems(frame)).includes(tag) && !(await tagInput.inputValue()).trim()) { found = true; break; }
      await page.waitForTimeout(100);
    }
    if (!found) throw new Error(`Naver tag was not confirmed: ${tag}`);
  }
  const registered = await naverTagItems(frame);
  if (tags.some(tag => !registered.includes(tag))) throw new Error('Naver tag readback differs from approved draft');
  return tags;
}
export async function configurePlatformReservation(page, channel, at, tags = []) {
  const target = seoulScheduleParts(at);
  if (dateTooSoon(at)) throw new Error('Publication time is too soon for safe reservation');
  if (channel === 'naver') {
    if (Number(target.minute) % 10 !== 0) throw new Error('Naver reservations use ten-minute increments');
    const frame = page.frameLocator('iframe#mainFrame');
    // exact: the header also has a "예약 발행 N건" button that opens the reservation list instead of the publish panel.
    await frame.getByRole('button', { name: '발행', exact: true }).first().click();
    await frame.locator('#open_public').check();
    await enterNaverTags(frame, page, tags);
    // The radio input sits under its styled label, which intercepts pointer events.
    await frame.locator('label[for="radio_time2"]').click();
    if (!(await frame.locator('#radio_time2').isChecked())) throw new Error('Naver reservation mode was not selected');
    const date = frame.locator('input[readonly].input_date__UwKAB');
    const current = (await date.inputValue()).match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
    if (!current) throw new Error('Naver reservation date unavailable');
    await date.click();
    for (let index = 0; index < monthSteps(Number(current[1]), Number(current[2]), target); index++) await frame.getByRole('button', { name: '다음 달' }).click();
    await frame.getByRole('button', { name: String(target.day), exact: true }).click();
    await frame.locator('select[title="예약 발행 시간 선택"]').selectOption(target.hour);
    await frame.locator('select[title="예약 발행 분 선택"]').selectOption(target.minute);
    const selected = await date.inputValue(), selectedParts = selected.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
    if (!(await frame.locator('#open_public').isChecked()) || !(await frame.locator('#radio_time2').isChecked()) || !selectedParts || Number(selectedParts[1]) !== target.year || Number(selectedParts[2]) !== target.month || Number(selectedParts[3]) !== target.day || await frame.locator('select[title="예약 발행 시간 선택"]').inputValue() !== target.hour || await frame.locator('select[title="예약 발행 분 선택"]').inputValue() !== target.minute) throw new Error('Naver reservation readback differs');
    return { channel, publishAt: new Date(at).toISOString(), localDate: selected, hour: target.hour, minute: target.minute };
  }
  if (channel === 'tistory') {
    await page.locator('#publish-layer-btn').click();
    await page.locator('#open20').check();
    await page.getByRole('button', { name: '예약', exact: true }).click();
    const date = page.getByRole('button', { name: /^\d{4}-\d{2}-\d{2}$/ });
    const current = (await date.innerText()).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!current) throw new Error('Tistory reservation date unavailable');
    await date.click();
    for (let index = 0; index < monthSteps(Number(current[1]), Number(current[2]), target); index++) await page.getByRole('button', { name: '다음날짜' }).click();
    await page.getByRole('button', { name: String(target.day), exact: true }).click();
    await page.locator('#dateHour').fill(String(Number(target.hour)));
    await page.locator('#dateMinute').fill(String(Number(target.minute)));
    const expectedDate = `${target.year}-${String(target.month).padStart(2,'0')}-${String(target.day).padStart(2,'0')}`;
    const reservationMode = await page.getByRole('button', { name: '예약', exact: true }).getAttribute('class');
    if ((await date.innerText()).trim() !== expectedDate || Number(await page.locator('#dateHour').inputValue()) !== Number(target.hour) || Number(await page.locator('#dateMinute').inputValue()) !== Number(target.minute) || !(await page.locator('#open20').isChecked()) || !reservationMode?.split(/\s+/).includes('on')) throw new Error('Tistory reservation readback differs');
    return { channel, publishAt: new Date(at).toISOString(), localDate: expectedDate, hour: target.hour, minute: target.minute };
  }
  throw new Error('Platform reservation adapter unavailable');
}
function dateTooSoon(at) { return Date.parse(at) <= Date.now() + 10 * 60_000; }

export function reservationReceiptMatches(text, title, at) {
  if (!text.includes(title) || !/예약/.test(text)) return false;
  const target = seoulScheduleParts(at);
  const date = new RegExp(`${target.year}\\s*[.\\-/년]\\s*0?${target.month}\\s*[.\\-/월]\\s*0?${target.day}(?:\\s*일)?`);
  const time = new RegExp(`(?:^|\\D)0?${Number(target.hour)}\\s*[:시]\\s*${target.minute}(?:\\D|$)`);
  return date.test(text) && time.test(text);
}

// Count entries in the Naver "예약 발행 글" list whose title line is the approved title and whose next line is the exact Seoul time.
// Matching per entry keeps one post's title from pairing with another post's time.
export function naverReservationListCount(text, title, at) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.some(line => line.includes('예약 발행'))) return 0;
  return lines.filter((line, index) => line === title.trim() && lines[index + 1] && reservationReceiptMatches(`예약 ${line} ${lines[index + 1]}`, title, at)).length;
}

// Open a separate editor tab only to read the reservation list, then close it. Never edits or publishes.
export async function readNaverReservationList(context, handle) {
  const page = await context.newPage();
  try {
    await page.goto(`https://blog.naver.com/${handle}?Redirect=Write&`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const frame = page.frameLocator('iframe#mainFrame');
    await frame.locator('.se-title-text .se-text-paragraph').waitFor({ state: 'visible', timeout: 30_000 });
    const resumePrompt = frame.locator('.se-popup-alert-confirm').filter({ hasText: '작성 중인 글이 있습니다' });
    if (await resumePrompt.isVisible().catch(() => false)) {
      await resumePrompt.locator('.se-popup-button-cancel').click();
      await resumePrompt.waitFor({ state: 'hidden', timeout: 5000 });
    }
    const listButton = frame.getByRole('button', { name: /^예약 발행/ });
    if (await listButton.count() === 0) return '';
    await listButton.first().click();
    const popup = frame.locator('[class*="layer_popup"]').filter({ hasText: '예약 발행 글' }).first();
    await popup.waitFor({ state: 'visible', timeout: 10_000 });
    return await popup.innerText();
  } finally {
    await page.close().catch(() => {});
  }
}

// Re-check an uncertain (unknown) Naver submission by reading the reservation list. Never edits or publishes.
// Exactly one entry with the approved title and Seoul time confirms it; none or duplicates stay unknown for the user to inspect.
export async function recheckNaverReservation(job) {
  if (job.channel !== 'naver') throw new Error('Reservation list re-check is available for Naver only');
  const cdpEndpoint = process.env.POSTGEN_BROWSER_CDP_ENDPOINT || process.env.POSTGEN_EDGE_CDP_ENDPOINT;
  const context = cdpEndpoint
    ? (await sharedExistingEdge(cdpEndpoint)).context
    : await chromium.launchPersistentContext(path.join(profileRoot(), job.accountId), { channel: 'msedge', headless: false, acceptDownloads: false });
  try {
    const listUrl = `https://blog.naver.com/${job.accountHandle}?Redirect=Write&`;
    const count = naverReservationListCount(await readNaverReservationList(context, job.accountHandle), job.draft.title, job.schedule.at);
    if (count !== 1) return { verified: false, count, reason: count === 0 ? 'Approved title and Seoul time are not in the Naver reservation list' : `Naver reservation list has ${count} entries with the approved title and time; remove duplicates on the platform` };
    return { verified: true, count, accountHandle: job.accountHandle, publishAt: job.schedule.at, evidence: 'Re-check: Naver editor reservation list shows exactly one entry with the approved title and exact Seoul publication time', remoteId: null, reservationUrl: listUrl };
  } finally {
    if (!cdpEndpoint) await context.close();
  }
}

export async function submitPlatformReservation(sessionId, job, beforeSubmit = async () => {}) {
  const session = sessions.get(sessionId);
  if (!session || session.jobId !== job.id || session.channel !== job.channel || session.accountHandle !== job.accountHandle) throw new Error('Editor session does not match approved account');
  const editor = await readEditorSession(sessionId);
  if (editor.title.trim() !== job.draft.title.trim() || editor.body.trim() !== job.draft.body.trim()) throw new Error('Editor content differs from approved draft');
  if (!session.mapping && job.draft.images.length) {
    const currentSources = await nativeImageSources(session.page, job.channel);
    if (currentSources.length !== job.draft.images.length || JSON.stringify(currentSources) !== JSON.stringify(session.imageSources)) throw new Error('Approved images changed or disappeared from editor');
  }
  const configured = await configurePlatformReservation(session.page, job.channel, job.schedule.at, job.draft.tags || []);
  if (configured.publishAt !== job.schedule.at) throw new Error('Reservation time mismatch');
  const before = job.channel === 'naver' ? session.page.frames().find(frame => frame.name() === 'mainFrame')?.url() : session.page.url();
  let listedBefore = 0;
  if (job.channel === 'naver') {
    const buttons = session.page.frameLocator('iframe#mainFrame').getByRole('button', { name: '발행', exact: true });
    if (await buttons.count() !== 2) throw new Error('Naver final reservation button is ambiguous');
    // Read the list before submitting so an existing reservation with the same title and time cannot count as this one.
    listedBefore = naverReservationListCount(await readNaverReservationList(session.context, job.accountHandle), job.draft.title, job.schedule.at);
    await beforeSubmit();
    await buttons.last().click();
  } else {
    if (await session.page.locator('#publish-btn').count() !== 1) throw new Error('Tistory final reservation button is ambiguous');
    await beforeSubmit();
    await session.page.locator('#publish-btn').click();
  }
  const currentUrl = () => job.channel === 'naver' ? session.page.frames().find(frame => frame.name() === 'mainFrame')?.url() || session.page.url() : session.page.url();
  let candidate = currentUrl();
  for (let attempt = 0; attempt < 30 && candidate === before; attempt++) { await new Promise(resolve => setTimeout(resolve, 500)); candidate = currentUrl(); }
  if (job.channel === 'naver') {
    // After submitting, Naver shows the post list, which has no reservation time. The editor's reservation list does.
    let listedAfter = 0;
    try { listedAfter = naverReservationListCount(await readNaverReservationList(session.context, job.accountHandle), job.draft.title, job.schedule.at); }
    catch (error) { return { verified: false, reason: `Naver reservation list could not be read (${error.message}); inspect platform before retrying`, candidateUrl: candidate }; }
    if (listedAfter !== listedBefore + 1) return { verified: false, reason: `Naver reservation list does not show one new entry with the approved title and exact Seoul time (before ${listedBefore}, after ${listedAfter}); inspect platform before retrying`, candidateUrl: candidate };
    const logNo = (() => { try { return new URL(candidate).searchParams.get('logNo'); } catch { return null; } })();
    return { verified: true, accountHandle: job.accountHandle, publishAt: job.schedule.at, evidence: 'Naver editor reservation list gained one entry with the approved title and exact Seoul publication time', remoteId: logNo, reservationUrl: channels.naver(new URL(candidate).hostname) ? candidate : null };
  }
  const visible = job.channel === 'naver' ? await session.page.frameLocator('iframe#mainFrame').locator('body').innerText().catch(() => '') : await session.page.locator('body').innerText().catch(() => '');
  const allowed = channels[job.channel];
  if (candidate === before || !allowed(new URL(candidate).hostname) || !reservationReceiptMatches(visible, job.draft.title, job.schedule.at)) return { verified: false, reason: 'Reservation receipt does not show the approved title and exact Seoul publication time; inspect platform before retrying', candidateUrl: candidate };
  return { verified: true, accountHandle: job.accountHandle, publishAt: job.schedule.at, evidence: 'Platform reservation page displays approved title and exact Seoul publication time', reservationUrl: candidate };
}
