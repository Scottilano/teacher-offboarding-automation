import { isAuthFailureResponse, isSessionExpiryText } from './session-check.mjs';
// Observe native dialogs as well as DOM dialogs. Never record headers, bodies,
// query strings or credentials. The listener must settle every native dialog.
export function observeAction(page, { confirmDialog, allowedConfirmMessages = [], platform } = {}) {
  const events = [];
  const tasks = new Set();
  let blocked = false;
  let sessionExpired = false;
  const pending = new Set();
  let lastNetworkChange = Date.now();
  const add = event => events.push({ timestamp: new Date().toISOString(), ...event });
  const safeUrl = value => {
    try { const url = new URL(value); return url.origin + url.pathname; }
    catch { return 'unavailable'; }
  };
  const onDialog = dialog => {
    const task = (async () => {
      const type = dialog.type();
      const message = dialog.message();
      if (isSessionExpiryText(message)) sessionExpired = true;
      let accepted = false;
      if (type === 'confirm' && !sessionExpired) {
        accepted = allowedConfirmMessages.includes(message) ||
          Boolean(confirmDialog && await confirmDialog({ type, message }));
      }
      add({ kind: 'native-dialog', type, message, decision: accepted ? 'accept' : 'dismiss' });
      if (!accepted) blocked = true;
      if (accepted) await dialog.accept();
      else await dialog.dismiss();
    })().catch(async error => {
      blocked = true;
      add({ kind: 'dialog-handler-error', message: String(error.message) });
      await dialog.dismiss().catch(() => {});
    });
    tasks.add(task);
    task.finally(() => tasks.delete(task));
  };
  const onRequest = request => {
    if (['xhr', 'fetch'].includes(request.resourceType())) pending.add(request);
    lastNetworkChange = Date.now();
    add({ kind: 'request', method: request.method(), url: safeUrl(request.url()), resourceType: request.resourceType() });
  };
  const onFinished = request => { pending.delete(request); lastNetworkChange = Date.now(); };
  const onResponse = response => {
    if (isAuthFailureResponse(platform, response.status(), response.url())) sessionExpired = true;
    add({ kind: 'response', status: response.status(), url: safeUrl(response.url()) });
  };
  const onFailed = request => { onFinished(request); add({ kind: 'requestfailed', url: safeUrl(request.url()), error: request.failure()?.errorText }); };
  const onError = error => add({ kind: 'pageerror', message: String(error.message) });
  for (const [name, fn] of [['dialog', onDialog], ['request', onRequest], ['requestfinished', onFinished], ['response', onResponse], ['requestfailed', onFailed], ['pageerror', onError]]) page.on(name, fn);
  return {
    events,
    get blocked() { return blocked; },
    get sessionExpired() { return sessionExpired; },
    async settle() { await Promise.all([...tasks]); },
    async waitForQuiet(timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await Promise.all([...tasks]);
        if (!pending.size && Date.now() - lastNetworkChange >= 1000) return true;
        await page.waitForTimeout(250);
      }
      return false;
    },
    async stop() {
      await Promise.all([...tasks]);
      for (const [name, fn] of [['dialog', onDialog], ['request', onRequest], ['requestfinished', onFinished], ['response', onResponse], ['requestfailed', onFailed], ['pageerror', onError]]) page.off(name, fn);
    }
  };
}
