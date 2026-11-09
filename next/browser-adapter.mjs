import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { dataDir } from '../skill/postgen/scripts/profile.mjs';

const sessions = new Map();
const profileRoot = () => path.join(process.env.POSTGEN_NEXT_DIR || path.join(dataDir(), 'next'), 'browser-profiles');
const channels = {
  naver: hostname => hostname === 'blog.naver.com' || hostname.endsWith('.blog.naver.com'),
  tistory: hostname => hostname === 'tistory.com' || hostname.endsWith('.tistory.com')
};
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
    if (await titleArea.count() !== 1) throw new Error('Naver title field unavailable');
    const existingTitle = await readNaverTitle(page);
    const existingBody = await readNaverBody(page);
    const existingImages = await frame.locator('.se-image img.se-image-resource').count();
    if (existingTitle || existingBody || existingImages) throw new Error('Naver editor contains an existing draft; open a blank editor before automatic input');
    await titleArea.click();
    await page.keyboard.insertText(job.draft.title);
    const bodyArea = frame.locator('.se-component[data-a11y-title="본문"] .se-text-paragraph').first();
    await bodyArea.click();
    for (const [index, line] of job.draft.body.split('\n').entries()) { if (index) await page.keyboard.press('Enter'); if (line) await page.keyboard.insertText(line); }
    const title = await readNaverTitle(page);
    const body = await readNaverBody(page);
    if (title !== job.draft.title.trim() || body !== job.draft.body.trim()) throw new Error('Naver editor readback differs');
    const uploadedImages = await uploadNaverImages(page, job.draft.images);
    const afterUpload = await readNaverBody(page);
    if (afterUpload !== body) throw new Error('Naver body changed during image upload');
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
    await paragraphs.nth(nonemptyIndexes[image.afterParagraph - 1]).click();
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
  const profile = path.join(profileRoot(), job.accountId);
  const context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: false, acceptDownloads: false });
  let sessionId;
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    sessionId = crypto.randomUUID();
    sessions.set(sessionId, { context, page, mapping, editorUrl: url.toString(), jobId: job.id, channel: job.channel, accountHandle: job.accountHandle });
    if (!allowed(new URL(page.url()).hostname)) return { sessionId, loginRequired: true, message: 'Sign in in the opened PostGen Edge profile, then resume preparation' };
    const editor = mapping ? await fillEditorPage(page, mapping, job) : await fillNativeEditorPage(page, job);
    if (!mapping && job.draft.images.length) sessions.get(sessionId).imageSources = await nativeImageSources(page, job.channel);
    return { sessionId, editor };
  } catch (error) { if (sessionId) sessions.delete(sessionId); await context.close(); throw error; }
}

export async function resumeEditorSession(sessionId, job) {
  const session = sessions.get(sessionId);
  if (!session || session.jobId !== job.id || session.accountHandle !== job.accountHandle) throw new Error('Unknown editor session');
  await session.page.goto(session.editorUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const editor = session.mapping ? await fillEditorPage(session.page, session.mapping, job) : await fillNativeEditorPage(session.page, job);
  if (!session.mapping && job.draft.images.length) session.imageSources = await nativeImageSources(session.page, job.channel);
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
    return { editorUrl: session.page.frames().find(item => item.name() === 'mainFrame')?.url(), title: await readNaverTitle(session.page), body: await readNaverBody(session.page) };
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
export async function configurePlatformReservation(page, channel, at) {
  const target = seoulScheduleParts(at);
  if (dateTooSoon(at)) throw new Error('Publication time is too soon for safe reservation');
  if (channel === 'naver') {
    if (Number(target.minute) % 10 !== 0) throw new Error('Naver reservations use ten-minute increments');
    const frame = page.frameLocator('iframe#mainFrame');
    await frame.getByRole('button', { name: '발행' }).first().click();
    await frame.locator('#open_public').check();
    await frame.locator('#radio_time2').check();
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

export async function submitPlatformReservation(sessionId, job) {
  const session = sessions.get(sessionId);
  if (!session || session.jobId !== job.id || session.channel !== job.channel || session.accountHandle !== job.accountHandle) throw new Error('Editor session does not match approved account');
  const editor = await readEditorSession(sessionId);
  if (editor.title.trim() !== job.draft.title.trim() || editor.body.trim() !== job.draft.body.trim()) throw new Error('Editor content differs from approved draft');
  if (!session.mapping && job.draft.images.length) {
    const currentSources = await nativeImageSources(session.page, job.channel);
    if (currentSources.length !== job.draft.images.length || JSON.stringify(currentSources) !== JSON.stringify(session.imageSources)) throw new Error('Approved images changed or disappeared from editor');
  }
  const configured = await configurePlatformReservation(session.page, job.channel, job.schedule.at);
  if (configured.publishAt !== job.schedule.at) throw new Error('Reservation time mismatch');
  const before = job.channel === 'naver' ? session.page.frames().find(frame => frame.name() === 'mainFrame')?.url() : session.page.url();
  if (job.channel === 'naver') {
    const buttons = session.page.frameLocator('iframe#mainFrame').getByRole('button', { name: '발행', exact: true });
    if (await buttons.count() !== 2) throw new Error('Naver final reservation button is ambiguous');
    await buttons.last().click();
  } else {
    if (await session.page.locator('#publish-btn').count() !== 1) throw new Error('Tistory final reservation button is ambiguous');
    await session.page.locator('#publish-btn').click();
  }
  const currentUrl = () => job.channel === 'naver' ? session.page.frames().find(frame => frame.name() === 'mainFrame')?.url() || session.page.url() : session.page.url();
  let candidate = currentUrl();
  for (let attempt = 0; attempt < 30 && candidate === before; attempt++) { await new Promise(resolve => setTimeout(resolve, 500)); candidate = currentUrl(); }
  const visible = job.channel === 'naver' ? await session.page.frameLocator('iframe#mainFrame').locator('body').innerText().catch(() => '') : await session.page.locator('body').innerText().catch(() => '');
  const allowed = channels[job.channel];
  if (candidate === before || !allowed(new URL(candidate).hostname) || !reservationReceiptMatches(visible, job.draft.title, job.schedule.at)) return { verified: false, reason: 'Reservation receipt does not show the approved title and exact Seoul publication time; inspect platform before retrying', candidateUrl: candidate };
  return { verified: true, accountHandle: job.accountHandle, publishAt: job.schedule.at, evidence: 'Platform reservation page displays approved title and exact Seoul publication time', reservationUrl: candidate };
}
