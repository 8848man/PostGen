import test from 'node:test';
import assert from 'node:assert/strict';
import { xWeightedLength, socialPostText, socialDraftProblems, isSocialChannel } from '../skill/postgen/scripts/channel-rules.mjs';
import { defaultPostingUrl, validatePostingUrl, loginUrlFor, checkLoginStatus } from '../next/posting-accounts.mjs';
import { emptyRegistry, addAccount } from '../skill/postgen/scripts/account-registry.mjs';
import { emptyState, createJob, setDraft, publishDraftReservation, republishJob } from '../skill/postgen/scripts/next-core.mjs';

const standard = { set: 'x-post', sha256: 'a'.repeat(64) };

test('X counts Korean as 2, ASCII as 1 and links as 23', () => {
  assert.equal(xWeightedLength('abc'), 3);
  assert.equal(xWeightedLength('가나다'), 6);
  assert.equal(xWeightedLength('see https://example.com/a/very/long/path'), 4 + 23);
});

test('post text appends approved tags as hashtags, except on Reddit', () => {
  assert.equal(socialPostText('x', ' 본문 ', ['AI 협업', 'PostGen']), '본문\n\n#AI협업 #PostGen');
  assert.equal(socialPostText('reddit', '본문', ['AI']), '본문');
  assert.equal(socialPostText('linkedin', '본문', []), '본문');
});

test('channel limits: X length, Instagram needs an image, Reddit is text only', () => {
  assert.deepEqual(socialDraftProblems('x', { title: 't', body: '가'.repeat(140), tags: [], images: [] }), []);
  assert.match(socialDraftProblems('x', { title: 't', body: '가'.repeat(141), tags: [], images: [] })[0], /282 characters/);
  assert.match(socialDraftProblems('instagram', { title: 't', body: '캡션', tags: [], images: [] })[0], /at least 1 image/);
  assert.match(socialDraftProblems('reddit', { title: 't', body: '본문', tags: [], images: [{ id: 'a' }] })[0], /text only/);
  assert.equal(isSocialChannel('tistory'), false);
});

test('accounts on the new channels can be registered and have posting and login addresses', () => {
  let registry = emptyRegistry();
  for (const channel of ['x', 'linkedin', 'instagram', 'reddit']) registry = addAccount(registry, { channel, handle: 'me', defaultGoal: 'share' });
  assert.equal(registry.accounts.length, 4);
  const reddit = { channel: 'reddit', handle: 'me' };
  assert.equal(defaultPostingUrl({ channel: 'x', handle: 'me' }), 'https://x.com/compose/post');
  assert.equal(validatePostingUrl(reddit, 'https://www.reddit.com/r/korea/submit?type=TEXT'), 'https://www.reddit.com/r/korea/submit?type=TEXT');
  assert.throws(() => validatePostingUrl(reddit, 'https://www.reddit.com/r/korea/'), /r\/<community>\/submit/);
  assert.throws(() => validatePostingUrl({ channel: 'linkedin', handle: 'me' }, 'https://evil.example/feed'), /linkedin\.com/);
  assert.equal(loginUrlFor({ channel: 'instagram', handle: 'me' }), 'https://www.instagram.com/accounts/login/');
});

test('login status of social accounts comes from the session cookie in the posting Chrome', async () => {
  const cookies = { 'https://x.com': [{ name: 'auth_token', value: 'v', expires: -1 }], 'https://www.reddit.com': [{ name: 'other', value: 'v', expires: -1 }] };
  const context = { cookies: async url => cookies[url] || [], request: { get: async () => { throw new Error('not used'); } } };
  const connect = async () => ({ contexts: () => [context], close: async () => {} });
  const statuses = await checkLoginStatus([{ id: 'x', channel: 'x', handle: 'me' }, { id: 'r', channel: 'reddit', handle: 'me' }], { endpoint: 'http://127.0.0.1:9222', connect });
  assert.deepEqual(statuses.map(status => [status.accountId, status.state]), [['x', 'logged_in'], ['r', 'logged_out']]);
});

test('publishing on a social channel needs no reservation time and checks the channel limits', () => {
  let state = createJob(emptyState(), { accountId: 'acc', accountHandle: 'me', audience: 'reader', goal: 'share', sources: [{ id: 's', type: 'text', ref: 'input', text: 'source' }] });
  const id = state.jobs[0].id;
  state = setDraft(state, id, { title: '내부 제목', body: '짧은 글', tags: ['AI'], claims: [], images: [], standard }, [], { channel: 'x' });
  const now = new Date('2026-11-26T03:00:20Z');
  const published = publishDraftReservation(state, id, undefined, { channel: 'x' }, now);
  assert.equal(published.jobs[0].status, 'awaiting_registration');
  assert.equal(published.jobs[0].schedule.manualPost, true);
  assert.equal(Date.parse(published.jobs[0].schedule.expiresAt) - now.getTime(), 7 * 86_400_000);
  const long = setDraft(state, id, { title: '내부 제목', body: '가'.repeat(200), tags: [], claims: [], images: [], standard }, [], { channel: 'x' });
  assert.throws(() => publishDraftReservation(long, id, undefined, { channel: 'x' }, now), /limit is 280/);
  assert.throws(() => publishDraftReservation(state, id, undefined, { channel: 'tistory' }, now), /ten minutes/);
  const again = republishJob(published, id, undefined, { channel: 'x' }, new Date('2026-11-26T03:05:00Z'));
  assert.equal(again.jobs[0].schedule.manualPost, true);
});
