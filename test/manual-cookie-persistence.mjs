// Manual integration test (not run by `npm test` — has side effects on
// sidecar Chrome). Verifies that cookies set via CDP in one cdpb session
// persist across `cdpb stop` + `cdpb launch --spawn`. This is the same
// in-Chrome persistence path attach mode relies on for user logins.
//
// Run with: node test/manual-cookie-persistence.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { connectBrowser } from '../src/cdp-client.mjs';

const TEST_DOMAIN = 'cdpb-test.local';
const TEST_NAME = 'persist_probe';
const TEST_VALUE = 'cdpb-' + Date.now();
const STATE = homedir() + '/.cdp-bridge/state.json';

function cdpb(...args) {
  // cdpb logs progress via stderr ([cdpb] prefix) and only the command's
  // structured result (e.g., file path) goes to stdout. We need both, so
  // spawnSync (not execFileSync — which returns only stdout).
  //
  // shell:true with a single-string cmdline avoids the Windows EINVAL we
  // hit on Node 22 when spawning .cmd shims directly (CVE-2024-27980) AND
  // the DEP0190 warning that comes with shell:true + args array.
  const cmdline = ['cdpb.cmd', ...args.map((a) => '"' + a.replace(/"/g, '\\"') + '"')].join(' ');
  const r = spawnSync(cmdline, { encoding: 'utf8', shell: true, windowsHide: true });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

function getPort() {
  return JSON.parse(readFileSync(STATE, 'utf8')).port;
}

async function getCookieValue(port, name) {
  const browser = await connectBrowser(port);
  try {
    /** @type {{ cookies: Array<{name:string,value:string,domain:string}> }} */
    const r = await browser.send('Storage.getCookies', {});
    const hit = r.cookies.find((c) => c.name === name);
    return hit?.value ?? null;
  } finally {
    browser.close();
  }
}

async function setCookie(port, domain, name, value) {
  const browser = await connectBrowser(port);
  try {
    await browser.send('Storage.setCookies', {
      cookies: [
        {
          name,
          value,
          domain,
          path: '/',
          // Far future so it survives the brief stop/launch cycle.
          expires: Math.floor(Date.now() / 1000) + 86400,
          httpOnly: false,
          secure: false,
        },
      ],
    });
  } finally {
    browser.close();
  }
}

async function clearTestCookie(port) {
  const browser = await connectBrowser(port);
  try {
    await browser.send('Storage.clearCookies', {});
  } finally {
    browser.close();
  }
}

async function main() {
  console.log('=== cookie persistence test ===');

  // Make sure we start spawn-mode. If a session is active, stop first
  // because we want a clean spawn.
  cdpb('stop');
  await delay(500);

  console.log('[1/6] launching spawn sidecar...');
  const out1 = cdpb('launch', '--spawn', '--headless');
  if (!out1.match(/spawned chrome\.exe|spawn session already active|ready/)) {
    console.error('launch failed:\n' + out1);
    process.exit(1);
  }
  const port = getPort();
  console.log('       port=' + port);

  console.log('[2/6] setting test cookie ' + TEST_NAME + '=' + TEST_VALUE + ' for ' + TEST_DOMAIN);
  await setCookie(port, TEST_DOMAIN, TEST_NAME, TEST_VALUE);
  const v1 = await getCookieValue(port, TEST_NAME);
  if (v1 !== TEST_VALUE) {
    console.error('       set failed: got ' + JSON.stringify(v1));
    process.exit(1);
  }
  console.log('       OK cookie readable in session 1 (value=' + v1 + ')');

  console.log('[2b] flushing cookie store to disk (Network.clearAcceptedEncodingsOverride is a no-op nudge — real flush happens on graceful Chrome shutdown)');
  // Give Chrome 2s to commit the cookie row to SQLite. Storage.setCookies
  // is committed via the network service's cookie monitor which has a
  // small write-back delay. Without this wait, killing Chrome too fast
  // loses the cookie (we observed this in dev).
  await delay(2000);

  console.log('[3/6] cdpb stop (kills sidecar pid)');
  console.log(cdpb('stop').trim());
  await delay(2000);

  console.log('[4/6] cdpb launch --spawn (fresh chrome.exe process, same profile dir)');
  const out2 = cdpb('launch', '--spawn', '--headless');
  if (!out2.match(/spawned chrome\.exe|ready/)) {
    console.error('relaunch failed:\n' + out2);
    process.exit(1);
  }
  const port2 = getPort();
  console.log('       port=' + port2);
  await delay(500);

  console.log('[5/6] reading test cookie in session 2...');
  const v2 = await getCookieValue(port2, TEST_NAME);
  if (v2 !== TEST_VALUE) {
    console.error('       FAIL: expected ' + TEST_VALUE + ' got ' + JSON.stringify(v2));
    await clearTestCookie(port2);
    cdpb('stop');
    process.exit(1);
  }
  console.log('       OK cookie SURVIVED stop+launch (value=' + v2 + ')');

  console.log('[6/6] cleanup');
  await clearTestCookie(port2);
  cdpb('stop');
  console.log('=== PASS — cookies persist across cdpb stop+launch in spawn mode ===');
}

main().catch((err) => {
  console.error('test errored: ' + (err.stack ?? err.message));
  cdpb('stop');
  process.exit(2);
});
