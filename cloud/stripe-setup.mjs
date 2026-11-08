// Creates the Stripe products and prices for Pixel Studio Cloud from src/features/cloud/plans.js, and with an https
// PUBLIC_URL also the webhook endpoint. Safe to run again: prices are found by lookup key and reused.
//   npm run cloud:stripe            (reads STRIPE_SECRET_KEY and PUBLIC_URL from .env or the environment)
// Then put the printed variables in .env or your host's secret store.
import { PLANS, CREDIT_PACKS, CURRENCY } from '../src/features/cloud/plans.js';
import { stripeRequest, WEBHOOK_EVENTS } from './billing.mjs';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('Set STRIPE_SECRET_KEY first (in .env or the environment).'); process.exit(1); }
const publicUrl = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const api = (path, params, method) => stripeRequest(key, path, params, { method });
// Managed Payments needs a digital-goods tax code: Software as a service, personal use.
const TAX_CODE = 'txcd_10103000';

const pro = PLANS.pro;
const wanted = [
  { env: 'STRIPE_PRICE_PRO_MONTHLY', lookup: 'pixel_studio_pro_monthly', product: `Pixel Studio ${pro.name}`, amount: pro.price.monthly, interval: 'month' },
  { env: 'STRIPE_PRICE_PRO_YEARLY', lookup: 'pixel_studio_pro_yearly', product: `Pixel Studio ${pro.name}`, amount: pro.price.yearly, interval: 'year' },
  ...CREDIT_PACKS.map(pack => ({ env: `STRIPE_PRICE_${pack.id.toUpperCase().replace(/-/g, '_')}`, lookup: `pixel_studio_${pack.id.replace(/-/g, '_')}`, product: `${pack.credits.toLocaleString('en')} AI credits`, amount: pack.price })),
];

const existing = await api('/prices', { lookup_keys: wanted.map(w => w.lookup), limit: 100, expand: ['data.product'] }, 'GET');
const products = new Map(existing.data.map(price => [price.product.name, price.product.id]));
const lines = [];
for (const w of wanted) {
  let price = existing.data.find(p => p.lookup_key === w.lookup);
  const cents = Math.round(w.amount * 100);
  if (price && (price.unit_amount !== cents || price.currency !== CURRENCY.toLowerCase())) {
    console.log(`${w.lookup}: price changed, creating a new one (existing subscribers keep the old price)`);
    price = null;
  }
  if (!price) {
    let productId = products.get(w.product);
    if (!productId) {
      productId = (await api('/products', { name: w.product, tax_code: TAX_CODE })).id;
      products.set(w.product, productId);
    }
    price = await api('/prices', {
      product: productId, currency: CURRENCY.toLowerCase(), unit_amount: cents, tax_behavior: 'exclusive',
      lookup_key: w.lookup, transfer_lookup_key: true, ...(w.interval ? { recurring: { interval: w.interval } } : {}),
    });
    console.log(`${w.lookup}: created ${price.id}`);
  }
  lines.push(`${w.env}=${price.id}`);
}

if (publicUrl.startsWith('https://')) {
  const url = `${publicUrl}/api/billing/webhook`;
  const endpoints = await api('/webhook_endpoints', { limit: 100 }, 'GET');
  if (endpoints.data.some(e => e.url === url)) console.log(`Webhook for ${url} exists; its signing secret is in the Stripe Dashboard.`);
  else {
    const endpoint = await api('/webhook_endpoints', { url, enabled_events: WEBHOOK_EVENTS, description: 'Pixel Studio Cloud' });
    lines.push(`STRIPE_WEBHOOK_SECRET=${endpoint.secret}`);
  }
} else {
  console.log('No https PUBLIC_URL, so no webhook endpoint was created. For local testing run:');
  console.log('  stripe listen --forward-to localhost:8080/api/billing/webhook   (and put its whsec_… in STRIPE_WEBHOOK_SECRET)');
}
console.log(`\n${lines.join('\n')}`);
