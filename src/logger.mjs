/**
 * Minimal logger. Prefixes lines with [cdpb] so output is greppable.
 */
export const log = {
  info: (msg) => console.error('[cdpb] ' + msg),
  warn: (msg) => console.error('[cdpb] WARN ' + msg),
  error: (msg) => console.error('[cdpb] ERROR ' + msg),
  raw: (msg) => process.stdout.write(msg + '\n'),
};
