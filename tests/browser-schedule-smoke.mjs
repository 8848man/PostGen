import { chromium } from 'playwright-core';
import { configurePlatformReservation, seoulScheduleParts } from '../next/browser-adapter.mjs';

const at = new Date(Date.now() + 48 * 60 * 60_000);
at.setUTCMinutes(20, 0, 0);
const target = seoulScheduleParts(at.toISOString());
const isoDate = `${target.year}-${String(target.month).padStart(2,'0')}-${String(target.day).padStart(2,'0')}`;
const naverDate = `${target.year}. ${String(target.month).padStart(2,'0')}. ${String(target.day).padStart(2,'0')}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<button id="publish-layer-btn" onclick="document.querySelector('#layer').hidden=false">완료</button><div id="layer" hidden><input id="open20" type="radio"><button id="reserve" onclick="this.classList.add('on')">예약</button><button id="date" onclick="document.querySelector('#calendar').hidden=false">${isoDate}</button><div id="calendar" hidden><button>다음날짜</button><button onclick="document.querySelector('#date').textContent='${isoDate}';document.querySelector('#calendar').hidden=true">${target.day}</button></div><input id="dateHour" type="number"><input id="dateMinute" type="number"><button id="publish-btn">공개 발행</button></div>`);
  const tistory = await configurePlatformReservation(page, 'tistory', at.toISOString());
  if (tistory.localDate !== isoDate || await page.locator('#publish-btn').evaluate(element => element.dataset.clicked === 'yes')) throw new Error('Tistory dry run failed');
  const frame = `<button onclick="document.querySelector('#layer').hidden=false">발행</button><div id="layer" hidden><input id="open_public" type="radio"><input id="radio_time2" type="radio"><input class="input_date__UwKAB" readonly value="${naverDate}" onclick="document.querySelector('#calendar').hidden=false"><div id="calendar" hidden><button>다음 달</button><button onclick="document.querySelector('#calendar').hidden=true">${target.day}</button></div><select title="예약 발행 시간 선택">${Array.from({length:24},(_,i)=>`<option>${String(i).padStart(2,'0')}</option>`).join('')}</select><select title="예약 발행 분 선택">${[0,10,20,30,40,50].map(i=>`<option>${String(i).padStart(2,'0')}</option>`).join('')}</select><button>발행</button></div>`;
  await page.setContent(`<iframe id="mainFrame"></iframe>`);
  await page.locator('#mainFrame').evaluate((element, html) => { element.srcdoc = html; }, frame);
  const naver = await configurePlatformReservation(page, 'naver', at.toISOString());
  if (naver.localDate !== naverDate) throw new Error('Naver dry run failed');
  process.stdout.write('Browser reservation dry run passed: Naver and Tistory date, time, public/scheduled mode\n');
} finally { await browser.close(); }
