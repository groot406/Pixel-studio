# Pixel Studio Cloud (SaaS edition)

Pixel Studio comes in three editions built from the same `src/` and `public/` folders:

| Edition | Run | AI | Accounts and billing |
| --- | --- | --- | --- |
| Static (GitHub Pages) | `npm run build` | User's own API key in the browser | None |
| Local | `npm start` | User's own Codex/ChatGPT login, or own keys | None |
| **Cloud** | `npm run cloud` / `Dockerfile` | Server-side keys, paid for with **credits** | Email sign-in, plans, Lemon Squeezy |

The editor stays free and works without an account. Customers pay for the parts that cost money to run: AI and cloud storage.

## Architecture

`cloud/` contains a single Node process with no npm dependencies. It needs Node 22.13 or later, because it uses `node:sqlite`.

- `cloud/start.mjs`: builds `dist/`, opens the SQLite database, serves the site and the API, and expires lapsed plans every hour.
- `cloud/server.mjs`: routes, security headers, CSRF checks and rate limits. The `index.html` it serves gets `<meta name="pixel-studio-cloud">`, which turns on the account button and the cloud AI paths in the browser.
- `cloud/store.mjs`: users, sessions, sign-in tokens, subscriptions, usage, processed webhooks and projects. Tokens are stored as SHA-256 hashes only.
- `cloud/ai.mjs`: assistant and AI edit through the OpenAI Chat Completions API (streamed), and image generation through the shared image providers.
- `cloud/billing.mjs`: Lemon Squeezy checkouts, customer portal and signed webhooks.
- `cloud/mailer.mjs`: magic-link email through Resend. In development the link is printed to the log.
- `src/features/cloud/plans.js`: plans, prices and credit maths. The server and the browser share it.
- `src/features/cloud/client.js` and `account-dialog.js`: the browser account dialog (sign in, credits, plans, cloud projects, export, delete).

The AI endpoints keep the local edition's contracts (`/api/local-ai/*`, `/api/image/*`), so the assistant, AI edit, motion and image dialogs work unchanged. The difference is that requests are charged in credits.

### API

| Route | Purpose |
| --- | --- |
| `GET /healthz` | Health check |
| `GET /api/account/me` | Plans, the current user and credits |
| `POST /api/account/login` | Email a sign-in link (rate limited) |
| `GET/POST /api/account/verify` | Confirm page, then the session cookie. The POST step stops email scanners from using up links. |
| `POST /api/account/logout`, `POST /api/account/delete`, `GET /api/account/export` | Session and GDPR controls |
| `GET /api/local-ai/status`, `POST /api/local-ai/edit` | Assistant and AI edit (NDJSON stream) |
| `GET /api/image/status`, `POST /api/image/generate` | Image generation |
| `POST /api/billing/checkout`, `GET /api/billing/portal`, `POST /api/billing/webhook` | Billing |
| `GET/PUT/DELETE /api/cloud/projects[/id]` | Cloud projects |

Every request that changes data needs the session cookie (`HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS), an `Origin` equal to `PUBLIC_URL`, and the `X-Pixel-Studio-Token` CSRF header. The webhook route is the exception: it is checked with an HMAC signature instead.

## Pricing and credits

1 credit ≈ $0.002 of provider cost (`CREDIT_USD`).

| | Free | Pro |
| --- | --- | --- |
| Price | €0 | €8/month or €72/year |
| AI credits | 30/month | 1,000/month |
| Cloud projects | 3 (2 MB each) | 200 (8 MB each) |

You can also buy a credit pack: 1,000 credits for €10. Pack credits never expire.

- The monthly allowance refills on the 1st (UTC) and is used before pack credits.
- Chat is charged by the actual token count, using the list price of `gpt-5-mini` (default) or `gpt-5`.
- Images have a fixed price: OpenAI low/medium/high quality costs 6, 21 or 84 credits; Gemini costs 20.
- A request needs at least `MIN_CHAT_CREDITS` (2) to start. If a stream is cancelled or fails, the output it produced is still charged.
- Margins at full use of the allowance:
  - Pro: €8 covers about $2 of AI cost.
  - Packs: €10 covers about $2 of AI cost.
  - After VAT and the merchant fee, this still leaves a healthy margin. Change the numbers in `plans.js` only, because both the server and the UI read from it.

## Configuration

Copy `cloud/.env.example` and set these variables in your host's secret store. In production (`NODE_ENV=production`), the server refuses to start without an `https` `PUBLIC_URL`, `RESEND_API_KEY` and `OPENAI_API_KEY`.

| Variable | Meaning |
| --- | --- |
| `PUBLIC_URL` | Public origin, for example `https://app.example.com`. It is used for links, `Origin` checks and secure cookies. |
| `PORT`, `HOST` | Listen address. The defaults are `8080` and `0.0.0.0` in production. |
| `DATABASE_PATH` | SQLite file. Put it on a persistent volume (the default is `/data/pixel-studio.db`). |
| `TRUST_PROXY` | Set to `1` behind a proxy that sets `X-Forwarded-For`, so rate limits apply per client. |
| `OPENAI_API_KEY`, `GEMINI_API_KEY` | Provider keys. They never reach the browser. |
| `RESEND_API_KEY`, `MAIL_FROM`, `SUPPORT_EMAIL` | Sign-in email and the support address shown to users. |
| `LEMONSQUEEZY_*` | API key, store ID, webhook secret, variant IDs and `TEST_MODE`. |

If billing is not configured, the plans are still displayed and the cards read "Payments open soon".

## Setting up billing (Lemon Squeezy)

Lemon Squeezy is the merchant of record: it charges and remits EU VAT and US sales tax, sends invoices and handles refunds.

1. Create a store, then create these products:
   - **Pro**: a subscription with monthly (€8) and yearly (€72) variants.
   - **1,000 credits**: a one-off product (€10).
2. Copy the variant IDs into `LEMONSQUEEZY_VARIANT_PRO_MONTHLY`, `_PRO_YEARLY` and `_CREDITS_1000`.
3. Create an API key (`LEMONSQUEEZY_API_KEY`) and note the store ID.
4. Add a webhook pointing to `https://YOUR_DOMAIN/api/billing/webhook` with a signing secret (`LEMONSQUEEZY_WEBHOOK_SECRET`). Subscribe to these events:
   - `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_resumed`, `subscription_expired`, `subscription_paused`, `subscription_unpaused`
   - `subscription_payment_success`
   - `order_created`, `order_refunded`
5. Test end to end with `LEMONSQUEEZY_TEST_MODE=1` and a test card, then switch to live mode.

How the server applies these events:
- Webhooks are idempotent and ignore out-of-order subscription updates.
- These statuses grant Pro: `active`, `on_trial` and `past_due`. A `cancelled` subscription keeps Pro until `ends_at`.
- A refunded credit pack removes its credits.

## Setting up email (Resend)

1. Add and verify your sending domain (SPF and DKIM records).
2. Set `RESEND_API_KEY` and `MAIL_FROM`, for example `Pixel Studio <login@example.com>`.

## Deploying

The included `Dockerfile` runs as a non-root user, exposes port 8080, keeps data in `/data` and has a health check. Any host that offers a persistent volume works. For example, on Fly.io:

```sh
fly launch --no-deploy
fly volumes create data --size 1
# in fly.toml, add: [mounts] source = "data", destination = "/data"
fly secrets set PUBLIC_URL=https://app.example.com OPENAI_API_KEY=... RESEND_API_KEY=... MAIL_FROM="Pixel Studio <login@example.com>" \
  LEMONSQUEEZY_API_KEY=... LEMONSQUEEZY_STORE_ID=... LEMONSQUEEZY_WEBHOOK_SECRET=... LEMONSQUEEZY_VARIANT_PRO_MONTHLY=... \
  LEMONSQUEEZY_VARIANT_PRO_YEARLY=... LEMONSQUEEZY_VARIANT_CREDITS_1000=... TRUST_PROXY=1
fly deploy
```

Back up the SQLite file, for example with volume snapshots or Litestream.

To try it locally, run `npm run cloud` and open <http://localhost:8080>. The sign-in link is printed to the terminal, and AI stays off until `OPENAI_API_KEY` is set.

## Scaling notes

- The server runs as a single instance. Rate limits and the "one AI request per user at a time" rule are kept in memory, and SQLite is a local file. To run several instances, move to Postgres and Redis, or keep one instance and scale it vertically, which is plenty for thousands of users.
- Free credits are given per email address. If people abuse this with throwaway addresses, lower the free allowance, block disposable domains, or add a CAPTCHA to `/api/account/login`.
- Spending: set provider budget alerts and hard limits in the OpenAI and Gemini dashboards.

## Launch checklist

These are product and legal decisions. Nothing for them is generated in this repository.

- [ ] **License.** The repository has no LICENSE file. Choose one: a proprietary license, or a source-available license such as BSL or FSL. Make the repository private if the hosted product is the business.
- [ ] **Terms of Service and Privacy Policy.** Cover the data processors (OpenAI, Google, Resend, Lemon Squeezy and your host), data retention and AI output ownership. Link both from the account dialog and from the checkout.
- [ ] **GDPR.** Data export (`/api/account/export`) and account deletion are built in. You still need a records-of-processing document and data processing agreements (DPAs) with each processor.
- [ ] Domain, HTTPS, Resend domain verification, live Lemon Squeezy products and webhook.
- [ ] Monitoring: the `/healthz` uptime check, error logs, provider spending alerts and database backups.
- [ ] Marketing: a landing page, the free plan as the entry point, and Pro for heavy AI users.
