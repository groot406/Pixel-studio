// Fills the marketing page (public/landing.html) with pricing from the shared plan table, so the page always
// matches what the account dialog shows and what the server enforces.
import { PLANS, CREDIT_PACKS, formatPrice } from '../src/features/cloud/plans.js';

const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function pricingHTML() {
  const card = plan => {
    const free = plan.price.monthly === 0;
    const saving = free ? 0 : Math.round((1 - plan.price.yearly / (plan.price.monthly * 12)) * 100);
    return `<article class="price-card${free ? '' : ' featured'}">
      <h3>${escapeHTML(plan.name)}</h3>
      <p class="price">${free ? formatPrice(0) : `${formatPrice(plan.price.monthly)}<small>/month</small>`}</p>
      <p class="price-alt">${free ? 'Forever' : `or ${formatPrice(plan.price.yearly)}/year${saving > 0 ? ` (save ${saving}%)` : ''}`}</p>
      <ul>${plan.features.map(feature => `<li>${escapeHTML(feature)}</li>`).join('')}</ul>
      <a class="button${free ? '' : ' primary'} large" href="./app${free ? '' : '?upgrade=pro'}">${free ? 'Start drawing' : `Get ${escapeHTML(plan.name)}`}</a>
    </article>`;
  };
  const packs = CREDIT_PACKS.map(pack => `${pack.credits.toLocaleString('en')} AI credits for ${formatPrice(pack.price)}`).join(' or ');
  return `<div class="price-grid">${Object.values(PLANS).map(card).join('')}</div>
    ${packs ? `<p class="pack-note">Need more AI? Pro members can add ${escapeHTML(packs)}. Extra credits never expire.</p>` : ''}`;
}

export function renderLanding(template, { supportEmail = '' } = {}) {
  return template
    .replace('<!--pricing-->', pricingHTML())
    .replace('<!--support-->', supportEmail ? `<a href="mailto:${escapeHTML(supportEmail)}">Support</a>` : '');
}
