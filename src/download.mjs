import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { connectBrowser, openPage, closeTarget } from './cdp-client.mjs';
import { paths } from './paths.mjs';
import { log } from './logger.mjs';

/**
 * Download a URL through the sidecar Chrome (so the user's proxy/extensions
 * apply). Returns the absolute path of the downloaded file.
 *
 * Strategy:
 *  1. Use Browser.setDownloadBehavior to redirect downloads to a private dir.
 *  2. Subscribe to Browser.downloadWillBegin / Browser.downloadProgress.
 *  3. Open a new page navigating to URL — Chrome auto-handles the download
 *     (URLs that don't trigger a download will load as a normal page; we
 *     bail with an error after a short grace window in that case).
 *  4. Move the resulting file to outputPath (if provided).
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

  // Browser.setDownloadBehavior is a browser-level command.
  // behavior=allowAndName -> Chrome uses guid as filename (deterministic, no clobber).
  // eventsEnabled=true is required to receive Browser.downloadWillBegin/Progress.
  await browser.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: stagingDir,
    eventsEnabled: true,
  });

  /** @type {{ guid: string, suggestedFilename: string } | null} */
  let beginInfo = null;
  /** @type {Promise<{ guid: string, totalBytes?: number }>} */
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

  // Open the URL in a new tab. Chrome will detect Content-Disposition and start
  // a download; the page itself becomes "blank" (about:blank).
  const { targetId } = await openPage(port, url);

  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {Promise<never>} */
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

    if (outputPath) {
      finalPath = resolve(outputPath);
      mkdirSync(dirname(finalPath), { recursive: true });
      renameSync(stagedFile, finalPath);
    } else {
      finalPath = join(paths.downloads, beginInfo.suggestedFilename);
      mkdirSync(dirname(finalPath), { recursive: true });
      renameSync(stagedFile, finalPath);
    }

    log.info('downloaded ' + finalPath + (done.totalBytes ? ' (' + done.totalBytes + ' bytes)' : ''));
    return finalPath;
  } finally {
    if (timer) clearTimeout(timer);
    try { await closeTarget(port, targetId); } catch {}
    browser.close();
  }
}
