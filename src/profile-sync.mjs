import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { paths, userChromeDataDir } from './paths.mjs';
import { log } from './logger.mjs';

/**
 * App-Bound-Encryption (ABE) protected files. Chrome 127+ encrypts these
 * with a key bound to the originating Chrome COM AppID, so copying them to
 * another Chrome instance (even same Windows user, same chrome.exe) yields
 * a file the recipient Chrome cannot decrypt.
 *
 * On INITIAL sync we still copy them — the harm is zero (Chrome silently
 * drops what it can't decrypt and treats the user as logged out, which is
 * the state we'd be in anyway). On RESYNC we skip them so we don't
 * overwrite cookies the sidecar generated itself after the user logged in.
 */
const ABE_PROTECTED = [
  'Default/Network',
  'Default/Login Data',
  'Default/Login Data-journal',
  'Default/Web Data',
  'Default/Web Data-journal',
  'Default/Extension Cookies',
  'Default/Extension Cookies-journal',
];

/**
 * Visible-state files: not ABE-protected, safe to copy at any time.
 *
 *  - `Local State`                top-level encryption keys; harmless even
 *                                 when ABE blocks the actual ciphertext
 *  - `Default/Preferences`        theme, proxy, search engines, default tab page
 *  - `Default/Secure Preferences` integrity-checked preferences (if present)
 *  - `Default/Extensions/`        extension code (manifest, JS, assets)
 *  - `Default/Local Extension Settings/` per-extension storage (e.g.
 *                                 SwitchyOmega rules, dictionary entries)
 *  - `Default/Local Storage/`     site localStorage (some sites stash login
 *                                 there — usually un-encrypted in Chrome)
 *  - `Default/Bookmarks*`         bookmarks JSON + backup
 *  - `Default/Top Sites*`         most-visited tiles on new tab page
 *  - `Default/Favicons*`          favicons cache (so bookmark icons aren't blank)
 */
const VISIBLE_STATE = [
  'Local State',
  'Default/Preferences',
  'Default/Secure Preferences',
  'Default/Extensions',
  'Default/Local Extension Settings',
  'Default/Local Storage',
  'Default/Bookmarks',
  'Default/Bookmarks.bak',
  'Default/Top Sites',
  'Default/Top Sites-journal',
  'Default/Favicons',
  'Default/Favicons-journal',
];

/**
 * Codes for which a one-shot retry-with-delay tends to succeed: the user's
 * main Chrome released the file in the time we slept, or AV scanning briefly
 * held it open. We do NOT retry on ENOENT (the source file genuinely missing).
 */
const RETRYABLE_CODES = new Set(['EPIPE', 'EBUSY', 'EPERM', 'EACCES']);

/**
 * Copy whitelist entries from user's main profile to sidecar profile dir.
 * Existing files are overwritten. Locked files (Chrome running) may fail —
 * we sleep and retry once, then accept partial sync.
 *
 * @param {{ mode?: 'initial' | 'resync' }} [opts] mode=initial copies
 *   everything (only safe on first launch where sidecar has no own state to
 *   protect); mode=resync skips ABE-protected files so we don't trample
 *   cookies the sidecar built up itself.
 * @returns {Promise<{ copied: string[], skipped: string[], retried: string[] }>}
 */
export async function syncProfile(opts = {}) {
  const mode = opts.mode ?? 'resync';
  const list = mode === 'initial' ? [...VISIBLE_STATE, ...ABE_PROTECTED] : VISIBLE_STATE;

  const src = userChromeDataDir();
  const dst = paths.chromeProfile;
  mkdirSync(dst, { recursive: true });
  mkdirSync(join(dst, 'Default'), { recursive: true });

  const copied = [];
  const skipped = [];
  const retried = [];

  for (const rel of list) {
    const from = join(src, rel);
    const to = join(dst, rel);

    if (!existsSync(from)) {
      skipped.push(rel + ' (missing)');
      continue;
    }

    const tryCopy = () => {
      const stat = statSync(from);
      if (stat.isDirectory()) {
        cpSync(from, to, { recursive: true, force: true, errorOnExist: false });
      } else {
        mkdirSync(join(to, '..'), { recursive: true });
        cpSync(from, to, { force: true });
      }
    };

    try {
      tryCopy();
      copied.push(rel);
    } catch (err) {
      if (RETRYABLE_CODES.has(err.code)) {
        await delay(1500);
        try {
          tryCopy();
          copied.push(rel);
          retried.push(rel);
          continue;
        } catch (err2) {
          err = err2;
        }
      }
      skipped.push(rel + ' (' + (err.code ?? 'ERR') + ')');
      log.warn('skipped ' + rel + ': ' + err.message);
    }
  }

  return { copied, skipped, retried };
}
