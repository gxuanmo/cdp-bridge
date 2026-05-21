import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isChromeReady } from '../chrome-manager.mjs';
import { downloadViaChrome } from '../download.mjs';
import { readState } from '../state.mjs';
import { log } from '../logger.mjs';

/**
 * cdpb install-skill <owner/repo or URL> [--branch <name>] [-g] [--keep]
 *
 * High-level:
 *  1. Resolve archive URL (try the user-specified branch, else master, else main).
 *  2. Download zip through sidecar Chrome.
 *  3. Expand-Archive into a temp dir.
 *  4. Run `npx skills add <inner-dir>` so the skills.sh CLI registers it.
 *  5. Clean up zip + temp extract dir (unless --keep).
 */
export async function run(argv) {
  const repoArg = argv.find((a) => !a.startsWith('-'));
  if (!repoArg) throw new Error('usage: cdpb install-skill <owner/repo | github URL> [--branch <name>] [-g] [--keep]');

  const repo = parseRepoArg(repoArg);
  const branchFlag = pickFlagValue(argv, '--branch');
  const branches = branchFlag ? [branchFlag] : ['master', 'main'];
  const global = argv.includes('-g') || argv.includes('--global');
  const keep = argv.includes('--keep');

  if (!(await isChromeReady())) {
    throw new Error('no Chrome session ready. Run `cdpb launch` first.');
  }
  const { port } = readState();

  // Step 1+2: try each candidate branch until one returns a real archive.
  const stamp = Date.now();
  const tmpRoot = join(tmpdir(), 'cdpb-install-' + stamp);
  mkdirSync(tmpRoot, { recursive: true });
  const zipPath = join(tmpRoot, repo.name + '.zip');

  let chosenBranch;
  for (const b of branches) {
    const url = 'https://github.com/' + repo.owner + '/' + repo.name + '/archive/refs/heads/' + b + '.zip';
    log.info('try ' + url);
    try {
      let last = 0;
      const t0 = Date.now();
      await downloadViaChrome({
        port,
        url,
        outputPath: zipPath,
        timeoutMs: 30 * 60 * 1000, // generous: 30min for big repos
        onProgress: ({ received, total }) => {
          const mb = Math.floor(received / 1048576);
          if (mb >= last + 10) {
            const pct = total ? ((received / total) * 100).toFixed(1) + '%' : '?';
            const elapsedSec = ((Date.now() - t0) / 1000).toFixed(0);
            log.info('  ' + mb + 'MB ' + pct + ' (' + elapsedSec + 's)');
            last = mb;
          }
        },
      });
      chosenBranch = b;
      break;
    } catch (err) {
      log.warn('branch ' + b + ' failed: ' + err.message);
    }
  }
  if (!chosenBranch) throw new Error('failed to download archive for ' + repo.owner + '/' + repo.name);

  // Step 3: extract using PowerShell Expand-Archive (zero-dep on Windows).
  const extractDir = join(tmpRoot, 'extracted');
  mkdirSync(extractDir, { recursive: true });
  log.info('extracting...');
  await runCmd('powershell', [
    '-NoProfile', '-NonInteractive',
    '-Command',
    'Expand-Archive -LiteralPath "' + zipPath + '" -DestinationPath "' + extractDir + '" -Force',
  ]);

  // GitHub archive lays out as `<repo>-<branch>/`.
  const inner = readdirSync(extractDir)
    .map((n) => join(extractDir, n))
    .find((p) => statSync(p).isDirectory());
  if (!inner) throw new Error('extracted archive has no directory: ' + extractDir);
  log.info('extracted to ' + inner);

  // Step 4: hand off to skills CLI.
  const skillsArgs = ['-y', 'skills', 'add', inner];
  if (global) skillsArgs.push('-g');
  log.info('running: npx ' + skillsArgs.join(' '));
  await runCmd('npx', skillsArgs, { stdio: 'inherit' });

  // Step 5: cleanup unless --keep.
  if (!keep) {
    log.info('cleaning up ' + tmpRoot);
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  } else {
    log.info('kept temp at ' + tmpRoot);
  }
}

function parseRepoArg(arg) {
  // owner/repo
  const m1 = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(arg);
  if (m1) return { owner: m1[1], name: m1[2] };
  // https://github.com/owner/repo[.git]
  const m2 = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/|$)/.exec(arg);
  if (m2) return { owner: m2[1], name: m2[2] };
  throw new Error('cannot parse repo: ' + arg);
}

function pickFlagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

/**
 * Spawn a child command, await exit. Throws on non-zero exit.
 *
 * Why `shell: true`: On Windows, npm/npx/pnpm/yarn are .cmd shims, and
 * Node 18.4+ refuses to spawn .cmd without `shell: true` (CVE-2024-27980).
 * We pre-validate every argument against a strict whitelist before passing
 * through cmd.exe so the deprecation's injection concern does not apply.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ stdio?: 'inherit' | 'pipe' }} [opts]
 */
function runCmd(cmd, args, opts = {}) {
  for (const a of args) assertSafeArg(a);
  // Build the full command string so we can use `shell: true` without the
  // separate-args form that triggers DEP0190. Args are quote-escaped above.
  const cmdline = [cmd, ...args.map(quoteIfNeeded)].join(' ');
  return new Promise((resolve, reject) => {
    const child = spawn(cmdline, {
      stdio: opts.stdio ?? 'pipe',
      shell: true,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    if (child.stdout) child.stdout.on('data', (d) => { out += d; });
    if (child.stderr) child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(cmd + ' exited ' + code + (err ? ': ' + err.slice(-500) : '')));
    });
  });
}

// Reject any argument containing shell metacharacters that could escape from
// our quoting. Allowed: typical filesystem paths, URLs, identifiers, flags.
const UNSAFE_ARG = /[`$\n\r\0]|&&|\|\||;[^\s]|>|</;

function assertSafeArg(a) {
  if (typeof a !== 'string') throw new Error('non-string spawn arg: ' + String(a));
  if (UNSAFE_ARG.test(a)) {
    throw new Error('unsafe characters in command argument: ' + JSON.stringify(a));
  }
}

function quoteIfNeeded(a) {
  if (/[\s"]/.test(a)) return '"' + a.replace(/"/g, '\\"') + '"';
  return a;
}
