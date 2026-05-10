import { readState } from '../state.mjs';
import { isSidecarRunning, probeCdp } from '../chrome-manager.mjs';
import { log } from '../logger.mjs';

/**
 * cdpb status — print pid/port and whether CDP is reachable.
 *
 * Output forms:
 *  - `never-launched`            no state.json or no pid ever recorded
 *  - `stopped (...)`             state.json exists, no pid (cdpb stop ran)
 *  - `dead pid=N port=P`         pid recorded but process gone (crash)
 *  - `ready pid=N port=P ...`    sidecar alive and CDP responds
 */
export async function run() {
  const s = readState();
  if (!s.pid) {
    if (s.lastStoppedAt) log.raw('stopped at=' + s.lastStoppedAt);
    else log.raw('never-launched');
    return;
  }
  const alive = await isSidecarRunning();
  if (!alive) {
    log.raw('dead pid=' + s.pid + ' port=' + s.port);
    return;
  }
  const v = await probeCdp(s.port);
  log.raw('ready pid=' + s.pid + ' port=' + s.port + ' product=' + (v?.Browser ?? 'unknown') + ' proxy=' + (s.proxy ?? 'none'));
}
