import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from './paths.mjs';

/**
 * Read state.json. Returns empty object if missing or unreadable.
 * Shape: { pid?: number, port?: number, proxy?: string,
 *          profileSyncedAt?: string, lastStoppedAt?: string }
 * @returns {{pid?: number, port?: number, proxy?: string, profileSyncedAt?: string, lastStoppedAt?: string}}
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
 * Merge-write state.json.
 * @param {Partial<{pid: number, port: number, profileSyncedAt: string}>} patch
 */
export function writeState(patch) {
  mkdirSync(dirname(paths.state), { recursive: true });
  const cur = readState();
  const next = { ...cur, ...patch };
  writeFileSync(paths.state, JSON.stringify(next, null, 2), 'utf8');
}
