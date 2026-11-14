import test from 'node:test';
import assert from 'node:assert/strict';
import { seoulScheduleParts, reservationReceiptMatches, naverReservationListCount } from '../next/browser-adapter.mjs';

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
