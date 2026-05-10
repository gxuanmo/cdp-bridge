import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { connectBrowser, openPage, closeTarget } from './cdp-client.mjs';
import { paths } from './paths.mjs';
import { log } from './logger.mjs';

/**
 * Download a URL through Chrome (sidecar OR user's daily Chrome via attach
 * mode). Returns the absolute path of the downloaded file.
 *
 * Mechanics:
 *  1. `Browser.setDownloadBehavior(allowAndName, <staging>)` — redirects
 *     downloads to our private staging dir. **Caveat in attach mode**: this
 *     applies to the entire default browser context, so any download the
 *     user manually triggers in their Chrome during this call also lands in
 *     the staging dir. We restore the default behavior in the `finally`
 *     block to keep the affected window as small as possible.
 *  2. Subscribe to `Browser.downloadWillBegin` / `Browser.downloadProgress`
 *     to track our specific guid.
 *  3. Open a NEW background tab navigating to the URL — `background: true`
 *     prevents stealing focus from the user's current tab.
 *  4. On completion, move the staged file to `outputPath`.
 *
 * @param {{
 *   port: number,
 *   url: string,
 *   outputPath?: string,
 *   timeoutMs?: number,
 *   onProgress?: (info: { received: number, total: number }) => void,
 * }} args
 * @returns {Promise<string>}
 */
export async function downloadViaChrome({ port, url, outputPath, timeoutMs = 10 * 60 * 1000, onProgress }) {
  const stagingDir = join(paths.downloads, 'staging-' + Date.now());
  mkdirSync(stagingDir, { recursive: true });

  const browser = await connectBrowser(port);

  await browser.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: stagingDir,
    eventsEnabled: true,
  });

  /** @type {{ guid: string, suggestedFilename: string } | null} */
  let beginInfo = null;
  const completion = new Promise((resolveDone, rejectDone) => {
    const offBegin = browser.on('Browser.downloadWillBegin', (p) => {
      if (p.url === url || beginInfo == null) {
        beginInfo = { guid: p.guid, suggestedFilename: p.suggestedFilename };
      }
    });
    const offProgress = browser.on('Browser.downloadProgress', (p) => {
      if (onProgress && beginInfo && p.guid === beginInfo.guid) {
        onProgress({ received: p.receivedBytes, total: p.totalBytes });
      }
      if (p.state === 'completed' && beginInfo && p.guid === beginInfo.guid) {
        offBegin();
        offProgress();
        resolveDone({ guid: p.guid, totalBytes: p.totalBytes });
      } else if (p.state === 'canceled') {
        offBegin();
        offProgress();
        rejectDone(new Error('download canceled by browser (guid=' + p.guid + ')'));
      }
    });
  });

  const { targetId } = await openPage(port, url, { background: true });

  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('download timeout after ' + timeoutMs + 'ms')), timeoutMs);
  });

  let finalPath;
  try {
    const done = await Promise.race([completion, timeout]);
    if (timer) clearTimeout(timer);
    if (!beginInfo) throw new Error('download started but no Browser.downloadWillBegin event captured');

    const stagedFile = join(stagingDir, beginInfo.guid);
    if (!existsSync(stagedFile)) {
      throw new Error('download completed but file missing at ' + stagedFile);
    }

    finalPath = outputPath ? resolve(outputPath) : join(paths.downloads, beginInfo.suggestedFilename);
    mkdirSync(dirname(finalPath), { recursive: true });
    renameSync(stagedFile, finalPath);

    log.info('downloaded ' + finalPath + (done.totalBytes ? ' (' + done.totalBytes + ' bytes)' : ''));
    return finalPath;
  } finally {
    if (timer) clearTimeout(timer);
    try { await closeTarget(port, targetId); } catch {}
    // Restore default download behavior so the user's manual downloads
    // resume going wherever Chrome's Preferences say (usually ~/Downloads).
    try {
      await browser.send('Browser.setDownloadBehavior', { behavior: 'default' });
    } catch {}
    browser.close();
  }
}
