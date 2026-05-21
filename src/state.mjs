import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from './paths.mjs';

/**
 * Read state.json. Returns empty object if missing or unreadable.
 *
 * Shape: { mode?: 'attach' | 'spawn',
 *          pid?: number,             // spawn only — daily Chrome pid is unknown to us
 *          port?: number,
 *          proxy?: string,           // spawn only — what we passed to Chrome's --proxy-server
 *          profileSyncedAt?: string, // spawn only — last successful sidecar profile copy
 *          lastStoppedAt?: string }
 *
 * @returns {{mode?: 'attach' | 'spawn', pid?: number, port?: number, proxy?: string, profileSyncedAt?: string, lastStoppedAt?: string}}
 */
export function readState() {
  if (!existsSync(paths.state)) return {};
  try {
    return JSON.parse(readFileSync(paths.state, 'utf8'));
  } catch (err) {
    return {};
  }
}

/**
 * Merge-write state.json. Pass `undefined` for any field to clear it.
 * @param {Partial<{mode: 'attach' | 'spawn' | undefined, pid: number | undefined, port: number | undefined, proxy: string | undefined, profileSyncedAt: string | undefined, lastStoppedAt: string | undefined}>} patch
 */
export function writeState(patch) {
  mkdirSync(dirname(paths.state), { recursive: true });
  const cur = readState();
  const next = { ...cur, ...patch };
  writeFileSync(paths.state, JSON.stringify(next, null, 2), 'utf8');
}
