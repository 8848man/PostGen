import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityLog, TRACKED_ROUTES } from '../next/activity.mjs';

test('activity log lists running work first and keeps finished work with its result', () => {
  let clock = 1_000;
  const log = createActivityLog(() => clock);
  const first = log.start({ route: '/api/images/generate', label: TRACKED_ROUTES['/api/images/generate'], jobId: 'j1', imageId: 'i1', title: '글', detail: '장면' });
  clock += 5_000;
  const second = log.start({ route: '/api/generate', label: '초안 생성', jobId: 'j2' });
  clock += 1_000;
  log.finish(second, 'Codex failed');
  const [running, failed] = log.list();
  assert.equal(running.id, first);
  assert.equal(running.status, 'running');
  assert.equal(running.elapsedMs, 6_000);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'Codex failed');
  assert.equal(failed.elapsedMs, 1_000);
  log.finish(first);
  assert.equal(log.list().find(entry => entry.id === first).status, 'done');
  // finishing twice changes nothing
  log.finish(first, 'late error');
  assert.equal(log.list().find(entry => entry.id === first).error, null);
});

test('the same task cannot start twice for the same job and image, but other items can', () => {
  const log = createActivityLog(() => 0);
  log.start({ route: '/api/images/generate', label: '이미지 생성', jobId: 'j1', imageId: 'i1' });
  assert.throws(() => log.start({ route: '/api/images/generate', label: '이미지 생성', jobId: 'j1', imageId: 'i1' }), /already running/);
  log.start({ route: '/api/images/generate', label: '이미지 생성', jobId: 'j1', imageId: 'i2' });
  log.start({ route: '/api/job', label: '작업 만들기' });
  log.start({ route: '/api/job', label: '작업 만들기' });
  assert.equal(log.list().length, 4);
});

test('finished work is dropped after ten minutes', () => {
  let clock = 0;
  const log = createActivityLog(() => clock);
  log.finish(log.start({ route: '/api/generate', label: '초안 생성', jobId: 'j' }));
  clock += 10 * 60_000 + 1;
  assert.equal(log.list().length, 0);
});
