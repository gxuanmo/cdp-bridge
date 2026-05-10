import { existsSync, readdirSync } from 'node:fs';
import { paths } from '../paths.mjs';
import { syncProfile } from '../profile-sync.mjs';
import { launchSidecar, isSidecarRunning } from '../chrome-manager.mjs';
import { readState } from '../state.mjs';
import { log } from '../logger.mjs';

/**
 * cdpb launch [--port N] [--headless] [--proxy <addr>|none] [--resync]
 *
 * Behaviour:
 *  - If sidecar already running, no-op (idempotent).
 *  - First-ever launch (sidecar profile missing/empty): runs full INITIAL
 *    sync (visible state + ABE-protected files). After that, subsequent
 *    launches DO NOT auto-resync, so cookies you generate in sidecar
 *    survive across restarts. Pass --resync to refresh non-ABE files
 *    (bookmarks, extensions, prefs); ABE-protected files (cookies, login
 *    data) are never re-synced (Chrome 127+ ABE blocks decryption anyway,
 *    so re-syncing only trashes your sidecar logins).
 *  - Proxy: explicit --proxy wins; --proxy none disables; otherwise Chrome
 *    inherits Windows system proxy via explicit --proxy-server pass-through.
 */
export async function run(argv) {
  const port = pickFlag(argv, '--port', 9222, Number);
  const headless = argv.includes('--headless');
  const wantResync = argv.includes('--resync');
  const proxyVal = pickFlag(argv, '--proxy', undefined);

  if (await isSidecarRunning()) {
    const s = readState();
    log.info('sidecar already running pid=' + s.pid + ' port=' + s.port);
    return;
  }

  const hasExisting = existsSync(paths.chromeProfile) && readdirSync(paths.chromeProfile).length > 0;
  if (!hasExisting) {
    log.info('first launch — initial profile sync (full)...');
    await runSync('initial');
  } else if (wantResync) {
    log.info('refreshing profile (skipping ABE-protected to keep sidecar logins)...');
    await runSync('resync');
  } else {
    log.info('reusing existing sidecar profile (no resync — sidecar logins preserved)');
  }

  log.info('launching sidecar Chrome (port=' + port + ', headless=' + headless + ')...');
  const r = await launchSidecar({ port, headless, proxy: proxyVal });
  log.info('ready: pid=' + r.pid + ' port=' + r.port + ' product=' + r.version.Browser + ' proxy=' + (r.proxy ?? 'none'));
}

/**
 * @param {'initial' | 'resync'} mode
 */
async function runSync(mode) {
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

function pickFlag(argv, name, def, cast) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return cast ? cast(v) : v;
}
