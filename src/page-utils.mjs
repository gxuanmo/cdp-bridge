/**
 * Navigate a page session to a URL and wait for the load event.
 *
 * Subscribe to Page.lifecycleEvent before sending Page.navigate to avoid
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

  const isSynthetic = /^(about|data|blob):/i.test(url);
  if (isSynthetic) return;

  let loaded = false;

  /** @type {null | ((v: any) => void)} */
  let resolveLoad;
  const loadPromise = new Promise((resolve) => {
    resolveLoad = resolve;
  });

  const off = session.on('Page.lifecycleEvent', (p) => {
    if (p.name === 'load' && !loaded) {
      loaded = true;
      resolveLoad();
    }
  });

  const { errorText } = await session.send('Page.navigate', { url });
  if (errorText) {
    off();
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
    off();
  }
}
