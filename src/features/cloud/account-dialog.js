/**
 * Account dialog for Pixel Studio Cloud: email sign-in, plan and AI credits, upgrades and credit packs (Lemon Squeezy
 * checkout), the billing portal, cloud projects, data export and account deletion. Only shown in the hosted edition.
 */
import { packProject, unpackProject } from '../../domain/versions.js';
import { PLANS, formatPrice, planAllows } from './plans.js';
import {
  isCloudEdition, currentAccount, refreshAccount, onAccountChange, noteCredits, sendSignInLink, signOut, deleteAccount,
  startCheckout, openBillingPortal, listCloudProjects, loadCloudProject, saveCloudProject, deleteCloudProject, cloudIdFor, linkCloudId,
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
  const signin = params.get('signin'), billing = params.get('billing'), upgrade = params.get('upgrade');
  if (!signin && !billing && !upgrade) return;
  params.delete('signin'); params.delete('billing'); params.delete('upgrade');
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
  if (signin === 'ok') d.toast(`Signed in as ${currentAccount()?.email || 'you'}.`);
  // A signed-out visitor who chose "Get Pro" signs in first; show the plans when they come back.
  const INTENT = 'pixel-studio.upgrade-intent';
  if (upgrade && !currentAccount()?.signedIn) { try { sessionStorage.setItem(INTENT, '1'); } catch { /* ignore */ } }
  let wantsPro = !!upgrade;
  if (signin === 'ok') { try { wantsPro = sessionStorage.getItem(INTENT) === '1'; sessionStorage.removeItem(INTENT); } catch { /* ignore */ } }
  if (wantsPro && currentAccount()?.plan !== 'pro') accountDialog();
  if (signin === 'expired') accountDialog({ notice: 'That sign-in link has expired or was already used. Ask for a new one below.' });
  if (billing === 'done') {
    d.toast('Thank you! Your purchase is being confirmed…');
    // The webhook usually lands within seconds of the redirect.
    let tries = 0;
    const before = JSON.stringify(currentAccount()?.credits) + currentAccount()?.plan;
    const poll = setInterval(async () => {
      const now = await refreshAccount();
      if (++tries > 10 || JSON.stringify(now?.credits) + now?.plan !== before) {
        clearInterval(poll);
        if (tries <= 10) d.toast(now?.plan === 'pro' ? 'Pro is active. Enjoy!' : 'Your credits have been added.');
      }
    }, 3000);
  }
}

export async function accountDialog({ notice = '' } = {}) {
  if (!isCloudEdition()) return;
  const account = await refreshAccount() || currentAccount();
  if (!account?.signedIn) return signInDialog(account, notice);
  d.openDialog('Your account', accountHTML(account, notice), 'PIXEL STUDIO CLOUD');
  d.$('modal').classList.add('wide');
  wireAccount(account);
  renderProjects();
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

function accountHTML(account, notice) {
  const { credits, subscription: sub } = account, plan = PLANS[account.plan] || PLANS.free;
  const share = credits.monthly ? Math.min(100, Math.round(credits.allowance / credits.monthly * 100)) : 0;
  const usage = (account.usage || []).map(u => `${u.requests} ${u.kind === 'image' ? 'image' : 'AI'} request${u.requests === 1 ? '' : 's'} (${u.credits} credits)`).join(' · ');
  const subLine = sub && account.plan === 'pro'
    ? sub.status === 'cancelled' ? `Cancelled · Pro until ${date(sub.endsAt)}` : sub.status === 'past_due' ? 'Payment failed · update your card under Billing' : sub.renewsAt ? `Renews ${date(sub.renewsAt)}` : ''
    : '';
  return `
    ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
    <div class="account-head"><div><strong>${esc(account.email)}</strong><span class="plan-badge" data-plan="${esc(account.plan)}">${esc(plan.name)}</span>${subLine ? `<small>${esc(subLine)}</small>` : ''}</div>
      <div class="account-head-actions">${account.canManageBilling ? '<button type="button" class="button subtle" id="cloud-billing">Billing &amp; invoices</button>' : ''}<button type="button" class="button subtle" id="cloud-signout">Sign out</button></div></div>
    ${planAllows(account.plan, 'ai') || credits.balance > 0 ? `<section class="account-section"><h3>AI credits</h3>
      <div class="credit-meter" role="meter" aria-valuemin="0" aria-valuemax="${credits.monthly}" aria-valuenow="${credits.allowance}" aria-label="Monthly credits left"><i style="width:${share}%"></i></div>
      <p class="field-hint"><strong>${credits.balance.toLocaleString()}</strong> credits left: ${credits.allowance.toLocaleString()} of ${credits.monthly.toLocaleString()} monthly (refills on the 1st)${credits.purchased ? ` + ${credits.purchased.toLocaleString()} bought (never expire)` : ''}.${usage ? ` This month: ${esc(usage)}.` : ''}</p>
      <p class="field-hint">A typical assistant reply costs 2–10 credits, an AI edit 5–40 and an image 6–84 (by quality).</p>
      ${account.billing && planAllows(account.plan, 'creditPacks') ? `<div class="modal-actions left">${account.packs.map(p => `<button type="button" class="button" data-checkout="${esc(p.id)}">Buy ${p.credits.toLocaleString()} credits · ${formatPrice(p.price)}</button>`).join('')}</div>` : ''}
    </section>` : ''}
    ${account.plan === 'free' ? `<section class="account-section"><h3>Plans</h3>${plansHTML(account)}</section>` : ''}
    <section class="account-section"><h3>Cloud projects</h3>
      <p class="field-hint">Projects saved here open on any device where you sign in. Your projects on this device are not uploaded unless you save them here.</p>
      <div class="modal-actions left"><button type="button" class="button primary" id="cloud-save-current">Save “${esc(d.state.project.name)}” to the cloud</button></div>
      <div id="cloud-projects" class="cloud-projects" aria-live="polite"><p class="field-hint">Loading…</p></div>
    </section>
    <details class="account-section account-danger"><summary>Your data</summary>
      <p class="field-hint">Download everything stored for your account, or delete the account with its cloud projects. Projects on this device stay.</p>
      <div class="modal-actions left"><a class="button" href="/api/account/export" download>Download my data</a><button type="button" class="button danger" id="cloud-delete">Delete account…</button></div>
    </details>
    ${account.supportEmail ? `<p class="field-hint">Questions? <a href="mailto:${esc(account.supportEmail)}">${esc(account.supportEmail)}</a></p>` : ''}`;
}

function wireAccount(account) {
  const busy = async (button, work) => {
    button.disabled = true;
    try { await work(); } catch (error) { d.toast(error.message); } finally { if (button.isConnected) button.disabled = false; }
  };
  for (const button of d.$('modal-content').querySelectorAll('[data-checkout]')) button.onclick = () => busy(button, () => startCheckout(button.dataset.checkout));
  const billing = d.$('cloud-billing');
  if (billing) billing.onclick = () => busy(billing, openBillingPortal);
  d.$('cloud-signout').onclick = () => busy(d.$('cloud-signout'), async () => { await signOut(); d.$('modal').close(); d.toast('Signed out. Your projects on this device are still here.'); });
  d.$('cloud-save-current').onclick = () => busy(d.$('cloud-save-current'), saveCurrent);
  d.$('cloud-delete').onclick = () => {
    const typed = prompt(`This deletes your account, its cloud projects and remaining credits. It cannot be undone.\n\nType ${account.email} to confirm.`);
    if (typed === null) return;
    busy(d.$('cloud-delete'), async () => { await deleteAccount(typed.trim().toLowerCase()); d.$('modal').close(); d.toast('Your account has been deleted.'); });
  };
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
