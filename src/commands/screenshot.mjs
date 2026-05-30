import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openPage, closePage } from '../cdp-client.mjs';
import { requirePort } from '../chrome-manager.mjs';
import { log } from '../logger.mjs';
import { navigateAndWait } from '../page-utils.mjs';

/**
 * @param {string[]} argv
 * @returns {{ url: string, output?: string, fullPage: boolean }}
 */
export function parseScreenshotArgs(argv) {
  const url = argv.find(a => /^https?:\/\//i.test(a));
  if (!url) throw new Error('usage: cdpb screenshot <url> [-o <path>] [--full-page]');
  const outIdx = argv.findIndex(a => a === '-o' || a === '--output');
  const output = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  const fullPage = argv.includes('--full-page');
  return { url, output, fullPage };
}

/**
 * @param {object} metrics CDP Page.getLayoutMetrics result
 * @param {boolean} fullPage
 * @returns {object} CDP Page.captureScreenshot params
 */
export function buildCaptureScreenshotParams(metrics, fullPage) {
  const params = { format: 'png' };
  if (!fullPage) return params;

  params.captureBeyondViewport = true;
  const size = metrics.cssContentSize ?? metrics.contentSize;
  params.clip = {
    x: 0,
    y: 0,
    width: Math.ceil(size.width),
    height: Math.ceil(size.height),
    scale: 1,
  };
  return params;
}

export async function run(argv) {
  const { url, output, fullPage } = parseScreenshotArgs(argv);
  const port = await requirePort();

  const { session, targetId } = await openPage(port, 'about:blank', { background: true });
  try {
    await navigateAndWait(session, url);
    const metrics = await session.send('Page.getLayoutMetrics');
    const params = buildCaptureScreenshotParams(metrics, fullPage);
    const { data } = await session.send('Page.captureScreenshot', params);
    if (!data) throw new Error('screenshot returned empty data');

    const buf = Buffer.from(data, 'base64');
    const filePath = output ? resolve(output) : resolve('./screenshot-' + Date.now() + '.png');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, buf);

    log.info('screenshot saved to ' + filePath);
    log.raw(filePath);
  } finally {
    await closePage(port, session, targetId);
  }
}
