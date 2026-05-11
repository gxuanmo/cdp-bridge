import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.mjs';

const LOCK_PATH = join(paths.root, '.lock');

/**
 * Process-existence check via signal-0 kill. On Windows, Node maps signal 0
 * to a no-op probe; returns true if the pid is alive (or EPERM = exists
 * but we lack the rights to see it).
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Acquire an exclusive cdpb lock, run `fn`, release.
 *
 * Why a file lock at all: cdpb commands that touch `state.json` or
 * `Browser.setDownloadBehavior` (which is process-wide on Chrome's side)
 * race against each other when invoked concurrently. Two parallel
 * `cdpb fetch` calls in the same Chrome would overwrite each other's
 * download path mid-flight. The lock makes the CLI single-writer.
 *
 * Stale-lock recovery: if the lock file points at a pid that's no longer
 * alive (crashed cdpb / killed via Ctrl-C without cleanup), we replace it.
 * If the lock file is unreadable garbage, same — take over.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withLock(fn) {
  mkdirSync(paths.root, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      // wx = O_CREAT | O_EXCL — atomic create-or-fail. The OS guarantees
      // only one process can pass this point at a time.
      fd = openSync(LOCK_PATH, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (handleStaleLock()) continue; // unlinked stale; retry once
      throw lockHeldError();
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      closeSync(fd);
      fd = null;
      return await fn();
    } finally {
      if (fd != null) { try { closeSync(fd); } catch {} }
      try { unlinkSync(LOCK_PATH); } catch {}
    }
  }

  throw new Error('failed to acquire cdpb lock at ' + LOCK_PATH);
}

/**
 * Inspect an existing lock file; if it points at a dead pid (or is
 * unparseable), remove it so the next attempt can take over. Returns
 * true iff we unlinked something — caller should retry.
 * @returns {boolean}
 */
function handleStaleLock() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  } catch {
    // Unreadable. Treat as stale.
    try { unlinkSync(LOCK_PATH); return true; } catch { return false; }
  }
  if (typeof parsed.pid === 'number' && !isAlive(parsed.pid)) {
    try { unlinkSync(LOCK_PATH); return true; } catch { return false; }
  }
  return false;
}

function lockHeldError() {
  let pidPart = '';
  try {
    const parsed = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
    if (parsed.pid) pidPart = ' (held by pid=' + parsed.pid + ')';
  } catch {}
  return new Error(
    'another cdpb command is running' + pidPart + '. Wait for it to finish, or — if you are certain no cdpb is running — delete `' + LOCK_PATH + '` manually.',
  );
}
