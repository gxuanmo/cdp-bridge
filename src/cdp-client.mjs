import { probeCdp } from './chrome-manager.mjs';

/**
 * Minimal CDP client over WebSocket. Single in-flight connection per instance.
 * Use connectBrowser() for browser-level domains (Target, Browser),
 * use connectPage() for page-level domains (Page, Network, Runtime).
 */
class CdpSession {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
    this.pending = new Map();
    /** @type {Map<string, ((params: any) => void)[]>} */
    this.listeners = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      ws.onopen = () => {
        this.ws = ws;
        resolve();
      };
      ws.onerror = (e) => reject(new Error('CDP WebSocket error: ' + (e.message || 'unknown')));
      ws.onmessage = (msg) => this._onMessage(msg);
      ws.onclose = () => {
        const err = new Error('CDP socket closed');
        for (const { reject } of this.pending.values()) reject(err);
        this.pending.clear();
        this.ws = null;
      };
    });
  }

  _onMessage(msg) {
    let data;
    try {
      data = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (data.id != null) {
      const slot = this.pending.get(data.id);
      if (!slot) return;
      this.pending.delete(data.id);
      if (data.error) slot.reject(new Error(data.error.message + ' (' + data.error.code + ')'));
      else slot.resolve(data.result);
    } else if (data.method) {
      const subs = this.listeners.get(data.method);
      if (subs) for (const fn of subs) fn(data.params);
    }
  }

  /**
   * Send a CDP command and await the response.
   * @template T
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<T>}
   */
  send(method, params = {}) {
    if (!this.ws) throw new Error('CDP not connected');
    const id = this.nextId++;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  /**
   * Subscribe to a CDP event.
   * @param {string} method
   * @param {(params: any) => void} fn
   * @returns {() => void} unsubscribe
   */
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

  close() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}

/**
 * Connect to the browser-level CDP endpoint.
 * @param {number} port
 * @returns {Promise<CdpSession>}
 */
export async function connectBrowser(port) {
  const v = await probeCdp(port);
  if (!v) throw new Error('CDP not reachable on port ' + port);
  const url = v.webSocketDebuggerUrl;
  if (!url) throw new Error('CDP /json/version did not return webSocketDebuggerUrl');
  const sess = new CdpSession(url);
  await sess.connect();
  return sess;
}

/**
 * Open a new page and connect to its CDP target.
 * @param {number} port
 * @param {string} url
 * @returns {Promise<{ session: CdpSession, targetId: string }>}
 */
export async function openPage(port, url) {
  const browser = await connectBrowser(port);
  /** @type {{ targetId: string }} */
  const { targetId } = await browser.send('Target.createTarget', { url });
  browser.close();

  const wsUrl = 'ws://127.0.0.1:' + port + '/devtools/page/' + targetId;
  const sess = new CdpSession(wsUrl);
  await sess.connect();
  return { session: sess, targetId };
}

/**
 * Close a target by id.
 * @param {number} port
 * @param {string} targetId
 */
export async function closeTarget(port, targetId) {
  const browser = await connectBrowser(port);
  try {
    await browser.send('Target.closeTarget', { targetId });
  } finally {
    browser.close();
  }
}
