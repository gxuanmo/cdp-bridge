import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  withLock,
  isAlive,
  handleStaleLock,
  unlinkIfUnchanged,
  setLockPath,
} from '../src/lock.mjs';

const tmp = join(tmpdir(), 'cdpb-test-lock-' + process.pid);
let lockFile = join(tmp, 'test.lock');

setLockPath(lockFile);

function reset() {
  try { unlinkSync(lockFile); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  mkdirSync(tmp, { recursive: true });
}

function writeLock(pid) {
  writeFileSync(lockFile, JSON.stringify({ pid, ts: Date.now() }), 'utf8');
}

beforeEach(reset);
afterEach(reset);

// --- isAlive ---------------------------------------------------------------

test('isAlive: own pid is alive', () => {
  assert.equal(isAlive(process.pid), true);
});

test('isAlive: non-existent pid is dead', () => {
  assert.equal(isAlive(999999), false);
});

// --- unlinkIfUnchanged -----------------------------------------------------

test('unlinkIfUnchanged: unlinks when content matches', () => {
  writeFileSync(lockFile, 'hello', 'utf8');
  assert.equal(unlinkIfUnchanged(lockFile, 'hello'), true);
  // File should be gone
  try { readFileSync(lockFile, 'utf8'); assert.fail('file should be gone'); } catch (e) {
    assert.equal(e.code, 'ENOENT');
  }
});

test('unlinkIfUnchanged: leaves file when content differs', () => {
  writeFileSync(lockFile, 'hello', 'utf8');
  assert.equal(unlinkIfUnchanged(lockFile, 'bye'), false);
  // File should still be there
  assert.equal(readFileSync(lockFile, 'utf8'), 'hello');
});

test('unlinkIfUnchanged: returns false when file does not exist', () => {
  assert.equal(unlinkIfUnchanged(lockFile, 'hello'), false);
});

// --- handleStaleLock -------------------------------------------------------

test('handleStaleLock: recovers from dead pid', () => {
  writeLock(999999);
  assert.equal(handleStaleLock(lockFile), true);
  // File should be gone
  try { readFileSync(lockFile, 'utf8'); assert.fail('stale lock not unlinked'); } catch (e) {
    assert.equal(e.code, 'ENOENT');
  }
});

test('handleStaleLock: leaves alive pid alone', () => {
  writeLock(process.pid);
  assert.equal(handleStaleLock(lockFile), false);
  // File should still be there
  const data = JSON.parse(readFileSync(lockFile, 'utf8'));
  assert.equal(data.pid, process.pid);
});

test('handleStaleLock: recovers from unparseable garbage', () => {
  writeFileSync(lockFile, 'not json', 'utf8');
  assert.equal(handleStaleLock(lockFile), true);
});

test('handleStaleLock: returns false when file does not exist', () => {
  assert.equal(handleStaleLock(lockFile), false);
});

// --- withLock: serialization -----------------------------------------------

test('withLock: exactly one caller succeeds when raced', async () => {
  let entered = 0;

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      withLock(async () => {
        entered++;
        await new Promise((r) => setTimeout(r, 2));
      }),
    ),
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  // Exactly one wins the lock; others get lockHeldError.
  assert.equal(succeeded, 1);
  assert.equal(failed, 7);
  assert.equal(entered, 1);
});

test('withLock: second caller succeeds after holder finishes', async () => {
  reset();

  // P1 acquires, holds briefly, releases.
  const r1 = await withLock(async () => 'a');

  // P2 acquires immediately after — lock should be free.
  const r2 = await withLock(async () => 'b');

  assert.equal(r1, 'a');
  assert.equal(r2, 'b');
});

test('withLock: returns fn result', async () => {
  reset();
  const result = await withLock(async () => 42);
  assert.equal(result, 42);
});

test('withLock: cleans up lock after fn completes', async () => {
  reset();
  await withLock(async () => {});
  try { readFileSync(lockFile, 'utf8'); assert.fail('lock not cleaned up'); } catch (e) {
    assert.equal(e.code, 'ENOENT');
  }
});

test('withLock: cleans up lock after fn throws', async () => {
  reset();
  try {
    await withLock(async () => { throw new Error('boom'); });
  } catch {}
  try { readFileSync(lockFile, 'utf8'); assert.fail('lock not cleaned up after throw'); } catch (e) {
    assert.equal(e.code, 'ENOENT');
  }
});

test('withLock: recovers from stale lock left by dead pid', async () => {
  reset();
  writeLock(999999);
  const result = await withLock(async () => 'recovered');
  assert.equal(result, 'recovered');
});
