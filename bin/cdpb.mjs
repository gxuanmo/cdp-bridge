#!/usr/bin/env node
import { log } from '../src/logger.mjs';

const COMMANDS = {
  launch: () => import('../src/commands/launch.mjs'),
  status: () => import('../src/commands/status.mjs'),
  stop: () => import('../src/commands/stop.mjs'),
  fetch: () => import('../src/commands/fetch.mjs'),
  'install-skill': () => import('../src/commands/install-skill.mjs'),
  'sync-profile': () => import('../src/commands/sync-profile.mjs'),
};

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
  await mod.run(rest);
}

function printHelp() {
  log.raw([
    'cdpb — drive a sidecar Chrome via CDP, reusing your real profile',
    '',
    'Usage: cdpb <command> [args]',
    '',
    'Commands:',
    '  launch [--port N] [--headless] [--proxy <a>|none] [--resync]   start sidecar Chrome',
    '  status                                                          show running state',
    '  stop                                                            kill sidecar Chrome',
    '  sync-profile [--full]                                           refresh from main Chrome (sidecar must be stopped)',
    '  fetch <url> [-o <path>] [--timeout <ms>]                        download via Chrome',
    '  install-skill <owner/repo> [--branch <b>] [-g]                  install a GitHub skill',
    '',
    'Sidecar profile lives at ~/.cdp-bridge/. CDP port 9222 by default.',
    'First launch syncs everything from your main Chrome; later launches reuse',
    'the sidecar profile so logins you do in sidecar persist. Run sync-profile',
    'to refresh bookmarks/extensions; cookies are preserved unless you use --full.',
  ].join('\n'));
}

main().catch((err) => {
  // Stack is noisy for expected errors (e.g., "sidecar already running");
  // dump it only when the user opts in via DEBUG=1.
  if (process.env.DEBUG) log.error(err.stack || String(err));
  else log.error(err.message ?? String(err));
  process.exit(1);
});
