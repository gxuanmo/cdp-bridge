import { connectBrowser, closeTarget } from '../cdp-client.mjs';
import { requirePort } from '../chrome-manager.mjs';
import { log } from '../logger.mjs';

const SUBCOMMANDS = ['list', 'new', 'close'];

/**
 * @param {string[]} argv
 * @returns {{ sub: string, arg?: string }}
 */
export function parseTabArgs(argv) {
  const sub = argv[0];
  if (!sub) throw new Error('usage: cdpb tab list|new|close (' + SUBCOMMANDS.join('|') + ')');
  if (!SUBCOMMANDS.includes(sub)) {
    throw new Error('unknown tab subcommand: ' + sub + ' (expected ' + SUBCOMMANDS.join('|') + ')');
  }
  return { sub, arg: argv[1] };
}

export async function run(argv) {
  const { sub, arg } = parseTabArgs(argv);
  const port = await requirePort();

  switch (sub) {
    case 'list':
      await listTabs(port);
      break;
    case 'new':
      await newTab(port, arg);
      break;
    case 'close':
      await closeTab(port, arg);
      break;
  }
}

async function listTabs(port) {
  const browser = await connectBrowser(port);
  try {
    const { targetInfos } = await browser.send('Target.getTargets');
    const pages = targetInfos.filter(t => t.type === 'page').map(t => ({
      id: t.targetId,
      url: t.url,
      title: t.title,
    }));
    log.raw(JSON.stringify(pages));
  } finally {
    browser.close();
  }
}

async function newTab(port, url) {
  if (!url) throw new Error('usage: cdpb tab new <url>');
  const browser = await connectBrowser(port);
  try {
    const { targetId } = await browser.send('Target.createTarget', { url, background: true });
    log.raw(JSON.stringify({ targetId }));
  } finally {
    browser.close();
  }
}

async function closeTab(port, targetId) {
  if (!targetId) throw new Error('usage: cdpb tab close <targetId>');
  await closeTarget(port, targetId);
  log.info('closed tab ' + targetId);
}
