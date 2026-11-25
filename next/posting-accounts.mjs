// Posting address and login status per blog account. Login is read with the posting Chrome's cookies
// through an HTTP request (no tab is opened), and the login page opens as a new tab in that same browser.
import { chromium } from 'playwright-core';

const LOGIN_CHANNELS = ['naver', 'tistory'];

export function defaultPostingUrl(account) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(account.handle)) throw new Error('Use the blog ID as the account handle');
  if (account.channel === 'naver') return `https://blog.naver.com/${account.handle}?Redirect=Write&`;
  if (account.channel === 'tistory') return `https://${account.handle}.tistory.com/manage/newpost`;
  throw new Error('No native browser editor for this channel');
}

export function postingUrlFor(account) {
  return account.postingUrl || defaultPostingUrl(account);
}

// Editor automation checks the account against the address, so the address must belong to this account's blog.
export function validatePostingUrl(account, value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('Enter the full posting address, starting with https://'); }
  if (url.protocol !== 'https:') throw new Error('The posting address must start with https://');
  if (account.channel === 'tistory') {
    if (url.hostname !== `${account.handle}.tistory.com` || !url.pathname.startsWith('/manage/newpost')) throw new Error(`A Tistory posting address looks like https://${account.handle}.tistory.com/manage/newpost`);
  } else if (account.channel === 'naver') {
    if (url.hostname !== 'blog.naver.com' || !url.href.toLowerCase().includes(account.handle.toLowerCase())) throw new Error(`A Naver posting address looks like https://blog.naver.com/${account.handle}?Redirect=Write&`);
  } else throw new Error('Posting addresses are available for Naver and Tistory accounts');
  return url.toString();
}

export function loginUrlFor(account) {
  const target = encodeURIComponent(postingUrlFor(account));
  if (account.channel === 'naver') return `https://nid.naver.com/nidlogin.login?url=${target}`;
  if (account.channel === 'tistory') return `https://www.tistory.com/auth/login?redirectUrl=${target}`;
  throw new Error('Login is available for Naver and Tistory accounts');
}

// Signals checked on 2026-11-25: logged out, Tistory redirects the editor to www.tistory.com/auth/login;
// Naver's write form answers with a short page that sends the browser to nid.naver.com/nidlogin.
export function loginStateFromResponse(channel, { status, finalUrl, body }) {
  const host = (() => { try { return new URL(finalUrl).hostname; } catch { return ''; } })();
  if (channel === 'tistory') {
    if (host === 'www.tistory.com' && new URL(finalUrl).pathname.startsWith('/auth/login')) return 'logged_out';
    return status === 200 && host.endsWith('.tistory.com') ? 'logged_in' : 'unknown';
  }
  if (channel === 'naver') {
    if (host === 'nid.naver.com' || /nid\.naver\.com\/nidlogin/i.test(body)) return 'logged_out';
    return status === 200 && host === 'blog.naver.com' ? 'logged_in' : 'unknown';
  }
  return 'unknown';
}

async function withPostingBrowser(endpoint, action, connect = url => chromium.connectOverCDP(url, { timeout: 5000 })) {
  if (!endpoint) throw new Error('The posting Chrome connection is not configured; start PostGen with the review launcher');
  const browser = await connect(endpoint);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('The posting Chrome has no open window');
    return await action(context);
  } finally {
    // Disconnects only; the user's browser keeps running.
    await browser.close().catch(() => {});
  }
}

export async function checkLoginStatus(accounts, { endpoint = process.env.POSTGEN_BROWSER_CDP_ENDPOINT || process.env.POSTGEN_EDGE_CDP_ENDPOINT, connect } = {}) {
  const checkedAt = new Date().toISOString();
  const targets = accounts.filter(account => LOGIN_CHANNELS.includes(account.channel));
  try {
    return await withPostingBrowser(endpoint, async context => Promise.all(targets.map(async account => {
      try {
        const response = await context.request.get(postingUrlFor(account), { failOnStatusCode: false, timeout: 15_000 });
        const body = (await response.text()).slice(0, 20_000);
        const state = loginStateFromResponse(account.channel, { status: response.status(), finalUrl: response.url(), body });
        return { accountId: account.id, state, checkedAt, reason: state === 'unknown' ? `Unexpected response ${response.status()}` : null };
      } catch (error) {
        return { accountId: account.id, state: 'unknown', checkedAt, reason: error.message };
      }
    })), connect);
  } catch (error) {
    return targets.map(account => ({ accountId: account.id, state: 'unknown', checkedAt, reason: error.message }));
  }
}

// Opens the login page (or the posting page when already logged in) as a new tab in the posting Chrome.
export async function openInPostingBrowser(url, { endpoint = process.env.POSTGEN_BROWSER_CDP_ENDPOINT || process.env.POSTGEN_EDGE_CDP_ENDPOINT, connect } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !/(^|\.)(naver\.com|tistory\.com)$/.test(target.hostname)) throw new Error('Only Naver and Tistory pages can be opened');
  return withPostingBrowser(endpoint, async context => {
    const page = await context.newPage();
    await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    return { opened: true };
  }, connect);
}
