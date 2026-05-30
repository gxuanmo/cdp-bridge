import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCaptureScreenshotParams,
  parseScreenshotArgs,
} from '../src/commands/screenshot.mjs';

test('parseScreenshotArgs: extracts URL from argv', () => {
  const { url, output, fullPage } = parseScreenshotArgs(['https://example.com']);
  assert.equal(url, 'https://example.com');
  assert.equal(output, undefined);
  assert.equal(fullPage, false);
});

test('parseScreenshotArgs: extracts -o flag', () => {
  const { url, output } = parseScreenshotArgs(['https://example.com', '-o', './out.png']);
  assert.equal(url, 'https://example.com');
  assert.equal(output, './out.png');
});

test('parseScreenshotArgs: extracts --output flag', () => {
  const { url, output } = parseScreenshotArgs(['https://example.com', '--output', 'shot.png']);
  assert.equal(url, 'https://example.com');
  assert.equal(output, 'shot.png');
});

test('parseScreenshotArgs: detects --full-page', () => {
  const { fullPage } = parseScreenshotArgs(['https://example.com', '--full-page']);
  assert.equal(fullPage, true);
});

test('parseScreenshotArgs: fullPage false without flag', () => {
  const { fullPage } = parseScreenshotArgs(['https://example.com']);
  assert.equal(fullPage, false);
});

test('parseScreenshotArgs: all flags combined', () => {
  const { url, output, fullPage } = parseScreenshotArgs([
    'https://example.com/page',
    '--full-page',
    '-o',
    'full.png',
  ]);
  assert.equal(url, 'https://example.com/page');
  assert.equal(output, 'full.png');
  assert.equal(fullPage, true);
});

test('parseScreenshotArgs: URL at any position', () => {
  const { url } = parseScreenshotArgs(['-o', 'x.png', '--full-page', 'https://example.com']);
  assert.equal(url, 'https://example.com');
});

test('parseScreenshotArgs: throws on missing URL', () => {
  assert.throws(() => parseScreenshotArgs([]), /usage:/);
  assert.throws(() => parseScreenshotArgs(['-o', 'x.png']), /usage:/);
});

test('parseScreenshotArgs: -o flag without value returns undefined', () => {
  const { url, output } = parseScreenshotArgs(['https://example.com', '-o']);
  assert.equal(url, 'https://example.com');
  assert.equal(output, undefined);
});

test('buildCaptureScreenshotParams: viewport screenshot has no clip', () => {
  assert.deepEqual(
    buildCaptureScreenshotParams({ cssContentSize: { width: 100, height: 200 } }, false),
    { format: 'png' },
  );
});

test('buildCaptureScreenshotParams: full page uses css content size', () => {
  assert.deepEqual(
    buildCaptureScreenshotParams({ cssContentSize: { width: 100.2, height: 2400.1 } }, true),
    {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 101, height: 2401, scale: 1 },
    },
  );
});

test('buildCaptureScreenshotParams: falls back to legacy contentSize', () => {
  assert.deepEqual(
    buildCaptureScreenshotParams({ contentSize: { width: 763, height: 2400 } }, true),
    {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 763, height: 2400, scale: 1 },
    },
  );
});
