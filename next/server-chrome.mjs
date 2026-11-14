// `npm run next:chrome`: run PostGen against the posting Chrome (desktop shortcut, port 9333; 9222 is often taken by Edge).
// That Chrome uses its own profile (D:\chrome-posting), so connecting does not ask for debugging approval.
process.env.POSTGEN_BROWSER_CDP_ENDPOINT ||= 'http://127.0.0.1:9333';
await import('./server.mjs');
