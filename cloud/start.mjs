#!/usr/bin/env node
// Starts Pixel Studio Cloud: builds the editor into dist/, opens the database and serves everything on PORT.
import { readConfig } from './config.mjs';
import { openStore } from './store.mjs';
import { createMailer } from './mailer.mjs';
import { createBilling } from './billing.mjs';
import { createCloudServer } from './server.mjs';
import { buildSite } from '../scripts/build.mjs';

const config = readConfig();
await buildSite();
const store = openStore(config.databasePath);
const log = (...args) => console.log(new Date().toISOString(), ...args);
const billing = createBilling({ config, store, log });
const cloud = createCloudServer({ config, store, mailer: createMailer({ config, log }), billing, log });
const url = await cloud.listen();
log(`Pixel Studio Cloud on ${url} (public ${config.publicUrl}); billing ${billing.enabled ? 'on' : 'off'}, AI ${config.openaiApiKey ? 'on' : 'off'}`);
// Cancelled subscriptions end without a webhook at ends_at.
const expiry = setInterval(() => { try { store.expirePlans(); } catch (error) { log('[expire]', error); } }, 60 * 60_000);
expiry.unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    log(`${signal}: shutting down`);
    clearInterval(expiry);
    await cloud.close();
    store.close();
    process.exit(0);
  });
}
