// Playwright answers every JavaScript dialog (confirm, prompt, alert) with "dismiss" in a browser it is connected to,
// unless something listens for it. PostGen connects to the user's posting Chrome, where the review screen itself runs,
// so while that connection was open the screen's confirm() returned false before the user saw it ("재발행을 취소했습니다",
// a cancel button that did nothing) until the server restarted. Only tabs PostGen opened for automation keep the old
// auto-dismiss; dialogs in every other tab stay open for the user to answer.
const automationPages = new WeakSet();
const guarded = new WeakSet();

export function markAutomationPage(page) {
  automationPages.add(page);
  return page;
}

export function leaveDialogsToUser(context) {
  if (typeof context?.on !== 'function' || guarded.has(context)) return context;
  guarded.add(context);
  context.on('dialog', dialog => {
    if (automationPages.has(dialog.page())) dialog.dismiss().catch(() => {});
  });
  return context;
}
