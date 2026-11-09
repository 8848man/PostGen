import test from 'node:test';
import assert from 'node:assert/strict';
import { seoulScheduleParts, reservationReceiptMatches } from '../next/browser-adapter.mjs';

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
