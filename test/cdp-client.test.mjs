import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CdpSession } from '../src/cdp-client.mjs';

test('CdpSession.close: rejects pending commands and closes open socket', async () => {
  const session = new CdpSession('ws://127.0.0.1/devtools/page/test');
  let sentPayload;
  let closeCalled = false;
  session.ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sentPayload = JSON.parse(payload);
    },
    close() {
      closeCalled = true;
    },
  };

  const pending = session.send('Runtime.evaluate', { expression: '1 + 1' });
  assert.equal(sentPayload.method, 'Runtime.evaluate');

  session.close();

  await assert.rejects(pending, /CDP socket closed/);
  assert.equal(session.pending.size, 0);
  assert.equal(session.ws, null);
  assert.equal(closeCalled, true);
});

test('CdpSession.close: handles already-cleared sockets', () => {
  const session = new CdpSession('ws://127.0.0.1/devtools/page/test');

  assert.doesNotThrow(() => session.close());
  assert.equal(session.pending.size, 0);
  assert.equal(session.ws, null);
});
