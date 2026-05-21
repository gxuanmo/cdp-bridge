import { isChromeReady } from '../chrome-manager.mjs';
import { downloadViaChrome } from '../download.mjs';
import { readState } from '../state.mjs';
import { log } from '../logger.mjs';

/**
 * cdpb fetch <url> [-o <output-path>] [--timeout <ms>]
 *
 * Downloads via the active Chrome session — your daily Chrome in attach
 * mode (so your proxy / login state apply natively), or the spawned
 * sidecar in spawn mode. Uses a background tab so the user's current tab
 * is not disturbed.
 */
export async function run(argv) {
  const url = argv.find((a) => /^https?:\/\//i.test(a));
  if (!url) throw new Error('usage: cdpb fetch <url> [-o <path>]');

  const outIdx = argv.findIndex((a) => a === '-o' || a === '--output');
  const output = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  const tIdx = argv.findIndex((a) => a === '--timeout');
  const timeoutMs = tIdx >= 0 ? Number(argv[tIdx + 1]) : 600000;

  if (!(await isChromeReady())) {
    throw new Error('no Chrome session ready. Run `cdpb launch` first.');
  }
  const { port } = readState();

  let last = 0;
  const t0 = Date.now();
  const path = await downloadViaChrome({
    port,
    url,
    outputPath: output,
    timeoutMs,
    onProgress: ({ received, total }) => {
      const mb = Math.floor(received / 1048576);
      if (mb >= last + 5) {
        const pct = total ? ((received / total) * 100).toFixed(1) + '%' : '?';
        const elapsedSec = ((Date.now() - t0) / 1000).toFixed(0);
        log.info('progress ' + mb + 'MB ' + pct + ' (' + elapsedSec + 's)');
        last = mb;
      }
    },
  });

  log.raw(path);
}
