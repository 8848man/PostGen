import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPostingUrl, postingUrlFor, validatePostingUrl, loginUrlFor, loginStateFromResponse, checkLoginStatus } from '../next/posting-accounts.mjs';
import { emptyRegistry, addAccount, setPostingUrl } from '../skill/postgen/scripts/account-registry.mjs';

const tistory = { id: 't', channel: 'tistory', handle: 'lattatui' };
const naver = { id: 'n', channel: 'naver', handle: '8848man' };

test('posting address defaults per channel and can be replaced with an address of the same blog', () => {
  assert.equal(defaultPostingUrl(tistory), 'https://lattatui.tistory.com/manage/newpost');
  assert.equal(postingUrlFor({ ...naver, postingUrl: null }), 'https://blog.naver.com/8848man?Redirect=Write&');
  assert.equal(postingUrlFor({ ...tistory, postingUrl: 'https://lattatui.tistory.com/manage/newpost?type=post' }), 'https://lattatui.tistory.com/manage/newpost?type=post');
  assert.equal(validatePostingUrl(tistory, ' https://lattatui.tistory.com/manage/newpost '), 'https://lattatui.tistory.com/manage/newpost');
  assert.throws(() => validatePostingUrl(tistory, 'https://other.tistory.com/manage/newpost'), /lattatui\.tistory\.com/);
  assert.throws(() => validatePostingUrl(tistory, 'http://lattatui.tistory.com/manage/newpost'), /https/);
  assert.throws(() => validatePostingUrl(naver, 'https://blog.naver.com/someoneelse?Redirect=Write&'), /blog\.naver\.com\/8848man/);
  assert.throws(() => validatePostingUrl(naver, 'not a url'), /full posting address/);
});

test('login page returns to the posting address', () => {
  assert.equal(loginUrlFor(tistory), 'https://www.tistory.com/auth/login?redirectUrl=https%3A%2F%2Flattatui.tistory.com%2Fmanage%2Fnewpost');
  assert.ok(loginUrlFor(naver).startsWith('https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fblog.naver.com%2F8848man'));
});

test('login state follows the responses seen on 2026-11-25', () => {
  assert.equal(loginStateFromResponse('tistory', { status: 200, finalUrl: 'https://lattatui.tistory.com/manage/newpost', body: '<html>' }), 'logged_in');
  assert.equal(loginStateFromResponse('tistory', { status: 200, finalUrl: 'https://www.tistory.com/auth/login?redirectUrl=x', body: '' }), 'logged_out');
  assert.equal(loginStateFromResponse('naver', { status: 200, finalUrl: 'https://blog.naver.com/PostWriteForm.naver?blogId=8848man', body: '<html>editor</html>' }), 'logged_in');
  assert.equal(loginStateFromResponse('naver', { status: 200, finalUrl: 'https://blog.naver.com/PostWriteForm.naver?blogId=8848man', body: "location.replace('https://nid.naver.com/nidlogin.login?url=x')" }), 'logged_out');
  assert.equal(loginStateFromResponse('naver', { status: 500, finalUrl: 'https://blog.naver.com/x', body: '' }), 'unknown');
});

test('login check reports unknown instead of failing when the posting Chrome is not reachable', async () => {
  const statuses = await checkLoginStatus([tistory, naver, { id: 'x', channel: 'x', handle: 'h' }], { endpoint: null });
  assert.deepEqual(statuses.map(status => [status.accountId, status.state]), [['t', 'unknown'], ['n', 'unknown'], ['x', 'unknown']]);
  assert.match(statuses[0].reason, /review launcher/);
  const failing = await checkLoginStatus([tistory], { endpoint: 'http://127.0.0.1:1', connect: async () => { throw new Error('connect refused'); } });
  assert.equal(failing[0].reason, 'connect refused');
});

test('registry keeps an optional https posting address per account', () => {
  const registry = addAccount(emptyRegistry(), { channel: 'tistory', handle: 'lattatui', defaultGoal: 'g' });
  const id = registry.accounts[0].id;
  const saved = setPostingUrl(registry, id, 'https://lattatui.tistory.com/manage/newpost');
  assert.equal(saved.accounts[0].postingUrl, 'https://lattatui.tistory.com/manage/newpost');
  assert.equal(saved.accounts[0].revision, 1);
  assert.equal(setPostingUrl(saved, id, '').accounts[0].postingUrl, null);
  assert.throws(() => setPostingUrl(registry, id, 'http://lattatui.tistory.com/manage/newpost'), /Invalid account/);
  assert.throws(() => setPostingUrl(registry, 'missing', null), /Unknown account/);
});
