/**
 * Plugin message protocol — pure and shared by the browser host (worker-host.js), the Node test adapter and the worker
 * itself. `workerMain` runs INSIDE the plugin worker: it is serialised with Function.prototype.toString, so it must stay
 * self-contained (no references to this module's scope).
 *
 * Host → worker: { type: 'run', id, commandId, context }
 * Worker → host: { type: 'ready', registrations } once the plugin code has run, { type: 'result', id, result },
 *                { type: 'error', id?, message } and { type: 'log', message }.
 *
 * Isolation is best-effort inside the worker (network globals are replaced by throwing stubs before plugin code runs;
 * dynamic import() cannot be stubbed). The real boundary is structural: a worker has no DOM, no access to the editor's
 * state or storage, and only ever receives copies of plain data; everything it returns is validated (validate.js).
 */

export const RUN_TIMEOUT_MS = 5000;
export const LOAD_TIMEOUT_MS = 5000;

export function workerMain(scope) {
  'use strict';
  const blocked = name => function blockedApi() { throw new Error(`${name} is not available to Pixel Studio plugins: they work offline on the data they are given.`); };
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'WebTransport', 'Worker', 'SharedWorker', 'BroadcastChannel', 'indexedDB', 'caches', 'RTCPeerConnection']) {
    // Shadow the global and also replace it on every prototype that defines it (fetch lives on WorkerGlobalScope.prototype).
    for (let target = Object.getPrototypeOf(scope); target; target = Object.getPrototypeOf(target)) {
      if (Object.hasOwn(target, name)) try { Object.defineProperty(target, name, { value: blocked(name), writable: false, configurable: false }); } catch { /* best-effort */ }
    }
    try { Object.defineProperty(scope, name, { value: blocked(name), writable: false, configurable: false }); } catch { /* best-effort */ }
  }
  const post = scope.postMessage.bind(scope);
  const handlers = new Map(), meta = { commands: [], effects: [], promptSkills: [], palettes: [] };
  const plain = value => JSON.parse(JSON.stringify(value === undefined ? null : value));
  const message = error => String((error && error.message) || error || 'Unknown error').slice(0, 500);
  function action(kind, def, handler) {
    if (typeof handler !== 'function') throw new Error(`${kind} “${def && def.id}” needs a handler function as its second argument.`);
    const id = String(def && def.id);
    if (handlers.has(id)) throw new Error(`“${id}” is registered twice.`);
    handlers.set(id, handler);
    meta[kind].push(plain(def));
  }
  const api = Object.freeze({
    apiVersion: 1,
    registerCommand: (def, handler) => action('commands', def, handler),
    registerEffect: (def, handler) => action('effects', def, handler),
    registerPromptSkill: def => { meta.promptSkills.push(plain(def)); },
    registerPalette: def => { meta.palettes.push(plain(def)); },
    log: (...args) => post({ type: 'log', message: args.map(String).join(' ').slice(0, 500) }),
  });
  Object.defineProperty(scope, 'pixelStudio', { value: api, writable: false, configurable: false });
  Object.defineProperty(scope, '__pixelStudioDone', {
    value: error => post(error ? { type: 'error', message: `The plugin failed while loading: ${message(error)}` } : { type: 'ready', registrations: meta }),
    writable: false, configurable: false,
  });
  scope.onmessage = event => {
    const data = event.data;
    if (!data || data.type !== 'run') return;
    const handler = handlers.get(data.commandId);
    Promise.resolve()
      .then(() => { if (!handler) throw new Error(`Unknown command “${data.commandId}”.`); return handler(data.context); })
      .then(result => {
        try { post({ type: 'result', id: data.id, result }); }
        catch { post({ type: 'error', id: data.id, message: 'The plugin returned data that cannot be copied (functions or objects with methods).' }); }
      }, error => post({ type: 'error', id: data.id, message: message(error) }));
  };
}

const NODE_SHIM = `const { parentPort } = require('node:worker_threads');
globalThis.self = globalThis;
self.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
parentPort.on('message', data => { if (typeof self.onmessage === 'function') self.onmessage({ data }); });
`;

/**
 * The complete worker script: the prelude (workerMain), then the plugin code inside a strict function so its top-level
 * declarations stay local, then the ready signal. `platform` 'node' adds a worker_threads shim (tests only).
 */
export function buildWorkerSource(code, { platform = 'browser' } = {}) {
  return `${platform === 'node' ? NODE_SHIM : ''}(${workerMain.toString()})(self);
try {
(function (pixelStudio) { 'use strict';
${code}
}).call(undefined, self.pixelStudio);
self.__pixelStudioDone();
} catch (error) { self.__pixelStudioDone(error); }
`;
}

/**
 * Drive one plugin worker. `spawn(source)` returns an endpoint { post(message, transfer), terminate(), onMessage(fn),
 * onError(fn) } — a Web Worker in the browser, a worker_threads Worker in tests. Every call has a timeout; on timeout
 * (or a crash) the worker is terminated and the host must be started again.
 */
export class PluginHost {
  constructor(code, spawn, { loadTimeout = LOAD_TIMEOUT_MS, runTimeout = RUN_TIMEOUT_MS, onLog, platform = 'browser' } = {}) {
    Object.assign(this, { code, spawn, loadTimeout, runTimeout, onLog, platform, endpoint: null, pending: new Map(), nextId: 1, ready: null });
  }

  get running() { return Boolean(this.endpoint); }

  /** Start the worker and resolve to the raw registrations (validate them with validateRegistrations). */
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let endpoint;
      const timer = setTimeout(() => { this.stop(); reject(new Error(`The plugin did not finish loading within ${this.loadTimeout / 1000} s.`)); }, this.loadTimeout);
      const fail = error => { clearTimeout(timer); this.stop(error); reject(error); };
      try { endpoint = this.spawn(buildWorkerSource(this.code, { platform: this.platform })); }
      catch (error) { fail(new Error(`The plugin worker could not start: ${error.message}`)); return; }
      this.endpoint = endpoint;
      endpoint.onError(error => fail(error instanceof Error ? error : new Error(String(error))));
      endpoint.onMessage(data => {
        if (!data || typeof data !== 'object') return;
        if (data.type === 'ready') { clearTimeout(timer); resolve(data.registrations); }
        else if (data.type === 'log') this.onLog?.(String(data.message));
        else if (data.type === 'error' && data.id === undefined) fail(new Error(String(data.message)));
        else if (data.type === 'result' || data.type === 'error') {
          const call = this.pending.get(data.id);
          if (!call) return;
          this.pending.delete(data.id); clearTimeout(call.timer);
          data.type === 'result' ? call.resolve(data.result) : call.reject(new Error(String(data.message)));
        }
      });
    });
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  /** Run a registered command with a plain-data `context`; resolves to the raw result. */
  async run(commandId, context, transfer = []) {
    await this.start();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stop(new Error('stopped'));
        reject(new Error(`The plugin took longer than ${this.runTimeout / 1000} s and was stopped.`));
      }, this.runTimeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.endpoint.post({ type: 'run', id, commandId, context }, transfer); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(new Error(`Could not send data to the plugin: ${error.message}`)); }
    });
  }

  /** Terminate the worker; pending calls fail with `error`. */
  stop(error = new Error('The plugin was stopped.')) {
    const endpoint = this.endpoint;
    this.endpoint = null; this.ready = null;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear();
    try { endpoint?.terminate(); } catch { /* already gone */ }
  }
}
