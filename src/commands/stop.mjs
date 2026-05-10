import { stopSidecar } from '../chrome-manager.mjs';
import { log } from '../logger.mjs';

/**
 * cdpb stop — kill sidecar Chrome (taskkill /T /F).
 */
export async function run() {
  const r = stopSidecar();
  if (!r.killed && !r.pid) {
    log.info('no sidecar pid recorded; nothing to stop');
    return;
  }
  if (r.killed) log.info('killed sidecar pid=' + r.pid);
  else log.warn('failed to kill pid=' + r.pid);
}
