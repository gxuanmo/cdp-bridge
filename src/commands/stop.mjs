import { stopChrome } from '../chrome-manager.mjs';
import { log } from '../logger.mjs';

/**
 * cdpb stop — clean up the current Chrome session.
 *
 *  - spawn mode: kill the sidecar via `taskkill /T /F`
 *  - attach mode: just clear our state.json record; **never kills the
 *    user's daily Chrome**
 *  - no session: no-op
 */
export async function run() {
  const r = stopChrome();
  if (r.mode === 'none') {
    log.info('no active session to stop');
    return;
  }
  if (r.mode === 'attach') {
    log.info('cleared attach session record (your daily Chrome was not touched)');
    return;
  }
  if (r.killed) log.info('killed sidecar pid=' + r.pid);
  else log.warn('failed to kill pid=' + r.pid);
}
