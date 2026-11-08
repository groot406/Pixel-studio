// Lemon Squeezy billing (merchant of record: it charges customers and handles EU VAT and sales tax).
// Checkouts carry the Pixel Studio user ID as custom data; signed webhooks update plans and credit packs.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CREDIT_PACKS } from '../src/features/cloud/plans.js';
import { CloudError } from './store.mjs';

const API = 'https://api.lemonsqueezy.com/v1';

/** X-Signature is the hex HMAC-SHA256 of the raw request body with the webhook signing secret. */
export function verifySignature(rawBody, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/** Which product a checkout is for → the configured Lemon Squeezy variant ID. */
export function variantFor(config, product) {
  const variant = { 'pro-monthly': config.lsVariantProMonthly, 'pro-yearly': config.lsVariantProYearly, 'credits-1000': config.lsVariantCredits1000 }[product];
  if (!variant) throw new CloudError('UNKNOWN_PRODUCT', 'This product is not available.', 400);
  return String(variant);
}

export function createBilling({ config, store, fetchImpl = globalThis.fetch, log = () => {} }) {
  const enabled = !!(config.lsApiKey && config.lsStoreId && config.lsWebhookSecret);
  const packFor = variantId => {
    if (String(variantId) === String(config.lsVariantCredits1000)) return CREDIT_PACKS.find(p => p.id === 'credits-1000');
    return null;
  };

  async function api(path, init = {}) {
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, { ...init, headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', Authorization: `Bearer ${config.lsApiKey}`, ...(init.headers || {}) } });
    } catch { throw new CloudError('BILLING_UNAVAILABLE', 'The payment service could not be reached. Try again in a moment.', 502); }
    if (!response.ok) { log('billing', path, response.status); throw new CloudError('BILLING_UNAVAILABLE', 'The payment service could not start a checkout. Try again in a moment.', 502); }
    return response.json();
  }

  return {
    enabled,
    /** A hosted checkout URL for `product` ('pro-monthly' | 'pro-yearly' | 'credits-1000'). */
    async checkout(user, product) {
      if (!enabled) throw new CloudError('BILLING_DISABLED', 'Payments are not set up on this server yet.', 503);
      if (product.startsWith('pro-') && user.plan === 'pro') throw new CloudError('ALREADY_PRO', 'You already have Pro. Manage it under Billing.', 409);
      const body = {
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: { email: user.email, custom: { user_id: user.id } },
            product_options: { redirect_url: `${config.publicUrl}/app?billing=done`, enabled_variants: [Number(variantFor(config, product))] },
            checkout_options: { embed: false },
            ...(config.lsTestMode ? { test_mode: true } : {}),
          },
          relationships: {
            store: { data: { type: 'stores', id: String(config.lsStoreId) } },
            variant: { data: { type: 'variants', id: variantFor(config, product) } },
          },
        },
      };
      const result = await api('/checkouts', { method: 'POST', body: JSON.stringify(body) });
      const url = result?.data?.attributes?.url;
      if (typeof url !== 'string' || !url.startsWith('https://')) throw new CloudError('BILLING_UNAVAILABLE', 'The payment service returned no checkout link.', 502);
      return url;
    },
    /** The customer portal link (manage plan, invoices, payment method) saved from the latest subscription event. */
    portal(user) {
      if (!user.portalUrl) throw new CloudError('NO_BILLING_ACCOUNT', 'There is no subscription on this account yet.', 404);
      return user.portalUrl;
    },
    /** Applies a verified webhook payload. Returns a short description for logs. */
    handleEvent(payload) {
      const event = payload?.meta?.event_name, data = payload?.data, attributes = data?.attributes || {};
      const userId = payload?.meta?.custom_data?.user_id;
      if (typeof event !== 'string' || !data) throw new CloudError('INVALID_WEBHOOK', 'Malformed webhook.', 400);
      if (!userId || !store.user(userId)) return `ignored ${event}: unknown user`;
      if (event.startsWith('subscription_') && data.type === 'subscriptions') {
        if (event === 'subscription_payment_success' || event === 'subscription_payment_failed' || event === 'subscription_payment_recovered') return `ignored ${event}`;
        store.setBillingCustomer(userId, { customerId: attributes.customer_id != null ? String(attributes.customer_id) : null, portalUrl: attributes.urls?.customer_portal || null });
        const user = store.saveSubscription(userId, { id: data.id, status: attributes.status, variantId: attributes.variant_id != null ? String(attributes.variant_id) : null, renewsAt: attributes.renews_at || null, endsAt: attributes.ends_at || null, sourceUpdatedAt: attributes.updated_at || '' });
        return `${event}: ${attributes.status} → ${user.plan}`;
      }
      if (event === 'order_created' && data.type === 'orders') {
        if (attributes.status !== 'paid') return `ignored order ${data.id}: ${attributes.status}`;
        const pack = packFor(attributes.first_order_item?.variant_id);
        if (!pack) return `ignored order ${data.id}: not a credit pack`;
        if (!store.markProcessed(`order:${data.id}`)) return `duplicate order ${data.id}`;
        store.setBillingCustomer(userId, { customerId: attributes.customer_id != null ? String(attributes.customer_id) : null });
        store.addPurchasedCredits(userId, pack.credits);
        return `order ${data.id}: +${pack.credits} credits`;
      }
      if (event === 'order_refunded' && data.type === 'orders') {
        const pack = packFor(attributes.first_order_item?.variant_id);
        if (!pack || !store.markProcessed(`refund:${data.id}`)) return `ignored refund ${data.id}`;
        store.addPurchasedCredits(userId, -pack.credits);
        return `refund ${data.id}: -${pack.credits} credits`;
      }
      return `ignored ${event}`;
    },
  };
}
