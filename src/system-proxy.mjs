import { execFileSync } from 'node:child_process';

/**
 * Read Windows system proxy from registry.
 *
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
 *   - ProxyEnable (DWORD): 1 if proxy is on
 *   - ProxyServer (REG_SZ): "host:port" or per-protocol "http=h:p;https=h:p"
 *   - AutoConfigURL (REG_SZ): PAC URL (we ignore PAC for v1)
 *
 * Why explicit pass-through to Chrome instead of relying on auto-pickup:
 * Chrome's WinHTTP-based proxy auto-detection has been flaky for us when
 * the proxy is on a LAN host (not localhost). Forwarding via --proxy-server
 * makes it deterministic and lets us log what we used.
 *
 * @returns {string | null} "host:port" usable by Chrome --proxy-server, or null
 */
export function getWindowsSystemProxy() {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true },
    );
    const enableMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(out);
    if (!enableMatch || parseInt(enableMatch[1], 16) === 0) return null;

    const serverMatch = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(out);
    if (!serverMatch) return null;
    const raw = serverMatch[1].trim();

    // "host:port" or "http=h:p;https=h:p" — Chrome's --proxy-server accepts both
    // forms, but normalize to scheme-less host:port when it's a single value
    // so we get one entry per logged line.
    if (!raw.includes(';') && !raw.includes('=')) return raw;
    return raw;
  } catch {
    return null;
  }
}
