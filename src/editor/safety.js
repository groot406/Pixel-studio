/**
 * Crash safety: recovery journals (a packed copy of each project with unsaved changes, written synchronously to
 * localStorage, or to the browser database when that is full), a per-tab heartbeat to spot sessions that ended
 * without saving, the "Recover unsaved work" banner, and the global "Something went wrong" toast.
 */
import { encodeAIProject } from '../formats/pxa.js';
import { validateProject, compositeFrame } from '../domain/project.js';
import { sameValue } from '../domain/history.js';
import { orphanedJournals, versionTime, packProject, unpackProject, DAY } from '../domain/versions.js';

const JOURNAL = 'pixel-studio.journal.', BEATS = 'pixel-studio.heartbeats', BEAT_MS = 5000;
let d, sessionId, warnedQuota = false, lastError = 0;
const databaseJournals = new Set(), journaled = new Map(), queue = [];
export const encodeProject = project => encodeAIProject(project, { version: project.version === 3 ? 2 : 1 });

function readBeats() { try { return JSON.parse(localStorage.getItem(BEATS) || '{}') || {}; } catch { return {}; } }
/** Record that this tab is alive (or, when closing cleanly, remove it); stale beats from old sessions are pruned. */
function beat(alive = true) {
  try {
    const beats = readBeats(), now = Date.now();
    for (const [id, at] of Object.entries(beats)) if (!(now - at < DAY)) delete beats[id];
    if (alive) beats[sessionId] = now; else delete beats[sessionId];
    localStorage.setItem(BEATS, JSON.stringify(beats));
  } catch { /* Without localStorage the database journal still works; recovery just cannot tell live tabs apart. */ }
}

/** A non-blocking toast with buttons (`[label, action]`); several stack above the plain toast and stay longer. */
export function alertToast(message, actions = [], ms = 12000) {
  let stack = document.getElementById('alert-stack');
  if (!stack) { stack = document.createElement('div'); stack.id = 'alert-stack'; stack.className = 'alert-stack'; document.body.append(stack); }
  const box = document.createElement('div');
  box.className = 'toast alert-toast'; box.setAttribute('role', 'alert');
  box.innerHTML = `<span>${d.escapeHTML(message)}</span>${actions.map((a, i) => `<button type="button" class="button small" data-alert="${i}">${d.escapeHTML(a[0])}</button>`).join('')}<button type="button" class="icon-button" data-alert="close" aria-label="Dismiss">${d.icon('close')}</button>`;
  box.onclick = event => {
    const key = event.target.closest('[data-alert]')?.dataset.alert;
    if (key === undefined) return;
    box.remove();
    if (key !== 'close') actions[+key][1]();
  };
  stack.append(box);
  setTimeout(() => box.remove(), ms);
}

/** Download the current project as PXA (works even when storage is failing). */
export function downloadBackup() {
  try { d.downloadBlob(new Blob([encodeProject(d.state.project)], { type: 'text/plain;charset=utf-8' }), `${d.fileName(d.state.project.name)}-backup.pxa`); }
  catch (error) { d.toast(`Could not create a backup: ${error.message}`); }
}

/** Synchronously keep a recovery copy of `document`; returns false when it had to go to the (asynchronous) database. */
export function writeJournal(document) {
  const entry = { documentId: document.id, sessionId, name: document.project.name, revision: document.revision, updatedAt: Date.now(), data: packProject(document.project) };
  journaled.set(document.id, document.revision);
  try {
    localStorage.setItem(JOURNAL + document.id, JSON.stringify(entry));
    if (databaseJournals.delete(document.id)) d.store()?.deleteJournal(document.id).catch(() => {});
    return true;
  } catch {
    try { localStorage.removeItem(JOURNAL + document.id); } catch { /* Nothing stored. */ }
    databaseJournals.add(document.id);
    d.store()?.saveJournal(entry).catch(() => {});
    if (!warnedQuota) {
      warnedQuota = true;
      alertToast('This device’s quick-recovery storage is full, so recovery copies now go to the browser database. Download a backup to be extra safe.', [['Download backup', downloadBackup]]);
    }
    return false;
  }
}
export function clearJournal(id) {
  journaled.delete(id);
  try { localStorage.removeItem(JOURNAL + id); } catch { /* Unavailable storage holds nothing. */ }
  if (databaseJournals.delete(id)) d.store()?.deleteJournal(id).catch(() => {});
}
/** Journal every open project with changes that are not yet in the database (on hide, close and errors; on the heartbeat once they are `minAge` ms old). */
export function flushJournals(minAge = 0) {
  const now = Date.now();
  for (const document of d.state.documents.values()) if ((document.revision !== document.savedRevision || document.saving) && journaled.get(document.id) !== document.revision && now - (document.dirtyAt || 0) >= minAge) {
    try { writeJournal(document); } catch { /* Keep going: one bad project must not block the others. */ }
  }
}

function onError(error) {
  const text = String(error?.message ?? error ?? '');
  if (/ResizeObserver loop/.test(text)) return;
  try { d.syncDocument(); flushJournals(); } catch { /* Best effort. */ }
  if (Date.now() - lastError < 8000) return;
  lastError = Date.now();
  alertToast('Something went wrong — your work is safe. You can keep editing, or download a backup.', [['Download backup', downloadBackup]]);
}

/** Start the heartbeat and global handlers. */
export function initSafety(deps) {
  d = deps;
  sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  beat(); setInterval(() => { beat(); if (!d.state.drawing) { d.syncDocument(); flushJournals(BEAT_MS); } }, BEAT_MS);
  window.addEventListener('error', event => onError(event.error || event.message));
  window.addEventListener('unhandledrejection', event => onError(event.reason));
  window.addEventListener('pagehide', () => { flushJournals(); beat(false); });
  window.addEventListener('pageshow', event => { if (event.persisted) beat(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushJournals(); });
}

/** Journals from earlier sessions that hold work newer than (different from) the saved project; matching ones are removed. */
export async function findRecoverable() {
  const entries = new Map(), add = entry => { if (entry?.documentId && !(entries.get(entry.documentId)?.updatedAt >= entry.updatedAt)) entries.set(entry.documentId, entry); };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(JOURNAL)) try { add(JSON.parse(localStorage.getItem(key))); } catch { /* Ignore unreadable entries. */ }
    }
  } catch { /* No localStorage. */ }
  try { for (const entry of await d.store().listJournals()) { databaseJournals.add(entry.documentId); add(entry); } } catch { /* No database journals. */ }
  const found = [];
  for (const entry of orphanedJournals([...entries.values()], readBeats(), Date.now(), { sessionId })) {
    let project;
    try { project = validateProject(unpackProject(entry.data)); } catch { clearJournal(entry.documentId); continue; }
    const saved = d.state.documents.get(entry.documentId)?.project || (await d.store().getDocument(entry.documentId).catch(() => null))?.project || null;
    if (saved && sameValue(saved, project)) { clearJournal(entry.documentId); continue; }
    found.push({ entry, project, saved });
  }
  return found;
}

/** Offer recovered work one project at a time: Restore (undoable), Discard (kept as a version), or Compare thumbnails. */
export function showRecovery(found) {
  queue.push(...found);
  const item = queue[0];
  let banner = document.getElementById('recovery-banner');
  if (!item) { banner?.remove(); return; }
  if (!banner) { banner = document.createElement('section'); banner.id = 'recovery-banner'; banner.className = 'recovery-banner'; banner.setAttribute('role', 'alertdialog'); banner.setAttribute('aria-labelledby', 'recovery-title'); document.body.append(banner); }
  const { entry, project, saved } = item, name = d.escapeHTML(entry.name || project.name);
  banner.innerHTML = `${d.icon('history')}<div class="recovery-text"><strong id="recovery-title">Recover unsaved work</strong><p>“${name}” has changes from ${versionTime(entry.updatedAt)} that were not saved before Pixel Studio closed.${queue.length > 1 ? ` ${queue.length - 1} more project${queue.length > 2 ? 's' : ''} after this.` : ''}</p></div>
    <div class="recovery-compare" hidden><figure><canvas data-thumb="saved"></canvas><figcaption>${saved ? 'Saved' : 'Not saved yet'}</figcaption></figure><figure><canvas data-thumb="recovered"></canvas><figcaption>Unsaved</figcaption></figure></div>
    <div class="recovery-actions"><button type="button" class="button small" data-recovery="compare" aria-expanded="false">Compare</button><button type="button" class="button small" data-recovery="discard">Discard</button><button type="button" class="button small primary" data-recovery="restore">${d.icon('undo')} Restore</button></div>`;
  const paint = (canvas, p) => { if (p) d.paintSprite(canvas, compositeFrame(p, p.animations[0].frames[0]), p.palette, true, p.width, p.height); };
  paint(banner.querySelector('[data-thumb="saved"]'), saved); paint(banner.querySelector('[data-thumb="recovered"]'), project);
  banner.onclick = async event => {
    const action = event.target.closest('[data-recovery]')?.dataset.recovery;
    if (action === 'compare') {
      const compare = banner.querySelector('.recovery-compare');
      compare.hidden = !compare.hidden; event.target.closest('button').setAttribute('aria-expanded', String(!compare.hidden));
      return;
    }
    if (!action) return;
    banner.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      if (action === 'restore') { await d.restoreRecovered(entry.documentId, project); d.toast(`Recovered “${entry.name || project.name}”. Undo goes back to the saved version.`); }
      else { await d.saveVersion({ kind: 'before', reason: 'Discarded unsaved work', project, documentId: entry.documentId }); d.toast('Discarded. A copy is kept in Version history, just in case.'); }
      clearJournal(entry.documentId);
    } catch (error) { d.toast(error.message); }
    queue.shift(); showRecovery([]);
  };
}
