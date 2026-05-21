import { openPage, closePage } from '../cdp-client.mjs';
import { requirePort } from '../chrome-manager.mjs';
import { log } from '../logger.mjs';
import { navigateAndWait } from '../page-utils.mjs';

/**
 * @param {string[]} argv
 * @returns {{ url: string, js: string }}
 */
export function parseExecArgs(argv) {
  const positionals = argv.filter(a => !a.startsWith('-'));
  const url = positionals[0];
  const js = positionals[1];
  if (!url || !js) throw new Error('usage: cdpb exec <url> <js>');
  return { url, js };
}

export async function run(argv) {
  const { url, js } = parseExecArgs(argv);
  const port = await requirePort();

  const { session, targetId } = await openPage(port, 'about:blank', { background: true });
  try {
    await navigateAndWait(session, url);
    const r = await session.send('Runtime.evaluate', { expression: js, returnByValue: true });

    if (r.exceptionDetails) {
      throw new Error('JS exception: ' + (r.exceptionDetails.text || r.exceptionDetails.exception?.description || 'unknown'));
    }

    if (r.result.type === 'undefined') {
      log.raw('null');
    } else {
      try {
        log.raw(JSON.stringify(r.result.value));
      } catch {
        throw new Error('failed to serialize return value (circular reference or non-serializable type)');
      }
    }
  } finally {
    await closePage(port, session, targetId);
  }
}
