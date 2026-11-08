/**
 * Browser side of Pixel Studio Cloud (the hosted edition). The cloud server adds <meta name="pixel-studio-cloud">
 * to index.html; everywhere else (GitHub Pages, Pixel Studio Local, file previews) these features stay hidden.
 */
import { planAllows } from './plans.js';

export const isCloudEdition = () => typeof document !== 'undefined' && !!document.querySelector('meta[name="pixel-studio-cloud"]');

let account = null;
const listeners = new Set();

export const currentAccount = () => account;
/** Whether a Pro feature is available: always outside the hosted edition, otherwise only on a plan that includes it. */
export const cloudAllows = feature => !isCloudEdition() || planAllows(account?.plan || 'free', feature);
export function onAccountChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function publish(next) { account = next; for (const listener of listeners) listener(account); return account; }

async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && account?.csrfToken) headers['X-Pixel-Studio-Token'] = account.csrfToken;
  let response;
  try { response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error('Pixel Studio Cloud could not be reached. Check your connection.'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || `Request failed (${response.status}).`), { code: result.code, status: response.status });
  return result;
}

export async function refreshAccount() {
  if (!isCloudEdition()) return null;
  try { return publish(await request('/api/account/me')); } catch { return account; }
}
/** Applies a { used, balance } credit update from an AI response without another round trip. */
export function noteCredits(update) {
  if (!account?.signedIn || !update || typeof update.balance !== 'number') return;
  const allowance = Math.max(0, Math.min(account.credits.allowance, update.balance - account.credits.purchased));
  publish({ ...account, credits: { ...account.credits, balance: update.balance, allowance, purchased: update.balance - allowance } });
}

export const sendSignInLink = email => request('/api/account/login', { method: 'POST', body: { email } });
export async function signOut() { await request('/api/account/logout', { method: 'POST' }); return refreshAccount(); }
export async function deleteAccount(confirm) { await request('/api/account/delete', { method: 'POST', body: { confirm } }); return refreshAccount(); }
export const fetchUsage = days => request(`/api/account/usage?days=${encodeURIComponent(days)}`);
/** Saves (after the server checked it with the provider) or, with an empty key, removes the user's own AI key. */
export async function saveAiKey(provider, key) { const result = await request('/api/account/ai-key', { method: 'POST', body: { provider, key } }); await refreshAccount(); return result; }
export async function confirmCheckout(sessionId) { return request('/api/billing/confirm', { method: 'POST', body: { sessionId } }); }
export async function startCheckout(product) { const { url } = await request('/api/billing/checkout', { method: 'POST', body: { product } }); location.assign(url); }
export async function openBillingPortal() { const { url } = await request('/api/billing/portal'); window.open(url, '_blank', 'noopener'); }

export const listCloudProjects = () => request('/api/cloud/projects');
export const loadCloudProject = id => request(`/api/cloud/projects/${encodeURIComponent(id)}`);
export const saveCloudProject = (id, name, data) => request(`/api/cloud/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: { name, data } });
export const deleteCloudProject = id => request(`/api/cloud/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });

const LINKS = 'pixel-studio.cloud-links.v1';
/** Which cloud project a local document was last saved to, so saving again updates it instead of adding a copy. */
export function cloudIdFor(documentId, create = false) {
  let links = {};
  try { links = JSON.parse(localStorage.getItem(LINKS) || '{}') || {}; } catch { links = {}; }
  if (!links[documentId] && create) {
    links[documentId] = `p-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    try { localStorage.setItem(LINKS, JSON.stringify(links)); } catch { /* private mode: a new copy each time */ }
  }
  return links[documentId] || null;
}
export function linkCloudId(documentId, cloudId) {
  let links = {};
  try { links = JSON.parse(localStorage.getItem(LINKS) || '{}') || {}; } catch { links = {}; }
  links[documentId] = cloudId;
  try { localStorage.setItem(LINKS, JSON.stringify(links)); } catch { /* ignore */ }
}
