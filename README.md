# cdp-bridge

A small CLI (`cdpb`) that drives Chrome via the **Chrome DevTools Protocol** so agents and scripts can download files, navigate, and interact through a real browser — keeping your network setup (system proxy, VPN, ISP route), your login state, and your extensions.

Two modes:

- **attach** (default) — connect to your daily Chrome over CDP. No profile copy, no cookie loss, you get **full login state and the warm cache** of the browser you actually use. Requires Chrome to be launched with `--remote-debugging-port=9222`; `cdpb setup-shortcut` adds that to your shortcut once.
- **spawn** — launch an isolated sidecar Chrome on port `9223` with a selectively-copied profile in `~/.cdp-bridge/chrome-profile/`. Useful if you don't want any automation reaching into your daily Chrome. **Logins won't transfer** (Chrome 127+ App-Bound Encryption — see below); you'll log in once per site in the sidecar.

Node 22+ and zero npm dependencies. Windows-first; macOS/Linux not supported in v0.x.

---

## Install

```powershell
git clone <this-repo> D:\Desktop\project\cdp-bridge
cd D:\Desktop\project\cdp-bridge
npm link
```

Puts `cdpb` on PATH. There are no dependencies to install — the project uses Node's built-in WebSocket / fs / child_process / test runner.

---

## First-time setup (attach mode)

Required because Chrome 136+ refuses to bind `--remote-debugging-port` unless you also pass `--user-data-dir`. `cdpb setup-shortcut` adds both:

```powershell
cdpb setup-shortcut          # patches your taskbar / Start Menu / Public Desktop Chrome shortcuts
# - Then COMPLETELY close every Chrome window. Chrome is single-instance;
#   if any chrome.exe is still alive, the next launch merges into it and
#   the new flags are silently dropped.
# - Re-open Chrome from the modified shortcut (the taskbar icon you just
#   patched). Yellow "automated test software" banner = CDP is on.
cdpb launch                  # probes 127.0.0.1:9222, attaches
cdpb status                  # ready mode=attach port=9222 product=Chrome/147
```

Roll back with `cdpb setup-shortcut --revert`. The legacy `--remote-allow-origins` flag from earlier cdpb versions is also stripped on revert.

If your usual Chrome entry isn't a `.lnk` (e.g., the OS file-association handler when you double-click an `.html`), add `--include-registry` to also patch `HKCU\Software\Classes\ChromeHTML\shell\open\command` (user-scope, no admin needed).

---

## Commands

| Command | What it does |
|---|---|
| `cdpb launch [--attach \| --spawn] [--port N] [--proxy <addr>\|none] [--resync] [--headless]` | Start a Chrome session. Default tries attach to 9222; if no Chrome is there, prints actionable advice and exits non-zero (no silent fallback). `--spawn` forces sidecar mode. |
| `cdpb status` | `ready mode=… port=… …` / `dead` / `attach-stale` / `stopped at=…` / `never-launched` |
| `cdpb stop` | End session. Spawn mode: graceful CDP `Browser.close` first (flushes cookies/IndexedDB to SQLite), polls 5s for natural exit, falls back to `taskkill /T /F`. Attach mode: only clears the state record; **never kills your daily Chrome**. |
| `cdpb setup-shortcut [--dry-run] [--revert] [--force] [--include-registry]` | Add CDP flags to Chrome `.lnk` shortcuts (and optionally HKCU registry handler). Refuses to patch when Chrome is running (use `--force` to override). |
| `cdpb sync-profile [--full]` | (Spawn mode only.) Refresh non-cookie state (bookmarks, extensions, preferences) from your daily Chrome to `~/.cdp-bridge/chrome-profile/`. `--full` also copies ABE-protected files (cookies, login data) — only useful on first launch where there's nothing to preserve. Refuses while a sidecar is running. |
| `cdpb fetch <url> [-o <path>] [--timeout <ms>]` | Download `<url>` via the active Chrome session in a **background tab** (no focus stealing). Returns the saved path on stdout. |
| `cdpb install-skill <owner/repo> [--branch <b>] [-g] [--keep]` | One-shot: fetch GitHub zip via Chrome, extract with `Expand-Archive`, then `npx skills add <extracted-dir>`. Tries `master` then `main` if no `--branch`. |
| `cdpb screenshot <url> [-o <path>] [--full-page]` | Open `<url>` in a background tab, capture a full-resolution PNG screenshot. `--full-page` captures the entire scrollable page, not just the viewport. |
| `cdpb exec <url> <js>` | Open `<url>` in a background tab, evaluate `<js>` via `Runtime.evaluate`, print the returned value as JSON on stdout. |
| `cdpb tab list\|new\|close` | Manage browser tabs. `list` outputs a JSON array of page targets. `new <url>` opens a background tab. `close <targetId>` closes by CDP target id. |

All commands log progress to `stderr` prefixed `[cdpb]`. Structured results (file paths, status strings) go to `stdout` so they pipe cleanly.

---

## Why two modes — the Chrome 127+ App-Bound Encryption story

Chrome 127 (July 2024) shipped App-Bound Encryption (ABE) to defeat cookie-stealing malware. The implication for any tool that *copies* a Chrome profile to another Chrome instance:

| File | Transfers across Chrome instances? |
|---|---|
| Bookmarks, Top Sites, Favicons | ✅ |
| Preferences (theme, proxy, search engines) | ✅ |
| Extensions + Local Extension Settings + Local Storage | ✅ |
| `Default/Network/Cookies` (httpOnly cookies — almost all logins) | ❌ ABE-encrypted, recipient Chrome can't decrypt |
| `Default/Login Data` (saved passwords) | ❌ Same |
| `Default/Web Data` (autofill, payment methods) | ❌ Same |

So **spawn mode preserves everything visible** but you re-log into each site once in the sidecar. **Attach mode is the same Chrome instance**, so ABE is satisfied trivially — full login state.

`cdpb` doesn't try to bypass ABE (the `--disable-features=AppBoundEncryption` flag doesn't help — it only affects new writes, not decrypting existing data) and won't pretend it can. If you want full login transfer, use attach.

---

## Concurrency

A file lock at `~/.cdp-bridge/.lock` serializes any cdpb command that mutates state or touches Chrome (`launch`, `stop`, `fetch`, `install-skill`, `sync-profile`, `setup-shortcut`, `screenshot`, `exec`, `tab`). Two parallel `cdpb fetch` calls otherwise race on `Browser.setDownloadBehavior` (which is browser-context-wide). `cdpb status` is read-only and excluded.

Stale-lock recovery: if the lock points at a dead pid (crashed/Ctrl-Ced cdpb), the next command auto-cleans it. If you really need to nuke it, delete `~/.cdp-bridge/.lock`.

---

## State and disk

```
~/.cdp-bridge/
├── chrome-profile/   # sidecar Chrome's user-data-dir (spawn mode only)
├── downloads/        # cdpb fetch staging — cleaned after each call
├── logs/             # Chrome stderr in spawn mode
├── state.json        # { mode, pid, port, proxy, profileSyncedAt, lastStoppedAt }
└── .lock             # acquired by stateful commands
```

Full uninstall:

```powershell
cdpb stop
cdpb setup-shortcut --revert
cd D:\Desktop\project\cdp-bridge ; npm unlink -g
Remove-Item C:\Users\$env:USERNAME\.cdp-bridge -Recurse -Force
Remove-Item C:\Users\$env:USERNAME\.claude\skills\cdp-bridge -Recurse -Force
```

---

## Tests

```powershell
npm test
```

Runs 67 unit tests via Node's built-in test runner (`node --test`). Covers:
- Pure parsing helpers in `setup-shortcut.mjs` (quote-aware tokenization, idempotent flag injection, legacy-flag stripping on revert, registry-value patcher).
- File lock correctness in `lock.mjs` (concurrent serialization, stale-lock recovery, cleanup after fn completes/throws, `isAlive`/`unlinkIfUnchanged`/`handleStaleLock` helpers).
- Argument parsing for new commands in `screenshot.mjs`, `exec.mjs`, and `tab.mjs` (URL extraction, flag handling, subcommand routing).

Manual integration tests (have side effects on sidecar Chrome, not in CI):

```powershell
node test/manual-cookie-persistence.mjs   # cookies survive cdpb stop+launch
```

---

## Safety / known constraints

- Chrome's yellow "automated test software" banner is unavoidable when CDP is on.
- The CDP port binds `127.0.0.1` only — but it's trusted by anything on the same machine. **Don't run cdpb on a shared/public PC.**
- `Browser.setDownloadBehavior` is browser-context-wide. During a `cdpb fetch` (a window of seconds for small files, minutes for big ones), any download the user manually triggers in their Chrome temporarily lands in our staging dir. The `frameId` filter prevents us from confusing it for our own download, and `cdpb fetch` cleans the staging dir on exit — but if the user's manual download was still in-flight at that moment, the orphan files go away with it.
- `cdpb setup-shortcut` modifies user-level shortcuts without admin. Machine-wide shortcuts (Public Desktop, ProgramData Start Menu) are patched only if you have admin rights; otherwise they're reported as `failed:` and skipped.

## Won't-do (deliberately)

- Bypass / work around ABE — Chrome treats this as malware behavior.
- Kill or relaunch the user's daily Chrome process. Attach mode connects, never controls lifecycle.
- macOS / Linux support (v0.x is Windows-only).
- Chrome Beta / Canary / Edge / Brave detection (only stable Chrome at its default install path).
- Modify HKLM (machine-wide) registry. `--include-registry` only writes HKCU.

## License

MIT.
