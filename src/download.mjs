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
 *  2. Open a NEW background tab and capture its root frameId via
 *     Page.getFrameTree. Subscribe to `Browser.downloadWillBegin` /
 *     `Browser.downloadProgress` and **filter by frameId** so unrelated
 *     downloads that the user triggers in their own tabs are ignored.
 *  3. Chrome's network stack initiates the download; we wait for the
 *     completion event for OUR guid.
 *  4. Move the staged file to outputPath.
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

  // Open our tab first so we know its frameId before any downloadWillBegin
  // event could fire. `Target.createTarget` synchronously returns the
  // targetId, and Page.getFrameTree on the new session returns the root
  // frameId — both before the navigation actually triggers a download
  // (navigation kicks in once we Page.enable / interact with the session).
  const { session: pageSession, targetId } = await openPage(port, 'about:blank', { background: true });
  await pageSession.send('Page.enable');
  /** @type {{ frameTree: { frame: { id: string } } }} */
  const tree = await pageSession.send('Page.getFrameTree');
  const ourFrameId = tree.frameTree.frame.id;

  /** @type {{ guid: string, suggestedFilename: string } | null} */
  let beginInfo = null;
  const completion = new Promise((resolveDone, rejectDone) => {
    const offBegin = browser.on('Browser.downloadWillBegin', (p) => {
      // Filter strictly by frameId — only events from our tab. Skip
      // anything else, including downloads the user triggered manually.
      if (p.frameId !== ourFrameId) return;
      if (beginInfo == null) {
        beginInfo = { guid: p.guid, suggestedFilename: p.suggestedFilename };
      }
    });
    const offProgress = browser.on('Browser.downloadProgress', (p) => {
      if (!beginInfo || p.guid !== beginInfo.guid) return;
      if (onProgress) onProgress({ received: p.receivedBytes, total: p.totalBytes });
      if (p.state === 'completed') {
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

  // Navigate the tab we already created to the download URL.
  await pageSession.send('Page.navigate', { url });

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
    try { pageSession.close(); } catch {}
    try { await closeTarget(port, targetId); } catch {}
    // Restore default download behavior so the user's manual downloads
    // resume going wherever Chrome's Preferences say (usually ~/Downloads).
    try {
      await browser.send('Browser.setDownloadBehavior', { behavior: 'default' });
    } catch {}
    browser.close();
  }
}
