import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { chatCredits, refreshCredits, spendCredits, creditBalance, subscriptionGrantsPro, imageCredits } from '../src/features/cloud/plans.js';
import { openStore } from '../cloud/store.mjs';
import { createBilling } from '../cloud/billing.mjs';
import { createCloudServer } from '../cloud/server.mjs';
import { createMailer } from '../cloud/mailer.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==';
const SECRET = 'whsec_test';

test('credits refill monthly, spend the allowance first and price tokens and images', () => {
  const nov = Date.parse('2026-11-08T12:00:00Z'), dec = Date.parse('2026-12-01T00:00:01Z');
  assert.equal(refreshCredits({ plan: 'free', allowance: 0, allowancePeriod: '', purchased: 0 }, nov).allowance, 0, 'Free has no AI credits');
  let user = refreshCredits({ plan: 'pro', allowance: 0, allowancePeriod: '', purchased: 5 }, nov);
  assert.equal(user.allowance, 1000);
  user = spendCredits(user, 1003);
  assert.deepEqual([user.allowance, user.purchased, creditBalance(user)], [0, 2, 2]);
  assert.equal(refreshCredits(user, nov).allowance, 0, 'same month: no refill');
  assert.equal(refreshCredits(user, dec).allowance, 1000);
  assert.equal(creditBalance(spendCredits(user, 10)), -8, 'an overdraft comes out of purchased credits');
  assert.equal(chatCredits('gpt-5-mini', 0, 0), 1);
  assert.equal(chatCredits('gpt-5-mini', 20_000, 5_000), 8); // $0.005 + $0.01 = $0.015 → 7.5 → 8
  assert.equal(chatCredits('gpt-5', 20_000, 5_000), 38);
  assert.equal(imageCredits('openai', { n: 2, quality: 'low' }), 12);
  assert.ok(subscriptionGrantsPro({ status: 'active', endsAt: '2026-12-01T00:00:00Z' }, nov), 'cancelled at period end: Pro until then');
  assert.ok(!subscriptionGrantsPro({ status: 'active', endsAt: '2026-11-01T00:00:00Z' }, nov));
  assert.ok(!subscriptionGrantsPro({ status: 'canceled' }, nov));
});

async function setup(t, { now = () => Date.now() } = {}) {
  const dist = await mkdtemp(join(tmpdir(), 'ps-cloud-'));
  await writeFile(join(dist, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
  await writeFile(join(dist, 'app.js'), 'export {};');
  await writeFile(join(dist, 'landing.html'), '<!doctype html><html><head><title>Pixel Studio</title></head><body><!--pricing--><!--support--></body></html>');
  const mails = [], upstream = [];
  const config = {
    publicUrl: 'http://placeholder', openaiApiKey: 'sk-server', geminiApiKey: '', stripeSecretKey: 'sk_test_stripe', stripeWebhookSecret: SECRET,
    stripePriceProMonthly: 'price_pm', stripePriceProYearly: 'price_py', stripePriceCredits1000: 'price_c1000', stripeManagedPayments: true,
    aiKeySecret: 'test-ai-key-secret', supportEmail: 'help@example.com',
  };
  let openaiReply = { text: '{"reply":"Hi!"}', usage: { prompt_tokens: 20_000, completion_tokens: 5_000 } };
  const sessions = new Map();
  const fetchImpl = async (url, init) => {
    upstream.push({ url: String(url), init });
    const path = String(url).replace(/\?.*$/, '');
    if (path.endsWith('/v1/models') || path.endsWith('/v1beta/models')) {
      const key = init.headers.Authorization?.slice(7) || init.headers['x-goog-api-key'];
      return Response.json({}, { status: /bad/.test(key) ? 401 : 200 });
    }
    if (path === 'https://api.stripe.com/v1/checkout/sessions') return Response.json({ id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' });
    if (path === 'https://api.stripe.com/v1/billing_portal/sessions') return Response.json({ url: 'https://billing.stripe.com/p/session/abc' });
    if (path.startsWith('https://api.stripe.com/v1/checkout/sessions/')) {
      const found = sessions.get(path.split('/').at(-1));
      return found ? Response.json(found) : Response.json({ error: { message: 'No such checkout.session' } }, { status: 404 });
    }
    if (String(url).endsWith('/chat/completions')) {
      const chunks = [...openaiReply.text.match(/.{1,5}/gs)].map(text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      chunks.push(`data: ${JSON.stringify({ choices: [], usage: openaiReply.usage })}\n\ndata: [DONE]\n\n`);
      return new Response(new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (String(url).endsWith('/images/generations')) return Response.json({ data: [{ b64_json: PNG }] });
    throw new Error(`unexpected ${url}`);
  };
  const store = openStore(':memory:', { now });
  const billing = createBilling({ config, store, fetchImpl });
  const mailer = { async sendSignIn(email, link) { mails.push({ email, link }); } };
  // The public URL is only known after listen; the server reads config.publicUrl at creation, so create on a fixed port.
  const probe = createCloudServer({ config, store, mailer, billing, distDirectory: dist, fetchImpl, log: () => {} });
  const tmpUrl = await probe.listen(0, '127.0.0.1');
  const port = new URL(tmpUrl).port;
  await probe.close();
  const cfg = { ...config, publicUrl: `http://127.0.0.1:${port}` };
  const cloud = createCloudServer({ config: cfg, store, mailer, billing: createBilling({ config: cfg, store, fetchImpl }), distDirectory: dist, fetchImpl, log: () => {} });
  const base = await cloud.listen(Number(port), '127.0.0.1');
  t.after(async () => { await cloud.close(); store.close(); await rm(dist, { recursive: true, force: true }); });
  const origin = base.replace(/\/$/, '');
  let cookie = '';
  const call = async (path, { method = 'GET', body, headers = {}, raw } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method, redirect: 'manual',
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return response;
  };
  async function signIn(email = 'Ada@Example.com') {
    assert.equal((await call('/api/account/login', { method: 'POST', body: { email } })).status, 200);
    const link = new URL(mails.at(-1).link);
    const page = await call(`${link.pathname}${link.search}`);
    assert.match(await page.text(), /<form method="post"/);
    const done = await call('/api/account/verify', { method: 'POST', raw: `token=${encodeURIComponent(link.searchParams.get('token'))}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(done.status, 303);
    assert.equal(done.headers.get('location'), '/app?signin=ok');
    const me = await (await call('/api/account/me')).json();
    return { me, token: link.searchParams.get('token') };
  }
  const signWebhook = (payload, at = Math.floor(Date.now() / 1000)) => {
    const raw = JSON.stringify(payload);
    return { raw, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${at},v1=${createHmac('sha256', SECRET).update(`${at}.${raw}`).digest('hex')}` } };
  };
  const subscription = (userId, status, extra = {}) => ({ id: `sub_${userId.slice(0, 8)}`, object: 'subscription', status, customer: 'cus_9', metadata: { user_id: userId }, items: { data: [{ price: { id: 'price_pm' }, current_period_end: 4_102_444_800 }] }, ...extra });
  async function goPro(email = 'ada@example.com') {
    const hook = signWebhook({ id: `evt_${email}`, type: 'customer.subscription.created', created: Math.floor(Date.now() / 1000), data: { object: subscription(store.userByEmail(email).id, 'active') } });
    assert.equal((await call('/api/billing/webhook', { method: 'POST', raw: hook.raw, headers: hook.headers })).status, 200);
  }
  return { call, signIn, goPro, mails, upstream, store, origin, signWebhook, subscription, sessions, setReply: reply => { openaiReply = reply; }, clearCookie: () => { cookie = ''; } };
}

test('email sign-in: confirm page, single-use token, session cookie, marker tag and sign-out', async t => {
  const s = await setup(t);
  const html = await (await s.call('/app')).text();
  assert.match(html, /<meta name="pixel-studio-cloud" content="1">/);
  const landing = await (await s.call('/')).text();
  assert.doesNotMatch(landing, /pixel-studio-cloud/, 'the marketing page is not the editor');
  assert.match(landing, /€8<small>\/month<\/small>/, 'pricing comes from the shared plan table');
  assert.match(landing, /href="\.\/app\?upgrade=pro"/);
  assert.match(landing, /mailto:help@example\.com/);
  const legacy = await s.call('/index.html?x=1');
  assert.equal(legacy.status, 301);
  assert.equal(legacy.headers.get('location'), '/app?x=1');
  assert.equal((await s.call('/api/account/login', { method: 'POST', body: { email: 'not-an-email' } })).status, 400);
  const dev = await (await s.call('/api/account/login', { method: 'POST', body: { email: 'dev@example.com' } })).json();
  assert.equal(dev.devLink, s.mails.at(-1).link, 'without an email provider in development the link is returned');
  assert.equal((await s.call('/api/account/login', { method: 'POST', body: { email: 'a@b.co' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  const { me, token } = await s.signIn();
  assert.equal(me.signedIn, true);
  assert.equal(me.email, 'ada@example.com');
  assert.equal(me.plan, 'free');
  assert.deepEqual(me.credits, { allowance: 0, purchased: 0, balance: 0, monthly: 0 });
  s.clearCookie();
  const reuse = await s.call('/api/account/verify', { method: 'POST', raw: `token=${token}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(reuse.headers.get('location'), '/app?signin=expired');
  await s.signIn('ada@example.com');
  assert.equal((await s.call('/api/account/logout', { method: 'POST' })).status, 200);
  assert.equal((await (await s.call('/api/account/me')).json()).signedIn, false);
});

test('hosted AI streams like Pixel Studio Local, needs the CSRF token and charges credits by tokens', async t => {
  const s = await setup(t);
  assert.equal((await (await s.call('/api/local-ai/status')).json()).connected, false);
  const { me } = await s.signIn();
  const free = await (await s.call('/api/local-ai/status')).json();
  assert.equal(free.code, 'PRO_REQUIRED');
  const freeEdit = await s.call('/api/local-ai/edit', { method: 'POST', body: { prompt: 'PXACHAT 1\nHi' }, headers: { 'X-Pixel-Studio-Token': me.csrfToken } });
  assert.equal(freeEdit.status, 402, 'AI is Pro only');
  assert.equal(s.upstream.length, 0);
  await s.goPro();
  const status = await (await s.call('/api/local-ai/status')).json();
  assert.equal(status.local, true);
  assert.equal(status.authMode, 'cloud');
  assert.ok(status.models.some(m => m.id === 'gpt-5-mini'));
  const prompt = 'PXACHAT 1\nHello';
  assert.equal((await s.call('/api/local-ai/edit', { method: 'POST', body: { prompt } })).status, 403, 'missing CSRF token');
  const headers = { 'X-Pixel-Studio-Token': status.csrfToken };
  const response = await s.call('/api/local-ai/edit', { method: 'POST', body: { prompt }, headers });
  assert.match(response.headers.get('content-type'), /ndjson/);
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), '{"reply":"Hi!"}');
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.deepEqual(done.credits, { used: 8, balance: 992 });
  const sent = JSON.parse(s.upstream.at(-1).init.body);
  assert.equal(s.upstream.at(-1).init.headers.Authorization, 'Bearer sk-server');
  assert.match(sent.messages[0].content, /Pixel Studio assistant/);
  // Spend the rest: 992 → 0 with an expensive reply, then the next request is refused before any upstream call.
  s.setReply({ text: '{"reply":"x"}', usage: { prompt_tokens: 0, completion_tokens: 992_000 } });
  await (await s.call('/api/local-ai/edit', { method: 'POST', body: { prompt }, headers })).text();
  const calls = s.upstream.length;
  const refused = await s.call('/api/local-ai/edit', { method: 'POST', body: { prompt }, headers });
  assert.equal(refused.status, 402);
  assert.equal((await refused.json()).code, 'NO_CREDITS');
  assert.equal(s.upstream.length, calls);
});

test('image generation charges fixed credits per image', async t => {
  const s = await setup(t);
  await s.signIn();
  const free = await (await s.call('/api/image/status')).json();
  assert.equal(free.proRequired, true);
  assert.equal(free.providers.openai.available, false);
  assert.equal((await s.call('/api/image/generate', { method: 'POST', body: { provider: 'openai', prompt: 'a cat' }, headers: { 'X-Pixel-Studio-Token': free.csrfToken } })).status, 402);
  await s.goPro();
  const status = await (await s.call('/api/image/status')).json();
  assert.equal(status.providers.openai.available, true);
  assert.equal(status.providers.gemini.available, false);
  const response = await s.call('/api/image/generate', { method: 'POST', body: { provider: 'openai', prompt: 'a cat', quality: 'medium' }, headers: { 'X-Pixel-Studio-Token': status.csrfToken } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.images, [PNG]);
  assert.deepEqual(body.credits, { used: 21, balance: 979 });
});

test('Stripe: checkout carries the user, signed webhooks switch plans and add credit packs once', async t => {
  const s = await setup(t);
  const { me } = await s.signIn();
  const headers = { 'X-Pixel-Studio-Token': me.csrfToken };
  assert.equal((await s.call('/api/billing/checkout', { method: 'POST', body: { product: 'credits-1000' }, headers })).status, 402, 'credit packs are for Pro');
  const checkout = await (await s.call('/api/billing/checkout', { method: 'POST', body: { product: 'pro-monthly' }, headers })).json();
  assert.equal(checkout.url, 'https://checkout.stripe.com/c/pay/cs_test_new');
  const sent = new URLSearchParams(s.upstream.at(-1).init.body);
  assert.equal(sent.get('line_items[0][price]'), 'price_pm');
  assert.equal(sent.get('mode'), 'subscription');
  assert.equal(sent.get('managed_payments[enabled]'), 'true');
  assert.match(sent.get('success_url'), /\/app\?billing=done&session_id=\{CHECKOUT_SESSION_ID\}$/);
  const userId = sent.get('client_reference_id');
  assert.equal(sent.get('subscription_data[metadata][user_id]'), userId);

  const bad = s.signWebhook({});
  assert.equal((await s.call('/api/billing/webhook', { method: 'POST', raw: bad.raw, headers: { ...bad.headers, 'Stripe-Signature': `t=1,v1=${'0'.repeat(64)}` } })).status, 401);
  const old = s.signWebhook({ type: 'customer.subscription.updated', data: { object: s.subscription(userId, 'active') } }, Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await s.call('/api/billing/webhook', { method: 'POST', raw: old.raw, headers: old.headers })).status, 401, 'replayed (old) signatures are refused');
  const event = (type, created, object) => s.signWebhook({ id: `evt_${created}`, type, created, data: { object } });
  const deliver = async hook => assert.equal((await s.call('/api/billing/webhook', { method: 'POST', raw: hook.raw, headers: hook.headers })).status, 200);
  await deliver(event('customer.subscription.updated', 1000, s.subscription(userId, 'active')));
  let account = await (await s.call('/api/account/me')).json();
  assert.equal(account.plan, 'pro');
  assert.equal(account.credits.allowance, 1000, 'upgrading tops up this month');
  assert.equal(account.canManageBilling, true);
  assert.equal((await (await s.call('/api/billing/portal')).json()).url, 'https://billing.stripe.com/p/session/abc');
  await deliver(event('customer.subscription.deleted', 900, s.subscription(userId, 'canceled')));
  assert.equal((await (await s.call('/api/account/me')).json()).plan, 'pro', 'an older, late delivery is ignored');
  await deliver(event('customer.subscription.updated', 1100, s.subscription(userId, 'active', { cancel_at_period_end: true })));
  account = await (await s.call('/api/account/me')).json();
  assert.equal(account.plan, 'pro', 'cancelled keeps Pro until the period ends');
  assert.ok(account.subscription.endsAt);
  await deliver(event('customer.subscription.deleted', 1200, s.subscription(userId, 'canceled')));
  account = await (await s.call('/api/account/me')).json();
  assert.equal(account.plan, 'free');
  assert.equal(account.credits.allowance, 0);

  const order = event('checkout.session.completed', 1300, { id: 'cs_test_pack', object: 'checkout.session', mode: 'payment', payment_status: 'paid', customer: 'cus_9', client_reference_id: userId, metadata: { user_id: userId, product: 'credits-1000' } });
  await deliver(order);
  await deliver(order);
  assert.equal((await (await s.call('/api/account/me')).json()).credits.purchased, 1000, 'retried deliveries count once');
});

test('returning from checkout confirms the purchase without waiting for the webhook', async t => {
  const s = await setup(t);
  const { me } = await s.signIn();
  const headers = { 'X-Pixel-Studio-Token': me.csrfToken };
  const confirm = sessionId => s.call('/api/billing/confirm', { method: 'POST', body: { sessionId }, headers });
  assert.equal((await confirm('not-a-session')).status, 400);
  assert.equal((await confirm('cs_test_unknown123456')).status, 404);
  const userId = s.store.userByEmail('ada@example.com').id;
  s.sessions.set('cs_test_someoneelse1', { id: 'cs_test_someoneelse1', status: 'complete', mode: 'subscription', client_reference_id: 'another-user', subscription: s.subscription('another-user', 'active') });
  assert.equal((await confirm('cs_test_someoneelse1')).status, 404, 'a checkout of another user is not applied');
  s.sessions.set('cs_test_open00000001', { id: 'cs_test_open00000001', status: 'open', mode: 'subscription', client_reference_id: userId, metadata: { product: 'pro-monthly' } });
  assert.deepEqual(await (await confirm('cs_test_open00000001')).json(), { state: 'pending', product: 'pro-monthly' });
  s.sessions.set('cs_test_paid00000001', { id: 'cs_test_paid00000001', status: 'complete', mode: 'subscription', customer: 'cus_9', client_reference_id: userId, metadata: { user_id: userId, product: 'pro-monthly' }, subscription: { ...s.subscription(userId, 'active'), metadata: {} } });
  assert.deepEqual(await (await confirm('cs_test_paid00000001')).json(), { state: 'complete', product: 'pro-monthly' });
  assert.ok(s.upstream.at(-1).url.includes('expand%5B0%5D=subscription'));
  let account = await (await s.call('/api/account/me')).json();
  assert.equal(account.plan, 'pro');
  assert.equal(account.canManageBilling, true);
  s.sessions.set('cs_test_pack00000001', { id: 'cs_test_pack00000001', status: 'complete', mode: 'payment', payment_status: 'paid', client_reference_id: userId, metadata: { user_id: userId, product: 'credits-1000' } });
  await confirm('cs_test_pack00000001');
  await confirm('cs_test_pack00000001');
  const pack = s.signWebhook({ type: 'checkout.session.completed', created: 2000, data: { object: s.sessions.get('cs_test_pack00000001') } });
  assert.equal((await s.call('/api/billing/webhook', { method: 'POST', raw: pack.raw, headers: pack.headers })).status, 200);
  account = await (await s.call('/api/account/me')).json();
  assert.equal(account.credits.purchased, 1000, 'confirm and webhook together add the pack once');
});

test('your own AI key: Pro only, checked, stored encrypted, used without credits and shown in usage', async t => {
  const s = await setup(t);
  const { me } = await s.signIn();
  const headers = { 'X-Pixel-Studio-Token': me.csrfToken };
  const save = (provider, key) => s.call('/api/account/ai-key', { method: 'POST', body: { provider, key }, headers });
  assert.equal(me.ownKeys, true);
  assert.equal((await save('openai', 'sk-user-0123456789abcdefghij')).status, 402, 'Pro feature');
  await s.goPro();
  assert.equal((await save('openai', 'not-a-key')).status, 400);
  assert.equal((await (await save('openai', 'sk-bad-0123456789abcdefghijk')).json()).code, 'OWN_KEY_REJECTED');
  const saved = await (await save('openai', 'sk-user-0123456789abcdefghij')).json();
  assert.equal(saved.aiKeys.length, 1);
  assert.equal(saved.aiKeys[0].provider, 'openai');
  assert.doesNotMatch(saved.aiKeys[0].hint, /0123456789abcdef/, 'only a hint is shown');
  const userId = s.store.userByEmail('ada@example.com').id;
  assert.doesNotMatch(s.store.aiKeySecret(userId, 'openai'), /sk-user/, 'stored encrypted');
  assert.doesNotMatch(await (await s.call('/api/account/export')).text(), /sk-user-0123/, 'never exported');

  const status = await (await s.call('/api/local-ai/status')).json();
  assert.equal(status.ownKey, true);
  const before = (await (await s.call('/api/account/me')).json()).credits.balance;
  const events = (await (await s.call('/api/local-ai/edit', { method: 'POST', body: { prompt: 'PXACHAT 1\nHi' }, headers })).text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, 'done');
  assert.equal(s.upstream.at(-1).init.headers.Authorization, 'Bearer sk-user-0123456789abcdefghij');
  assert.equal((await (await s.call('/api/account/me')).json()).credits.balance, before, 'no credits used');
  const image = await s.call('/api/image/generate', { method: 'POST', body: { provider: 'openai', prompt: 'a cat', quality: 'low' }, headers });
  assert.equal((await image.json()).credits.used, 0);

  const stats = await (await s.call('/api/account/usage?days=7')).json();
  assert.equal(stats.days.length, 1, 'one day with requests');
  assert.equal(stats.total.requests, 2);
  assert.equal(stats.total.ownKeyRequests, 2);
  assert.equal(stats.total.credits, 0);
  assert.equal(stats.total.images, 1);
  assert.equal(stats.total.inputTokens, 20_000);
  assert.deepEqual(stats.models.map(m => m.kind).sort(), ['chat', 'image'].sort());

  assert.deepEqual((await (await save('openai', '')).json()).aiKeys, []);
  assert.equal((await (await s.call('/api/local-ai/status')).json()).ownKey, false);
});

test('cloud projects are per user and limited by plan', async t => {
  const s = await setup(t);
  const { me } = await s.signIn();
  const headers = { 'X-Pixel-Studio-Token': me.csrfToken };
  const data = JSON.stringify({ name: 'Cat', animations: [] });
  for (const id of ['proj-aaa1']) assert.equal((await s.call(`/api/cloud/projects/${id}`, { method: 'PUT', body: { name: id, data }, headers })).status, 200);
  const limited = await s.call('/api/cloud/projects/proj-aaa2', { method: 'PUT', body: { name: 'x', data }, headers });
  assert.equal(limited.status, 403);
  assert.match((await limited.json()).error, /Free plan keeps 1 /);
  assert.equal((await s.call('/api/cloud/projects/proj-aaa1', { method: 'PUT', body: { name: 'Renamed', data }, headers })).status, 200, 'overwriting is not a new project');
  const list = await (await s.call('/api/cloud/projects')).json();
  assert.equal(list.projects.length, 1);
  assert.equal(list.limit, 1);
  assert.equal((await (await s.call('/api/cloud/projects/proj-aaa1')).json()).name, 'Renamed');
  await s.signIn('other@example.com');
  assert.equal((await s.call('/api/cloud/projects/proj-aaa1')).status, 404);
  assert.equal((await (await s.call('/api/cloud/projects')).json()).projects.length, 0);
});

test('a refused sign-in email logs the link in development and fails in production', async () => {
  const refused = async () => new Response('{"message":"testing domain restriction"}', { status: 403 });
  const logs = [];
  const dev = createMailer({ config: { resendApiKey: 're_test', mailFrom: 'a@b.c', production: false }, fetchImpl: refused, log: line => logs.push(line) });
  await dev.sendSignIn('me@example.com', 'http://localhost/verify?token=x');
  assert.ok(logs.some(line => line.includes('403') && line.includes('testing domain restriction')));
  assert.ok(logs.some(line => line.includes('http://localhost/verify?token=x')));
  const prod = createMailer({ config: { resendApiKey: 're_test', mailFrom: 'a@b.c', production: true }, fetchImpl: refused, log: () => {} });
  await assert.rejects(prod.sendSignIn('me@example.com', 'https://x/verify'), { code: 'MAIL_FAILED' });
});
