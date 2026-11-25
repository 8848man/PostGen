import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { configurePlatformReservation, seoulScheduleParts, verifyTistoryTags } from '../next/browser-adapter.mjs';

const at = new Date(Date.now() + 48 * 60 * 60_000);
at.setUTCMinutes(20, 0, 0);
const target = seoulScheduleParts(at.toISOString());
const isoDate = `${target.year}-${String(target.month).padStart(2,'0')}-${String(target.day).padStart(2,'0')}`;
const naverDate = `${target.year}. ${String(target.month).padStart(2,'0')}. ${String(target.day).padStart(2,'0')}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  const tistoryLayer = `<button id="publish-layer-btn" onclick="document.querySelector('#layer').hidden=false">완료</button><div id="layer" hidden><input id="open20" type="radio"><button id="reserve" onclick="this.classList.add('on')">예약</button><button id="date" onclick="document.querySelector('#calendar').hidden=false">${isoDate}</button><div id="calendar" hidden><button>다음날짜</button><button onclick="document.querySelector('#date').textContent='${isoDate}';document.querySelector('#calendar').hidden=true">${target.day}</button></div><input id="dateHour" type="number"><input id="dateMinute" type="number"><button id="publish-btn">공개 발행</button></div>`;
  await page.setContent(tistoryLayer);
  const tistory = await configurePlatformReservation(page, 'tistory', at.toISOString());
  if (tistory.localDate !== isoDate || await page.locator('#publish-btn').evaluate(element => element.dataset.clicked === 'yes')) throw new Error('Tistory dry run failed');
  // Tistory tags: entered as chips in the tag box under the editor, then read back exactly.
  // Mirrors the real editor (2026-11-25): chips with a delete link, and a hidden sizing div holding the placeholder.
  const tistoryChip = chip => `<span class="txt_tag"><a href="#" aria-label="${chip} 태그 수정">#${chip}</a><a href="#" class="btn_delete"><span>${chip} 태그 삭제</span></a></span>`;
  const tistoryTagBox = chips => `<script>function addChip(input) { const chip = document.createElement('span'); chip.className = 'txt_tag'; chip.innerHTML = '<a href="#">#' + input.value + '</a><a href="#" class="btn_delete"><span>' + input.value + ' 태그 삭제</span></a>'; input.closest('.inp_tag').before(chip); input.value = ''; }</script><div class="editor_tag">${chips.map(tistoryChip).join('')}<span class="inp_tag"><span>#</span><div style="display:inline-block"><input type="text" title="태그" id="tagText" placeholder="태그입력" onkeydown="if(event.key==='Enter')addChip(this)"><div style="visibility:hidden;height:0">태그입력</div></div></span></div>`;
  await page.setContent(tistoryTagBox([]) + tistoryLayer);
  await configurePlatformReservation(page, 'tistory', at.toISOString(), ['PostGen', '글검토']);
  assert.deepEqual(await verifyTistoryTags(page, ['PostGen', '글검토']), ['PostGen', '글검토']);
  await assert.rejects(verifyTistoryTags(page, ['PostGen']), /Tistory tags differ from approved draft/);
  await page.setContent(tistoryTagBox(['예전태그']) + tistoryLayer);
  await assert.rejects(configurePlatformReservation(page, 'tistory', at.toISOString(), ['PostGen']), /Tistory tags differ from approved draft/);
  await page.setContent(tistoryLayer);
  await assert.rejects(configurePlatformReservation(page, 'tistory', at.toISOString(), ['PostGen']), /Tistory tag field is unavailable/);
  await page.setContent(`<div class="editor_tag"><span class="inp_tag"><input id="tagText" placeholder="태그입력" onkeydown="if(event.key==='Enter')this.value=''"><div style="visibility:hidden;height:0">태그입력</div></span></div>${tistoryLayer}`);
  await assert.rejects(configurePlatformReservation(page, 'tistory', at.toISOString(), ['PostGen']), /Tistory tag was not confirmed: PostGen/);
  await page.setContent(`<div class="tag-box"><input id="tagText" placeholder="태그입력"></div>${tistoryLayer}`);
  await assert.rejects(configurePlatformReservation(page, 'tistory', at.toISOString(), ['PostGen']), /Tistory tag box layout is unknown/);
  const frame = `<button onclick="document.querySelector('#layer').hidden=false">발행</button><div id="layer" hidden><input id="open_public" type="radio"><input id="radio_time2" type="radio"><input class="input_date__UwKAB" readonly value="${naverDate}" onclick="document.querySelector('#calendar').hidden=false"><div id="calendar" hidden><button>다음 달</button><button onclick="document.querySelector('#calendar').hidden=true">${target.day}</button></div><select title="예약 발행 시간 선택">${Array.from({length:24},(_,i)=>`<option>${String(i).padStart(2,'0')}</option>`).join('')}</select><select title="예약 발행 분 선택">${[0,10,20,30,40,50].map(i=>`<option>${String(i).padStart(2,'0')}</option>`).join('')}</select><button>발행</button></div>`;
  await page.setContent(`<iframe id="mainFrame"></iframe>`);
  const taggedFrame = frame.replace('<input id="open_public"', `<div class="tag_editor"><input aria-label="태그 입력" hidden onkeydown="if(event.key==='Enter'){const chip=document.createElement('span');chip.textContent=this.value;this.before(chip);this.value=''}"></div><input id="open_public" onchange="document.querySelector('.tag_editor input').hidden=false"`).replace('<input id="radio_time2"', '<label for="radio_time2">예약</label><input id="radio_time2"');
  await page.locator('#mainFrame').evaluate((element, html) => { element.srcdoc = html; }, taggedFrame);
  const naver = await configurePlatformReservation(page, 'naver', at.toISOString(), ['PostGen', '글검토']);
  if (naver.localDate !== naverDate || !(await page.frameLocator('#mainFrame').locator('.tag_editor').innerText()).includes('글검토')) throw new Error('Naver dry run failed');
  const autoTaggedFrame = frame.replace('<input id="open_public"', `<div class="tag_editor"><span>#PostGen</span><span>#글검토</span></div><input id="open_public"`).replace('<input id="radio_time2"', '<label for="radio_time2">예약</label><input id="radio_time2"');
  await page.locator('#mainFrame').evaluate((element, html) => { element.srcdoc = html; }, autoTaggedFrame);
  await configurePlatformReservation(page, 'naver', at.toISOString(), ['PostGen', '글검토']);
  const misleadingFrame = frame.replace('<input id="open_public"', `<div class="tag_editor"><span>PostGen2</span><input placeholder="태그 입력" onkeydown="if(event.key==='Enter')this.value=''"></div><input id="open_public"`).replace('<input id="radio_time2"', '<label for="radio_time2">예약</label><input id="radio_time2"');
  await page.locator('#mainFrame').evaluate((element, html) => { element.srcdoc = html; }, misleadingFrame);
  await assert.rejects(configurePlatformReservation(page, 'naver', at.toISOString(), ['PostGen']), /tags differ from approved draft/);
  const unexpectedFrame = frame.replace('<input id="open_public"', `<div class="tag_editor"><span>#자동태그</span><input placeholder="태그 입력" onkeydown="if(event.key==='Enter'){const chip=document.createElement('span');chip.textContent=this.value;this.before(chip);this.value=''}"></div><input id="open_public"`).replace('<input id="radio_time2"', '<label for="radio_time2">예약</label><input id="radio_time2"');
  await page.locator('#mainFrame').evaluate((element, html) => { element.srcdoc = html; }, unexpectedFrame);
  await assert.rejects(configurePlatformReservation(page, 'naver', at.toISOString(), ['PostGen']), /tags differ from approved draft/);
  await page.locator('#mainFrame').evaluate((element, html) => { element.srcdoc = html; }, unexpectedFrame);
  await assert.rejects(configurePlatformReservation(page, 'naver', at.toISOString(), []), /tags differ from approved draft/);
  process.stdout.write('Browser reservation dry run passed: Naver and Tistory date, time, public/scheduled mode, tags\n');
} finally { await browser.close(); }
