// Posting address and login status per blog account. Login is read with the posting Chrome's cookies
// through an HTTP request (no tab is opened), and the login page opens as a new tab in that same browser.
import { chromium } from 'playwright-core';
import { leaveDialogsToUser } from './browser-dialogs.mjs';
import { SOCIAL_HOSTS, isSocialChannel } from '../skill/postgen/scripts/channel-rules.mjs';

const LOGIN_CHANNELS = ['naver', 'tistory', 'x', 'linkedin', 'instagram', 'reddit'];

// Social channels: where the composer opens by default, the login page, and the cookie that is present only while
// signed in (read from the posting Chrome, no tab is opened). Reddit's address can point at one community instead.
export const SOCIAL_ACCOUNTS = {
  x: { posting: () => 'https://x.com/compose/post', login: 'https://x.com/i/flow/login', cookie: { url: 'https://x.com', name: 'auth_token' }, example: 'https://x.com/compose/post' },
  linkedin: { posting: () => 'https://www.linkedin.com/feed/', login: 'https://www.linkedin.com/login', cookie: { url: 'https://www.linkedin.com', name: 'li_at' }, example: 'https://www.linkedin.com/feed/' },
  instagram: { posting: () => 'https://www.instagram.com/', login: 'https://www.instagram.com/accounts/login/', cookie: { url: 'https://www.instagram.com', name: 'sessionid' }, example: 'https://www.instagram.com/' },
  reddit: { posting: () => 'https://www.reddit.com/submit?type=TEXT', login: 'https://www.reddit.com/login/', cookie: { url: 'https://www.reddit.com', name: 'reddit_session' }, example: 'https://www.reddit.com/r/<커뮤니티>/submit?type=TEXT' }
};
export const socialHostAllowed = (channel, hostname) => (SOCIAL_HOSTS[channel] || []).includes(hostname);

export function defaultPostingUrl(account) {
  if (isSocialChannel(account.channel)) return SOCIAL_ACCOUNTS[account.channel].posting(account);
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
  } else if (isSocialChannel(account.channel)) {
    if (!socialHostAllowed(account.channel, url.hostname)) throw new Error(`A posting address for this channel looks like ${SOCIAL_ACCOUNTS[account.channel].example}`);
    if (account.channel === 'reddit' && !/^\/(r\/[A-Za-z0-9_]{2,21}\/)?submit\/?$/.test(url.pathname)) throw new Error('A Reddit posting address looks like https://www.reddit.com/r/<community>/submit?type=TEXT');
  } else throw new Error('Posting addresses are available for Naver, Tistory, X, LinkedIn, Instagram and Reddit accounts');
  return url.toString();
}

export function loginUrlFor(account) {
  if (isSocialChannel(account.channel)) return SOCIAL_ACCOUNTS[account.channel].login;
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
    // While connected, dialogs in the user's tabs (the review screen) stay with the user.
    leaveDialogsToUser(context);
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
        if (isSocialChannel(account.channel)) {
          // The platforms answer a signed-out page with 200 as well; their session cookie is the reliable signal.
          const { url, name } = SOCIAL_ACCOUNTS[account.channel].cookie;
          const signedIn = (await context.cookies(url)).some(cookie => cookie.name === name && cookie.value && (cookie.expires === -1 || cookie.expires * 1000 > Date.now()));
          return { accountId: account.id, state: signedIn ? 'logged_in' : 'logged_out', checkedAt, reason: null, accountMatch: 'unverified' };
        }
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
  const socialHost = Object.keys(SOCIAL_HOSTS).some(channel => socialHostAllowed(channel, target.hostname));
  if (target.protocol !== 'https:' || !(socialHost || /(^|\.)(naver\.com|tistory\.com)$/.test(target.hostname))) throw new Error('Only Naver, Tistory, X, LinkedIn, Instagram and Reddit pages can be opened');
  return withPostingBrowser(endpoint, async context => {
    const page = await context.newPage();
    await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    return { opened: true };
  }, connect);
}
