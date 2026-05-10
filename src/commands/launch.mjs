import { existsSync, readdirSync } from 'node:fs';
import { paths } from '../paths.mjs';
import { syncProfile } from '../profile-sync.mjs';
import {
  spawnSidecar,
  tryAttach,
  recordAttach,
  isChromeReady,
  PORTS,
} from '../chrome-manager.mjs';
import { readState } from '../state.mjs';
import { log } from '../logger.mjs';

/**
 * cdpb launch [--attach | --spawn] [--port N] [--headless] [--proxy <addr>|none] [--resync]
 *
 * Modes:
 *  - default: try attach to user's daily Chrome (port 9222). If attached,
 *    we use ALL of their cookies/sessions/extensions in-place — no profile
 *    copy, no ABE pain, full login state. If attach fails (Chrome not
 *    started with --remote-debugging-port=9222), prints actionable advice
 *    and exits non-zero. Won't silently fall back so the user knows.
 *  - --attach: same as default; just makes the intent explicit.
 *  - --spawn: spawn an isolated sidecar Chrome on port 9223 with our own
 *    profile dir (the v0.1 behavior). Use when you don't want any
 *    automation touching your daily Chrome, accepting that ABE blocks
 *    cross-instance cookie decryption (you'll re-login per site).
 *
 * Sidecar profile-sync rules apply only in spawn mode.
 */
export async function run(argv) {
  const wantSpawn = argv.includes('--spawn');
  const wantAttach = argv.includes('--attach');
  if (wantSpawn && wantAttach) throw new Error('--spawn and --attach are mutually exclusive');

  const port = pickFlag(argv, '--port', undefined, Number);
  const headless = argv.includes('--headless');
  const wantResync = argv.includes('--resync');
  const proxyVal = pickFlag(argv, '--proxy', undefined);

  if (await isChromeReady()) {
    const s = readState();
    log.info(s.mode + ' session already active port=' + s.port + (s.pid ? ' pid=' + s.pid : ''));
    return;
  }

  if (wantSpawn) {
    return doSpawn({ port: port ?? PORTS.sidecar, headless, proxyVal, wantResync });
  }

  // Default + --attach: try attach.
  const attachPort = port ?? PORTS.default;
  log.info('probing user Chrome at 127.0.0.1:' + attachPort + '...');
  const attached = await tryAttach({ ports: [attachPort] });
  if (attached) {
    // Warn about flags that only mean something in spawn mode, so users
    // who pass them expecting an effect aren't silently disappointed.
    const droppedFlags = [];
    if (proxyVal !== undefined) droppedFlags.push('--proxy');
    if (headless) droppedFlags.push('--headless');
    if (wantResync) droppedFlags.push('--resync');
    if (droppedFlags.length) {
      log.warn(
        'attach mode ignores ' + droppedFlags.join(', ') +
          ' — these only apply to spawn mode (the daily Chrome you attached to was started with its own flags).',
      );
    }
    recordAttach(attached);
    log.info('attached to user Chrome port=' + attached.port + ' product=' + attached.version.Browser);
    log.info('  using your daily Chrome — all cookies, extensions, login state are live');
    return;
  }

  if (wantAttach) {
    throw new Error(
      'no Chrome with CDP found on port ' + attachPort + '. Start Chrome with `--remote-debugging-port=' + attachPort +
        '` (or run `cdpb setup-shortcut` to add the flag to your Chrome shortcut), then re-run.',
    );
  }

  // Default mode without --attach: helpful, actionable error. We throw so the
  // CLI router (bin/cdpb.mjs) does the logging + non-zero exit uniformly.
  throw new Error(
    'no Chrome with CDP on port ' + attachPort + ' — pick one:\n' +
      '  1. `cdpb setup-shortcut` then restart Chrome from your shortcut (recommended; full login state)\n' +
      '  2. `cdpb launch --spawn` to spawn an isolated sidecar Chrome (no login state, ABE-limited)',
  );
}

async function doSpawn({ port, headless, proxyVal, wantResync }) {
  const hasExisting = existsSync(paths.chromeProfile) && readdirSync(paths.chromeProfile).length > 0;
  if (!hasExisting) {
    log.info('first spawn — initial profile sync (full)...');
    await runSync('initial');
  } else if (wantResync) {
    log.info('refreshing profile (skipping ABE-protected to keep sidecar logins)...');
    await runSync('resync');
  } else {
    log.info('reusing existing sidecar profile (no resync — sidecar logins preserved)');
  }

  log.info('spawning sidecar Chrome on port=' + port + ', headless=' + headless + '...');
  const r = await spawnSidecar({ port, headless, proxy: proxyVal });
  log.info(
    'ready: pid=' + r.pid + ' port=' + r.port + ' product=' + r.version.Browser +
      ' proxy=' + (r.proxy ?? 'none'),
  );
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
