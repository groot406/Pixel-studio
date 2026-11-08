/**
 * Pixel Studio Cloud plans, AI credit prices and limits. Shared by the hosted server (cloud/) and the browser
 * (account dialog), so what users see is what the server enforces. Pure: no DOM, no Node APIs.
 */

/** One credit covers this much upstream AI cost (USD). Pro's 1,000 monthly credits therefore cost at most $2. */
export const CREDIT_USD = 0.002;

/** Pro-only parts of the hosted edition. Free covers drawing, PNG export and one cloud project; anything that
 * costs money to run (AI) or that working artists need (sheets, animations) is Pro. */
export const PRO_FEATURES = Object.freeze({
  ai: 'AI (assistant, AI edit, image generation)',
  sheetExport: 'Sprite sheet export',
  animationExport: 'GIF and APNG export',
  creditPacks: 'Extra AI credit packs',
});

export const PLANS = Object.freeze({
  free: Object.freeze({
    id: 'free', name: 'Free', price: { monthly: 0, yearly: 0 },
    monthlyCredits: 0, cloudProjects: 1, projectBytes: 2 * 1024 * 1024, allows: Object.freeze([]),
    features: ['The full pixel editor in your browser', 'PNG frames, PNG sequences and project files', '1 project in the cloud'],
  }),
  pro: Object.freeze({
    id: 'pro', name: 'Pro', price: { monthly: 8, yearly: 72 },
    monthlyCredits: 1000, cloudProjects: 200, projectBytes: 8 * 1024 * 1024, allows: Object.freeze(Object.keys(PRO_FEATURES)),
    features: ['Everything in Free', '1,000 AI credits every month (assistant, AI edit, image generation)', 'Sprite sheets for Aseprite, Godot and Unity, GIF and APNG export', '200 projects in the cloud, on every device', 'Extra credit packs when you need more', 'Priority support'],
  }),
});

/** Whether a plan includes a PRO_FEATURES key. */
export const planAllows = (planId, feature) => (PLANS[planId] || PLANS.free).allows.includes(feature);

/** One-off credit packs; purchased credits never expire and are used after the monthly allowance. */
export const CREDIT_PACKS = Object.freeze([Object.freeze({ id: 'credits-1000', credits: 1000, price: 10 })]);
export const CURRENCY = 'EUR';

/** Text models the hosted assistant and AI edit may use, with OpenAI list prices in USD per million tokens. */
export const CHAT_MODELS = Object.freeze({
  'gpt-5-mini': Object.freeze({ name: 'GPT-5 mini (fast)', input: 0.25, output: 2, supportsImages: true }),
  'gpt-5': Object.freeze({ name: 'GPT-5 (best)', input: 1.25, output: 10, supportsImages: true }),
});
export const DEFAULT_CHAT_MODEL = 'gpt-5-mini';
/** Credits a text request must be able to cover before it starts (the real charge follows the token count). */
export const MIN_CHAT_CREDITS = 2;

/** Credits per generated 1024 × 1024 image (≈ list price / CREDIT_USD). */
export const IMAGE_CREDITS = Object.freeze({
  openai: Object.freeze({ low: 6, medium: 21, high: 84 }),
  gemini: Object.freeze({ default: 20 }),
});

export const planFor = id => PLANS[id] || PLANS.free;

/** Credits for a finished text request: its token cost in CREDIT_USD units, rounded up, at least 1. */
export function chatCredits(model, inputTokens = 0, outputTokens = 0) {
  const price = CHAT_MODELS[model] || CHAT_MODELS[DEFAULT_CHAT_MODEL];
  const usd = (Math.max(0, inputTokens) * price.input + Math.max(0, outputTokens) * price.output) / 1e6;
  return Math.max(1, Math.ceil(usd / CREDIT_USD - 1e-9));
}

export function imageCredits(provider, { n = 1, quality = 'medium' } = {}) {
  const table = IMAGE_CREDITS[provider];
  if (!table) throw new Error(`Unknown image provider ${provider}.`);
  return (table[quality] ?? table.medium ?? table.default) * n;
}

/** The allowance period a moment belongs to: the calendar month in UTC ("2026-11"). */
export const creditPeriod = (at = Date.now()) => new Date(at).toISOString().slice(0, 7);

/**
 * A user's credit buckets after the monthly reset: the allowance refills to the plan amount when the period changes;
 * purchased credits carry over. Returns a new object.
 */
export function refreshCredits(account, at = Date.now()) {
  const period = creditPeriod(at);
  if (account.allowancePeriod === period) return { ...account };
  return { ...account, allowance: planFor(account.plan).monthlyCredits, allowancePeriod: period };
}

/** Spend `credits`: allowance first, then purchased credits. A final charge may exceed the balance; the overdraft
 * comes out of purchased credits (which may go negative) and blocks further requests until it is covered. */
export function spendCredits(account, credits) {
  const fromAllowance = Math.min(Math.max(0, account.allowance), credits);
  return { ...account, allowance: account.allowance - fromAllowance, purchased: account.purchased - (credits - fromAllowance) };
}

export const creditBalance = account => Math.max(0, account.allowance) + account.purchased;

/** Lemon Squeezy subscription statuses that still grant Pro. "cancelled" keeps Pro until ends_at. */
export function subscriptionGrantsPro({ status, endsAt } = {}, at = Date.now()) {
  if (['active', 'on_trial', 'past_due'].includes(status)) return true;
  if (status === 'cancelled') return !!endsAt && Date.parse(endsAt) > at;
  return false;
}

export const formatPrice = (amount, currency = CURRENCY) => new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount);
