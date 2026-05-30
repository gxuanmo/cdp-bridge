import { test } from 'node:test';
import assert from 'node:assert/strict';

import { navigateAndWait } from '../src/page-utils.mjs';

class FakeSession {
  constructor(eventName, eventParams = {}) {
    this.eventName = eventName;
    this.eventParams = eventParams;
    this.listeners = new Map();
    this.calls = [];
  }

  async send(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'Page.navigate') {
      queueMicrotask(() => this.emit(this.eventName, this.eventParams));
      return {};
    }
    return {};
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return () => {
      const arr = this.listeners.get(method);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  emit(method, params) {
    for (const fn of this.listeners.get(method) ?? []) fn(params);
  }
}

test('navigateAndWait: resolves on Page.loadEventFired', async () => {
  const session = new FakeSession('Page.loadEventFired');

  await navigateAndWait(session, 'https://example.com', 1000);

  assert.deepEqual(session.calls.map(c => c.method), [
    'Page.enable',
    'Page.setLifecycleEventsEnabled',
    'Page.navigate',
  ]);
  assert.equal(session.listeners.get('Page.loadEventFired').length, 0);
  assert.equal(session.listeners.get('Page.lifecycleEvent').length, 0);
});

test('navigateAndWait: resolves on lifecycle load fallback', async () => {
  const session = new FakeSession('Page.lifecycleEvent', { name: 'load' });

  await navigateAndWait(session, 'https://example.com', 1000);

  assert.equal(session.calls.at(-1).method, 'Page.navigate');
});

test('navigateAndWait: synthetic urls now navigate (no early return)', async () => {
  const session = new FakeSession('Page.loadEventFired');

  await navigateAndWait(session, 'about:blank', 1000);

  assert.deepEqual(session.calls.map(c => c.method), [
    'Page.enable',
    'Page.setLifecycleEventsEnabled',
    'Page.navigate',
  ]);
  assert.equal(session.listeners.get('Page.loadEventFired').length, 0);
  assert.equal(session.listeners.get('Page.lifecycleEvent').length, 0);
});
