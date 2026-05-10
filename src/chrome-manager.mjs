import { spawn, execFileSync } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { paths, findChromeExe } from './paths.mjs';
import { readState, writeState } from './state.mjs';
import { getWindowsSystemProxy } from './system-proxy.mjs';
import { log } from './logger.mjs';

const DEFAULT_PORT = 9222;
const SIDECAR_PORT = 9223;

/**
 * Check if a process is alive on Windows by sending signal 0.
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // EPERM means process exists but no permission
  }
}

/**
 * Probe CDP HTTP endpoint /json/version to confirm Chrome is ready.
 * @param {number} port
 * @returns {Promise<null | object>} version JSON or null on failure
 */
export async function probeCdp(port) {
  try {
    const ctl = AbortSignal.timeout(2000);
    const res = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: ctl });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Wait until /json/version responds, polling every 250ms.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<object>} version JSON
 */
async function waitForCdp(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await probeCdp(port);
    if (v) return v;
    await delay(250);
  }
  throw new Error('CDP did not become ready on port ' + port + ' within ' + timeoutMs + 'ms');
}

/**
 * Is the recorded Chrome session reachable? Works for both attach and spawn
 * modes. For spawn mode also checks the recorded pid is alive.
 *
 * Requires `mode` to be set — orphan port records (from a stop that didn't
 * also clear port) shouldn't make `isChromeReady` lie about ownership.
 *
 * @returns {Promise<boolean>}
 */
export async function isChromeReady() {
  const s = readState();
  if (!s.mode || !s.port) return false;
  if (s.mode === 'spawn' && (!s.pid || !isAlive(s.pid))) return false;
  return (await probeCdp(s.port)) != null;
}

/**
 * Try to attach to the user's daily Chrome via CDP. Probes a list of common
 * ports (9222 by default; 9223 reserved for our spawned sidecar so we don't
 * accidentally attach to ourselves and re-spawn).
 *
 * @param {{ ports?: number[] }} [opts]
 * @returns {Promise<{ port: number, version: object } | null>}
 */
export async function tryAttach(opts = {}) {
  const ports = opts.ports ?? [DEFAULT_PORT];
  for (const p of ports) {
    const v = await probeCdp(p);
    if (v) return { port: p, version: v };
  }
  return null;
}

/**
 * Resolve the proxy string Chrome should be told to use.
 *  - explicit `opts.proxy` wins (string sets, 'none' disables)
 *  - else read Windows system proxy from registry
 *  - else null (no proxy flag)
 */
function resolveProxy(opts) {
  if (opts.proxy === 'none') return null;
  if (opts.proxy) return opts.proxy;
  return getWindowsSystemProxy();
}

/**
 * Spawn a fresh sidecar Chrome with our own profile dir and CDP port.
 *
 * The sidecar runs on SIDECAR_PORT (9223) so it never collides with the
 * user's daily Chrome listening on 9222 — both can coexist.
 *
 * Detaches from the parent so the CLI can exit while Chrome stays running.
 *
 * @param {{ port?: number, headless?: boolean, proxy?: string | 'none' }} [opts]
 * @returns {Promise<{ pid: number, port: number, version: object, proxy: string | null }>}
 */
export async function spawnSidecar(opts = {}) {
  const port = opts.port ?? SIDECAR_PORT;
  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(paths.chromeProfile, { recursive: true });

  const s = readState();
  if (s.mode === 'spawn' && s.pid && isAlive(s.pid) && (await probeCdp(s.port))) {
    return { pid: s.pid, port: s.port, version: await probeCdp(s.port), proxy: s.proxy ?? null };
  }

  const proxy = resolveProxy(opts);
  const chrome = findChromeExe();
  const args = [
    '--user-data-dir=' + paths.chromeProfile,
    '--remote-debugging-port=' + port,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ChromeWhatsNewUI',
    ...(proxy ? ['--proxy-server=' + proxy] : []),
    ...(opts.headless ? ['--headless=new'] : []),
  ];

  const stderrFd = openSync(paths.chromeStderr, 'a');
  const child = spawn(chrome, args, {
    detached: true,
    stdio: ['ignore', 'ignore', stderrFd],
    windowsHide: false,
  });
  child.unref();

  if (!child.pid) throw new Error('Failed to spawn chrome.exe');
  log.info('spawned chrome.exe pid=' + child.pid + ' port=' + port + (proxy ? ' proxy=' + proxy : ' proxy=none'));

  // Persist BEFORE waiting on CDP so that if waitForCdp times out (locked
  // user-data-dir, ABE policy, AV delay, etc.) `cdpb stop` can still kill
  // the orphan via state.json. We patch the record again on success to add
  // version/profile timestamps.
  writeState({
    mode: 'spawn',
    pid: child.pid,
    port,
    proxy: proxy ?? undefined,
  });

  let version;
  try {
    version = await waitForCdp(port, 30000);
  } catch (err) {
    // Leave state.json populated so user can `cdpb stop` to recover.
    throw new Error(
      err.message + ' — chrome.exe pid=' + child.pid + ' is detached; run `cdpb stop` to kill it.',
    );
  }
  writeState({ profileSyncedAt: new Date().toISOString() });
  return { pid: child.pid, port, version, proxy };
}

/**
 * Persist an attach connection. We don't know the daily Chrome's pid (and
 * don't need it — we re-probe per command); we just remember the port.
 *
 * @param {{ port: number, version: object }} info
 */
export function recordAttach(info) {
  writeState({
    mode: 'attach',
    pid: undefined,
    port: info.port,
    proxy: undefined, // user's Chrome carries its own proxy config; we don't override
  });
}

/**
 * Stop only applies to spawn mode — we never kill the user's daily Chrome
 * even if state.json points at it. In attach mode this just clears the
 * connection record.
 *
 * @returns {{ killed: boolean, mode: 'attach' | 'spawn' | 'none', pid?: number }}
 */
export function stopChrome() {
  const s = readState();
  if (!s.mode) return { killed: false, mode: 'none' };

  if (s.mode === 'attach') {
    writeState({ pid: undefined, port: undefined, mode: undefined, lastStoppedAt: new Date().toISOString() });
    return { killed: false, mode: 'attach' };
  }

  if (!s.pid) return { killed: false, mode: 'spawn' };
  // Synchronous taskkill so we actually know if it succeeded — the previous
  // detached spawn returned {killed:true} regardless of outcome.
  try {
    execFileSync('taskkill', ['/PID', String(s.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (err) {
    // taskkill exits non-zero if the pid is already gone (128) or access
    // denied. Treat "already gone" as success — we wanted it dead, it's dead.
    if (!isAlive(s.pid)) {
      writeState({ pid: undefined, port: undefined, mode: undefined, lastStoppedAt: new Date().toISOString() });
      return { killed: true, mode: 'spawn', pid: s.pid };
    }
    return { killed: false, mode: 'spawn', pid: s.pid };
  }
  writeState({ pid: undefined, port: undefined, mode: undefined, lastStoppedAt: new Date().toISOString() });
  return { killed: true, mode: 'spawn', pid: s.pid };
}

export const PORTS = { default: DEFAULT_PORT, sidecar: SIDECAR_PORT };
