/**
 * Navigate a page session to a URL and wait for the load event.
 *
 * Subscribe to Page.loadEventFired before sending Page.navigate to avoid
 * a race where the event fires before the subscription is in place.
 * about: and data: URLs skip the wait since they load synchronously
 * during Target.createTarget — the lifecycle events fire before we can
 * subscribe.
 *
 * @param {import('./cdp-client.mjs').CdpSession} session
 * @param {string} url
 * @param {number} [timeoutMs=30000]
 */
export async function navigateAndWait(session, url, timeoutMs = 30000) {
  await session.send('Page.enable');

  // Always call Page.navigate — don't assume the URL was pre-loaded via
  // Target.createTarget. Callers (screenshot, exec) create tabs with
  // about:blank, then navigate separately. If the URL was already loaded,
  // Page.navigate to the same URL triggers a reload whose events we'll catch.

  let loaded = false;

  /** @type {null | ((v: any) => void)} */
  let resolveLoad;
  const loadPromise = new Promise((resolve) => {
    resolveLoad = resolve;
  });

  const markLoaded = () => {
    if (!loaded) {
      loaded = true;
      resolveLoad();
    }
  };

  const offLoad = session.on('Page.loadEventFired', markLoaded);
  const offLifecycle = session.on('Page.lifecycleEvent', (p) => {
    if (p.name === 'load' && !loaded) {
      markLoaded();
    }
  });
  try { await session.send('Page.setLifecycleEventsEnabled', { enabled: true }); } catch {}

  try {
    const { errorText } = await session.send('Page.navigate', { url });
    if (errorText) {
      throw new Error('navigation failed: ' + errorText);
    }

    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('page load timeout after ' + timeoutMs + 'ms')), timeoutMs);
    });

    try {
      await Promise.race([loadPromise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    offLoad();
    offLifecycle();
  }
}
