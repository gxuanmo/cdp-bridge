import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../logger.mjs';

const FLAGS = [
  '--remote-debugging-port=9222',
  '--remote-debugging-address=127.0.0.1',
  '--remote-allow-origins=http://127.0.0.1:9222',
];

/**
 * Common Windows locations where users keep Chrome shortcuts. We scan these,
 * check each .lnk's TargetPath points at a chrome.exe, and modify the
 * Arguments. Per-user paths are checked first (no admin needed); machine-wide
 * paths last (writes there require admin so we surface them as warnings).
 */
function shortcutCandidates() {
  const env = process.env;
  const paths = [
    join(env.USERPROFILE ?? '', 'Desktop', 'Google Chrome.lnk'),
    join(env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Google Chrome.lnk'),
    // Taskbar pinned:
    join(env.APPDATA ?? '', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Google Chrome.lnk'),
    // Machine-wide (read-only without admin):
    join(env.PUBLIC ?? '', 'Desktop', 'Google Chrome.lnk'),
    join(env.PROGRAMDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Google Chrome.lnk'),
  ];
  return paths.filter(Boolean).filter((p) => existsSync(p));
}

/**
 * cdpb setup-shortcut [--dry-run] [--revert]
 *
 * Adds (or removes, with --revert) these flags to each found Chrome
 * shortcut's Arguments:
 *   --remote-debugging-port=9222
 *   --remote-debugging-address=127.0.0.1
 *   --remote-allow-origins=http://127.0.0.1:9222
 *
 * After modifying, the user must close every Chrome window (so the running
 * Chrome process exits — Chrome doesn't re-read flags on tab open) and
 * re-launch from one of the modified shortcuts. Subsequent `cdpb launch`
 * will then attach to that Chrome.
 *
 * Limitations:
 *  - File double-click (default-browser handler) bypasses .lnk and reads
 *    the registry's `ChromeHTML\shell\open\command`. We don't touch that
 *    by default — invoke `--include-registry` to opt in (writes to
 *    HKCU\Software\Classes\ChromeHTML; user-scoped, no admin).
 *  - Machine-wide shortcuts (in PUBLIC / PROGRAMDATA) need admin to write;
 *    we report them as "needs admin" rather than fail.
 */
export async function run(argv) {
  const dryRun = argv.includes('--dry-run');
  const revert = argv.includes('--revert');
  const includeRegistry = argv.includes('--include-registry');

  const targets = shortcutCandidates();
  if (targets.length === 0) {
    throw new Error('no Chrome shortcuts found in standard locations. Modify your shortcut manually with the flags: ' + FLAGS.join(' '));
  }

  log.info((dryRun ? 'DRY RUN — ' : '') + (revert ? 'reverting' : 'patching') + ' ' + targets.length + ' shortcut(s)');
  for (const lnk of targets) {
    try {
      const before = readShortcut(lnk);
      const after = revert ? removeFlags(before.args) : addFlags(before.args);
      if (before.args === after) {
        log.info('  unchanged: ' + lnk + (revert ? ' (no flags to remove)' : ' (already patched)'));
        continue;
      }
      log.info('  ' + lnk);
      log.info('    target: ' + before.target);
      log.info('    before: ' + (before.args || '(empty)'));
      log.info('    after:  ' + (after || '(empty)'));
      if (!dryRun) writeShortcut(lnk, before.target, after);
    } catch (err) {
      log.warn('  failed: ' + lnk + ' — ' + err.message);
    }
  }

  if (includeRegistry) {
    log.info(revert ? 'reverting registry ChromeHTML handler' : 'patching registry ChromeHTML handler (HKCU)');
    try {
      patchChromeHtmlRegistry({ revert, dryRun });
    } catch (err) {
      log.warn('registry patch failed: ' + err.message);
    }
  }

  if (!dryRun && !revert) {
    log.info('');
    log.info('next: close ALL Chrome windows (so Chrome process exits), then re-launch from your modified shortcut');
    log.info('then: cdpb launch    # should attach instead of asking for setup');
  }
}

function readShortcut(lnk) {
  // Use PowerShell COM via single-quoted here-string. Output: 2 lines, target then args.
  const script =
    '$ws = New-Object -ComObject WScript.Shell; ' +
    '$s = $ws.CreateShortcut(\'' + lnk.replace(/'/g, "''") + '\'); ' +
    "Write-Output $s.TargetPath; Write-Output ('A:' + $s.Arguments)";
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const lines = out.split(/\r?\n/);
  const target = (lines[0] ?? '').trim();
  const argLine = lines.find((l) => l.startsWith('A:')) ?? 'A:';
  return { target, args: argLine.slice(2).trim() };
}

function writeShortcut(lnk, target, args) {
  const script =
    '$ws = New-Object -ComObject WScript.Shell; ' +
    '$s = $ws.CreateShortcut(\'' + lnk.replace(/'/g, "''") + '\'); ' +
    '$s.TargetPath = \'' + target.replace(/'/g, "''") + '\'; ' +
    '$s.Arguments = \'' + args.replace(/'/g, "''") + '\'; ' +
    '$s.Save()';
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
  });
}

function addFlags(existing) {
  const tokens = splitArgs(existing);
  const without = tokens.filter((t) => !FLAGS.some((f) => t.startsWith(stripValue(f) + '=') || t === stripValue(f)));
  return [...without, ...FLAGS].join(' ').trim();
}

function removeFlags(existing) {
  const tokens = splitArgs(existing);
  return tokens
    .filter((t) => !FLAGS.some((f) => t.startsWith(stripValue(f) + '=') || t === stripValue(f)))
    .join(' ')
    .trim();
}

/** Strip the value portion of `--flag=value` so we can match the flag name alone. */
function stripValue(flag) {
  const i = flag.indexOf('=');
  return i < 0 ? flag : flag.slice(0, i);
}

/** Naive arg split — Chrome flags don't contain spaces in their values. */
function splitArgs(s) {
  return s.split(/\s+/).filter(Boolean);
}

/**
 * Patch HKCU\Software\Classes\ChromeHTML\shell\open\command\(default) so that
 * file double-click (and any registered URL handler) launches Chrome with
 * our flags. User-scope HKCU writes don't need admin.
 *
 * Original value example:
 *   "C:\Program Files\Google\Chrome\Application\chrome.exe" --single-argument %1
 * After:
 *   "C:\...\chrome.exe" --remote-debugging-port=9222 ... --single-argument %1
 */
function patchChromeHtmlRegistry({ revert, dryRun }) {
  const key = 'HKCU\\Software\\Classes\\ChromeHTML\\shell\\open\\command';
  let current = '';
  try {
    const out = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true });
    const m = /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out);
    if (m) current = m[1].trim();
  } catch {
    log.info('  no existing HKCU ChromeHTML handler — skipping (system-wide handler in HKLM is left alone)');
    return;
  }

  const target = revert ? removeFlagsInRegistryValue(current) : addFlagsInRegistryValue(current);
  if (target === current) {
    log.info('  registry value unchanged');
    return;
  }
  log.info('  before: ' + current);
  log.info('  after:  ' + target);
  if (dryRun) return;
  execFileSync('reg', ['add', key, '/ve', '/d', target, '/f'], { windowsHide: true });
}

function addFlagsInRegistryValue(value) {
  // Layout: "<path-to-chrome.exe>" <existing-args>
  const m = /^("[^"]+")\s*(.*)$/.exec(value);
  if (!m) return value;
  const exe = m[1];
  const rest = m[2] ?? '';
  const without = splitArgs(rest).filter((t) => !FLAGS.some((f) => t.startsWith(stripValue(f) + '=') || t === stripValue(f)));
  return [exe, ...FLAGS, ...without].join(' ');
}

function removeFlagsInRegistryValue(value) {
  const m = /^("[^"]+")\s*(.*)$/.exec(value);
  if (!m) return value;
  const exe = m[1];
  const rest = m[2] ?? '';
  const cleaned = splitArgs(rest)
    .filter((t) => !FLAGS.some((f) => t.startsWith(stripValue(f) + '=') || t === stripValue(f)))
    .join(' ');
  return cleaned ? exe + ' ' + cleaned : exe;
}
