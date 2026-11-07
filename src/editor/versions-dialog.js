/**
 * Version history: automatic snapshots (after 5 minutes of editing or 100 changes, and before risky operations) and
 * named versions of each project, stored packed (lossless) in the workspace database and thinned by domain/versions.js.
 */
import { validateProject, compositeFrame } from '../domain/project.js';
import { versionMeta, thinVersions, trackActivity, snapshotDue, versionTime, packProject, unpackProject } from '../domain/versions.js';
import { encodeProject } from './safety.js';

let d, previewTimer = 0;
const activity = new Map();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const versionLabel = v => v.name || (v.kind === 'before' ? v.reason : 'Automatic snapshot');
export function initVersions(deps) { d = deps; }

/** Store a version of `project` (encoded now, so later edits never leak in) and thin that project's history. Resolves to its metadata, or null. */
export async function saveVersion({ kind = 'auto', name = '', reason = '', project = d.state.project, documentId = d.state.documentId } = {}) {
  const store = d.store();
  if (!store?.saveVersion) return null;
  try {
    const data = packProject(project);
    const meta = await store.saveVersion({ ...versionMeta(project, { id: d.uid(), documentId, kind, name, reason, bytes: data.length }), data });
    const drop = thinVersions(await store.listVersions(documentId));
    if (drop.length) await store.deleteVersions(drop);
    return meta;
  } catch { return null; }
}
/** Snapshot the current project before a risky change (palette replace, templates, retarget, imports, AI edits). */
export const versionBefore = reason => { saveVersion({ kind: 'before', reason }); };
/** Count one change towards the next automatic snapshot. */
export function noteChange(documentId) { activity.set(documentId, trackActivity(activity.get(documentId))); }
/** After a successful save: take an automatic snapshot when enough editing happened. */
export function autoSnapshot(document) {
  if (!snapshotDue(activity.get(document.id))) return;
  activity.delete(document.id);
  saveVersion({ kind: 'auto', project: document.project, documentId: document.id });
}

async function loadVersion(id) {
  const data = await d.store().getVersionData(id);
  if (!data) throw new Error('This version could not be read.');
  return validateProject(unpackProject(data));
}
const paintThumb = (canvas, { width, height, palette, pixels }) => d.paintSprite(canvas, pixels, palette, true, width, height);

/** The Version history dialog for the active project. */
export async function versionsDialog() {
  await d.saveNow();
  const { $, icon, escapeHTML: esc } = d;
  d.openDialog('Version history', `<form class="version-save" id="version-form"><label class="sr-only" for="version-name">Version name</label><input id="version-name" maxlength="80" placeholder="Name this version, e.g. Before recolour" autocomplete="off"><button type="submit" class="button primary">${icon('plus')} Save version</button></form>
    <p class="modal-body-text">Named versions stay until you delete them. Automatic snapshots are taken while you work and before big changes; older ones are thinned to one per hour, then one per day for a month.${d.store()?.available ? '' : ' <strong>This browser is not keeping versions after a reload — download the ones you need.</strong>'}</p>
    <div id="version-list" class="version-list" aria-live="polite"><p class="helper-text">Loading versions…</p></div>`, 'HISTORY');
  $('modal').classList.add('versions-modal');
  const box = $('modal-content'), documentId = d.state.documentId;
  let versions = [];
  const stopPreview = () => { clearTimeout(previewTimer); previewTimer = 0; };
  $('modal').addEventListener('close', stopPreview, { once: true });
  $('modal').addEventListener('pixel-studio:dialog-replace', stopPreview, { once: true });
  const render = async () => {
    stopPreview();
    try { versions = await d.store().listVersions(documentId); } catch { versions = []; }
    const list = box.querySelector('#version-list');
    if (!list) return;
    list.innerHTML = versions.length ? versions.map(v => `<div class="version-row${v.kind === 'named' ? ' named' : ''}" data-version="${esc(v.id)}">
      <canvas class="version-thumb" aria-hidden="true"></canvas>
      <span class="version-info"><strong>${esc(versionLabel(v))}</strong><small>${versionTime(v.createdAt)} · ${plural(v.frameCount, 'frame')} · ${plural(v.animationCount, 'animation')} · ${v.width} × ${v.height}</small></span>
      <span class="version-actions">
        <button type="button" class="icon-button" data-act="preview" title="Preview" aria-label="Preview ${esc(versionLabel(v))}">${icon('eye')}</button>
        <button type="button" class="icon-button" data-act="restore" title="Restore this version (undoable)" aria-label="Restore ${esc(versionLabel(v))}">${icon('undo')}</button>
        <button type="button" class="icon-button" data-act="copy" title="Open as a copy in a new tab" aria-label="Open ${esc(versionLabel(v))} as a copy">${icon('copy')}</button>
        <button type="button" class="icon-button" data-act="download" title="Download as .pxa" aria-label="Download ${esc(versionLabel(v))}">${icon('export')}</button>
        <button type="button" class="icon-button" data-act="delete" title="Delete this version" aria-label="Delete ${esc(versionLabel(v))}">${icon('trash')}</button>
      </span></div>`).join('') : '<p class="helper-text">No versions yet. Save one above, or keep editing — snapshots are taken automatically.</p>';
    list.querySelectorAll('[data-version]').forEach((row, i) => paintThumb(row.querySelector('canvas'), versions[i].thumbnail));
  };
  const preview = async meta => {
    const project = await loadVersion(meta.id), list = box.querySelector('#version-list'), frames = project.animations[0].frames;
    list.innerHTML = `<div class="version-preview"><canvas class="version-preview-canvas" aria-label="Animated preview of ${esc(versionLabel(meta))}"></canvas>
      <div><strong>${esc(versionLabel(meta))}</strong><small>${versionTime(meta.createdAt)} · ${esc(project.name)} · ${esc(project.animations[0].name)} animation, ${plural(frames.length, 'frame')}</small></div>
      <div class="modal-actions"><button type="button" class="button" data-act="back">${icon('left')} All versions</button><button type="button" class="button primary" data-act="restore" data-id="${esc(meta.id)}">${icon('undo')} Restore</button></div></div>`;
    const canvas = list.querySelector('canvas'), scale = Math.max(1, Math.floor(256 / Math.max(project.width, project.height)));
    canvas.style.width = `${project.width * scale}px`; canvas.style.height = `${project.height * scale}px`;
    let index = 0;
    const step = () => {
      paintThumb(canvas, { width: project.width, height: project.height, palette: project.palette, pixels: compositeFrame(project, frames[index]) });
      if (frames.length > 1) previewTimer = setTimeout(step, frames[index].duration);
      index = (index + 1) % frames.length;
    };
    step();
  };
  const restore = async meta => {
    const project = await loadVersion(meta.id);
    if (d.state.documentId !== documentId) throw new Error('Switch back to this project to restore its versions.');
    await saveVersion({ kind: 'before', reason: `Before restoring “${versionLabel(meta)}”` });
    d.mutate(() => { d.state.project = project; d.state.selection = null; });
    $('modal').close();
    d.toast(`Restored “${versionLabel(meta)}”. Undo brings back the work you replaced.`);
  };
  box.querySelector('#version-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = box.querySelector('#version-name'), name = input.value.trim() || `Version ${new Date().toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}`;
    d.syncDocument();
    const meta = await saveVersion({ kind: 'named', name });
    if (!meta) { d.toast('This version could not be saved. Download a backup instead.'); return; }
    input.value = ''; d.toast(`Version “${name}” saved.`);
    render();
  });
  box.querySelector('#version-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const act = button.dataset.act, meta = versions.find(v => v.id === (button.dataset.id || button.closest('[data-version]')?.dataset.version));
    if (act === 'back') { render(); return; }
    if (!meta) return;
    button.disabled = true;
    try {
      if (act === 'preview') await preview(meta);
      else if (act === 'restore') await restore(meta);
      else if (act === 'copy') {
        const project = await loadVersion(meta.id);
        $('modal').close();
        d.replaceProject({ ...project, name: `${project.name} (${versionLabel(meta)})`.slice(0, 80) }, 'Version opened as a copy in a new tab.');
      } else if (act === 'download') {
        const project = await loadVersion(meta.id), stamp = new Date(meta.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');
        d.downloadBlob(new Blob([encodeProject(project)], { type: 'text/plain;charset=utf-8' }), `${d.fileName(project.name)}-${stamp}.pxa`);
      } else if (act === 'delete') {
        if (button.dataset.confirm !== 'yes') { button.dataset.confirm = 'yes'; button.classList.add('danger'); button.title = 'Click again to delete'; button.disabled = false; return; }
        await d.store().deleteVersions([meta.id]); render();
      }
    } catch (error) { d.toast(error.message); }
    if (button.isConnected) button.disabled = false;
  });
  render();
}
