import test from 'node:test';
import assert from 'node:assert/strict';
import { seoulScheduleParts, reservationReceiptMatches, naverReservationListCount, tistoryReservationEntries, stage, firstLineDifference } from '../next/browser-adapter.mjs';

test('automation stage brings the editor to front and tags failures with the step name', async () => {
  const calls = [];
  const page = { bringToFront: async () => { calls.push('front'); } };
  assert.equal(await stage('제목 입력', page, async () => { calls.push('run'); return 1; }), 1);
  assert.deepEqual(calls, ['front', 'run']);
  await assert.rejects(stage('본문 입력', page, async () => { throw new Error('dropped'); }), error => error.stage === '본문 입력' && error.message === '[본문 입력] dropped');
  // An inner stage keeps its own label instead of being renamed by an outer one.
  await assert.rejects(stage('바깥', page, () => stage('안쪽', page, async () => { throw new Error('x'); })), error => error.stage === '안쪽' && error.message === '[안쪽] x');
  const closed = { bringToFront: async () => { throw new Error('Target closed'); } };
  assert.equal(await stage('확인', closed, async () => 'ok'), 'ok');
});

test('first line difference reports the line number without copying text', () => {
  assert.equal(firstLineDifference('a\nb\nc', 'a\nX\nc'), 'first difference at line 2; editor 3 lines, approved 3 lines');
  assert.equal(firstLineDifference('a\nb', 'a\nb\nc'), 'first difference at line 3; editor 2 lines, approved 3 lines');
});

test('platform reservation converts explicit offsets into Seoul calendar fields', () => {
  assert.deepEqual(seoulScheduleParts('2026-11-08T01:20:00Z'), { year: 2026, month: 11, day: 8, hour: '10', minute: '20' });
  assert.deepEqual(seoulScheduleParts('2026-11-08T10:20:00+09:00'), { year: 2026, month: 11, day: 8, hour: '10', minute: '20' });
  assert.throws(() => seoulScheduleParts('not-a-time'), /Invalid publication time/);
});

test('reservation receipt must display the approved title and exact Seoul date and time', () => {
  const at = '2026-11-08T11:20:00.000Z';
  assert.equal(reservationReceiptMatches('예약 PostGen 검증 2026.11.08 20:20', 'PostGen 검증', at), true);
  assert.equal(reservationReceiptMatches('예약 PostGen 검증 2026.11.08 20:30', 'PostGen 검증', at), false);
  assert.equal(reservationReceiptMatches('예약 PostGen 검증 2026.11.09 20:20', 'PostGen 검증', at), false);
  assert.equal(reservationReceiptMatches('예약 다른 글 2026.11.08 20:20', 'PostGen 검증', at), false);
});

test('Tistory post list matches a reserved entry by exact title and Seoul time', () => {
  const at = '2026-12-02T13:30:00.000Z';
  const title = '[PostGen 시험] 티스토리 예약 등록 확인';
  const reserved = { title, status: '[예약]', times: ['랗다뚜이', '2026-12-02 22:30'], url: 'https://lattatui.tistory.com/17' };
  assert.deepEqual(tistoryReservationEntries([reserved, { title: '다른 글', status: '', times: ['2024-07-17 15:48'], url: 'https://lattatui.tistory.com/9' }], title, at), [reserved]);
  // a published (not reserved) post, another time, or a longer title must not count
  assert.equal(tistoryReservationEntries([{ ...reserved, status: '' }], title, at).length, 0);
  assert.equal(tistoryReservationEntries([{ ...reserved, times: ['2026-12-02 22:40'] }], title, at).length, 0);
  assert.equal(tistoryReservationEntries([{ ...reserved, title: `${title} 2` }], title, at).length, 0);
});

test('Naver reservation list matches title and time within the same entry', () => {
  const at = '2026-11-18T00:00:00.000Z';
  const title = '[uCompany] AI 팀을 멈추면, 진행하던 일은 어떻게 될까요?';
  const list = `예약 발행 글\n총2개\n${title}\n2026.11.18 09:00\n[AI 사서] 다른 글\n2026.11.16 09:00\n팝업닫기`;
  assert.equal(naverReservationListCount(list, title, at), 1);
  // another post's time must not pair with this title
  assert.equal(naverReservationListCount(`예약 발행 글\n${title}\n2026.11.16 09:00\n다른 글\n2026.11.18 09:00`, title, at), 0);
  assert.equal(naverReservationListCount(`예약 발행 글\n${title}\n2026.11.18 09:00\n${title}\n2026.11.18 09:00`, title, at), 2);
  assert.equal(naverReservationListCount('', title, at), 0);
  assert.equal(naverReservationListCount(`${title}\n2026.11.18 09:00`, title, at), 0);
});
