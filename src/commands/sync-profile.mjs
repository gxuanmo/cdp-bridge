import { syncProfile } from '../profile-sync.mjs';
import { readState } from '../state.mjs';
import { isChromeReady } from '../chrome-manager.mjs';
import { log } from '../logger.mjs';

/**
 * cdpb sync-profile [--full]
 *
 * Refresh **sidecar** profile from user's main Chrome. This is a spawn-mode
 * operation: it copies files from the user's normal Chrome User Data into
 * `~/.cdp-bridge/chrome-profile/`. It is meaningless in attach mode (we
 * don't keep our own profile dir there).
 *
 *  - Default (resync): copies bookmarks, extensions, prefs, etc. Skips
 *    ABE-protected files (Cookies, Login Data, Web Data) so the sidecar's
 *    own logins are preserved.
 *  - --full: copies ABE-protected files too. Useful only on first spawn
 *    (where there's nothing to preserve) or as a manual reset.
 *
 * Refuses to run while a spawned sidecar is up — Chrome holds Preferences/
 * Extensions open and the sync would partially fail.
 */
export async function run(argv) {
  const s = readState();

  if (s.mode === 'attach') {
    throw new Error(
      'sync-profile is a spawn-mode operation; current session is attached to your daily Chrome. ' +
        'There is no sidecar profile to refresh in attach mode.',
    );
  }

  if (s.mode === 'spawn' && (await isChromeReady())) {
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
