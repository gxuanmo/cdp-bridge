#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const bin = join(root, 'bin', 'cdpb.mjs');
const tmp = join(tmpdir(), 'cdpb-smoke-' + process.pid);
const screenshot = join(tmp, 'full-page.png');
const download = join(tmp, 'download.txt');

mkdirSync(tmp, { recursive: true });

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>cdpb smoke page</title>
    <style>
      body { margin: 0; font-family: Arial, sans-serif; }
      main { height: 2400px; padding: 48px; box-sizing: border-box; background: linear-gradient(#f7f7f7, #dedede); }
      h1 { margin: 0; font-size: 32px; }
    </style>
  </head>
  <body>
    <main>
      <h1 id="title">cdpb smoke</h1>
      <p>full-page capture target</p>
      <script>window.__cdpbSmoke = 42;</script>
    </main>
  </body>
</html>`;

const server = createServer((req, res) => {
  if (req.url === '/file.txt') {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Disposition': 'attachment; filename="smoke.txt"',
    });
    res.end('cdpb smoke file\n');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

function run(args, opts = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const { timeoutMs = 60000, ...spawnOpts } = opts;
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: root,
      windowsHide: true,
      ...spawnOpts,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectRun(new Error(
          'cdpb ' + args.join(' ') + ' failed with exit ' + code + (timedOut ? ' (timeout)' : '') + '\n' +
            (stdout ? 'stdout:\n' + stdout : '') +
            (stderr ? 'stderr:\n' + stderr : ''),
        ));
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });
}

function readPngSize(path) {
  const buf = readFileSync(path);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bytes: buf.length,
  };
}

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const statusBefore = (await run(['status'])).stdout.trim();
  if (statusBefore.startsWith('ready ')) {
    throw new Error('refusing to run smoke while a cdpb session is already ready: ' + statusBefore);
  }

  await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  const { port } = server.address();
  const baseUrl = 'http://127.0.0.1:' + port;

  try {
    await run(['launch', '--spawn', '--headless', '--proxy', 'none']);
    const status = (await run(['status'])).stdout.trim();
    assertOk(status.includes('ready mode=spawn'), 'expected ready spawn status, got: ' + status);

    const execResult = JSON.parse(
      (await run([
        'exec',
        baseUrl + '/',
        "({title:document.title,h1:document.querySelector('#title').textContent,smoke:window.__cdpbSmoke,height:document.documentElement.scrollHeight})",
      ])).stdout,
    );
    assertOk(execResult.title === 'cdpb smoke page', 'unexpected exec title');
    assertOk(execResult.h1 === 'cdpb smoke', 'unexpected exec h1');
    assertOk(execResult.smoke === 42, 'unexpected exec smoke value');
    assertOk(execResult.height >= 2400, 'unexpected page height: ' + execResult.height);

    await run(['screenshot', baseUrl + '/', '--full-page', '-o', screenshot]);
    const size = readPngSize(screenshot);
    assertOk(size.width > 0, 'screenshot width should be positive');
    assertOk(size.height >= 2400, 'expected full-page screenshot height >= 2400, got ' + size.height);

    await run(['fetch', baseUrl + '/file.txt', '-o', download, '--timeout', '30000']);
    const text = readFileSync(download, 'utf8').trim();
    assertOk(text === 'cdpb smoke file', 'unexpected downloaded text: ' + text);

    console.log(JSON.stringify({
      status,
      exec: execResult,
      screenshot: { path: screenshot, ...size },
      fetch: { path: download, text },
    }, null, 2));
  } finally {
    try { await run(['stop']); } catch {}
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
