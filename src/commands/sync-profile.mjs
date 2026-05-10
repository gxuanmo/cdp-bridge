import { syncProfile } from '../profile-sync.mjs';
import { isSidecarRunning } from '../chrome-manager.mjs';
import { log } from '../logger.mjs';

/**
 * cdpb sync-profile [--full]
 *
 * Refresh sidecar profile from user's main Chrome.
 *
 *  - Default (resync): copies bookmarks, extensions, prefs, etc. Skips
 *    ABE-protected files (Cookies, Login Data, Web Data) so the sidecar's
 *    own logins are preserved. This is what you want most of the time.
 *  - --full: copies ABE-protected files too. Useful only on first launch
 *    (where there's nothing to preserve) or as a manual reset that wipes
 *    sidecar's accumulated logins.
 *
 * Refuses to run while sidecar is up — Chrome holds Preferences/Extensions
 * open, sync would partially fail. Stop sidecar first.
 */
export async function run(argv) {
  if (await isSidecarRunning()) {
    throw new Error('sidecar Chrome is running — `cdpb stop` first, then `cdpb sync-profile`');
  }

  const full = argv.includes('--full');
  const mode = full ? 'initial' : 'resync';

  log.info('sync-profile mode=' + mode + (full ? ' (full — will overwrite sidecar cookies/logins!)' : ' (preserves sidecar logins)'));
  const t0 = Date.now();
  const r = await syncProfile({ mode });
  log.info(
    'synced ' + r.copied.length + ' entries in ' + (Date.now() - t0) + 'ms' +
    (r.retried.length ? ', retried ' + r.retried.length : '') +
    (r.skipped.length ? ', skipped ' + r.skipped.length : ''),
  );
  if (r.retried.length) for (const s of r.retried) log.info('  retried ' + s);
  if (r.skipped.length) for (const s of r.skipped) log.info('  skipped ' + s);
}
