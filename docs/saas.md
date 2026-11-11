# Pixel Studio Cloud (SaaS edition)

Pixel Studio comes in three editions built from the same `src/` and `public/` folders:

| Edition | Run | AI | Accounts and billing |
| --- | --- | --- | --- |
| Static (GitHub Pages) | `npm run build` | User's own API key in the browser | None |
| Local | `npm start` | User's own Codex/ChatGPT login, or own keys | None |
| **Cloud** | `npm run cloud` / `Dockerfile` | Server-side keys, paid for with **credits** | Email sign-in, plans, Stripe |

The editor stays free and works without an account. Customers pay for the parts that cost money to run: AI and cloud storage.

## Architecture

`cloud/` contains a single Node process with no npm dependencies. It needs Node 22.13 or later, because it uses `node:sqlite`.

- `cloud/start.mjs`: builds `dist/`, opens the SQLite database, serves the site and the API, and expires lapsed plans every hour.
- `cloud/server.mjs`: routes, security headers, CSRF checks and rate limits. `/` serves the marketing page (`public/landing.html`) and `/app` serves the editor. The editor page gets `<meta name="pixel-studio-cloud">`, which turns on the account button and the cloud AI paths in the browser. `/index.html` and `/app/` redirect to `/app`.
- `cloud/landing.mjs`: fills the pricing cards on the marketing page from `plans.js`, so prices are defined in one place.
- `cloud/store.mjs`: users, sessions, sign-in tokens, subscriptions, usage, processed webhooks, projects and users' own AI keys. Tokens are stored as SHA-256 hashes only; AI keys are encrypted (AES-256-GCM, `cloud/secrets.mjs`).
- `cloud/ai.mjs`: assistant and AI edit through the OpenAI Chat Completions API (streamed), and image generation through the shared image providers.
- `cloud/billing.mjs`: Stripe checkouts (Managed Payments), the customer portal, signed webhooks and the confirmation when a customer returns from checkout.
- `cloud/stripe-setup.mjs` (`npm run cloud:stripe`): creates the Stripe products, prices and webhook from `plans.js`.
- `cloud/mailer.mjs`: magic-link email through Resend. In development the link is printed to the log.
- `src/features/cloud/plans.js`: plans, prices and credit maths. The server and the browser share it.
- `src/features/cloud/client.js`, `account-dialog.js` and `account.css`: sign-in, the account page (overview, usage chart, your own AI keys, plan and billing with limits, cloud projects, your data) and the welcome screen after an upgrade.

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
| `GET /api/account/usage?days=30` | Usage per day and per model (requests, credits, tokens, images, own-key requests) |
| `POST /api/account/ai-key` | Save (after checking it with the provider) or remove the user's own OpenAI or Gemini key (Pro) |
| `POST /api/billing/checkout`, `POST /api/billing/confirm`, `GET /api/billing/portal`, `POST /api/billing/webhook` | Billing. `confirm` applies a finished checkout when the customer returns, so the upgrade does not wait for the webhook. |
| `GET/PUT/DELETE /api/cloud/projects[/id]` | Cloud projects |

Every request that changes data needs the session cookie (`HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS), an `Origin` equal to `PUBLIC_URL`, and the `X-Pixel-Studio-Token` CSRF header. The webhook route is the exception: it is checked with Stripe's signature (`Stripe-Signature`, HMAC with a timestamp; deliveries older than 5 minutes are refused) instead.

## Pricing and credits

1 credit ≈ $0.002 of provider cost (`CREDIT_USD`).

| | Free | Pro |
| --- | --- | --- |
| Price | €0 | €8/month or €72/year |
| AI credits | none | 1,000/month |
| Cloud projects | 1 (2 MB) | 200 (8 MB each) |
| Sprite sheet, GIF and APNG export | – | ✓ |
| Credit packs | – | ✓ |

Free costs nothing to run: it has no AI. Pro users can also buy a credit pack: 1,000 credits for €10. Pack credits never expire, but they can only be used while Pro is active.

Each plan lists its features in `allows` (`PRO_FEATURES` in `plans.js`). The server enforces AI, image generation, credit packs and the project limit, and returns `402 PRO_REQUIRED` for Free users. The export tabs are only gated in the browser, so a determined user can bypass that gate. Those exports cost you nothing, so this is acceptable.

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
| `AI_KEY_SECRET` | Encrypts users' own AI keys. Without it in production, "bring your own AI" is off. Keep it stable. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe API key and webhook signing secret. |
| `STRIPE_PRICE_PRO_MONTHLY`, `_PRO_YEARLY`, `_CREDITS_1000` | Price IDs (printed by `npm run cloud:stripe`). |
| `STRIPE_MANAGED_PAYMENTS` | `1` (default): Stripe is the merchant of record. `0`: you are. |

If billing is not configured, the plans are still displayed and the cards read "Payments open soon".

## Setting up billing (Stripe)

With Managed Payments, Stripe is the merchant of record: it charges customers, handles EU VAT and US sales tax, fraud and disputes, and sends receipts.

1. In the Stripe Dashboard, activate Managed Payments and save a Customer Portal configuration (Settings → Billing → Customer portal).
2. Put `STRIPE_SECRET_KEY` in `.env` and run `npm run cloud:stripe`. It creates **Pro** (monthly €8, yearly €72) and **1,000 credits** (€10) from `plans.js`, and, with an https `PUBLIC_URL`, the webhook endpoint. Copy the printed variables into `.env` or your secret store.
3. Locally, forward webhooks with the Stripe CLI and use the secret it prints as `STRIPE_WEBHOOK_SECRET`:
   `stripe listen --forward-to localhost:8080/api/billing/webhook`
4. Test with card `4242 4242 4242 4242`, then switch to live keys and run step 2 again in live mode.

Webhook events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and `charge.refunded`.

How the server applies them:
- Returning from checkout (`/app?billing=done&session_id=…`) calls `POST /api/billing/confirm`, which reads the session from Stripe and applies it at once. The webhook is still needed for renewals, cancellations and refunds; both paths are idempotent.
- Out-of-order subscription events are ignored (the event time decides).
- `active`, `trialing` and `past_due` grant Pro. A subscription cancelled at period end keeps Pro until then.
- A refunded credit pack removes its credits.

## Bring your own AI key

Pro users can add their own OpenAI key (assistant, AI edit, images) and Gemini key (images) on the account page. The server checks a key with the provider before saving it, stores it encrypted with `AI_KEY_SECRET` and only shows a hint afterwards. Requests made with the user's key are proxied through the server (the browser's CSP only allows same-origin requests), are recorded in usage with `own_key = 1` and cost no credits. A key the provider rejects later shows a clear error instead of falling back to credits.

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
  AI_KEY_SECRET="$(openssl rand -base64 32)" STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... STRIPE_PRICE_PRO_MONTHLY=... \
  STRIPE_PRICE_PRO_YEARLY=... STRIPE_PRICE_CREDITS_1000=... TRUST_PROXY=1
fly deploy
```

Back up the SQLite file, for example with volume snapshots or Litestream.

To try it locally, run `npm run cloud` (it loads a gitignored `.env` in the repo root if there is one; see `cloud/.env.example`) and open <http://localhost:8080> (the marketing page; the editor is at `/app`). Without `RESEND_API_KEY`, no email is sent: the sign-in link is printed to the terminal, and outside production the sign-in dialog also shows it. AI stays off until `OPENAI_API_KEY` is set, and is only available on Pro.

## Scaling notes

- The server runs as a single instance. Rate limits and the "one AI request per user at a time" rule are kept in memory, and SQLite is a local file. To run several instances, move to Postgres and Redis, or keep one instance and scale it vertically, which is plenty for thousands of users.
- Free accounts get no AI credits, so throwaway addresses only cost storage (1 project of at most 2 MB). If that becomes a problem, block disposable domains or add a CAPTCHA to `/api/account/login`.
- Spending: set provider budget alerts and hard limits in the OpenAI and Gemini dashboards.

## Launch checklist

These are product and legal decisions. Nothing for them is generated in this repository.

- [ ] **License.** The repository has no LICENSE file. Choose one: a proprietary license, or a source-available license such as BSL or FSL. Make the repository private if the hosted product is the business.
- [ ] **Terms of Service and Privacy Policy.** Cover the data processors (OpenAI, Google, Resend, Stripe and your host), data retention and AI output ownership. Link both from the account dialog and from the checkout.
- [ ] **GDPR.** Data export (`/api/account/export`) and account deletion are built in. You still need a records-of-processing document and data processing agreements (DPAs) with each processor.
- [ ] Domain, HTTPS, Resend domain verification, live Stripe products, prices and webhook (`npm run cloud:stripe` with live keys), `AI_KEY_SECRET` set.
- [ ] Monitoring: the `/healthz` uptime check, error logs, provider spending alerts and database backups.
- [ ] Marketing: a landing page, the free plan as the entry point, and Pro for heavy AI users.
