/**
 * Pixel Studio Cloud account: email sign-in, the account page (overview, usage, the user's own AI keys, plan and
 * billing with limits, cloud projects, data export and deletion) and the confirmation after a Stripe checkout.
 * Only shown in the hosted edition.
 */
import { packProject, unpackProject } from '../../domain/versions.js';
import { PLANS, PRO_FEATURES, CHAT_MODELS, formatPrice, planAllows, planFor } from './plans.js';
import {
  isCloudEdition, currentAccount, refreshAccount, onAccountChange, noteCredits, sendSignInLink, signOut, deleteAccount,
  startCheckout, openBillingPortal, confirmCheckout, fetchUsage, saveAiKey, listCloudProjects, loadCloudProject, saveCloudProject, deleteCloudProject, cloudIdFor, linkCloudId,
} from './client.js';

let d;
const esc = text => d.escapeHTML(String(text ?? ''));
const when = ms => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const date = iso => iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';
const kb = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function initAccount(deps) {
  d = deps;
  const button = d.$('cloud-account-button');
  if (!isCloudEdition()) { button.hidden = true; return; }
  button.hidden = false;
  button.onclick = () => accountDialog();
  window.addEventListener('pixel-studio:credits', event => noteCredits(event.detail));
  onAccountChange(renderButton);
  refreshAccount().then(handleReturn);
  window.addEventListener('focus', () => { if (currentAccount()?.signedIn) refreshAccount(); });
}

function renderButton(account) {
  const button = d.$('cloud-account-button'), label = button.querySelector('span');
  if (!account?.signedIn) {
    label.textContent = 'Sign in';
    button.title = 'Sign in to Pixel Studio Cloud: AI credits and cloud projects';
    button.dataset.plan = '';
    return;
  }
  const { balance } = account.credits;
  label.textContent = account.plan === 'pro' ? `Pro · ${balance.toLocaleString()} credits` : 'Free · Upgrade';
  button.title = `${account.email} · ${PLANS[account.plan]?.name || 'Free'} plan · ${balance.toLocaleString()} AI credits left`;
  button.dataset.plan = account.plan;
  button.dataset.low = String(account.plan === 'pro' && balance < 10);
}

/** Messages after returning from the sign-in link or a checkout (?signin=ok|expired, ?billing=done), and the
 * landing page's "Get Pro" link (?upgrade=pro). */
function handleReturn() {
  const params = new URLSearchParams(location.search);
  const signin = params.get('signin'), billing = params.get('billing'), upgrade = params.get('upgrade'), sessionId = params.get('session_id');
  if (!signin && !billing && !upgrade) return;
  for (const key of ['signin', 'billing', 'upgrade', 'session_id']) params.delete(key);
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
  if (signin === 'ok') d.toast(`Signed in as ${currentAccount()?.email || 'you'}.`);
  // A signed-out visitor who chose "Get Pro" signs in first; show the plans when they come back.
  const INTENT = 'pixel-studio.upgrade-intent';
  if (upgrade && !currentAccount()?.signedIn) { try { sessionStorage.setItem(INTENT, '1'); } catch { /* ignore */ } }
  let wantsPro = !!upgrade;
  if (signin === 'ok') { try { wantsPro = sessionStorage.getItem(INTENT) === '1'; sessionStorage.removeItem(INTENT); } catch { /* ignore */ } }
  if (wantsPro && currentAccount()?.plan !== 'pro') accountDialog();
  if (signin === 'expired') accountDialog({ notice: 'That sign-in link has expired or was already used. Ask for a new one below.' });
  if (billing === 'done') confirmPurchase(sessionId);
}

/** After Stripe checkout: confirm the payment with the server right away (webhooks may lag or be missing in
 * development), then celebrate what was unlocked. Falls back to polling if Stripe still reports it as pending. */
async function confirmPurchase(sessionId) {
  const before = currentAccount();
  d.openDialog('Confirming your payment…', `<div class="welcome-wait"><span class="welcome-spinner" aria-hidden="true"></span><p class="modal-body-text" role="status">One moment while Stripe confirms your purchase.</p></div>`, 'THANK YOU');
  d.$('modal').classList.add('welcome-modal');
  let result = null;
  if (sessionId) { try { result = await confirmCheckout(sessionId); } catch (error) { result = { state: 'error', error }; } }
  let account = await refreshAccount();
  const changed = now => now && (now.plan !== before?.plan || now.credits?.balance !== before?.credits?.balance);
  for (let tries = 0; !changed(account) && result?.state !== 'complete' && tries < 10; tries++) {
    if (!d.$('modal').classList.contains('welcome-modal')) return;
    await new Promise(resolve => setTimeout(resolve, 3000));
    account = await refreshAccount();
  }
  if (!d.$('modal').open || !d.$('modal').classList.contains('welcome-modal')) return;
  if (account?.plan === 'pro' && before?.plan !== 'pro') return welcomePro(account);
  if (changed(account) || (result?.state === 'complete' && result.product !== 'pro')) return creditsAdded(account, before);
  if (account?.plan === 'pro') return welcomePro(account);
  d.openDialog('Payment received', `<p class="modal-body-text">Thank you! Stripe is still processing your payment, which can take a minute. Your account updates automatically; you will get an email receipt from Stripe.${account?.supportEmail ? ` If nothing changes within 10 minutes, write to <a href="mailto:${esc(account.supportEmail)}">${esc(account.supportEmail)}</a>.` : ''}</p>
    <div class="modal-actions"><button type="button" class="button primary" id="welcome-close">Back to drawing</button></div>`, 'THANK YOU');
  d.$('welcome-close').onclick = () => d.$('modal').close();
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function confetti() {
  if (reducedMotion()) return '';
  const colors = ['#285b47', '#dfe9ba', '#e8a33d', '#d9614c', '#6aa2c8', '#8fbf6a'];
  return `<div class="welcome-confetti" aria-hidden="true">${Array.from({ length: 36 }, (_, i) => `<i style="left:${(i * 37 % 100)}%;background:${colors[i % colors.length]};animation-delay:${(i % 9) * 0.07}s;--drift:${(i % 7 - 3) * 14}px;--fall:${170 + (i * 53 % 120)}px"></i>`).join('')}</div>`;
}

function welcomePro(account) {
  const tiles = [
    ['spark', `${account.credits.balance.toLocaleString()} AI credits`, 'Assistant, AI edits and image generation. 1,000 more every month.'],
    ['frames', 'Sprite sheets, GIF & APNG', 'Export animations for games and the web.'],
    ['folder', `${planFor('pro').cloudProjects} cloud projects`, 'Open your work on any device.'],
    ['plugin', 'Your own AI keys', 'Use OpenAI or Gemini without spending credits.'],
  ];
  d.openDialog('Welcome to Pro', `${confetti()}
    <div class="welcome-hero"><span class="welcome-badge">${d.icon('check')}</span><p>Thank you for supporting Pixel Studio. Everything below is unlocked right now.</p></div>
    <ul class="welcome-tiles">${tiles.map(([glyph, title, text]) => `<li>${d.icon(glyph)}<strong>${esc(title)}</strong><span>${esc(text)}</span></li>`).join('')}</ul>
    <p class="field-hint welcome-small">Manage your plan, invoices and usage any time under Account. A receipt from Stripe is on its way to ${esc(account.email)}.</p>
    <div class="modal-actions"><button type="button" class="button" id="welcome-account">See my account</button><button type="button" class="button" id="welcome-ai">Try an AI edit</button><button type="button" class="button primary" id="welcome-start">Start creating</button></div>`, 'YOU ARE PRO');
  d.$('modal').classList.add('welcome-modal');
  d.$('welcome-start').onclick = () => d.$('modal').close();
  d.$('welcome-account').onclick = () => accountDialog({ section: 'overview' });
  d.$('welcome-ai').onclick = () => d.openAiEdit ? d.openAiEdit() : d.$('modal').close();
  d.$('welcome-start').focus();
}

function creditsAdded(account, before) {
  const added = Math.max(0, (account?.credits?.balance || 0) - (before?.credits?.balance || 0));
  d.openDialog(added ? `+${added.toLocaleString()} credits` : 'Credits added', `${confetti()}
    <div class="welcome-hero"><span class="welcome-badge">${d.icon('spark')}</span><p>Thank you! You now have <strong>${(account?.credits?.balance || 0).toLocaleString()}</strong> AI credits. Bought credits never expire and are used after your monthly credits.</p></div>
    <div class="modal-actions"><button type="button" class="button" id="welcome-account">See usage</button><button type="button" class="button primary" id="welcome-start">Back to drawing</button></div>`, 'THANK YOU');
  d.$('modal').classList.add('welcome-modal');
  d.$('welcome-start').onclick = () => d.$('modal').close();
  d.$('welcome-account').onclick = () => accountDialog({ section: 'usage' });
  d.$('welcome-start').focus();
}

export async function accountDialog({ notice = '', section } = {}) {
  if (!isCloudEdition()) return;
  const account = await refreshAccount() || currentAccount();
  if (!account?.signedIn) return signInDialog(account, notice);
  if (section) page = section;
  d.openDialog('Your account', `${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
    <div class="acct">
      <nav class="acct-nav" aria-label="Account sections">${SECTIONS.map(([id, label, glyph]) => `<button type="button" data-section="${id}">${d.icon(glyph)}<span>${label}</span></button>`).join('')}</nav>
      <div class="acct-main" id="acct-main" tabindex="-1"></div>
    </div>`, 'PIXEL STUDIO CLOUD');
  d.$('modal').classList.add('account-page-modal');
  for (const button of d.$('modal-content').querySelectorAll('[data-section]')) button.onclick = () => showSection(button.dataset.section, { focus: true });
  showSection(page);
}

const SECTIONS = [
  ['overview', 'Overview', 'grid'], ['usage', 'Usage', 'timing'], ['ai', 'Your own AI', 'spark'],
  ['plan', 'Plan & billing', 'layers'], ['projects', 'Cloud projects', 'folder'], ['data', 'Your data', 'file'],
];
let page = 'overview', usageDays = 30;

function showSection(id, { focus = false } = {}) {
  const main = d.$('acct-main'), account = currentAccount();
  if (!main || !account?.signedIn) return;
  page = SECTIONS.some(([key]) => key === id) ? id : 'overview';
  for (const button of d.$('modal-content').querySelectorAll('[data-section]')) button.setAttribute('aria-current', String(button.dataset.section === page));
  main.innerHTML = { overview: overviewHTML, usage: () => '<div id="acct-usage"><p class="field-hint">Loading usage…</p></div>', ai: aiKeysHTML, plan: planHTML, projects: projectsHTML, data: dataHTML }[page](account);
  main.scrollTop = 0;
  if (focus) main.focus({ preventScroll: true });
  wireSection(account);
}

const nextRefill = () => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(); };
const subscriptionLine = account => {
  const sub = account.subscription;
  if (!sub || account.plan !== 'pro') return '';
  if (sub.status === 'past_due') return 'Payment failed: update your card under Billing.';
  if (sub.endsAt) return `Cancelled: Pro until ${date(sub.endsAt)}.`;
  return sub.renewsAt ? `Renews ${date(sub.renewsAt)}.` : '';
};
const ownKeyFor = (account, provider) => (account.aiKeys || []).find(k => k.provider === provider);

function creditsCard(account) {
  const { credits } = account, share = credits.monthly ? Math.min(100, Math.round(credits.allowance / credits.monthly * 100)) : 0;
  if (!planAllows(account.plan, 'ai') && !credits.balance) return `<div class="acct-card"><h4>AI credits</h4><p class="acct-big">–</p><p class="acct-sub">AI is part of Pro: 1,000 credits every month.</p></div>`;
  return `<div class="acct-card"><h4>AI credits left</h4><p class="acct-big">${credits.balance.toLocaleString()}</p>
    <div class="credit-meter" role="meter" aria-valuemin="0" aria-valuemax="${credits.monthly}" aria-valuenow="${credits.allowance}" aria-label="Monthly credits left"><i style="width:${share}%"></i></div>
    <p class="acct-sub">${credits.allowance.toLocaleString()} of ${credits.monthly.toLocaleString()} monthly · refills ${date(nextRefill())}${credits.purchased ? `<br>+ ${credits.purchased.toLocaleString()} bought, never expire` : ''}</p></div>`;
}

function overviewHTML(account) {
  const plan = planFor(account.plan), used = (account.usage || []).reduce((sum, u) => ({ requests: sum.requests + u.requests, credits: sum.credits + (u.credits || 0) }), { requests: 0, credits: 0 });
  const keys = (account.aiKeys || []).map(k => k.provider === 'openai' ? 'OpenAI' : 'Gemini');
  return `
    <div class="acct-profile">
      <span class="acct-avatar" aria-hidden="true">${esc(account.email[0].toUpperCase())}</span>
      <div><strong>${esc(account.email)}</strong><small>${account.memberSince ? `Member since ${date(new Date(account.memberSince).toISOString())}` : ''}</small></div>
      <span class="plan-badge" data-plan="${esc(account.plan)}">${esc(plan.name)}</span>
    </div>
    ${subscriptionLine(account) ? `<p class="acct-note">${esc(subscriptionLine(account))}</p>` : ''}
    <div class="acct-cards">
      ${creditsCard(account)}
      <div class="acct-card"><h4>AI this month</h4><p class="acct-big">${used.requests.toLocaleString()}</p><p class="acct-sub">request${used.requests === 1 ? '' : 's'} · ${used.credits.toLocaleString()} credits used</p><button type="button" class="text-button" data-go="usage">See usage →</button></div>
      <div class="acct-card"><h4>Cloud projects</h4><p class="acct-big">${account.projects}<small> / ${plan.cloudProjects}</small></p><p class="acct-sub">up to ${plan.projectBytes / 1024 / 1024} MB each</p><button type="button" class="text-button" data-go="projects">Manage →</button></div>
      <div class="acct-card"><h4>Your own AI</h4><p class="acct-big acct-mid">${keys.length ? esc(keys.join(' + ')) : 'Not set'}</p><p class="acct-sub">${keys.length ? 'Requests with your key use no credits.' : planAllows(account.plan, 'ownKeys') ? 'Add an OpenAI or Gemini key to use AI without credits.' : 'Pro: use your own OpenAI or Gemini key.'}</p><button type="button" class="text-button" data-go="ai">${keys.length ? 'Manage keys' : 'Set up'} →</button></div>
    </div>
    ${account.plan === 'free' ? `<div class="acct-upsell"><div><strong>Get more with Pro</strong><p>1,000 AI credits every month, your own AI keys, sprite sheets, GIF and APNG export and 200 cloud projects.</p></div><button type="button" class="button primary" data-go="plan">See Pro</button></div>` : ''}
    <div class="modal-actions left"><button type="button" class="button subtle" id="cloud-signout">Sign out</button>${account.supportEmail ? `<a class="button subtle" href="mailto:${esc(account.supportEmail)}">Contact support</a>` : ''}</div>`;
}

async function renderUsage() {
  const box = d.$('acct-usage');
  if (!box) return;
  let stats;
  try { stats = await fetchUsage(usageDays); } catch (error) { box.innerHTML = `<p class="field-hint">${esc(error.message)}</p>`; return; }
  if (!box.isConnected) return;
  const days = [], byDay = new Map(stats.days.map(day => [day.day, day]));
  for (let i = 0; i < usageDays; i++) {
    const day = new Date(stats.since + i * 86_400_000).toISOString().slice(0, 10);
    days.push(byDay.get(day) || { day, requests: 0, credits: 0, ownKeyRequests: 0 });
  }
  const peak = Math.max(1, ...days.map(day => day.requests)), t = stats.total, label = day => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const stat = (value, name) => `<div class="acct-stat"><strong>${value}</strong><span>${name}</span></div>`;
  box.innerHTML = `
    <div class="acct-stats">
      ${stat(t.requests.toLocaleString(), 'AI requests')}${stat(t.credits.toLocaleString(), 'credits used')}${stat(t.images.toLocaleString(), 'images')}
      ${stat(compact(t.inputTokens + t.outputTokens), 'tokens')}${stat(t.ownKeyRequests.toLocaleString(), 'with your key')}
    </div>
    <div class="usage-chart" role="img" aria-label="AI requests per day over the last ${usageDays} days">
      ${days.map(day => `<span title="${esc(label(day.day))}: ${day.requests} request${day.requests === 1 ? '' : 's'}, ${day.credits} credits${day.ownKeyRequests ? `, ${day.ownKeyRequests} with your key` : ''}"><i class="paid" style="height:${(day.requests - day.ownKeyRequests) / peak * 100}%"></i><i class="own" style="height:${day.ownKeyRequests / peak * 100}%"></i></span>`).join('')}
    </div>
    <div class="usage-axis"><span>${esc(label(days[0].day))}</span><span>${esc(label(days.at(-1).day))}</span></div>
    <p class="usage-legend"><i class="paid"></i>Paid with credits <i class="own"></i>Your own key</p>
    ${stats.models.length ? `<table class="acct-table"><thead><tr><th>Model</th><th>Requests</th><th>Tokens in</th><th>Tokens out</th><th>Credits</th></tr></thead><tbody>
      ${stats.models.map(m => `<tr><td>${esc(modelName(m))}</td><td>${m.requests.toLocaleString()}</td><td>${m.kind === 'image' ? '–' : compact(m.inputTokens)}</td><td>${m.kind === 'image' ? '–' : compact(m.outputTokens)}</td><td>${m.credits.toLocaleString()}</td></tr>`).join('')}
    </tbody></table>` : `<p class="acct-empty">No AI requests in the last ${usageDays} days.</p>`}
    <p class="field-hint">This month: ${stats.month.requests.toLocaleString()} requests, ${stats.month.credits.toLocaleString()} credits. Since you joined: ${stats.lifetime.requests.toLocaleString()} requests.</p>
    <p class="field-hint">One credit is about $0.002 of AI cost. A typical assistant reply costs 2–10 credits, an AI edit 5–40 and an image 6–84 (by quality). Requests made with your own key are free here; your provider bills you.</p>`;
}
const compact = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString();
const modelName = m => m.kind === 'image' ? `Images · ${m.model.replace('/', ' ')}` : (CHAT_MODELS[m.model]?.name || m.model);

const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', uses: 'Assistant, AI edit and image generation', placeholder: 'sk-…', where: 'https://platform.openai.com/api-keys', whereLabel: 'platform.openai.com' },
  { id: 'gemini', name: 'Google Gemini', uses: 'Image generation', placeholder: 'AIza…', where: 'https://aistudio.google.com/apikey', whereLabel: 'aistudio.google.com' },
];
function aiKeysHTML(account) {
  const allowed = planAllows(account.plan, 'ownKeys');
  return `
    <h3 class="acct-h">Bring your own AI</h3>
    <p class="acct-lead">Use your own OpenAI or Google Gemini API key. Requests that use your key spend no credits: your provider bills you directly, at their prices. Your credits stay for everything else.</p>
    ${!account.ownKeys ? '<div class="notice">Your own AI keys are not available on this server yet.</div>' : !allowed ? `<div class="acct-upsell"><div><strong>Part of Pro</strong><p>Upgrade to use your own keys, with no limit from us on how much you use.</p></div><button type="button" class="button primary" data-go="plan">See Pro</button></div>` : ''}
    <div class="acct-keys">
      ${PROVIDERS.map(p => { const saved = ownKeyFor(account, p.id); return `<form class="acct-key${saved ? ' set' : ''}" data-provider="${p.id}">
        <div class="acct-key-head"><div><strong>${p.name}</strong><small>${p.uses}</small></div><span class="acct-key-status">${saved ? `${d.icon('check')} ${esc(saved.hint)} · added ${date(new Date(saved.addedAt).toISOString())}` : 'Not added'}</span></div>
        <div class="acct-key-row"><input type="password" name="key" autocomplete="off" spellcheck="false" placeholder="${saved ? 'Paste a new key to replace it' : p.placeholder}" aria-label="${p.name} API key"${allowed && account.ownKeys ? '' : ' disabled'}>
          <button type="submit" class="button primary"${allowed && account.ownKeys ? '' : ' disabled'}>Check &amp; save</button>${saved ? '<button type="button" class="button danger" data-remove>Remove</button>' : ''}</div>
        <p class="acct-key-msg" role="status"></p>
        <p class="field-hint">Create a key at <a href="${p.where}" target="_blank" rel="noopener noreferrer">${p.whereLabel} ↗</a>. Set a spending limit there to stay in control.</p>
      </form>`; }).join('')}
    </div>
    <p class="field-hint">Keys are checked with the provider before saving, stored encrypted, used only for your own requests and never shown again. Removing a key deletes it from our servers.</p>`;
}

function limitsHTML(account) {
  const yes = d.icon('check'), no = '<span class="acct-no">–</span>', mb = bytes => `${bytes / 1024 / 1024} MB`;
  const rows = [
    ['AI credits every month', p => p.monthlyCredits ? p.monthlyCredits.toLocaleString() : no],
    ['Projects in the cloud', p => p.cloudProjects.toLocaleString()],
    ['Size per cloud project', p => mb(p.projectBytes)],
    ...Object.entries(PRO_FEATURES).map(([key, label]) => [label, p => p.allows.includes(key) ? yes : no]),
  ];
  const plans = Object.values(PLANS);
  return `<table class="acct-table acct-limits"><thead><tr><th>Limits</th>${plans.map(p => `<th${p.id === account.plan ? ' class="current"' : ''}>${esc(p.name)}${p.id === account.plan ? ' <small>(you)</small>' : ''}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(([label, cell]) => `<tr><td>${esc(label)}</td>${plans.map(p => `<td${p.id === account.plan ? ' class="current"' : ''}>${cell(p)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function planHTML(account) {
  const plan = planFor(account.plan);
  return `
    <h3 class="acct-h">Plan &amp; billing</h3>
    <div class="acct-current"><div><span class="plan-badge" data-plan="${esc(account.plan)}">${esc(plan.name)}</span>${plan.price.monthly ? ` <strong>${formatPrice(plan.price.monthly)}/month</strong>` : ''}<p>${esc(subscriptionLine(account) || (account.plan === 'free' ? 'Free forever. Upgrade any time; cancel any time.' : ''))}</p></div>
      ${account.canManageBilling ? '<button type="button" class="button" id="cloud-billing">Billing, invoices &amp; cancel ↗</button>' : ''}</div>
    ${account.plan === 'free' ? plansHTML(account) : ''}
    ${account.billing && planAllows(account.plan, 'creditPacks') ? `<div class="acct-packs"><div><strong>Need more credits?</strong><p>Bought credits never expire and are used after your monthly credits.</p></div>${account.packs.map(p => `<button type="button" class="button" data-checkout="${esc(p.id)}">Buy ${p.credits.toLocaleString()} credits · ${formatPrice(p.price)}</button>`).join('')}</div>` : ''}
    ${limitsHTML(account)}
    <p class="field-hint">Payments are handled securely by Stripe. Any VAT or sales tax is calculated at checkout.</p>`;
}

function projectsHTML() {
  return `
    <h3 class="acct-h">Cloud projects</h3>
    <p class="acct-lead">Projects saved here open on any device where you sign in. Projects on this device are not uploaded unless you save them here.</p>
    <div class="modal-actions left"><button type="button" class="button primary" id="cloud-save-current">Save “${esc(d.state.project.name)}” to the cloud</button></div>
    <div id="cloud-projects" class="cloud-projects" aria-live="polite"><p class="field-hint">Loading…</p></div>`;
}

function dataHTML(account) {
  return `
    <h3 class="acct-h">Your data</h3>
    <p class="acct-lead">Download everything stored for your account: profile, plan, usage, key hints (never the keys) and cloud projects.</p>
    <div class="modal-actions left"><a class="button" href="/api/account/export" download>Download my data</a></div>
    <div class="acct-danger"><strong>Delete account</strong><p>Deletes your account, its cloud projects, saved AI keys and remaining credits. Projects on this device stay. ${account.plan === 'pro' ? 'Cancel Pro under Plan &amp; billing first.' : ''}</p><button type="button" class="button danger" id="cloud-delete">Delete account…</button></div>
    <div class="modal-actions left"><button type="button" class="button subtle" id="cloud-signout">Sign out</button></div>`;
}

function wireSection(account) {
  const root = d.$('acct-main');
  const busy = async (button, work) => {
    button.disabled = true;
    try { await work(); } catch (error) { d.toast(error.message); } finally { if (button.isConnected) button.disabled = false; }
  };
  for (const button of root.querySelectorAll('[data-go]')) button.onclick = () => showSection(button.dataset.go, { focus: true });
  for (const button of root.querySelectorAll('[data-checkout]')) button.onclick = () => busy(button, () => startCheckout(button.dataset.checkout));
  const billing = root.querySelector('#cloud-billing');
  if (billing) billing.onclick = () => busy(billing, openBillingPortal);
  const signout = root.querySelector('#cloud-signout');
  if (signout) signout.onclick = () => busy(signout, async () => { await signOut(); d.$('modal').close(); d.toast('Signed out. Your projects on this device are still here.'); });
  const save = root.querySelector('#cloud-save-current');
  if (save) { save.onclick = () => busy(save, saveCurrent); renderProjects(); }
  const remove = root.querySelector('#cloud-delete');
  if (remove) remove.onclick = () => {
    const typed = prompt(`This deletes your account, its cloud projects, saved AI keys and remaining credits. It cannot be undone.\n\nType ${account.email} to confirm.`);
    if (typed === null) return;
    busy(remove, async () => { await deleteAccount(typed.trim().toLowerCase()); d.$('modal').close(); d.toast('Your account has been deleted.'); });
  };
  if (page === 'usage') {
    const box = d.$('acct-usage');
    box.insertAdjacentHTML('beforebegin', `<div class="acct-toolbar"><h3 class="acct-h">Usage</h3><div class="acct-range" role="group" aria-label="Period">${[7, 30, 90].map(n => `<button type="button" data-days="${n}" aria-pressed="${n === usageDays}">${n} days</button>`).join('')}</div></div>`);
    for (const button of root.querySelectorAll('[data-days]')) button.onclick = () => {
      usageDays = Number(button.dataset.days);
      for (const other of root.querySelectorAll('[data-days]')) other.setAttribute('aria-pressed', String(other === button));
      renderUsage();
    };
    renderUsage();
  }
  for (const form of root.querySelectorAll('.acct-key')) {
    const provider = form.dataset.provider, message = form.querySelector('.acct-key-msg');
    const run = (key, button) => busy(button, async () => {
      message.textContent = key ? 'Checking the key with the provider…' : 'Removing…'; message.dataset.state = '';
      try {
        await saveAiKey(provider, key);
        showSection('ai');
        d.toast(key ? `Your ${provider === 'openai' ? 'OpenAI' : 'Gemini'} key works and is saved. AI requests now use it.` : 'Key removed. AI uses your credits again.');
      } catch (error) { message.textContent = error.message; message.dataset.state = 'error'; }
    });
    form.onsubmit = event => {
      event.preventDefault();
      const key = form.elements.key.value.trim();
      if (!key) { message.textContent = 'Paste your API key first.'; message.dataset.state = 'error'; return; }
      run(key, form.querySelector('[type=submit]'));
    };
    const removeKey = form.querySelector('[data-remove]');
    if (removeKey) removeKey.onclick = () => { if (confirm('Remove this key? AI requests will use your credits again.')) run('', removeKey); };
  }
}

function plansHTML(account, { actions = true } = {}) {
  const billing = account?.billing, current = account?.plan;
  const card = plan => `<div class="plan-card${plan.id === 'pro' ? ' featured' : ''}${plan.id === current ? ' current' : ''}">
    <h3>${esc(plan.name)}</h3>
    <p class="plan-price">${plan.price.monthly ? `${formatPrice(plan.price.monthly)}<small>/month</small>` : 'Free'}${plan.price.yearly ? `<span>or ${formatPrice(plan.price.yearly)}/year (save ${Math.round((1 - plan.price.yearly / (plan.price.monthly * 12)) * 100)}%)</span>` : '<span>forever</span>'}</p>
    <ul>${plan.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
    ${plan.id === current ? '<p class="plan-current">Your plan</p>' : ''}
    ${actions && plan.id === 'pro' && current === 'free' ? (billing
      ? '<div class="plan-buy"><button type="button" class="button primary" data-checkout="pro-monthly">Upgrade · monthly</button><button type="button" class="button" data-checkout="pro-yearly">Yearly</button></div>'
      : '<p class="plan-current">Payments open soon.</p>') : ''}
  </div>`;
  return `<div class="plan-grid">${Object.values(PLANS).map(card).join('')}</div>`;
}

function signInDialog(account, notice) {
  d.openDialog('Sign in to Pixel Studio Cloud', `
    ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
    <p class="modal-body-text">The editor works without an account. Sign in to use AI without your own API key and to keep projects in the cloud. We email you a link; no password needed.</p>
    <form id="cloud-signin" class="cloud-signin">
      <label class="field"><span class="field-label">Email</span><input id="cloud-email" type="email" required autocomplete="email" placeholder="you@example.com" maxlength="254"></label>
      <button type="submit" class="button primary" id="cloud-send">Email me a sign-in link</button>
    </form>
    <p id="cloud-signin-status" class="field-hint" role="status"></p>
    ${plansHTML(account, { actions: false })}`, 'PIXEL STUDIO CLOUD');
  d.$('modal').classList.add('wide');
  d.$('cloud-signin').onsubmit = async event => {
    event.preventDefault();
    const email = d.$('cloud-email').value.trim(), status = d.$('cloud-signin-status'), send = d.$('cloud-send');
    send.disabled = true; status.textContent = 'Sending…';
    try {
      const sent = await sendSignInLink(email);
      status.innerHTML = sent.devLink
        ? `<strong>Development server:</strong> no email provider is set up (RESEND_API_KEY), so nothing was sent. <a href="${esc(sent.devLink)}">Open the sign-in link</a>.`
        : `<strong>Check your inbox.</strong> We sent a sign-in link to ${esc(email)}. It works once, for 15 minutes. You can close this window.`;
    } catch (error) { status.textContent = error.message; send.disabled = false; }
  };
  d.$('cloud-email').focus();
}

async function saveCurrent() {
  if (d.finishDrawing?.()) d.renderAll?.();
  const id = cloudIdFor(d.state.documentId, true), project = d.state.project;
  const saved = await saveCloudProject(id, project.name, packProject(project));
  d.toast(`“${saved.name}” saved to the cloud (${kb(saved.bytes)}).`);
  renderProjects();
}

async function renderProjects() {
  const box = d.$('cloud-projects');
  if (!box) return;
  let list;
  try { list = await listCloudProjects(); } catch (error) { box.innerHTML = `<p class="field-hint">${esc(error.message)}</p>`; return; }
  if (!box.isConnected) return;
  const current = cloudIdFor(d.state.documentId);
  box.innerHTML = list.projects.length
    ? `<p class="field-hint">${list.projects.length} of ${list.limit} projects</p><ul>${list.projects.map(p => `<li${p.id === current ? ' class="current"' : ''}><span><strong>${esc(p.name)}</strong><small>${kb(p.bytes)} · saved ${esc(when(p.updatedAt))}${p.id === current ? ' · this tab' : ''}</small></span><button type="button" class="button subtle" data-open="${esc(p.id)}">Open</button><button type="button" class="icon-button" data-delete="${esc(p.id)}" title="Delete from the cloud" aria-label="Delete ${esc(p.name)} from the cloud">✕</button></li>`).join('')}</ul>`
    : '<p class="field-hint">No cloud projects yet.</p>';
  for (const button of box.querySelectorAll('[data-open]')) button.onclick = async () => {
    button.disabled = true;
    try {
      const saved = await loadCloudProject(button.dataset.open);
      d.$('modal').close();
      d.openProject(unpackProject(saved.data), `“${saved.name}” opened from the cloud.`);
      linkCloudId(d.state.documentId, saved.id);
    } catch (error) { d.toast(error.message); button.disabled = false; }
  };
  for (const button of box.querySelectorAll('[data-delete]')) button.onclick = async () => {
    const name = list.projects.find(p => p.id === button.dataset.delete)?.name;
    if (!confirm(`Delete “${name}” from the cloud? Copies on your devices stay.`)) return;
    try { await deleteCloudProject(button.dataset.delete); renderProjects(); } catch (error) { d.toast(error.message); }
  };
}
