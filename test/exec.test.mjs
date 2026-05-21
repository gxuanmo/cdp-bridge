import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExecArgs } from '../src/commands/exec.mjs';

test('parseExecArgs: extracts URL and JS', () => {
  const { url, js } = parseExecArgs(['https://example.com', 'document.title']);
  assert.equal(url, 'https://example.com');
  assert.equal(js, 'document.title');
});

test('parseExecArgs: ignores flags', () => {
  const { url, js } = parseExecArgs(['--some-flag', 'https://example.com', '1+1']);
  assert.equal(url, 'https://example.com');
  assert.equal(js, '1+1');
});

test('parseExecArgs: about:blank URL accepted', () => {
  const { url, js } = parseExecArgs(['about:blank', '1+1']);
  assert.equal(url, 'about:blank');
  assert.equal(js, '1+1');
});

test('parseExecArgs: data: URL accepted', () => {
  const { url, js } = parseExecArgs(['data:text/html,<p>hi</p>', 'document.body.textContent']);
  assert.equal(url, 'data:text/html,<p>hi</p>');
  assert.equal(js, 'document.body.textContent');
});

test('parseExecArgs: JS with spaces as single arg', () => {
  const { js } = parseExecArgs(['https://example.com', 'document.querySelector("a")']);
  assert.equal(js, 'document.querySelector("a")');
});

test('parseExecArgs: throws on missing URL', () => {
  assert.throws(() => parseExecArgs([]), /usage:/);
});

test('parseExecArgs: throws on missing JS', () => {
  assert.throws(() => parseExecArgs(['https://example.com']), /usage:/);
});

test('parseExecArgs: throws when only flags provided', () => {
  assert.throws(() => parseExecArgs(['--verbose']), /usage:/);
});
