import { stopChrome } from '../chrome-manager.mjs';
import { log } from '../logger.mjs';

/**
 * cdpb stop — clean up the current Chrome session.
 *
 *  - spawn mode: two-stage shutdown — first ask Chrome to close gracefully
 *    over CDP (so it flushes cookies / IndexedDB / Local Storage to its
 *    SQLite stores), poll up to 5s for natural exit, then fall back to
 *    `taskkill /T /F`. Logged as `(graceful close)` or `(force kill)`.
 *  - attach mode: just clear our state.json record; **never kills the
 *    user's daily Chrome**.
 *  - no session: no-op.
 */
export async function run() {
  const r = await stopChrome();
  if (r.mode === 'none') {
    log.info('no active session to stop');
    return;
  }
  if (r.mode === 'attach') {
    log.info('cleared attach session record (your daily Chrome was not touched)');
    return;
  }
  if (r.killed) {
    log.info('killed sidecar pid=' + r.pid + (r.graceful ? ' (graceful close)' : ' (force kill)'));
  } else {
    log.warn('failed to kill pid=' + r.pid);
  }
}
