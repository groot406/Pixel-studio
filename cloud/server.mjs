// Pixel Studio Cloud: the hosted, multi-user edition. Serves the built editor (dist/) and the APIs the browser uses:
// passwordless email sign-in, metered AI (same contracts as Pixel Studio Local's /api/local-ai and /api/image),
// cloud projects and Lemon Squeezy billing. Zero dependencies: node:http + node:sqlite.
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { CHAT_MODELS, DEFAULT_CHAT_MODEL, MIN_CHAT_CREDITS, PLANS, CREDIT_PACKS, CURRENCY, chatCredits, imageCredits, creditBalance, planFor, planAllows } from '../src/features/cloud/plans.js';
import { IMAGE_PROVIDERS } from '../src/features/ai/image-api.js';
import { isPixelPrompt, readPreviewImages, MAX_PROMPT_BYTES, MAX_PREVIEW_BYTES, MAX_PREVIEW_COUNT } from '../local/pixel-request.mjs';
import { validateImageRequest, MAX_IMAGE_BODY_BYTES } from '../local/image-client.mjs';
import { CloudError } from './store.mjs';
import { chatEdit, chatModels, generateImages } from './ai.mjs';
import { verifySignature } from './billing.mjs';
import { renderLanding } from './landing.mjs';

const MAX_EDIT_BODY = MAX_PROMPT_BYTES + Math.ceil(MAX_PREVIEW_BYTES * MAX_PREVIEW_COUNT * 4 / 3) + 64 * 1024;
const MAX_PROJECT_BODY = 12 * 1024 * 1024;
const COOKIE = 'ps_session';
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const PROJECT_ID = /^[A-Za-z0-9_-]{6,64}$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.pxa': 'text/plain; charset=utf-8', '.pxs': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.zip': 'application/zip', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const fail = (code, message, status) => new CloudError(code, message, status);
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function sendJson(response, status, value, headers = {}) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(value));
}

async function readBody(request, limit) {
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > limit) throw fail('BODY_TOO_LARGE', 'This request is too large.', 413);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw fail('BODY_TOO_LARGE', 'This request is too large.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request, limit = 64 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw fail('INVALID_CONTENT_TYPE', 'Send this request as JSON.', 415);
  const raw = await readBody(request, limit);
  try {
    const body = JSON.parse(raw.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch { throw fail('INVALID_JSON', 'The request could not be read. Refresh Pixel Studio and try again.', 400); }
}

function cookies(request) {
  const out = {};
  for (const part of String(request.headers.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

/** Fixed-window counters per key; enough for one instance (use a shared store when running several). */
export function createRateLimiter({ now = () => Date.now() } = {}) {
  const windows = new Map();
  return (key, limit, windowMs) => {
    const at = now(), entry = windows.get(key);
    if (!entry || entry.reset <= at) { windows.set(key, { count: 1, reset: at + windowMs }); if (windows.size > 50_000) for (const [k, v] of windows) if (v.reset <= at) windows.delete(k); return true; }
    entry.count += 1;
    return entry.count <= limit;
  };
}

const PRO_AI_MESSAGE = 'AI is part of Pixel Studio Pro. Upgrade under Account (top right) to get 1,000 AI credits every month.';

export function createCloudServer({ config, store, mailer, billing, distDirectory = fileURLToPath(new URL('../dist/', import.meta.url)), fetchImpl = globalThis.fetch, log = console.log }) {
  const origin = new URL(config.publicUrl).origin;
  const secureCookie = config.publicUrl.startsWith('https://');
  const allow = createRateLimiter();
  const busyUsers = new Set();
  const controllers = new Set();
  let distRoot, indexHtml, landingHtml, closing = false;

  const clientIp = request => (config.trustProxy && String(request.headers['x-forwarded-for'] || '').split(',')[0].trim()) || request.socket.remoteAddress || 'unknown';
  const sessionCookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;

  function checkSameOrigin(request) {
    const sent = request.headers.origin;
    if (!sent || sent !== origin) throw fail('INVALID_ORIGIN', 'This request must come from Pixel Studio.', 403);
    const site = request.headers['sec-fetch-site'];
    if (site && !['same-origin', 'none'].includes(site)) throw fail('INVALID_ORIGIN', 'This request must come from Pixel Studio.', 403);
  }
  const current = request => store.session(cookies(request)[COOKIE]);
  function requireUser(request, { csrf = true } = {}) {
    const session = current(request);
    if (!session) throw fail('SIGN_IN_REQUIRED', 'Sign in to Pixel Studio Cloud first (Account, top right).', 401);
    if (csrf) {
      checkSameOrigin(request);
      if (!sameText(request.headers['x-pixel-studio-token'], session.csrf)) throw fail('INVALID_TOKEN', 'Your session changed. Refresh the page and try again.', 403);
    }
    return session;
  }

  const credits = user => ({ allowance: Math.max(0, user.allowance), purchased: user.purchased, balance: creditBalance(user), monthly: planFor(user.plan).monthlyCredits });
  function accountJson(session) {
    const base = { cloud: true, billing: billing.enabled, plans: PLANS, packs: CREDIT_PACKS, currency: CURRENCY, supportEmail: config.supportEmail || null };
    if (!session) return { ...base, signedIn: false };
    const { user } = session, monthStart = Date.parse(`${user.allowancePeriod}-01T00:00:00Z`);
    return {
      ...base, signedIn: true, email: user.email, plan: user.plan, credits: credits(user), csrfToken: session.csrf,
      subscription: store.subscriptions(user.id)[0] || null, canManageBilling: !!user.portalUrl,
      usage: store.usageSince(user.id, monthStart), projects: store.listProjects(user.id).length,
    };
  }

  // ---------- account ----------
  async function login(request, response) {
    checkSameOrigin(request);
    const { email: raw } = await readJson(request, 4096);
    const email = String(raw || '').trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) throw fail('INVALID_EMAIL', 'Enter a valid email address.', 400);
    if (!allow(`login-ip:${clientIp(request)}`, 10, 15 * 60_000) || store.recentLoginTokens(email, 15 * 60_000) >= 3) {
      throw fail('TOO_MANY_REQUESTS', 'Too many sign-in emails. Wait a few minutes, then try again.', 429);
    }
    const token = store.createLoginToken(email);
    const link = `${config.publicUrl}/api/account/verify?token=${encodeURIComponent(token)}`;
    await mailer.sendSignIn(email, link);
    // Development without an email provider: nothing is sent, so hand the link to the browser instead.
    sendJson(response, 200, { sent: true, ...(!config.production && !config.resendApiKey ? { devLink: link } : {}) });
  }
  // GET shows a confirm button; only the POST consumes the token, so link scanners in mail clients cannot use it up.
  function verifyPage(url, response) {
    const token = url.searchParams.get('token') || '';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Pixel Studio</title>
<style>body{font:16px system-ui,sans-serif;background:#16141f;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#221f2e;padding:32px;border-radius:14px;max-width:360px;text-align:center}button{font:inherit;background:#7c5cff;color:#fff;border:0;border-radius:8px;padding:10px 22px;cursor:pointer}</style></head>
<body><main><h1>Pixel Studio</h1><p>Continue to sign in on this device.</p><form method="post" action="/api/account/verify"><input type="hidden" name="token" value="${escapeHTML(token)}"><button type="submit">Sign in</button></form></main></body></html>`);
  }
  async function verify(request, response) {
    const site = request.headers['sec-fetch-site'];
    if ((request.headers.origin && request.headers.origin !== origin) || (site && !['same-origin', 'none'].includes(site))) throw fail('INVALID_ORIGIN', 'Open the link from your email again.', 403);
    if (!/^application\/x-www-form-urlencoded/i.test(request.headers['content-type'] || '')) throw fail('INVALID_CONTENT_TYPE', 'Open the link from your email again.', 415);
    const token = new URLSearchParams((await readBody(request, 4096)).toString('utf8')).get('token') || '';
    const user = token && store.consumeLoginToken(token);
    if (!user) {
      response.writeHead(303, { Location: '/app?signin=expired' });
      response.end();
      return;
    }
    const session = store.createSession(user.id);
    response.writeHead(303, { Location: '/app?signin=ok', 'Set-Cookie': sessionCookie(session.token, 30 * 86_400) });
    response.end();
  }
  async function logout(request, response) {
    checkSameOrigin(request);
    const token = cookies(request)[COOKIE];
    if (token) store.deleteSession(token);
    sendJson(response, 200, { signedIn: false }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  async function deleteAccount(request, response) {
    const { user } = requireUser(request);
    const { confirm } = await readJson(request, 1024);
    if (confirm !== user.email) throw fail('CONFIRM_EMAIL', 'Type your email address to confirm.', 400);
    if (store.subscriptions(user.id).some(s => ['active', 'on_trial', 'past_due', 'paused'].includes(s.status))) throw fail('CANCEL_FIRST', 'Cancel your Pro subscription under Billing first, then delete the account.', 409);
    store.deleteUser(user.id);
    sendJson(response, 200, { deleted: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  function exportAccount(request, response) {
    const { user } = requireUser(request, { csrf: false });
    const projects = store.listProjects(user.id).map(p => store.getProject(user.id, p.id));
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="pixel-studio-account.json"' });
    response.end(JSON.stringify({ email: user.email, createdAt: new Date(user.createdAt).toISOString(), plan: user.plan, credits: credits(user), subscriptions: store.subscriptions(user.id), usage: store.usageSince(user.id, 0), projects }, null, 2));
  }

  // ---------- AI (same contracts as Pixel Studio Local) ----------
  function requirePro(user, feature) {
    if (!planAllows(user.plan, feature)) throw fail('PRO_REQUIRED', feature === 'ai' ? PRO_AI_MESSAGE : 'This is part of Pixel Studio Pro. Upgrade under Account (top right).', 402);
  }
  function aiStatus(request, response, kind) {
    const session = current(request);
    const base = { local: true, cloud: true, busy: !!session && busyUsers.has(session.user.id) };
    if (kind === 'image') {
      const keys = { openai: config.openaiApiKey, gemini: config.geminiApiKey };
      const pro = !!session && planAllows(session.user.plan, 'ai');
      const providers = Object.fromEntries(Object.entries(IMAGE_PROVIDERS).map(([id, p]) => [id, { label: p.label, available: pro && !!keys[id], models: p.models, defaultModel: p.defaultModel }]));
      return sendJson(response, 200, { ...base, providers, csrfToken: session?.csrf || '', signedIn: !!session, proRequired: !!session && !pro, credits: session ? credits(session.user) : null });
    }
    if (!session) return sendJson(response, 200, { ...base, connected: false, authMode: null, models: [], code: 'SIGN_IN_REQUIRED', message: 'Sign in to Pixel Studio Cloud (Account, top right) to use AI with your monthly credits.' });
    const accountLabel = `Pixel Studio Cloud · ${planFor(session.user.plan).name}`;
    if (!planAllows(session.user.plan, 'ai')) return sendJson(response, 200, { ...base, connected: false, authMode: null, models: [], accountLabel, credits: credits(session.user), code: 'PRO_REQUIRED', message: PRO_AI_MESSAGE });
    if (!config.openaiApiKey) return sendJson(response, 200, { ...base, connected: false, authMode: null, models: [], accountLabel: `Pixel Studio Cloud · ${planFor(session.user.plan).name}`, credits: credits(session.user), code: 'AI_NOT_CONFIGURED', message: 'AI is not set up on this server yet.' });
    sendJson(response, 200, { ...base, connected: true, authMode: 'cloud', accountLabel: `Pixel Studio Cloud · ${planFor(session.user.plan).name}`, models: chatModels(), csrfToken: session.csrf, credits: credits(session.user) });
  }
  function reserve(userId) {
    if (busyUsers.has(userId)) throw fail('BUSY', 'Another AI request is running. Wait for it to finish.', 409);
    if (!allow(`ai:${userId}`, 60, 60 * 60_000)) throw fail('TOO_MANY_REQUESTS', 'You have sent many AI requests in the last hour. Take a short break and try again.', 429);
    busyUsers.add(userId);
    return () => busyUsers.delete(userId);
  }
  function abortOnClose(request, response) {
    const controller = new AbortController();
    controllers.add(controller);
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    request.once('aborted', cancel);
    response.once('close', cancel);
    return { controller, done: () => { controllers.delete(controller); request.removeListener('aborted', cancel); response.removeListener('close', cancel); } };
  }

  async function aiEdit(request, response) {
    const { user } = requireUser(request);
    requirePro(user, 'ai');
    store.requireCredits(user.id, MIN_CHAT_CREDITS);
    const release = reserve(user.id);
    const { controller, done } = abortOnClose(request, response);
    try {
      const body = await readJson(request, MAX_EDIT_BODY);
      if (Object.keys(body).some(key => !['prompt', 'model', 'previews'].includes(key))) throw fail('INVALID_REQUEST', 'This endpoint accepts a Pixel Studio prompt, model and optional PNG previews.', 400);
      if (!isPixelPrompt(body.prompt)) throw fail('INVALID_PROMPT', 'Use a Pixel Studio edit prompt of at most 2 MB.', 400);
      const model = body.model ?? DEFAULT_CHAT_MODEL;
      if (!CHAT_MODELS[model]) throw fail('INVALID_MODEL', 'Choose one of the listed models.', 400);
      const previews = body.previews ?? [];
      try { readPreviewImages(previews); } catch { throw fail('INVALID_PREVIEW', 'Use up to two PNG previews of at most 1 MiB and 1024 × 1024 pixels each.', 400); }
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
      response.flushHeaders();
      const send = event => {
        if (response.destroyed || response.writableEnded) return;
        if (response.writableLength > 1024 * 1024) { controller.abort(); return; }
        response.write(`${JSON.stringify(event)}\n`);
      };
      send({ type: 'status', message: 'Thinking…' });
      let result;
      try {
        result = await chatEdit({ key: config.openaiApiKey, prompt: body.prompt, model, previews, signal: controller.signal, onEvent: send, fetchImpl });
      } catch (error) {
        const partial = error.partial;
        if (partial?.text) store.charge(user.id, { kind: 'chat', model, inputTokens: partial.inputTokens, outputTokens: partial.outputTokens, credits: chatCredits(model, partial.inputTokens, partial.outputTokens) });
        throw error;
      }
      const charged = chatCredits(model, result.inputTokens, result.outputTokens);
      const after = store.charge(user.id, { kind: 'chat', model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, credits: charged });
      send({ type: 'done', text: result.text, model, credits: { used: charged, balance: creditBalance(after) } });
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      const safe = error instanceof CloudError ? error : fail('AI_UNAVAILABLE', 'The AI request failed. Try again.', 502);
      if (response.headersSent) response.write(`${JSON.stringify({ type: 'error', code: safe.code, error: safe.message })}\n`);
      else throw safe;
    } finally {
      release(); done();
      if (!response.destroyed && response.headersSent && !response.writableEnded) response.end();
    }
  }

  async function imageGenerate(request, response) {
    const { user } = requireUser(request);
    requirePro(user, 'ai');
    const release = reserve(user.id);
    const { controller, done } = abortOnClose(request, response);
    try {
      const body = validateImageRequest(await readJson(request, MAX_IMAGE_BODY_BYTES));
      const cost = imageCredits(body.provider, { n: body.n, quality: body.quality || 'medium' });
      store.requireCredits(user.id, cost);
      const { images } = await generateImages({ ...body, keys: { openai: config.openaiApiKey, gemini: config.geminiApiKey }, signal: controller.signal, fetchImpl });
      const after = store.charge(user.id, { kind: 'image', model: `${body.provider}/${body.model}`, credits: cost });
      if (!controller.signal.aborted) sendJson(response, 200, { images, provider: body.provider, model: body.model, credits: { used: cost, balance: creditBalance(after) } });
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    } finally { release(); done(); }
  }

  // ---------- cloud projects ----------
  async function projects(request, response, id) {
    if (id === null) {
      if (request.method !== 'GET') throw fail('METHOD_NOT_ALLOWED', 'Use GET to list projects.', 405);
      const { user } = requireUser(request, { csrf: false });
      const plan = planFor(user.plan);
      return sendJson(response, 200, { projects: store.listProjects(user.id), limit: plan.cloudProjects, maxBytes: plan.projectBytes });
    }
    if (!PROJECT_ID.test(id)) throw fail('NOT_FOUND', 'Project not found.', 404);
    if (request.method === 'GET') {
      const { user } = requireUser(request, { csrf: false });
      const project = store.getProject(user.id, id);
      if (!project) throw fail('NOT_FOUND', 'Project not found.', 404);
      return sendJson(response, 200, project);
    }
    if (request.method === 'PUT') {
      const { user } = requireUser(request);
      const body = await readJson(request, MAX_PROJECT_BODY);
      const name = String(body.name || '').trim().slice(0, 80) || 'Untitled';
      if (typeof body.data !== 'string' || !body.data.startsWith('{')) throw fail('INVALID_PROJECT', 'Send the project as Pixel Studio project data.', 400);
      return sendJson(response, 200, store.saveProject(user.id, { id, name, data: body.data }));
    }
    if (request.method === 'DELETE') {
      const { user } = requireUser(request);
      if (!store.deleteProject(user.id, id)) throw fail('NOT_FOUND', 'Project not found.', 404);
      return sendJson(response, 200, { deleted: true });
    }
    throw fail('METHOD_NOT_ALLOWED', 'Unsupported method.', 405);
  }

  // ---------- billing ----------
  async function checkout(request, response) {
    const { user } = requireUser(request);
    const { product } = await readJson(request, 1024);
    if (String(product).startsWith('credits-')) requirePro(user, 'creditPacks');
    sendJson(response, 200, { url: await billing.checkout(user, String(product || '')) });
  }
  async function webhook(request, response) {
    const raw = await readBody(request, 1024 * 1024);
    if (!verifySignature(raw, request.headers['x-signature'], config.lsWebhookSecret)) throw fail('INVALID_SIGNATURE', 'Invalid signature.', 401);
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { throw fail('INVALID_JSON', 'Invalid JSON.', 400); }
    log(`[billing] ${billing.handleEvent(payload)}`);
    sendJson(response, 200, { ok: true });
  }

  // ---------- static ----------
  async function staticFile(pathname, request, response) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { throw fail('NOT_FOUND', 'File not found.', 404); }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) throw fail('NOT_FOUND', 'File not found.', 404);
    // The marketing page lives at /, the editor at /app (its relative asset URLs still resolve from the root).
    const page = decoded === '/app' ? indexHtml : decoded === '/' ? landingHtml : null;
    if (page) {
      response.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
      return response.end(request.method === 'HEAD' ? undefined : page);
    }
    if (['/', '/app/', '/index.html', '/landing.html'].includes(decoded)) {
      response.writeHead(301, { Location: decoded === '/landing.html' ? '/' : `/app${request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''}` });
      return response.end();
    }
    const requested = resolve(distRoot, `.${decoded}`);
    if (!requested.startsWith(distRoot + sep)) throw fail('NOT_FOUND', 'File not found.', 404);
    let path;
    try { path = await realpath(requested); } catch { throw fail('NOT_FOUND', 'File not found.', 404); }
    if (!path.startsWith(distRoot + sep)) throw fail('NOT_FOUND', 'File not found.', 404);
    const details = await stat(path);
    if (!details.isFile()) throw fail('NOT_FOUND', 'File not found.', 404);
    response.writeHead(200, { 'Content-Type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream', 'Content-Length': details.size, 'Cache-Control': 'no-cache' });
    if (request.method === 'HEAD') response.end();
    else response.end(await readFile(path));
  }

  const routes = {
    'GET /healthz': (_q, r) => sendJson(r, 200, { ok: true }),
    'GET /api/account/me': (q, r) => sendJson(r, 200, accountJson(current(q))),
    'POST /api/account/login': login,
    'GET /api/account/verify': (q, r, url) => verifyPage(url, r),
    'POST /api/account/verify': verify,
    'POST /api/account/logout': logout,
    'POST /api/account/delete': deleteAccount,
    'GET /api/account/export': exportAccount,
    'GET /api/local-ai/status': (q, r) => aiStatus(q, r, 'chat'),
    'POST /api/local-ai/edit': aiEdit,
    'GET /api/image/status': (q, r) => aiStatus(q, r, 'image'),
    'POST /api/image/generate': imageGenerate,
    'POST /api/billing/checkout': checkout,
    'GET /api/billing/portal': (q, r) => sendJson(r, 200, { url: billing.portal(requireUser(q, { csrf: false }).user) }),
    'POST /api/billing/webhook': webhook,
  };

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', CSP);
    if (secureCookie) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    try {
      if (closing) throw fail('SHUTTING_DOWN', 'Pixel Studio is restarting. Try again in a moment.', 503);
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw fail('INVALID_REQUEST', 'Invalid request.', 400);
      const url = new URL(request.url, origin);
      const route = routes[`${request.method} ${url.pathname}`];
      if (route) return await route(request, response, url);
      const project = /^\/api\/cloud\/projects(?:\/([^/]+))?$/.exec(url.pathname);
      if (project) return await projects(request, response, project[1] ?? null);
      if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') throw fail(Object.keys(routes).some(key => key.endsWith(` ${url.pathname}`)) ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', 'Unknown endpoint.', Object.keys(routes).some(key => key.endsWith(` ${url.pathname}`)) ? 405 : 404);
      if (!['GET', 'HEAD'].includes(request.method)) throw fail('METHOD_NOT_ALLOWED', 'Use GET to open Pixel Studio.', 405);
      await staticFile(url.pathname, request, response);
    } catch (error) {
      // LocalAIError comes from the request validators shared with Pixel Studio Local.
      const safe = error instanceof CloudError || error?.name === 'LocalAIError' ? error : (log('[error]', error), fail('SERVER_ERROR', 'Something went wrong. Try again.', 500));
      sendJson(response, safe.status === 499 ? 400 : safe.status, { error: safe.message, code: safe.code });
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    async listen(port = config.port, host = config.host) {
      distRoot = await realpath(distDirectory);
      // The editor detects the hosted edition from this tag (CSP forbids inline scripts).
      indexHtml = (await readFile(resolve(distRoot, 'index.html'), 'utf8')).replace('<head>', '<head>\n  <meta name="pixel-studio-cloud" content="1">');
      landingHtml = await readFile(resolve(distRoot, 'landing.html'), 'utf8').then(html => renderLanding(html, config), () => null);
      await new Promise((ok, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); ok(); }); });
      return `http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}/`;
    },
    async close() {
      if (closing) return;
      closing = true;
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise(done => server.close(done));
    },
  };
}
