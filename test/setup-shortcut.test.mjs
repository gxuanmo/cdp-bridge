import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitArgs,
  addFlags,
  removeFlags,
  isManagedToken,
  MANAGED_FLAG_NAMES,
  addFlagsInRegistryValue,
  removeFlagsInRegistryValue,
} from '../src/commands/setup-shortcut.mjs';

// --- splitArgs -------------------------------------------------------------

test('splitArgs: empty string', () => {
  assert.deepEqual(splitArgs(''), []);
});

test('splitArgs: whitespace only', () => {
  assert.deepEqual(splitArgs('   '), []);
});

test('splitArgs: single unquoted token', () => {
  assert.deepEqual(splitArgs('--port=9222'), ['--port=9222']);
});

test('splitArgs: multiple unquoted tokens', () => {
  assert.deepEqual(splitArgs('--a --b=1 --c'), ['--a', '--b=1', '--c']);
});

test('splitArgs: token whose value is a quoted string with spaces', () => {
  // The whole `--user-data-dir="C:\My Path"` is one token because the
  // quoted segment is contiguous with the leading `--user-data-dir=`.
  assert.deepEqual(
    splitArgs('--user-data-dir="C:\\My Path" --port=9222'),
    ['--user-data-dir="C:\\My Path"', '--port=9222'],
  );
});

test('splitArgs: standalone quoted phrase', () => {
  assert.deepEqual(splitArgs('"hello world" --port=1'), ['"hello world"', '--port=1']);
});

test('splitArgs: idempotent on already-tokenized input (join back, split again)', () => {
  const input = '--user-data-dir="C:\\Users\\X\\User Data" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1';
  const tokens = splitArgs(input);
  assert.equal(tokens.join(' '), input);
});

// --- isManagedToken --------------------------------------------------------

test('isManagedToken: recognizes flag with value', () => {
  assert.equal(isManagedToken('--remote-debugging-port=9222'), true);
});

test('isManagedToken: recognizes quoted user-data-dir', () => {
  assert.equal(isManagedToken('--user-data-dir="C:\\Users\\X\\User Data"'), true);
});

test('isManagedToken: recognizes legacy flag (still in revert whitelist)', () => {
  assert.equal(isManagedToken('--remote-allow-origins=http://127.0.0.1:9222'), true);
});

test('isManagedToken: rejects unrelated flag', () => {
  assert.equal(isManagedToken('--incognito'), false);
});

test('isManagedToken: does not match flag prefix without `=`', () => {
  // `--user-data` is not the full name; we only match `--user-data-dir`.
  assert.equal(isManagedToken('--user-data=foo'), false);
});

test('isManagedToken: all canonical names listed', () => {
  for (const name of MANAGED_FLAG_NAMES) {
    assert.equal(isManagedToken(name + '=value'), true, name + ' should be managed');
  }
});

// --- addFlags --------------------------------------------------------------

test('addFlags: empty existing — appends new flags', () => {
  const result = addFlags('', ['--port=9222']);
  assert.equal(result, '--port=9222');
});

test('addFlags: preserves unrelated existing flags', () => {
  const result = addFlags('--incognito --foo', ['--remote-debugging-port=9222']);
  assert.equal(result, '--incognito --foo --remote-debugging-port=9222');
});

test('addFlags: replaces existing managed flag (no duplicates)', () => {
  const result = addFlags(
    '--remote-debugging-port=8888 --incognito',
    ['--remote-debugging-port=9222'],
  );
  assert.equal(result, '--incognito --remote-debugging-port=9222');
});

test('addFlags: strips legacy managed flag when not in newFlags', () => {
  // Old shortcut has the legacy --remote-allow-origins; new flags do not
  // include it (deliberately dropped in v0.2). addFlags should remove it.
  const result = addFlags(
    '--remote-allow-origins=http://127.0.0.1:9222 --incognito',
    ['--remote-debugging-port=9222'],
  );
  assert.equal(result, '--incognito --remote-debugging-port=9222');
});

test('addFlags: idempotent (running twice yields same result)', () => {
  const newFlags = ['--user-data-dir="C:\\Path"', '--remote-debugging-port=9222'];
  const once = addFlags('--incognito', newFlags);
  const twice = addFlags(once, newFlags);
  assert.equal(once, twice);
});

test('addFlags: round-trips a token whose value contains spaces', () => {
  const newFlags = ['--user-data-dir="C:\\Users\\X\\User Data"'];
  const result = addFlags('', newFlags);
  assert.deepEqual(splitArgs(result), newFlags);
});

// --- removeFlags -----------------------------------------------------------

test('removeFlags: strips all managed flags, keeps unmanaged', () => {
  const input = '--incognito --user-data-dir="C:\\Path" --remote-debugging-port=9222 --foo --remote-allow-origins=*';
  assert.equal(removeFlags(input), '--incognito --foo');
});

test('removeFlags: no-op when no managed flags present', () => {
  assert.equal(removeFlags('--incognito --foo'), '--incognito --foo');
});

test('removeFlags: empty result is empty string (not null)', () => {
  assert.equal(removeFlags('--user-data-dir="C:\\Path" --remote-debugging-port=9222'), '');
});

test('removeFlags: removes both current and legacy managed flags', () => {
  const input = '--user-data-dir="C:\\Path" --remote-allow-origins=http://127.0.0.1:9222 --remote-debugging-port=9222';
  assert.equal(removeFlags(input), '');
});

// --- Registry helpers ------------------------------------------------------

test('addFlagsInRegistryValue: prepends new flags to existing args, keeps %1', () => {
  const value = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1';
  const result = addFlagsInRegistryValue(value, ['--remote-debugging-port=9222']);
  assert.equal(
    result,
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --single-argument %1',
  );
});

test('addFlagsInRegistryValue: replaces old managed flags rather than duplicating', () => {
  const value = '"C:\\chrome.exe" --remote-debugging-port=8888 --single-argument %1';
  const result = addFlagsInRegistryValue(value, ['--remote-debugging-port=9222']);
  assert.equal(result, '"C:\\chrome.exe" --remote-debugging-port=9222 --single-argument %1');
});

test('addFlagsInRegistryValue: returns input unchanged when exe path is missing', () => {
  const value = 'not-a-proper-handler';
  assert.equal(addFlagsInRegistryValue(value, ['--port=1']), value);
});

test('removeFlagsInRegistryValue: strips managed flags but keeps exe + %1', () => {
  const value = '"C:\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\X" --single-argument %1';
  assert.equal(removeFlagsInRegistryValue(value), '"C:\\chrome.exe" --single-argument %1');
});

test('removeFlagsInRegistryValue: when only managed flags exist, leaves just exe', () => {
  const value = '"C:\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\X"';
  assert.equal(removeFlagsInRegistryValue(value), '"C:\\chrome.exe"');
});
