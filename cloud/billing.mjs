// Stripe billing with Managed Payments: Stripe (through Link) is the merchant of record, so it charges customers and
// handles VAT, sales tax, fraud and disputes. Checkouts carry the Pixel Studio user ID as metadata; signed webhooks
// update plans and add credit packs. Zero dependencies: plain fetch and form-encoded requests.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CREDIT_PACKS } from '../src/features/cloud/plans.js';
import { CloudError } from './store.mjs';

const API = 'https://api.stripe.com/v1';
// Managed Payments needs 2025-03-31.basil or later. Subscription periods live on the subscription items since then.
export const STRIPE_API_VERSION = '2025-03-31.basil';
export const WEBHOOK_EVENTS = [
  'checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'charge.refunded',
];
const TOLERANCE_SECONDS = 300;

/** Stripe-Signature is `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`; old timestamps are rejected against replays. */
export function verifySignature(rawBody, header, secret, at = Date.now()) {
  if (!secret || typeof header !== 'string') return false;
  let timestamp = '';
  const signatures = [];
  for (const part of header.split(',')) {
    const [key, value = ''] = part.split('=');
    if (key === 't') timestamp = value;
    else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value)) signatures.push(Buffer.from(value, 'hex'));
  }
  if (!/^\d+$/.test(timestamp) || Math.abs(at / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatures.some(signature => timingSafeEqual(expected, signature));
}

/** Nested objects and arrays → Stripe's form encoding (`line_items[0][price]=…`). */
export function formEncode(value, prefix = '', out = new URLSearchParams()) {
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof item === 'object') formEncode(item, name, out);
    else out.append(name, String(item));
  }
  return out;
}

export async function stripeRequest(secretKey, path, params = {}, { method = 'POST', fetchImpl = globalThis.fetch } = {}) {
  const encoded = formEncode(params).toString(), query = method === 'GET' && encoded ? `?${encoded}` : '';
  const response = await fetchImpl(`${API}${path}${query}`, {
    method, headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': STRIPE_API_VERSION, ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
    ...(method === 'GET' ? {} : { body: formEncode(params).toString() }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Stripe ${method} ${path}: ${response.status} ${body?.error?.message || ''}`.trim());
    error.status = response.status;
    throw error;
  }
  return body;
}

/** Which product a checkout is for → the configured Stripe price ID. */
export function priceFor(config, product) {
  const price = { 'pro-monthly': config.stripePriceProMonthly, 'pro-yearly': config.stripePriceProYearly, 'credits-1000': config.stripePriceCredits1000 }[product];
  if (!price) throw new CloudError('UNKNOWN_PRODUCT', 'This product is not available.', 400);
  return String(price);
}

const iso = seconds => (seconds ? new Date(seconds * 1000).toISOString() : null);
const idOf = value => (typeof value === 'string' ? value : value?.id) || null;

export function createBilling({ config, store, fetchImpl = globalThis.fetch, log = () => {} }) {
  const enabled = !!(config.stripeSecretKey && config.stripeWebhookSecret);

  async function api(path, params, what) {
    try {
      return await stripeRequest(config.stripeSecretKey, path, params, { fetchImpl });
    } catch (error) {
      log('billing', error.message);
      throw new CloudError('BILLING_UNAVAILABLE', `The payment service could not ${what}. Try again in a moment.`, 502);
    }
  }

  return {
    enabled,
    /** A hosted checkout URL for `product` ('pro-monthly' | 'pro-yearly' | 'credits-1000'). */
    async checkout(user, product) {
      if (!enabled) throw new CloudError('BILLING_DISABLED', 'Payments are not set up on this server yet.', 503);
      if (product.startsWith('pro-') && user.plan === 'pro') throw new CloudError('ALREADY_PRO', 'You already have Pro. Manage it under Billing.', 409);
      const price = priceFor(config, product), subscription = product.startsWith('pro-');
      const metadata = { user_id: user.id, product };
      const session = await api('/checkout/sessions', {
        mode: subscription ? 'subscription' : 'payment',
        line_items: [{ price, quantity: 1 }],
        ...(config.stripeManagedPayments ? { managed_payments: { enabled: true } } : {}),
        success_url: `${config.publicUrl}/app?billing=done&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${config.publicUrl}/app`,
        client_reference_id: user.id,
        metadata,
        ...(user.customerId ? { customer: user.customerId } : { customer_email: user.email }),
        ...(subscription
          ? { subscription_data: { metadata } }
          : { payment_intent_data: { metadata }, ...(user.customerId ? {} : { customer_creation: 'always' }) }),
      }, 'start a checkout');
      if (typeof session?.url !== 'string' || !session.url.startsWith('https://')) throw new CloudError('BILLING_UNAVAILABLE', 'The payment service returned no checkout link.', 502);
      return session.url;
    },
    /** A short-lived Stripe customer portal link (plan, invoices, payment method, cancel). */
    async portal(user) {
      if (!enabled) throw new CloudError('BILLING_DISABLED', 'Payments are not set up on this server yet.', 503);
      if (!user.customerId) throw new CloudError('NO_BILLING_ACCOUNT', 'There is no subscription on this account yet.', 404);
      const session = await api('/billing_portal/sessions', { customer: user.customerId, return_url: `${config.publicUrl}/app` }, 'open billing');
      return session.url;
    },
    /** Applies a finished checkout right after the customer returns, so the upgrade shows up without waiting for (or
     * missing) the webhook. Uses the same handlers as the webhook, so applying both is harmless. */
    async confirm(user, sessionId) {
      if (!enabled) throw new CloudError('BILLING_DISABLED', 'Payments are not set up on this server yet.', 503);
      if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(String(sessionId))) throw new CloudError('INVALID_SESSION', 'Unknown checkout.', 400);
      let session;
      try {
        session = await stripeRequest(config.stripeSecretKey, `/checkout/sessions/${sessionId}`, { expand: ['subscription'] }, { method: 'GET', fetchImpl });
      } catch (error) {
        log('billing', error.message);
        if (error.status === 404) throw new CloudError('INVALID_SESSION', 'Unknown checkout.', 404);
        throw new CloudError('BILLING_UNAVAILABLE', 'The payment service could not confirm your purchase. Try again in a moment.', 502);
      }
      if ((session.client_reference_id || session.metadata?.user_id) !== user.id) throw new CloudError('INVALID_SESSION', 'Unknown checkout.', 404);
      if (session.status !== 'complete') return { state: 'pending', product: session.metadata?.product || null };
      const created = Math.floor(Date.now() / 1000);
      if (session.mode === 'subscription' && session.subscription && typeof session.subscription === 'object') {
        const subscription = { ...session.subscription, customer: session.subscription.customer || session.customer, metadata: { ...session.subscription.metadata, user_id: user.id } };
        log('billing', this.handleEvent({ type: 'customer.subscription.updated', created, data: { object: subscription } }));
      } else {
        log('billing', this.handleEvent({ type: 'checkout.session.completed', created, data: { object: session } }));
      }
      return { state: session.mode === 'payment' && session.payment_status !== 'paid' ? 'pending' : 'complete', product: session.metadata?.product || null };
    },
    /** Applies a verified webhook event. Returns a short description for logs. */
    handleEvent(event) {
      const type = event?.type, object = event?.data?.object;
      if (typeof type !== 'string' || !object || typeof object !== 'object') throw new CloudError('INVALID_WEBHOOK', 'Malformed webhook.', 400);
      const userId = object.metadata?.user_id || object.client_reference_id;
      if (!WEBHOOK_EVENTS.includes(type)) return `ignored ${type}`;
      if (!userId || !store.user(userId)) return `ignored ${type}: unknown user`;
      const customerId = idOf(object.customer);
      if (customerId) store.setBillingCustomer(userId, { customerId });

      if (type.startsWith('customer.subscription.')) {
        const item = object.items?.data?.[0];
        const periodEnd = item?.current_period_end ?? object.current_period_end;
        const status = type === 'customer.subscription.deleted' ? 'canceled' : object.status;
        const cancelAt = object.cancel_at || (object.cancel_at_period_end ? periodEnd : null);
        const user = store.saveSubscription(userId, {
          id: object.id, status, variantId: idOf(item?.price),
          renewsAt: cancelAt ? null : iso(periodEnd), endsAt: iso(cancelAt || object.ended_at),
          // Events can arrive out of order; the event time decides which state wins.
          sourceUpdatedAt: String(event.created || 0).padStart(12, '0'),
        });
        return `${type}: ${status} → ${user.plan}`;
      }
      if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
        if (object.mode !== 'payment') return `${type}: ${object.mode}`;
        if (object.payment_status !== 'paid') return `checkout ${object.id}: waiting for payment`;
        const pack = CREDIT_PACKS.find(p => p.id === object.metadata?.product);
        if (!pack) return `ignored checkout ${object.id}: not a credit pack`;
        if (!store.markProcessed(`checkout:${object.id}`)) return `duplicate checkout ${object.id}`;
        store.addPurchasedCredits(userId, pack.credits);
        return `checkout ${object.id}: +${pack.credits} credits`;
      }
      if (type === 'charge.refunded') {
        const pack = CREDIT_PACKS.find(p => p.id === object.metadata?.product);
        if (!pack || !object.refunded) return `ignored refund ${object.id}`;
        if (!store.markProcessed(`refund:${object.payment_intent || object.id}`)) return `duplicate refund ${object.id}`;
        store.addPurchasedCredits(userId, -pack.credits);
        return `refund ${object.id}: -${pack.credits} credits`;
      }
      return `ignored ${type}`;
    },
  };
}
