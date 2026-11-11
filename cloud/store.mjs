// Pixel Studio Cloud storage on node:sqlite (Node 22.13+): accounts, sessions, sign-in links, credits, usage,
// subscriptions and cloud projects. Secrets (session and sign-in tokens) are stored only as SHA-256 hashes.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { planFor, refreshCredits, spendCredits, creditBalance, subscriptionGrantsPro } from '../src/features/cloud/plans.js';

export const SESSION_DAYS = 30;
export const LOGIN_MINUTES = 15;
export const hashToken = token => createHash('sha256').update(String(token)).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free', allowance INTEGER NOT NULL DEFAULT 0, allowance_period TEXT NOT NULL DEFAULT '',
  purchased INTEGER NOT NULL DEFAULT 0, customer_id TEXT, portal_url TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL, variant_id TEXT, renews_at TEXT, ends_at TEXT, source_updated_at TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_user ON usage(user_id, at);
CREATE TABLE IF NOT EXISTS processed_events (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ai_keys (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL, secret TEXT NOT NULL,
  hint TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS projects (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL,
  data TEXT NOT NULL, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id)
);
`;

const account = row => row && ({
  id: row.id, email: row.email, createdAt: row.created_at, plan: row.plan, allowance: row.allowance,
  allowancePeriod: row.allowance_period, purchased: row.purchased, customerId: row.customer_id, portalUrl: row.portal_url,
});

export class CloudError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'CloudError'; this.code = code; this.status = status; }
}

export function openStore(path = ':memory:', { now = () => Date.now() } = {}) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Added after launch: usage paid for with the user's own AI key (no credits).
  if (!db.prepare('PRAGMA table_info(usage)').all().some(column => column.name === 'own_key')) db.exec('ALTER TABLE usage ADD COLUMN own_key INTEGER NOT NULL DEFAULT 0');
  const q = sql => db.prepare(sql);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const getUser = id => account(q('SELECT * FROM users WHERE id = ?').get(id));
  const saveCredits = user => q('UPDATE users SET allowance = ?, allowance_period = ?, purchased = ? WHERE id = ?').run(user.allowance, user.allowancePeriod, user.purchased, user.id);

  /** The user with this month's allowance applied (persisted when it changed). */
  function currentUser(id) {
    const user = getUser(id);
    if (!user) return null;
    const fresh = refreshCredits(user, now());
    if (fresh.allowancePeriod !== user.allowancePeriod) saveCredits(fresh);
    return fresh;
  }

  return {
    db,
    close: () => db.close(),

    // ---- sign-in links and sessions ----
    createLoginToken(email) {
      const token = newToken(), at = now();
      q('DELETE FROM login_tokens WHERE expires_at < ?').run(at);
      q('INSERT INTO login_tokens (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(hashToken(token), email, at, at + LOGIN_MINUTES * 60_000);
      return token;
    },
    recentLoginTokens(email, sinceMs) { return q('SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?').get(email, now() - sinceMs).n; },
    /** Single use: the token is deleted whether or not it is still valid. Creates the account on first sign-in. */
    consumeLoginToken(token) {
      return transaction(() => {
        const row = q('SELECT * FROM login_tokens WHERE token_hash = ?').get(hashToken(token));
        if (!row) return null;
        q('DELETE FROM login_tokens WHERE token_hash = ?').run(row.token_hash);
        if (row.expires_at < now()) return null;
        let user = account(q('SELECT * FROM users WHERE email = ?').get(row.email));
        if (!user) {
          const id = randomUUID();
          q('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(id, row.email, now());
          user = getUser(id);
        }
        return user;
      });
    },
    createSession(userId) {
      const token = newToken(), csrf = newToken(), at = now();
      q('DELETE FROM sessions WHERE expires_at < ?').run(at);
      q('INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(hashToken(token), userId, csrf, at, at + SESSION_DAYS * 86_400_000);
      return { token, csrf };
    },
    session(token) {
      if (!token) return null;
      const row = q('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hashToken(token), now());
      if (!row) return null;
      const user = currentUser(row.user_id);
      return user ? { user, csrf: row.csrf } : null;
    },
    deleteSession(token) { q('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)); },
    deleteUser(userId) { q('DELETE FROM users WHERE id = ?').run(userId); },

    // ---- credits ----
    user: currentUser,
    userByEmail(email) { const row = q('SELECT id FROM users WHERE email = ?').get(email); return row ? currentUser(row.id) : null; },
    /** Throws NO_CREDITS (402) unless the user can cover `credits`. */
    requireCredits(userId, credits) {
      const user = currentUser(userId);
      if (creditBalance(user) < credits) {
        throw new CloudError('NO_CREDITS', user.plan === 'pro'
          ? 'You have used this month’s AI credits. Buy a credit pack in Account, or wait for the monthly refill.'
          : 'You have used this month’s free AI credits. Upgrade to Pro or buy a credit pack in Account.', 402);
      }
      return user;
    },
    /** Spends `credits` and records the request. With `ownKey` the user's own AI key paid, so no credits are spent. */
    charge(userId, { kind, model = null, inputTokens = 0, outputTokens = 0, credits, ownKey = false }) {
      return transaction(() => {
        const user = ownKey ? currentUser(userId) : spendCredits(currentUser(userId), credits);
        if (!ownKey) saveCredits(user);
        q('INSERT INTO usage (user_id, kind, model, input_tokens, output_tokens, credits, own_key, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(userId, kind, model, inputTokens, outputTokens, ownKey ? 0 : credits, ownKey ? 1 : 0, now());
        return user;
      });
    },
    addPurchasedCredits(userId, credits) {
      q('UPDATE users SET purchased = purchased + ? WHERE id = ?').run(credits, userId);
      return currentUser(userId);
    },
    usageSince(userId, since) {
      return q('SELECT kind, COUNT(*) AS requests, SUM(credits) AS credits FROM usage WHERE user_id = ? AND at >= ? GROUP BY kind').all(userId, since)
        .map(row => ({ kind: row.kind, requests: row.requests, credits: row.credits }));
    },
    /** Usage since `since`: totals, per UTC day and per model, split by who paid (credits or the user's own key). */
    usageStats(userId, since) {
      const rows = q(`SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, kind, model, own_key, COUNT(*) AS requests,
        SUM(credits) AS credits, SUM(input_tokens) AS input, SUM(output_tokens) AS output
        FROM usage WHERE user_id = ? AND at >= ? GROUP BY day, kind, model, own_key ORDER BY day`).all(userId, since);
      const add = (target, row) => {
        target.requests += row.requests; target.credits += row.credits ?? 0;
        target.inputTokens += row.input ?? 0; target.outputTokens += row.output ?? 0;
        if (row.own_key) target.ownKeyRequests += row.requests;
        if (row.kind === 'image') target.images += row.requests;
        return target;
      };
      const empty = () => ({ requests: 0, credits: 0, inputTokens: 0, outputTokens: 0, ownKeyRequests: 0, images: 0 });
      const total = empty(), days = new Map(), models = new Map();
      for (const row of rows) {
        add(total, row);
        if (!days.has(row.day)) days.set(row.day, { day: row.day, ...empty() });
        add(days.get(row.day), row);
        const id = row.model || row.kind;
        if (!models.has(id)) models.set(id, { model: id, kind: row.kind, ...empty() });
        add(models.get(id), row);
      }
      return { total, days: [...days.values()], models: [...models.values()].sort((a, b) => b.requests - a.requests) };
    },

    // ---- the user's own AI keys (stored encrypted; see cloud/secrets.mjs) ----
    aiKeys(userId) {
      return q('SELECT provider, hint, created_at FROM ai_keys WHERE user_id = ? ORDER BY provider').all(userId)
        .map(row => ({ provider: row.provider, hint: row.hint, addedAt: row.created_at }));
    },
    aiKeySecret(userId, provider) { return q('SELECT secret FROM ai_keys WHERE user_id = ? AND provider = ?').get(userId, provider)?.secret || null; },
    setAiKey(userId, provider, { secret, hint }) {
      q(`INSERT INTO ai_keys (user_id, provider, secret, hint, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET secret = excluded.secret, hint = excluded.hint, created_at = excluded.created_at`).run(userId, provider, secret, hint, now());
    },
    deleteAiKey(userId, provider) { return q('DELETE FROM ai_keys WHERE user_id = ? AND provider = ?').run(userId, provider).changes > 0; },

    // ---- billing ----
    /** Records a webhook delivery key; false when it was already processed (webhook retries, or a checkout confirmed on return and by webhook). */
    markProcessed(key) {
      try { q('INSERT INTO processed_events (key, at) VALUES (?, ?)').run(key, now()); return true; }
      catch (error) { if (/UNIQUE|PRIMARY KEY/i.test(error.message)) return false; throw error; }
    },
    setBillingCustomer(userId, { customerId, portalUrl }) {
      q('UPDATE users SET customer_id = COALESCE(?, customer_id), portal_url = COALESCE(?, portal_url) WHERE id = ?').run(customerId ?? null, portalUrl ?? null, userId);
    },
    /** Upserts a subscription and recomputes the plan. Upgrading tops this month's allowance up to the Pro amount.
     * `sourceUpdatedAt` (the provider's ISO timestamp) makes late, out-of-order webhook deliveries harmless. */
    saveSubscription(userId, { id, status, variantId = null, renewsAt = null, endsAt = null, sourceUpdatedAt = '' }) {
      return transaction(() => {
        q(`INSERT INTO subscriptions (id, user_id, status, variant_id, renews_at, ends_at, source_updated_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, status = excluded.status, variant_id = excluded.variant_id,
           renews_at = excluded.renews_at, ends_at = excluded.ends_at, source_updated_at = excluded.source_updated_at, updated_at = excluded.updated_at
           WHERE excluded.source_updated_at >= subscriptions.source_updated_at`).run(String(id), userId, status, variantId, renewsAt, endsAt, String(sourceUpdatedAt || ''), now());
        return this.refreshPlan(userId);
      });
    },
    refreshPlan(userId) {
      const subs = q('SELECT status, ends_at FROM subscriptions WHERE user_id = ?').all(userId);
      const plan = subs.some(s => subscriptionGrantsPro({ status: s.status, endsAt: s.ends_at }, now())) ? 'pro' : 'free';
      const user = currentUser(userId);
      if (user.plan !== plan) {
        const allowance = plan === 'pro' ? Math.max(user.allowance, planFor('pro').monthlyCredits) : Math.min(user.allowance, planFor('free').monthlyCredits);
        q('UPDATE users SET plan = ?, allowance = ? WHERE id = ?').run(plan, allowance, userId);
      }
      return currentUser(userId);
    },
    subscriptions(userId) {
      return q('SELECT id, status, variant_id, renews_at, ends_at FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC').all(userId)
        .map(s => ({ id: s.id, status: s.status, variantId: s.variant_id, renewsAt: s.renews_at, endsAt: s.ends_at }));
    },
    /** Cancelled subscriptions lapse at ends_at without a webhook; call periodically. */
    expirePlans() {
      for (const { id } of q("SELECT id FROM users WHERE plan = 'pro'").all()) this.refreshPlan(id);
    },

    // ---- cloud projects ----
    listProjects(userId) {
      return q('SELECT id, name, bytes, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC').all(userId)
        .map(p => ({ id: p.id, name: p.name, bytes: p.bytes, updatedAt: p.updated_at }));
    },
    getProject(userId, id) {
      const p = q('SELECT id, name, data, updated_at FROM projects WHERE user_id = ? AND id = ?').get(userId, id);
      return p ? { id: p.id, name: p.name, data: p.data, updatedAt: p.updated_at } : null;
    },
    saveProject(userId, { id, name, data }) {
      return transaction(() => {
        const user = currentUser(userId), plan = planFor(user.plan), bytes = Buffer.byteLength(data);
        if (bytes > plan.projectBytes) throw new CloudError('PROJECT_TOO_LARGE', `This project is ${Math.ceil(bytes / 1024)} KB; ${plan.name} projects can be up to ${plan.projectBytes / 1024 / 1024} MB.`, 413);
        const exists = q('SELECT 1 FROM projects WHERE user_id = ? AND id = ?').get(userId, id);
        const count = q('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?').get(userId).n;
        if (!exists && count >= plan.cloudProjects) {
          throw new CloudError('PROJECT_LIMIT', plan.id === 'free' ? `The Free plan keeps ${plan.cloudProjects} project${plan.cloudProjects === 1 ? '' : 's'} in the cloud. ${plan.cloudProjects === 1 ? 'Delete it' : 'Delete one'} or upgrade to Pro.` : `You have reached ${plan.cloudProjects} cloud projects. Delete one to save another.`, 403);
        }
        const at = now();
        q(`INSERT INTO projects (user_id, id, name, data, bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, data = excluded.data, bytes = excluded.bytes, updated_at = excluded.updated_at`).run(userId, id, name, data, bytes, at);
        return { id, name, bytes, updatedAt: at };
      });
    },
    deleteProject(userId, id) { return q('DELETE FROM projects WHERE user_id = ? AND id = ?').run(userId, id).changes > 0; },
  };
}
