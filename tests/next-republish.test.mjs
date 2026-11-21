import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyState, createJob, setDraft, approveDraft, scheduleJob, startPreparation, reviewPreparation, beginScheduleSubmission, markScheduleUnknown, confirmPlatformSchedule, recordPublication, republishJob } from '../next/core.mjs';

const source = { id: 's1', type: 'text', ref: 'user-input', text: 'fact' };
const standard = { set: 'naver-blog-post', sha256: 'a'.repeat(64) };
const now = new Date('2026-11-20T00:00:00Z');
function readyJob(images = []) {
  let state = createJob(emptyState(), { accountId: 'a', audience: 'reader', goal: 'inform', sources: [source] });
  const id = state.jobs[0].id;
  state = approveDraft(setDraft(state, id, { title: 'title', body: 'body', claims: [], images, standard, ...(images.length ? { imagePlanApproved: true } : {}) }), id);
  state = scheduleJob(state, id, '2026-11-25T00:00:00Z', now);
  state = startPreparation(state, id, new Date('2026-11-20T01:00:00Z'));
  state = reviewPreparation(state, id, { editorUrl: 'https://example.com/edit', visibleAccount: 'a', title: 'title', body: 'body', uploadedImages: images.map(image => image.id) });
  return { state, id };
}

test('republish restarts registration from a stuck job with the approved draft kept', () => {
  const { state: ready, id } = readyJob();
  const state = republishJob(ready, id, '2026-11-26T00:10:00Z', {}, now);
  const job = state.jobs[0];
  assert.equal(job.status, 'awaiting_registration');
  assert.equal(job.schedule.at, '2026-11-26T00:10:00.000Z');
  assert.equal(job.editor, null);
  assert.equal(job.approval.draftRevision, job.draft.revision);
  assert.equal(job.republishHistory.length, 1);
  assert.equal(job.republishHistory[0].previousStatus, 'ready_to_register');
  assert.throws(() => republishJob(ready, id, '2026-11-20T00:05:00Z', {}, now), /ten minutes/);
});

test('republish after a possible platform submission needs the user platform check', () => {
  const { state: ready, id } = readyJob();
  const unknown = markScheduleUnknown(beginScheduleSubmission(ready, id, now), id, 'Naver reservations use ten-minute increments');
  assert.throws(() => republishJob(unknown, id, '2026-11-26T00:10:00Z', {}, now), /Check the platform/);
  const job = republishJob(unknown, id, '2026-11-26T00:10:00Z', { platformChecked: true }, now).jobs[0];
  assert.equal(job.status, 'awaiting_registration');
  assert.equal(job.submission, null);
  assert.equal(job.republishHistory[0].reason, 'Naver reservations use ten-minute increments');
  assert.equal(job.republishHistory[0].platformChecked, true);
  const registered = confirmPlatformSchedule(beginScheduleSubmission(ready, id, now), id, { verified: true, accountHandle: 'a', publishAt: '2026-11-25T00:00:00Z', evidence: 'list shows it', remoteId: '1' });
  assert.throws(() => republishJob(registered, id, '2026-11-26T00:10:00Z', {}, now), /Check the platform/);
  assert.equal(republishJob(registered, id, '2026-11-26T00:10:00Z', { platformChecked: true }, now).jobs[0].registration, null);
});

test('republish is not offered for published or unapproved jobs, or missing images', () => {
  const { state: ready, id } = readyJob();
  const registered = confirmPlatformSchedule(beginScheduleSubmission(ready, id, now), id, { verified: true, accountHandle: 'a', publishAt: '2026-11-25T00:00:00Z', evidence: 'list shows it', remoteId: '1' });
  const published = recordPublication(registered, id, { postUrl: 'https://example.com/post' }, new Date('2026-11-25T01:00:00Z'));
  assert.throws(() => republishJob(published, id, '2026-11-26T00:10:00Z', { platformChecked: true }, now), /Cannot change published job/);
  const drafted = createJob(emptyState(), { accountId: 'a', audience: 'r', goal: 'g', sources: [source] });
  assert.throws(() => republishJob(drafted, drafted.jobs[0].id, '2026-11-26T00:10:00Z', {}, now), /Cannot change selected job/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-republish-'));
  try {
    const file = path.join(dir, 'image.png'); fs.writeFileSync(file, 'x');
    const { state: withImage, id: imageJob } = readyJob([{ id: 'i1', afterParagraph: 1, description: 'scene', generatedPath: file }]);
    assert.equal(republishJob(withImage, imageJob, '2026-11-26T00:10:00Z', {}, now).jobs[0].status, 'awaiting_registration');
    fs.rmSync(file);
    assert.throws(() => republishJob(withImage, imageJob, '2026-11-26T00:10:00Z', {}, now), /Image file is missing/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
