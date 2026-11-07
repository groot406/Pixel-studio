import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexClient, LocalAIError, publicError } from './codex-client.mjs';
import { MAX_PROMPT_BYTES, MAX_PREVIEW_BYTES, MAX_PREVIEW_COUNT, readPreviewImages, isPixelPrompt } from './pixel-request.mjs';

const MAX_BODY_BYTES = MAX_PROMPT_BYTES + Math.ceil(MAX_PREVIEW_BYTES * MAX_PREVIEW_COUNT * 4 / 3) + 64 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.pxa': 'text/plain; charset=utf-8', '.pxs': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.zip': 'application/zip', '.woff2': 'font/woff2',
};

function errorJson(response, error) {
  const safe = publicError(error);
  if (response.headersSent || response.destroyed) return;
  response.writeHead(safe.status === 499 ? 400 : safe.status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: safe.message, code: safe.code }));
}

function matchesToken(value, expected) {
  if (typeof value !== 'string') return false;
  const received = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}

async function readJson(request) {
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new LocalAIError('BODY_TOO_LARGE', 'This request is too large. Choose one animation or frame.', 413);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new LocalAIError('INVALID_CONTENT_TYPE', 'Send this request as JSON.', 415);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new LocalAIError('BODY_TOO_LARGE', 'This request is too large. Choose one animation or frame.', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new LocalAIError('INVALID_JSON', 'The request could not be read. Refresh Pixel Studio and try again.', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['prompt', 'model', 'previews'].includes(key))) {
    throw new LocalAIError('INVALID_REQUEST', 'This endpoint accepts a Pixel Studio prompt, model and optional PNG previews.', 400);
  }
  if (!isPixelPrompt(body.prompt)) {
    throw new LocalAIError('INVALID_PROMPT', 'Use a Pixel Studio edit prompt of at most 2 MB.', 400);
  }
  if (body.model !== undefined && (typeof body.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9/._:-]{0,159}$/.test(body.model))) {
    throw new LocalAIError('INVALID_MODEL', 'Choose a model from the local Codex model list.', 400);
  }
  try { readPreviewImages(body.previews); }
  catch { throw new LocalAIError('INVALID_PREVIEW', 'Use up to two PNG previews of at most 1 MiB and 1024 × 1024 pixels each.', 400); }
  return body;
}

/** Loopback-only local application. clientFactory is an in-process test seam,
 * never an environment setting or a browser-controlled parameter. */
export function createLocalServer({ distDirectory = fileURLToPath(new URL('../dist/', import.meta.url)), clientFactory = () => new CodexClient() } = {}) {
  const csrfToken = randomBytes(32).toString('hex');
  const clients = new Set();
  const controllers = new Set();
  let active = false;
  let statusPromise;
  let lastStatus;
  let closing = false;
  let distRoot;

  async function status() {
    if (active && lastStatus) return lastStatus;
    if (statusPromise) return statusPromise;
    statusPromise = (async () => {
      const client = clientFactory();
      clients.add(client);
      try { lastStatus = await client.getStatus(); }
      catch (error) {
        const safe = publicError(error);
        lastStatus = { connected: false, authMode: null, accountLabel: null, models: [], code: safe.code, message: safe.message };
      } finally { await client.close(); clients.delete(client); }
      return lastStatus;
    })();
    try { return await statusPromise; } finally { statusPromise = null; }
  }

  function checkOrigin(request) {
    const port = server.address()?.port;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!hosts.has(request.headers.host)) throw new LocalAIError('INVALID_HOST', 'Open Pixel Studio at the localhost URL shown in Terminal.', 403);
    if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(request.socket.remoteAddress)) throw new LocalAIError('LOCAL_ONLY', 'This service accepts local connections only.', 403);
    const expected = `http://${request.headers.host}`;
    if (request.headers.origin && request.headers.origin !== expected) throw new LocalAIError('INVALID_ORIGIN', 'This request must come from the local Pixel Studio app.', 403);
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) throw new LocalAIError('INVALID_ORIGIN', 'This request must come from the local Pixel Studio app.', 403);
    return expected;
  }

  async function generate(request, response) {
    if (!matchesToken(request.headers['x-pixel-studio-token'], csrfToken)) throw new LocalAIError('INVALID_TOKEN', 'The local connection has changed. Refresh the connection and try again.', 403);
    if (active) throw new LocalAIError('BUSY', 'Another Codex edit is running. Finish or cancel it before starting another.', 409);
    // Reserve before reading the body so two simultaneous uploads cannot race.
    active = true;
    const controller = new AbortController();
    controllers.add(controller);
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    request.once('aborted', cancel);
    response.once('close', cancel);
    let client;
    try {
      const body = await readJson(request);
      if (controller.signal.aborted || closing) return;
      client = clientFactory();
      clients.add(client);
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
      response.flushHeaders();
      const send = event => {
        if (!response.destroyed && !response.writableEnded) {
          // Bounded output plus a strict socket queue prevents stalled browser
          // tabs from retaining an unbounded stream in memory.
          if (response.writableLength > 1024 * 1024) { controller.abort(); return; }
          response.write(`${JSON.stringify(event)}\n`);
        }
      };
      const result = await client.edit({ ...body, signal: controller.signal, onEvent: send });
      if (!controller.signal.aborted) send({ type: 'done', text: result.text, ...(result.model ? { model: result.model } : {}) });
    } catch (error) {
      const safe = publicError(error);
      if (!controller.signal.aborted && !response.destroyed) {
        if (response.headersSent) response.write(`${JSON.stringify({ type: 'error', code: safe.code, error: safe.message })}\n`);
        else errorJson(response, safe);
      }
    } finally {
      if (client) { await client.close(); clients.delete(client); }
      controllers.delete(controller);
      request.removeListener('aborted', cancel);
      response.removeListener('close', cancel);
      active = false;
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  }

  async function staticFile(pathname, request, response) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { throw new LocalAIError('NOT_FOUND', 'File not found.', 404); }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) throw new LocalAIError('NOT_FOUND', 'File not found.', 404);
    const requested = resolve(distRoot, `.${decoded === '/' ? '/index.html' : decoded}`);
    if (!requested.startsWith(distRoot + sep)) throw new LocalAIError('NOT_FOUND', 'File not found.', 404);
    let path;
    try { path = await realpath(requested); } catch { throw new LocalAIError('NOT_FOUND', 'File not found.', 404); }
    if (!path.startsWith(distRoot + sep)) throw new LocalAIError('NOT_FOUND', 'File not found.', 404);
    const details = await stat(path);
    if (!details.isFile()) throw new LocalAIError('NOT_FOUND', 'File not found.', 404);
    response.writeHead(200, { 'Content-Type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream', 'Content-Length': details.size });
    if (request.method === 'HEAD') response.end();
    else response.end(await readFile(path));
  }

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if (closing) throw new LocalAIError('SHUTTING_DOWN', 'Pixel Studio is closing.', 503);
      const origin = checkOrigin(request);
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new LocalAIError('INVALID_REQUEST', 'Invalid local request.', 400);
      const url = new URL(request.url, origin);
      if (url.pathname === '/api/local-ai/status') {
        if (request.method !== 'GET') throw new LocalAIError('METHOD_NOT_ALLOWED', 'Use GET for connection status.', 405);
        const connection = await status();
        if (response.destroyed) return;
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ local: true, ...connection, csrfToken, busy: active }));
        return;
      }
      if (url.pathname === '/api/local-ai/edit') {
        if (request.method !== 'POST') throw new LocalAIError('METHOD_NOT_ALLOWED', 'Use POST for pixel edits.', 405);
        await generate(request, response);
        return;
      }
      if (url.pathname.startsWith('/api/')) throw new LocalAIError('NOT_FOUND', 'Unknown local endpoint.', 404);
      if (!['GET', 'HEAD'].includes(request.method)) throw new LocalAIError('METHOD_NOT_ALLOWED', 'Use GET to open Pixel Studio.', 405);
      await staticFile(url.pathname, request, response);
    } catch (error) { errorJson(response, error); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return {
    server,
    async listen(port = 4317) {
      distRoot = await realpath(distDirectory);
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolveListen(); });
      });
      return `http://127.0.0.1:${server.address().port}/`;
    },
    async close() {
      if (closing) return;
      closing = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...clients].map(client => client.close()));
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}
