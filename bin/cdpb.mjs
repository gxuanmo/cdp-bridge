#!/usr/bin/env node
import { log } from '../src/logger.mjs';
import { withLock } from '../src/lock.mjs';

const COMMANDS = {
  launch: () => import('../src/commands/launch.mjs'),
  status: () => import('../src/commands/status.mjs'),
  stop: () => import('../src/commands/stop.mjs'),
  fetch: () => import('../src/commands/fetch.mjs'),
  'install-skill': () => import('../src/commands/install-skill.mjs'),
  'sync-profile': () => import('../src/commands/sync-profile.mjs'),
  'setup-shortcut': () => import('../src/commands/setup-shortcut.mjs'),
  screenshot: () => import('../src/commands/screenshot.mjs'),
  exec: () => import('../src/commands/exec.mjs'),
  tab: () => import('../src/commands/tab.mjs'),
};

// Commands that mutate state.json or shared Chrome state. Wrapped in
// withLock() so concurrent cdpb invocations don't stomp on each other
// (most notably Browser.setDownloadBehavior, which is browser-context-wide
// — two simultaneous fetches would overwrite each other's download path).
// `status` is read-only and excluded.
const STATEFUL = new Set(['launch', 'stop', 'fetch', 'install-skill', 'sync-profile', 'setup-shortcut', 'screenshot', 'exec', 'tab']);

async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp();
    return;
  }

  const loader = COMMANDS[cmd];
  if (!loader) {
    log.error('unknown command: ' + cmd);
    printHelp();
    process.exit(1);
  }

  const mod = await loader();
  if (STATEFUL.has(cmd)) {
    await withLock(() => mod.run(rest));
  } else {
    await mod.run(rest);
  }
}

function printHelp() {
  log.raw([
    'cdpb — drive a sidecar Chrome via CDP, reusing your real profile',
    '',
    'Usage: cdpb <command> [args]',
    '',
    'Commands:',
    '  launch [--attach | --spawn] [--port N] [--proxy <a>|none] [--resync] [--headless]',
    '                                                                  start a Chrome session',
    '  status                                                          show running state',
    '  stop                                                            end session (kill sidecar / clear attach)',
    '  setup-shortcut [--dry-run] [--revert] [--include-registry] [--force]',
    '                                                                  add CDP flags to your Chrome shortcut(s)',
    '  sync-profile [--full]                                           (spawn mode) refresh from main Chrome',
    '  fetch <url> [-o <path>] [--timeout <ms>]                        download via Chrome',
    '  install-skill <owner/repo> [--branch <b>] [-g]                  install a GitHub skill',
    '  screenshot <url> [-o <path>] [--full-page]                       capture a PNG screenshot of a page',
    '  exec <url> <js>                                                  execute JS in a page, print returned value',
    '  tab list|new|close                                               manage browser tabs',
    '',
    'Two modes:',
    '  attach (default)  drive your daily Chrome via CDP — full cookies/login state.',
    '                    Requires Chrome to be started with --remote-debugging-port=9222.',
    '                    Use `cdpb setup-shortcut` to add it to your shortcut once.',
    '  spawn             spawn an isolated sidecar Chrome on port 9223 (~/.cdp-bridge/',
    '                    chrome-profile copied from your daily Chrome). No login state',
    '                    transfers due to Chrome 127+ App-Bound Encryption.',
  ].join('\n'));
}

main().catch((err) => {
  // Stack is noisy for expected errors (e.g., "sidecar already running");
  // dump it only when the user opts in via DEBUG=1.
  if (process.env.DEBUG) log.error(err.stack || String(err));
  else log.error(err.message ?? String(err));
  process.exit(1);
});
