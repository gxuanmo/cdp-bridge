import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const HOME = homedir();
const ROOT = join(HOME, '.cdp-bridge');

export const paths = {
  root: ROOT,
  chromeProfile: join(ROOT, 'chrome-profile'),
  downloads: join(ROOT, 'downloads'),
  state: join(ROOT, 'state.json'),
  logsDir: join(ROOT, 'logs'),
  chromeStderr: join(ROOT, 'logs', 'chrome-stderr.log'),
};

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
];

/**
 * Locate chrome.exe on Windows.
 * @returns {string} absolute path to chrome.exe
 */
export function findChromeExe() {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  throw new Error(
    'chrome.exe not found in standard locations. Searched: ' + CHROME_CANDIDATES.filter(Boolean).join(', '),
  );
}

/**
 * User's daily Chrome User Data dir on Windows.
 * @returns {string}
 */
export function userChromeDataDir() {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error('LOCALAPPDATA env var not set; cannot locate Chrome User Data');
  const dir = join(local, 'Google\\Chrome\\User Data');
  if (!existsSync(dir)) throw new Error('Chrome User Data dir not found: ' + dir);
  return dir;
}
