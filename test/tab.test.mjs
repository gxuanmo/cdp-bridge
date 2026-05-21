import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTabArgs } from '../src/commands/tab.mjs';

test('parseTabArgs: list', () => {
  const { sub, arg } = parseTabArgs(['list']);
  assert.equal(sub, 'list');
  assert.equal(arg, undefined);
});

test('parseTabArgs: new with URL', () => {
  const { sub, arg } = parseTabArgs(['new', 'https://example.com']);
  assert.equal(sub, 'new');
  assert.equal(arg, 'https://example.com');
});

test('parseTabArgs: close with targetId', () => {
  const { sub, arg } = parseTabArgs(['close', 'ABC123']);
  assert.equal(sub, 'close');
  assert.equal(arg, 'ABC123');
});

test('parseTabArgs: throws on empty argv', () => {
  assert.throws(() => parseTabArgs([]), /usage:/);
});

test('parseTabArgs: throws on unknown subcommand', () => {
  assert.throws(() => parseTabArgs(['delete', 'ABC123']), /unknown tab subcommand/);
});

test('parseTabArgs: throws on arbitrary string', () => {
  assert.throws(() => parseTabArgs(['foobar']), /unknown tab subcommand/);
});

test('parseTabArgs: extra args are ignored (arg captures only argv[1])', () => {
  const { sub, arg } = parseTabArgs(['new', 'https://x.com', 'extra']);
  assert.equal(sub, 'new');
  assert.equal(arg, 'https://x.com');
});
