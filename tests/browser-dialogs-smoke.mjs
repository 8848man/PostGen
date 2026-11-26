// PostGen keeps a CDP connection to the posting Chrome. That connection must not answer the review screen's
// confirm() dialogs: the user does. Here a second connection stands in for the user and accepts the dialog.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { leaveDialogsToUser, markAutomationPage } from '../next/browser-dialogs.mjs';

const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'postgen-dialogs-'));
const port = await freePort();
const edgePaths = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
let browserProcess, postgen, user;
try {
  // A real Edge started with a debugging port, like the posting Chrome the launcher opens.
  const edge = edgePaths.find(file => fs.existsSync(file));
  if (!edge) throw new Error('Microsoft Edge is required for this smoke test');
  browserProcess = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt++) { try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }

  // PostGen's long-lived connection, guarded as the server does it.
  postgen = await chromium.connectOverCDP(endpoint, { noDefaults: true, isLocal: true });
  leaveDialogsToUser(postgen.contexts()[0]);

  // The "user": another connection that accepts dialogs on the review tab.
  user = await chromium.connectOverCDP(endpoint);
  const userContext = user.contexts()[0];
  const review = await userContext.newPage();
  review.on('dialog', dialog => setTimeout(() => dialog.accept().catch(() => {}), 300));
  await review.setContent('<p>review</p>');
  assert.equal(await review.evaluate(() => confirm('재발행할까요?')), true, 'the review screen confirm reaches the user');

  // A tab PostGen opened for automation keeps the old auto-dismiss.
  const automation = markAutomationPage(await postgen.contexts()[0].newPage());
  await automation.setContent('<p>editor</p>');
  assert.equal(await automation.evaluate(() => confirm('leave?')), false, 'automation tabs still dismiss dialogs');
  console.log('Browser dialogs smoke passed: review-screen confirm is left to the user, automation tabs auto-dismiss');
} finally {
  await user?.close().catch(() => {});
  await postgen?.close().catch(() => {});
  browserProcess?.kill();
  await new Promise(resolve => setTimeout(resolve, 500));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
