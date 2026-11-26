import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, createCampaign, archiveStaleCampaigns, setCampaignArchived, sourceWrittenAt } from '../skill/postgen/scripts/next-core.mjs';
import { createActivityLog } from '../next/activity.mjs';

const accounts = [{ id: 'naver', handle: 'n', goal: 'explain' }, { id: 'tistory', handle: 't', goal: 'inform' }];
const campaign = (state, ref) => createCampaign(state, { accounts, audience: 'reader', sources: [{ id: 's', type: 'text', ref, text: 'source' }] });

test('the written time comes from a vault post file name, otherwise from registration', () => {
  const [vault] = campaign(emptyState(), 'posts/postgen/2026-11-01-daily-제목.md').jobs;
  assert.equal(sourceWrittenAt(vault), '2026-10-31T15:00:00.000Z');
  const [plain] = campaign(emptyState(), 'user').jobs;
  assert.equal(sourceWrittenAt(plain), plain.createdAt);
});

test('campaigns written more than 14 days ago move to the archive as a whole, and stay out once taken out', () => {
  let state = campaign(emptyState(), 'posts/postgen/2026-11-01-daily-old.md');
  state = campaign(state, 'posts/postgen/2026-11-20-daily-new.md');
  const now = new Date('2026-11-26T03:00:00Z');
  state = archiveStaleCampaigns(state, now);
  const [oldA, oldB, newA, newB] = state.jobs;
  assert.ok(oldA.archivedAt && oldB.archivedAt);
  assert.ok(!newA.archivedAt && !newB.archivedAt);
  assert.equal(archiveStaleCampaigns(state, now).revision, state.revision, 'nothing changes on a second pass');

  state = setCampaignArchived(state, oldA.id, false, now);
  assert.ok(state.jobs.slice(0, 2).every(job => !job.archivedAt && job.archiveReleasedAt));
  assert.ok(!archiveStaleCampaigns(state, new Date('2026-12-30T00:00:00Z')).jobs[0].archivedAt, 'taken out by hand stays out');

  state = setCampaignArchived(state, newA.campaignId, true, now);
  assert.ok(state.jobs.slice(2).every(job => job.archivedAt));
});

test('a campaign with a reservation in progress is not archived automatically', () => {
  let state = campaign(emptyState(), 'posts/postgen/2026-11-01-daily-old.md');
  state.jobs[0].status = 'unknown';
  assert.ok(archiveStaleCampaigns(state, new Date('2026-11-26T03:00:00Z')).jobs.every(job => !job.archivedAt));
});

test('activity entries carry image progress with the time spent on the current image', () => {
  let clock = 0;
  const log = createActivityLog(() => clock);
  const id = log.start({ route: '/api/images/generate-batch', label: '이미지 일괄 생성' });
  log.progress(id, { done: 1, total: 4, detail: '이미지 2/4 생성 중' });
  clock += 30_000;
  const [entry] = log.list();
  assert.deepEqual(entry.progress, { done: 1, total: 4, itemElapsedMs: 30_000 });
  assert.equal(entry.detail, '이미지 2/4 생성 중');
  log.progress(id, { done: 9, total: 4 });
  assert.equal(log.list()[0].progress.done, 4);
  log.finish(id);
  log.progress(id, { done: 0, total: 4 });
  assert.equal(log.list()[0].progress.done, 4, 'finished entries keep their last progress');
});
