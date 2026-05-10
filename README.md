# cdp-bridge

Drive a sidecar Chrome via CDP, reusing your real profile (proxies, cookies, extensions) without touching your daily Chrome.

## Why

GitHub / npm / generic web fetches from China are often dog-slow on raw `curl`. A user's daily Chrome usually has the right network setup (system proxy pointed at a LAN Clash, browser extension proxy, etc.). But manually wiring `chrome://inspect` every time you want CDP access is friction.

`cdp-bridge` automates that: it takes a selective copy of your daily Chrome's profile (extensions, cookies, login state, preferences), launches a separate Chrome instance with `--remote-debugging-port`, and gives you a small CLI (`cdpb`) so any agent or script can drive it.

Your daily Chrome stays untouched.

## Install

```powershell
git clone <this repo> D:\Desktop\project\cdp-bridge
cd D:\Desktop\project\cdp-bridge
npm link
```

That puts `cdpb` on PATH.

## Quick start

```powershell
cdpb launch                                           # first run: copies profile, starts Chrome
cdpb status                                           # ready pid=12345 port=9222 product=Chrome/147 proxy=192.168.10.124:7897
cdpb install-skill alchaincyf/huashu-design -g        # downloads zip via Chrome → npx skills add
cdpb fetch <url> -o D:\downloads\file.zip             # any URL via the sidecar
cdpb stop                                             # kill sidecar Chrome
```

## Commands

| Command | Use |
|---------|-----|
| `cdpb launch [--port N] [--proxy <addr>\|none] [--headless] [--no-sync]` | start sidecar Chrome |
| `cdpb status` | print pid, port, proxy, ready/dead |
| `cdpb stop` | terminate sidecar Chrome |
| `cdpb fetch <url> [-o <path>] [--timeout <ms>]` | download via Chrome (uses real profile) |
| `cdpb install-skill <owner/repo> [--branch <b>] [-g] [--keep]` | one-shot: download GitHub zip + extract + `npx skills add` |

## Proxy

cdpb auto-reads Windows system proxy (`HKCU\...\Internet Settings\ProxyServer`) and passes it to Chrome via `--proxy-server`. We don't rely on Chrome's auto-pickup because we observed it being flaky for LAN proxies like `192.168.x.x:7897`.

- `--proxy 127.0.0.1:7890` — explicit override
- `--proxy none` — disable proxy (direct connect)
- (no flag) — auto-use system proxy

The chosen proxy is persisted to `~/.cdp-bridge/state.json` and shown by `cdpb status`.

## What gets copied to sidecar profile

Selective: `~260MB` mostly extensions. Skip cache/history/sessions to avoid bloat and lock conflicts. Specifically:

- `Local State` (encryption keys for cookies/passwords)
- `Default/Network/` (cookies, transport security)
- `Default/Login Data*` (saved passwords)
- `Default/Preferences`, `Default/Secure Preferences`
- `Default/Extensions/`, `Default/Local Extension Settings/`
- `Default/Extension Cookies*`
- `Default/Local Storage/`

After that, sidecar profile is independent. To refresh from main profile (e.g., after logging into a new site), `cdpb stop && rm -rf ~/.cdp-bridge/chrome-profile && cdpb launch`.

## Sidecar layout

```
~/.cdp-bridge/
├─ chrome-profile/         # sidecar Chrome's user-data-dir
├─ downloads/              # default for cdpb fetch (auto-cleaned per call)
├─ state.json              # { pid, port, proxy, profileSyncedAt }
└─ logs/
   └─ chrome-stderr.log    # Chrome's stderr (errors, extension issues)
```

## Constraints

- **Windows only (v1)**. Mac/Linux later.
- **Chrome stable only** at standard install paths.
- **Don't run on shared/public PCs** — the CDP port is open to all local processes; whoever holds the port owns Chrome.
- **Chrome shows a yellow "automated test software" banner** — that's CDP, can't be hidden.

## Known limits

- Cookies/login state are a snapshot; sites you log into in your daily Chrome won't appear in sidecar until you re-sync (manual for now, `cdpb sync-profile` is v2).
- `cdpb fetch` only handles URLs that trigger a Chrome download (`Content-Disposition: attachment` or known archive types). Plain text/HTML pages won't trigger `Browser.downloadWillBegin` and will time out.

## Debugging

Chrome stderr lives at `~/.cdp-bridge/logs/chrome-stderr.log`. The `[cdpb]` prefix on stderr means CLI-emitted; everything else is Chrome itself.

If `cdpb status` shows `dead`, `cdpb launch` again — it'll detect the missing process.

If downloads stall: `cdpb status` to confirm proxy looks right; `curl -x <proxy> <url>` directly to compare. If curl is fast and cdpb fetch is slow, file an issue with chrome-stderr.log.

## License

MIT.
