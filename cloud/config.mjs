// Pixel Studio Cloud configuration from environment variables (see docs/saas.md and cloud/.env.example).
const bool = value => /^(1|true|yes)$/i.test(String(value || ''));

export function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT || 8080);
  const publicUrl = String(env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const config = {
    production, port, publicUrl,
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    databasePath: env.DATABASE_PATH || (production ? '/data/pixel-studio.db' : 'pixel-studio-cloud.db'),
    trustProxy: bool(env.TRUST_PROXY),
    openaiApiKey: env.OPENAI_API_KEY || '',
    geminiApiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
    resendApiKey: env.RESEND_API_KEY || '',
    mailFrom: env.MAIL_FROM || 'Pixel Studio <login@example.com>',
    lsApiKey: env.LEMONSQUEEZY_API_KEY || '',
    lsStoreId: env.LEMONSQUEEZY_STORE_ID || '',
    lsWebhookSecret: env.LEMONSQUEEZY_WEBHOOK_SECRET || '',
    lsVariantProMonthly: env.LEMONSQUEEZY_VARIANT_PRO_MONTHLY || '',
    lsVariantProYearly: env.LEMONSQUEEZY_VARIANT_PRO_YEARLY || '',
    lsVariantCredits1000: env.LEMONSQUEEZY_VARIANT_CREDITS_1000 || '',
    lsTestMode: bool(env.LEMONSQUEEZY_TEST_MODE),
    supportEmail: env.SUPPORT_EMAIL || '',
  };
  if (production) {
    const missing = [];
    if (!publicUrl.startsWith('https://')) missing.push('PUBLIC_URL (https://…)');
    if (!config.resendApiKey) missing.push('RESEND_API_KEY');
    if (!config.openaiApiKey) missing.push('OPENAI_API_KEY');
    if (missing.length) throw new Error(`Pixel Studio Cloud needs ${missing.join(', ')} in production.`);
  }
  return Object.freeze(config);
}
