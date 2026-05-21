import { readState } from '../state.mjs';
import { isChromeReady, probeCdp } from '../chrome-manager.mjs';
import { log } from '../logger.mjs';

/**
 * cdpb status — show current Chrome session state.
 *
 * Output forms:
 *  - `never-launched`             no state.json or no session ever recorded
 *  - `stopped at=...`             prior session was stopped (cdpb stop)
 *  - `dead pid=N port=P`          spawn-mode pid recorded but process gone
 *  - `attach-stale port=P`        attach-mode but probe failed — user
 *                                 likely closed/restarted Chrome without flags
 *  - `ready mode=M port=P ...`    session reachable
 */
export async function run() {
  const s = readState();
  if (!s.mode) {
    if (s.lastStoppedAt) log.raw('stopped at=' + s.lastStoppedAt);
    else log.raw('never-launched');
    return;
  }

  const ready = await isChromeReady();
  if (!ready) {
    if (s.mode === 'spawn') log.raw('dead pid=' + s.pid + ' port=' + s.port);
    else log.raw('attach-stale port=' + s.port + ' — user Chrome closed or lost CDP flag');
    return;
  }

  const v = await probeCdp(s.port);
  let line = 'ready mode=' + s.mode + ' port=' + s.port + ' product=' + (v?.Browser ?? 'unknown');
  if (s.mode === 'spawn') line += ' pid=' + s.pid + ' proxy=' + (s.proxy ?? 'none');
  log.raw(line);
}
