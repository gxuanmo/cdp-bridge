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
 * **Race-safety notes**: `openSync('wx')` is atomic — only one creator wins
 * the syscall. But stale-recovery is NOT a single syscall: we read + check
 * pid + unlink + retry-openSync. Two concurrent recoveries could race so
 * that one process's `unlinkSync` deletes another's freshly-acquired
 * lock. Two defenses:
 *   1. `handleStaleLock` re-reads the file contents RIGHT BEFORE unlink,
 *      so if a competing process already replaced the lock between our
 *      read-pid and our unlink, we back off.
 *   2. After our own write, we read back the file. If the contents don't
 *      match our claim, we lost the race and bail out of fn() entirely.
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
      // wx = O_CREAT | O_EXCL — atomic create-or-fail.
      fd = openSync(LOCK_PATH, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Only attempt stale recovery once; if openSync still fails on the
      // retry, give up — someone else is genuinely holding the lock.
      if (attempt === 0 && handleStaleLock()) continue;
      throw lockHeldError();
    }
    const ourClaim = JSON.stringify({ pid: process.pid, ts: Date.now() });
    try {
      writeFileSync(fd, ourClaim);
      closeSync(fd);
      fd = null;
      // Defense layer 2: read back. If a concurrent stale-recovery raced
      // past us — unlinking our just-written lock and writing its own —
      // the file content won't match what we wrote. Bail without running
      // fn() so we don't double-hold with the racer.
      const readBack = readFileSync(LOCK_PATH, 'utf8');
      if (readBack !== ourClaim) throw lockHeldError();
      return await fn();
    } finally {
      if (fd != null) { try { closeSync(fd); } catch {} }
      // Only unlink if the file STILL contains our claim. Avoids
      // accidentally removing a lock another process took over after our
      // owner went away — they own it now, leave it alone.
      try {
        const cur = readFileSync(LOCK_PATH, 'utf8');
        if (cur === ourClaim) unlinkSync(LOCK_PATH);
      } catch {}
    }
  }

  throw new Error('failed to acquire cdpb lock at ' + LOCK_PATH);
}

/**
 * Inspect an existing lock file; if it points at a dead pid (or is
 * unparseable garbage), remove it so the next attempt can take over.
 * Returns true iff we unlinked — caller should retry.
 *
 * Race-safe: re-reads the file right before unlink and only unlinks when
 * the content still matches what we observed as stale. If another
 * process already replaced the lock between our pid check and our
 * unlink, we leave their lock alone.
 *
 * @returns {boolean}
 */
function handleStaleLock() {
  let content;
  try {
    content = readFileSync(LOCK_PATH, 'utf8');
  } catch {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Unparseable garbage. Only unlink if it's still the same garbage.
    return unlinkIfUnchanged(content);
  }
  if (typeof parsed.pid !== 'number' || isAlive(parsed.pid)) return false;
  return unlinkIfUnchanged(content);
}

/**
 * Unlink LOCK_PATH only if its current contents byte-equal `expected`.
 * Best-effort race-narrowing: the window between this re-read and the
 * unlink is a single fs syscall (~microseconds), versus the original
 * window of read-pid → check-alive → unlink (multiple syscalls).
 *
 * @param {string} expected
 * @returns {boolean}
 */
function unlinkIfUnchanged(expected) {
  try {
    const current = readFileSync(LOCK_PATH, 'utf8');
    if (current !== expected) return false;
    unlinkSync(LOCK_PATH);
    return true;
  } catch {
    return false;
  }
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
