import { spawn } from 'node:child_process';
import { existsSync, openSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { paths, findChromeExe } from './paths.mjs';
import { readState, writeState } from './state.mjs';
import { getWindowsSystemProxy } from './system-proxy.mjs';
import { log } from './logger.mjs';

const DEFAULT_PORT = 9222;

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
 * Whether the recorded sidecar Chrome is alive AND its CDP port answers.
 * @returns {Promise<boolean>}
 */
export async function isSidecarRunning() {
  const s = readState();
  if (!s.pid || !s.port) return false;
  if (!isAlive(s.pid)) return false;
  const v = await probeCdp(s.port);
  return v != null;
}

/**
 * Launch sidecar Chrome with CDP port. Detaches from the parent process so the
 * CLI can exit while Chrome stays running. Stderr is redirected to a log file.
 *
 * Resolves the proxy in this order: explicit `opts.proxy` > Windows system
 * proxy > none. The chosen value is logged and persisted so later commands
 * can show it via `cdpb status`.
 *
 * @param {{ port?: number, headless?: boolean, proxy?: string | 'none' }} [opts]
 * @returns {Promise<{ pid: number, port: number, version: object, proxy: string | null }>}
 */
export async function launchSidecar(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(paths.chromeProfile, { recursive: true });

  if (await isSidecarRunning()) {
    const s = readState();
    const v = await probeCdp(s.port);
    return { pid: s.pid, port: s.port, version: v, proxy: s.proxy ?? null };
  }

  let proxy;
  if (opts.proxy === 'none') {
    proxy = null;
  } else if (opts.proxy) {
    proxy = opts.proxy;
  } else {
    proxy = getWindowsSystemProxy();
  }

  const chrome = findChromeExe();
  const args = [
    '--user-data-dir=' + paths.chromeProfile,
    '--remote-debugging-port=' + port,
    '--remote-debugging-address=127.0.0.1',
    // Lock to a single instance so a stray double-launch doesn't fork Chrome.
    '--no-first-run',
    '--no-default-browser-check',
    // Suppress crash recovery prompt from prior dirty exits — sidecar profile
    // is disposable and the prompt blocks automation.
    '--disable-features=ChromeWhatsNewUI',
    // Pass proxy explicitly. Chrome would normally auto-pick up the Windows
    // system proxy, but we observed flaky behavior with LAN proxies — being
    // explicit removes that variable.
    ...(proxy ? ['--proxy-server=' + proxy] : []),
    // Headless mode optional; default off so user sees the warning bar.
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
  log.info('launched chrome.exe pid=' + child.pid + ' port=' + port + (proxy ? ' proxy=' + proxy : ' proxy=none'));

  const version = await waitForCdp(port, 30000);
  writeState({ pid: child.pid, port, proxy: proxy ?? undefined, profileSyncedAt: new Date().toISOString() });
  return { pid: child.pid, port, version, proxy };
}

/**
 * Kill sidecar Chrome and its child processes.
 * @returns {{ killed: boolean, pid?: number }}
 */
export function stopSidecar() {
  const s = readState();
  if (!s.pid) return { killed: false };
  try {
    // Windows: use taskkill /T /F to kill the whole tree.
    // process.kill on Windows doesn't reliably kill child processes.
    spawn('taskkill', ['/PID', String(s.pid), '/T', '/F'], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    }).unref();
    writeState({ pid: undefined, lastStoppedAt: new Date().toISOString() });
    return { killed: true, pid: s.pid };
  } catch (err) {
    return { killed: false, pid: s.pid };
  }
}
