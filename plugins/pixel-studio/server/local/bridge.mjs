/**
 * Live editor bridge for the local edition. The open editor subscribes with Server-Sent Events (same origin, CSRF
 * token) and answers requests; an external agent process (the MCP server) authenticates with a random bridge token
 * that is written to ~/.pixelstudio/bridge.json (mode 0600) while the server runs.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BRIDGE_TIMEOUT_MS = 30_000;
const MAX_CALL_BYTES = 6 * 1024 * 1024;
const MAX_REPLY_BYTES = 12 * 1024 * 1024;
const MAX_PENDING = 16;
const AGENT_ACTIVE_MS = 60_000;
export const BRIDGE_TOOLS = ['get_project', 'apply_project'];

/** Where bridge.json lives: $PIXELSTUDIO_BRIDGE_DIR, else ~/.pixelstudio. */
export const defaultBridgeDirectory = () => process.env.PIXELSTUDIO_BRIDGE_DIR || join(homedir(), '.pixelstudio');

class BridgeError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

function same(value, expected) {
  if (typeof value !== 'string' || !expected) return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new BridgeError('INVALID_CONTENT_TYPE', 'Send JSON.', 415);
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > limit) throw new BridgeError('BODY_TOO_LARGE', 'This bridge message is too large.', 413);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new BridgeError('BODY_TOO_LARGE', 'This bridge message is too large.', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new BridgeError('INVALID_JSON', 'The bridge message is not a JSON object.', 400); }
}

function sendJson(response, status, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

/**
 * createBridge({ directory, timeoutMs }) → { handle(request, response, url, csrfToken), publish(port), unpublish(), close(), token }.
 * `directory` is the bridge.json location (tests pass a temporary folder).
 */
export function createBridge({ directory = defaultBridgeDirectory(), timeoutMs = BRIDGE_TIMEOUT_MS } = {}) {
  const token = randomBytes(32).toString('hex');
  const subscribers = [];
  const pending = new Map();
  let lastAgentAt = 0, agentTimer = null, published = null;
  const file = join(directory, 'bridge.json');

  const write = (subscriber, event, data) => {
    if (subscriber.response.destroyed || subscriber.response.writableEnded) return false;
    subscriber.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  };
  const broadcast = (event, data) => { for (const s of subscribers) write(s, event, data); };
  const agentActive = () => Date.now() - lastAgentAt < AGENT_ACTIVE_MS;
  function touchAgent() {
    const was = agentActive();
    lastAgentAt = Date.now();
    if (!was) broadcast('agent', { active: true });
    clearTimeout(agentTimer);
    agentTimer = setTimeout(() => broadcast('agent', { active: false }), AGENT_ACTIVE_MS);
    agentTimer.unref?.();
  }

  function subscribe(request, response) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    const subscriber = { id: randomUUID(), response, connectedAt: Date.now() };
    subscribers.push(subscriber);
    write(subscriber, 'hello', { id: subscriber.id, agent: agentActive() });
    const keepAlive = setInterval(() => { if (!response.destroyed) response.write(': keep-alive\n\n'); }, 15_000);
    keepAlive.unref?.();
    const drop = () => {
      clearInterval(keepAlive);
      const index = subscribers.indexOf(subscriber);
      if (index >= 0) subscribers.splice(index, 1);
      for (const [id, call] of pending) if (call.subscriber === subscriber) { pending.delete(id); call.reject(new BridgeError('EDITOR_CLOSED', 'The Pixel Studio tab closed before answering.', 503)); }
    };
    // Only the response's close marks a lost connection; a GET request "closes" as soon as it is read.
    response.once('close', drop);
  }

  async function call(request, response) {
    if (!same(String(request.headers.authorization || '').replace(/^Bearer\s+/i, ''), token)) throw new BridgeError('INVALID_BRIDGE_TOKEN', 'The bridge token is missing or wrong. Restart the MCP server so it reads ~/.pixelstudio/bridge.json again.', 401);
    const body = await readBody(request, MAX_CALL_BYTES);
    touchAgent();
    if (body.tool === 'status' || body.tool === 'ping') {
      sendJson(response, 200, { result: { editorConnected: subscribers.length > 0, editors: subscribers.length } });
      return;
    }
    if (!BRIDGE_TOOLS.includes(body.tool)) throw new BridgeError('UNKNOWN_TOOL', `Unknown editor tool "${body.tool}".`, 400);
    if (body.args !== undefined && (typeof body.args !== 'object' || body.args === null || Array.isArray(body.args))) throw new BridgeError('INVALID_ARGS', 'args must be an object.', 400);
    // The most recently opened editor tab answers.
    const subscriber = subscribers.at(-1);
    if (!subscriber) throw new BridgeError('NO_EDITOR', 'No Pixel Studio editor is open. Open the local edition in a browser (the URL printed by `npm start`) and try again.', 409);
    if (pending.size >= MAX_PENDING) throw new BridgeError('BUSY', 'Too many editor requests are waiting. Try again shortly.', 429);
    const id = randomUUID();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new BridgeError('TIMEOUT', `The editor did not answer within ${Math.round(timeoutMs / 1000)} s (the user may not have approved the change).`, 504)); }, timeoutMs);
      timer.unref?.();
      pending.set(id, { subscriber, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      response.once('close', () => { if (pending.has(id) && !response.writableEnded) { const c = pending.get(id); pending.delete(id); c.reject(new BridgeError('CANCELLED', 'Cancelled.', 499)); } });
      if (!write(subscriber, 'request', { id, tool: body.tool, args: body.args || {} })) { pending.delete(id); clearTimeout(timer); reject(new BridgeError('NO_EDITOR', 'The editor connection was lost.', 409)); }
    });
    sendJson(response, 200, result);
  }

  async function reply(request, response, csrfToken) {
    if (!same(request.headers['x-pixel-studio-token'], csrfToken)) throw new BridgeError('INVALID_TOKEN', 'The local connection has changed. Refresh Pixel Studio.', 403);
    const body = await readBody(request, MAX_REPLY_BYTES);
    const call = typeof body.id === 'string' && pending.get(body.id);
    if (!call) throw new BridgeError('UNKNOWN_REQUEST', 'This editor request is unknown or has expired.', 404);
    pending.delete(body.id);
    if (typeof body.error === 'string') call.resolve({ error: body.error.slice(0, 2000), code: typeof body.code === 'string' ? body.code.slice(0, 40) : 'EDITOR_ERROR' });
    else call.resolve({ result: body.result ?? null });
    sendJson(response, 200, { ok: true });
  }

  return {
    get token() { return token; },
    get editors() { return subscribers.length; },
    /** Returns true when the request was a bridge endpoint (and has been answered). */
    async handle(request, response, url, csrfToken) {
      if (!url.pathname.startsWith('/api/bridge/')) return false;
      try {
        if (url.pathname === '/api/bridge/events') {
          if (request.method !== 'GET') throw new BridgeError('METHOD_NOT_ALLOWED', 'Use GET.', 405);
          if (!same(url.searchParams.get('token') || request.headers['x-pixel-studio-token'], csrfToken)) throw new BridgeError('INVALID_TOKEN', 'The local connection has changed. Refresh Pixel Studio.', 403);
          subscribe(request, response);
        } else if (url.pathname === '/api/bridge/reply') {
          if (request.method !== 'POST') throw new BridgeError('METHOD_NOT_ALLOWED', 'Use POST.', 405);
          await reply(request, response, csrfToken);
        } else if (url.pathname === '/api/bridge/call') {
          if (request.method !== 'POST') throw new BridgeError('METHOD_NOT_ALLOWED', 'Use POST.', 405);
          await call(request, response);
        } else throw new BridgeError('NOT_FOUND', 'Unknown bridge endpoint.', 404);
      } catch (error) {
        const status = error instanceof BridgeError ? (error.status === 499 ? 400 : error.status) : 500;
        sendJson(response, status, { error: error instanceof BridgeError ? error.message : 'The bridge failed.', code: error.code || 'BRIDGE_ERROR' });
      }
      return true;
    },
    /** Write bridge.json (0600) so local agent processes can find and authenticate to this server. */
    async publish(port) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      published = { port, token, pid: process.pid, url: `http://127.0.0.1:${port}/`, startedAt: new Date().toISOString() };
      await writeFile(file, `${JSON.stringify(published, null, 2)}\n`, { mode: 0o600 });
      await chmod(file, 0o600);
      return file;
    },
    /** Remove bridge.json, unless another server has replaced it since. */
    async unpublish() {
      if (!published) return;
      published = null;
      try {
        const current = JSON.parse(await readFile(file, 'utf8'));
        if (current.token === token) await rm(file, { force: true });
      } catch { /* already gone */ }
    },
    close() {
      clearTimeout(agentTimer);
      for (const [id, c] of pending) { pending.delete(id); c.reject(new BridgeError('SHUTTING_DOWN', 'Pixel Studio is closing.', 503)); }
      for (const s of subscribers.splice(0)) s.response.end();
    },
  };
}

/** Client side (agent process): read bridge.json. Returns null when the local edition is not running. */
export async function readBridgeInfo(directory = defaultBridgeDirectory()) {
  try {
    const info = JSON.parse(await readFile(join(directory, 'bridge.json'), 'utf8'));
    if (!Number.isInteger(info.port) || typeof info.token !== 'string') return null;
    return info;
  } catch { return null; }
}

/** Call an editor tool through a running local edition. Throws with a helpful message when unavailable. */
export async function callBridge(tool, args = {}, { directory, timeoutMs = BRIDGE_TIMEOUT_MS + 5000 } = {}) {
  const info = await readBridgeInfo(directory);
  if (!info) throw new Error('Pixel Studio Local is not running. Start it with `npm start` (or `pixelstudio serve`) in the Pixel Studio folder, open it in a browser, then try again.');
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${info.port}/api/bridge/call`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ tool, args }), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Could not reach Pixel Studio Local at ${info.url} (${error.name === 'TimeoutError' ? 'timed out' : error.message}). Is it still running?`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Pixel Studio Local answered ${response.status}.`);
  if (body.error) throw new Error(body.error);
  return body.result;
}
