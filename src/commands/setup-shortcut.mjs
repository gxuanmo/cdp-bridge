import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { userChromeDataDir } from '../paths.mjs';
import { log } from '../logger.mjs';

/**
 * The flags we currently inject. Order matters only cosmetically.
 *
 * `--user-data-dir` is REQUIRED by Chrome 136+: when you ask for
 * `--remote-debugging-port` without explicitly opting your profile in
 * via `--user-data-dir`, Chrome silently refuses to bind the DevTools
 * port (anti-cookie-theft hardening). Setting `--user-data-dir` to the
 * default Chrome User Data path keeps the user on their normal profile
 * AND satisfies Chrome's "you know what you're doing" check.
 *
 * We do NOT add `--remote-allow-origins` — the local CDP clients used
 * here (Node WebSocket) work with Chrome's default origin rules.
 */
function buildFlags() {
  // Default Chrome User Data dir contains a space ("User Data") so the
  // value MUST be quoted in the .lnk Arguments string. Without quotes
  // CreateProcess splits on the space and Chrome receives a truncated
  // path → falls back to default profile, which then trips the very
  // anti-DevTools rule we're trying to satisfy.
  const udd = userChromeDataDir();
  const uddFlag = /\s/.test(udd) ? '--user-data-dir="' + udd + '"' : '--user-data-dir=' + udd;
  return [
    uddFlag,
    '--remote-debugging-port=9222',
    '--remote-debugging-address=127.0.0.1',
  ];
}

/**
 * Flag names we manage. Used as the match key for both add (de-dup before
 * append) and revert (filter out). Includes legacy names so a shortcut
 * patched by an older cdpb gets cleanly overwritten on re-run.
 */
const MANAGED_FLAG_NAMES = [
  '--user-data-dir',
  '--remote-debugging-port',
  '--remote-debugging-address',
  '--remote-allow-origins', // legacy: removed in v0.2 but still strip on revert
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
 * cdpb setup-shortcut [--dry-run] [--revert] [--include-registry] [--force]
 *
 * Adds (or removes, with --revert) the flags returned by `buildFlags()` to
 * each found Chrome shortcut's Arguments. Currently:
 *   --user-data-dir="<default Chrome User Data path>"
 *   --remote-debugging-port=9222
 *   --remote-debugging-address=127.0.0.1
 * On revert, the legacy `--remote-allow-origins=...` (added by older cdpb
 * versions) is also stripped — see MANAGED_FLAG_NAMES.
 *
 * After modifying, the user must close every Chrome window (so the running
 * Chrome process exits — Chrome's single-instance pickup means a new
 * launch with the same user-data-dir merges into the running process and
 * drops the new flags). The command refuses to patch when chrome.exe
 * browser processes are detected, unless --force is given.
 *
 * Limitations:
 *  - File double-click (default-browser handler) bypasses .lnk and reads
 *    the registry's `ChromeHTML\shell\open\command`. We don't touch that
 *    by default — invoke `--include-registry` to opt in (writes to
 *    HKCU\Software\Classes\ChromeHTML; user-scoped, no admin).
 *  - Machine-wide shortcuts (in PUBLIC / PROGRAMDATA) need admin to write;
 *    failures land in the per-shortcut catch and are logged as "failed:".
 */
export async function run(argv) {
  const dryRun = argv.includes('--dry-run');
  const revert = argv.includes('--revert');
  const includeRegistry = argv.includes('--include-registry');
  const force = argv.includes('--force');

  const flags = buildFlags();
  const targets = shortcutCandidates();
  if (targets.length === 0) {
    throw new Error('no Chrome shortcuts found in standard locations. Modify your shortcut manually with the flags: ' + flags.join(' '));
  }

  // Chrome is single-instance per user-data-dir. If the user is running
  // chrome.exe right now and re-launches from a freshly patched .lnk, the
  // new chrome.exe just sends "open new window" IPC to the existing
  // process and exits — our flags are dropped on the floor and
  // `cdpb launch` will keep failing with "no Chrome with CDP". Detect this
  // up front, since a one-line warning here saves a confusing 10-minute
  // debug session.
  if (!dryRun && !revert && !force) {
    const running = chromeBrowserPidsRunning();
    if (running.length > 0) {
      throw new Error(
        running.length + ' chrome.exe browser process(es) are running (pids: ' + running.join(', ') + '). ' +
          'Patching the shortcut now is fine, but the patched flags only take effect when Chrome ' +
          'starts FRESH from the modified shortcut. Close ALL Chrome windows first, then re-run ' +
          '`cdpb setup-shortcut`. Or pass `--force` to patch anyway and remember to fully exit Chrome before re-launching.',
      );
    }
  }

  log.info((dryRun ? 'DRY RUN — ' : '') + (revert ? 'reverting' : 'patching') + ' ' + targets.length + ' shortcut(s)');
  for (const lnk of targets) {
    try {
      const before = readShortcut(lnk);
      const after = revert ? removeFlags(before.args) : addFlags(before.args, flags);
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

/** True if `token` is one of our managed flags (any value). */
function isManagedToken(token) {
  return MANAGED_FLAG_NAMES.some((name) => token === name || token.startsWith(name + '='));
}

function addFlags(existing, newFlags) {
  const tokens = splitArgs(existing).filter((t) => !isManagedToken(t));
  return [...tokens, ...newFlags].join(' ').trim();
}

function removeFlags(existing) {
  return splitArgs(existing).filter((t) => !isManagedToken(t)).join(' ').trim();
}

/**
 * Quote-aware tokenizer for Windows command-line argument strings.
 * Treats a contiguous run of (non-whitespace-non-quote chunks OR
 * "quoted-string" chunks) as a single token, matching how
 * CreateProcess parses cmdlines.
 *
 * Example: `--user-data-dir="C:\My Path" --port=9222`
 *   → ['--user-data-dir="C:\My Path"', '--port=9222']
 */
function splitArgs(s) {
  return s.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

/**
 * Return pids of chrome.exe BROWSER processes (not renderer/gpu/utility
 * children). Uses PowerShell Get-CimInstance because cmdline filtering is
 * the only way to distinguish browser from child processes; ~500ms but
 * acceptable for a one-shot setup command.
 *
 * Includes any Chromium-derived chrome.exe — e.g. Playwright MCP's
 * sandbox, our own --spawn sidecar — which is correct: the user is about
 * to modify a shortcut and we want to warn before *any* such instance
 * could grab the next launch's flags.
 *
 * @returns {number[]}
 */
function chromeBrowserPidsRunning() {
  try {
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
      "Where-Object { $_.CommandLine -notmatch '--type=' } | " +
      "Select-Object -ExpandProperty ProcessId";
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return out
      .split(/\r?\n/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    // If the probe itself fails (no PowerShell, permissions, etc.), don't
    // block setup-shortcut — the worst case is the existing "next: close
    // Chrome" advisory remains the only signal.
    return [];
  }
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

  const flags = buildFlags();
  const target = revert ? removeFlagsInRegistryValue(current) : addFlagsInRegistryValue(current, flags);
  if (target === current) {
    log.info('  registry value unchanged');
    return;
  }
  log.info('  before: ' + current);
  log.info('  after:  ' + target);
  if (dryRun) return;
  execFileSync('reg', ['add', key, '/ve', '/d', target, '/f'], { windowsHide: true });
}

function addFlagsInRegistryValue(value, newFlags) {
  // Layout: "<path-to-chrome.exe>" <existing-args>
  const m = /^("[^"]+")\s*(.*)$/.exec(value);
  if (!m) return value;
  const exe = m[1];
  const rest = m[2] ?? '';
  const without = splitArgs(rest).filter((t) => !isManagedToken(t));
  // Keep `%1` style placeholders at the end so Chrome still receives the URL.
  return [exe, ...newFlags, ...without].join(' ');
}

function removeFlagsInRegistryValue(value) {
  const m = /^("[^"]+")\s*(.*)$/.exec(value);
  if (!m) return value;
  const exe = m[1];
  const rest = m[2] ?? '';
  const cleaned = splitArgs(rest).filter((t) => !isManagedToken(t)).join(' ');
  return cleaned ? exe + ' ' + cleaned : exe;
}
