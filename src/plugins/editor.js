/**
 * Editor side of plugins: starts the registry, lists plugin effects and commands in the Effects panel, asks for their
 * parameters (with a live before/after preview for pixel scopes) and commits every run as one undo step through
 * deps.mutate. Pixel runs follow the built-in effects' rules (effects-panel.js blockedReason, edit scope, selection,
 * locked objects) via apply.js. Results are always validated (validate.js) before they touch the project.
 */
import { PluginRegistry } from './runtime.js';
import { spawnBrowserWorker } from './worker-host.js';
import { openPluginStore } from './store.js';
import { resolveParams, validateResult } from './validate.js';
import { pixelFrames, applyPixelResults, applyAnimationResult, applyProjectResult, selectionToMask } from './apply.js';
import { blockedReason, scopeText } from '../editor/effects-panel.js';
import { selectionTarget } from '../editor/tool-extras.js';
import { compositeFrame } from '../domain/project.js';
import { setExtraPalettes } from '../domain/palette-presets.js';
import { encodeAIProject } from '../formats/pxa.js';

let d, registry, busy = false;
const listeners = new Set();

/** Subscribe to registry changes (the manager dialog uses this); returns an unsubscribe function. */
export const onPluginsChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const pluginRegistry = () => registry;

export function initPlugins(deps) {
  d = deps;
  registry = new PluginRegistry({
    store: { list: async () => (await storePromise).list(), put: async r => (await storePromise).put(r), remove: async id => (await storePromise).remove(id) },
    spawn: spawnBrowserWorker,
    onChange: () => {
      setExtraPalettes(registry.palettes().map(p => ({ id: `plugin:${p.key}`, name: p.name, author: p.pluginName, colours: p.colors })));
      renderPluginPanel();
      for (const fn of listeners) fn();
    },
    onLog: (id, message) => console.info(`[plugin ${id}]`, message),
  });
  const storePromise = openPluginStore();
  registry.load().then(() => {
    const failed = registry.list().filter(p => p.status === 'error');
    if (failed.length) d.toast(`${failed.map(p => p.manifest.name).join(', ')} could not start. Open Plugins & skills for details.`);
  });
  d.$('plugin-effects')?.addEventListener('click', event => {
    const button = event.target.closest('[data-plugin-action]');
    if (button) { const action = registry.actions().find(a => a.key === button.dataset.pluginAction); if (action) runActionDialog(action); return; }
    if (event.target.closest('[data-plugin-manage]')) d.openPluginManager();
  });
  return registry;
}

const paramNeedsPixels = scope => scope === 'frame' || scope === 'selection';

/** Why `action` cannot run right now, or ''. */
function actionBlocked(action) {
  if (d.state.inPlaceEdit) return 'Finish editing the object first.';
  if (action.scope === 'project') return '';
  const reason = blockedReason();
  if (reason) return reason;
  if (action.scope === 'selection' && !d.state.selection) return 'Select an area first.';
  return '';
}

export function renderPluginPanel() {
  const host = d?.$('plugin-effects');
  if (!host || !registry) return;
  const actions = registry.actions();
  host.innerHTML = `<div class="plugin-panel-head"><span class="plugin-panel-title">Plugins</span><button type="button" class="text-button" data-plugin-manage>${actions.length ? 'Manage' : 'Add plugins…'}</button></div>${actions.length ? `<div class="object-action-list" role="group" aria-label="Plugin effects and commands">${actions.map(a => {
    const reason = actionBlocked(a);
    return `<button type="button" class="object-action" data-plugin-action="${d.escapeHTML(a.key)}"${reason || busy ? ' disabled' : ''} title="${d.escapeHTML(reason || `${a.pluginName} · ${a.scope} scope`)}"><svg aria-hidden="true"><use href="#i-plugin"/></svg><span class="object-action-copy"><strong>${d.escapeHTML(a.title)}</strong><small>${d.escapeHTML(a.description || a.pluginName)}</small></span></button>`;
  }).join('')}</div>` : ''}`;
}

/** Plugin actions for the command palette: [{ key, title, description, run }]. */
export function pluginPaletteCommands() {
  return registry ? registry.actions().map(a => ({ key: `plugin:${a.key}`, title: a.title, description: `${a.pluginName} · plugin ${a.kind}`, disabled: actionBlocked(a), run: () => runActionDialog(a) })) : [];
}

const lum = hex => parseInt(hex.slice(1, 3), 16) * .299 + parseInt(hex.slice(3, 5), 16) * .587 + parseInt(hex.slice(5, 7), 16) * .114;
function paletteInfo(palette) {
  let darkest = 0, lightest = 0;
  palette.forEach((c, i) => { if (lum(c) < lum(palette[darkest])) darkest = i; if (lum(c) > lum(palette[lightest])) lightest = i; });
  return { paletteLength: palette.length, active: Math.min(Math.max(0, d.state.color ?? 0), palette.length - 1), darkest, lightest };
}

function paramField(p, value, palette) {
  const id = `plg-${p.id}`, esc = d.escapeHTML;
  if (p.type === 'number') return `<label class="field"><span class="field-label">${esc(p.label)}</span><span class="field-row"><input id="${id}" data-param="${p.id}" type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${value}"><output id="${id}-out" for="${id}">${value}</output></span></label>`;
  if (p.type === 'select') return `<label class="field"><span class="field-label">${esc(p.label)}</span><select id="${id}" data-param="${p.id}">${p.options.map(o => `<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
  if (p.type === 'boolean') return `<label class="check-row"><input id="${id}" data-param="${p.id}" type="checkbox"${value ? ' checked' : ''}><span>${esc(p.label)}</span></label>`;
  return `<div class="field"><span class="field-label" id="${id}-label">${esc(p.label)}</span><div id="${id}" data-param="${p.id}" class="swatch-pick" role="radiogroup" aria-labelledby="${id}-label" data-value="${value}">${palette.map((c, i) => `<button type="button" class="swatch" style="--swatch:${c}" data-value="${i}" role="radio" aria-pressed="${i === value}" aria-checked="${i === value}" title="Colour ${i + 1} · ${c.toUpperCase()}" aria-label="Colour ${i + 1} ${c.toUpperCase()}"></button>`).join('')}</div></div>`;
}
function readParams(form) {
  const values = {};
  for (const el of form.querySelectorAll('[data-param]')) values[el.dataset.param] = el.type === 'checkbox' ? el.checked : el.classList.contains('swatch-pick') ? Number(el.dataset.value) : el.value;
  return values;
}

function scopeLabel(action) {
  if (action.scope === 'project') return 'the whole project (one version is saved first)';
  if (action.scope === 'animation') return `“${d.currentLayer().name}” in every frame of “${d.currentAnimation().name}”`;
  return scopeText();
}

/** Run `action` on `project` and return the validated, applied { project, frameIds?, skipped?, added? } — no state change. */
async function compute(action, values, project, editScope) {
  const { state } = d, { width, height } = project, permissions = registry.list().find(p => p.id === action.pluginId)?.manifest.permissions || [];
  const target = d.objectTarget(), params = resolveParams(action.params, values, paletteInfo(project.palette));
  const base = { width, height, palette: [...project.palette], params, activeColor: state.color ?? -1, scope: action.scope };
  if (action.scope === 'project') {
    const raw = await registry.run(action.pluginId, action.id, { ...base, pxa: encodeAIProject(project) });
    return applyProjectResult(validateResult('project', raw, { width, height, palette: project.palette }).project);
  }
  const animation = project.animations.find(a => a.id === target.animationId);
  if (action.scope === 'animation') {
    const frames = animation.frames.map(f => ({ pixels: Int16Array.from(f.cels.find(c => c.layerId === target.layerId).pixels), duration: f.duration ?? Math.round(1000 / animation.fps) }));
    const raw = await registry.run(action.pluginId, action.id, { ...base, frames, frameIndex: Math.max(0, animation.frames.findIndex(f => f.id === target.frameId)), frameCount: frames.length }, frames.map(f => f.pixels.buffer));
    const checked = validateResult('animation', raw, { width, height, palette: project.palette, frameCount: frames.length, permissions });
    return applyAnimationResult(project, target, checked.frames, checked.palette);
  }
  if (action.scope === 'selection' && !state.selection) throw new Error('Select an area first.');
  const selection = state.selection ? selectionTarget(state.selection, width, height) : null, mask = selectionToMask(selection, width, height);
  const selectionContext = state.selection ? { ...state.selection.rect, mask: mask ? Uint8Array.from(mask) : null } : null;
  const { frames, skipped } = pixelFrames(project, { ...target, editScope });
  let palette = [...project.palette];
  const results = [];
  for (const frame of frames) {
    const pixels = Int16Array.from(frame.pixels);
    const raw = await registry.run(action.pluginId, action.id, { ...base, palette: [...palette], pixels, frameIndex: frame.index, frameCount: animation.frames.length, selection: selectionContext }, [pixels.buffer]);
    const checked = validateResult(action.scope, raw, { width, height, palette, permissions });
    if (checked.palette) palette = checked.palette;
    results.push({ frameId: frame.id, pixels: checked.pixels });
  }
  const applied = applyPixelResults(project, { ...target, selection }, results, palette.length !== project.palette.length ? palette : undefined);
  return { ...applied, skipped };
}

/** Open the parameter dialog for `action` (or run it straight away when it has no parameters). */
export function runActionDialog(action) {
  const { $, state } = d, reason = actionBlocked(action);
  if (reason) { d.toast(reason); return; }
  if (busy) { d.toast('A plugin is still running.'); return; }
  const palette = state.project.palette, info = paletteInfo(palette), defaults = resolveParams(action.params, {}, info);
  const preview = paramNeedsPixels(action.scope);
  if (!action.params.length && !preview) { commit(action, {}); return; }
  d.openDialog(action.title, `<form id="plg-form" class="maths-form"><p class="modal-body-text">${d.escapeHTML(action.description || '')} <span class="plugin-byline">From the plugin “${d.escapeHTML(action.pluginName)}”.</span></p>
    ${preview ? '<div class="maths-preview"><figure><figcaption>Before</figcaption><canvas id="plg-before" aria-label="Current frame before the plugin"></canvas></figure><figure><figcaption>After</figcaption><canvas id="plg-after" aria-label="Preview with the plugin"></canvas></figure></div>' : ''}
    ${action.params.length ? `<div class="form-grid">${action.params.filter(p => p.type !== 'color').map(p => paramField(p, defaults[p.id], palette)).join('')}</div>${action.params.filter(p => p.type === 'color').map(p => paramField(p, defaults[p.id], palette)).join('')}` : ''}
    <p class="maths-info">Applies to ${d.escapeHTML(scopeLabel(action))}.</p><p id="plg-error" class="maths-error" role="alert"></p>
    <div class="modal-actions"><button type="button" id="plg-cancel" class="button">Cancel</button><button type="submit" id="plg-apply" class="button primary">Apply</button></div></form>`, 'PLUGIN');
  const form = $('plg-form');
  let running = false, dirty = false;
  const frame = d.currentFrame();
  const refreshPreview = async () => {
    if (!preview) return;
    if (running) { dirty = true; return; }
    running = true; dirty = false;
    try {
      const result = await compute(action, readParams(form), state.project, 'frame');
      if (!form.isConnected) return;
      const after = result.project.animations.find(a => a.id === d.currentAnimation().id)?.frames.find(f => f.id === frame.id);
      if (after) d.paintSprite($('plg-after'), compositeFrame(result.project, after), result.project.palette, true);
      $('plg-error').textContent = '';
    } catch (error) { if (form.isConnected) $('plg-error').textContent = error.message; }
    finally { running = false; if (dirty && form.isConnected) refreshPreview(); }
  };
  if (preview) { d.paintSprite($('plg-before'), compositeFrame(state.project, frame), palette, true); d.paintSprite($('plg-after'), compositeFrame(state.project, frame), palette, true); }
  const refresh = () => {
    for (const input of form.querySelectorAll('input[type="range"]')) { const out = $(`${input.id}-out`); if (out) out.textContent = input.value; }
    refreshPreview();
  };
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  form.addEventListener('click', event => {
    const option = event.target.closest('.swatch-pick [data-value]');
    if (!option) return;
    const group = option.parentElement;
    group.dataset.value = option.dataset.value;
    for (const el of group.querySelectorAll('[data-value]')) { const on = el === option; el.setAttribute('aria-pressed', String(on)); el.setAttribute('aria-checked', String(on)); }
    refresh();
  });
  $('plg-cancel').onclick = () => $('modal').close();
  form.onsubmit = async event => {
    event.preventDefault();
    $('plg-apply').disabled = true; $('plg-apply').textContent = 'Running…';
    const ok = await commit(action, readParams(form), message => { if (form.isConnected) $('plg-error').textContent = message; });
    if (ok) { if (form.isConnected) $('modal').close(); }
    else if (form.isConnected) { $('plg-apply').disabled = false; $('plg-apply').textContent = 'Apply'; }
  };
  refreshPreview();
}

/** Run for real against the current edit scope and commit as one undo step. Resolves true on success. */
async function commit(action, values, showError = d.toast) {
  const { state } = d, documentId = state.documentId, before = JSON.stringify(state.project);
  busy = true; renderPluginPanel();
  try {
    const result = await compute(action, values, state.project, state.objectScope === 'animation' ? 'animation' : 'frame');
    if (state.documentId !== documentId || JSON.stringify(state.project) !== before) throw new Error('The project changed while the plugin ran. Run it again.');
    if (action.scope === 'project') d.versionBefore(`Before plugin: ${action.title}`);
    d.mutate(() => { state.project = result.project; if (action.scope === 'project') state.selection = null; });
    const changed = result.frameIds?.length;
    d.toast(action.scope === 'project' ? `${action.title} replaced the project. Undo restores it.`
      : changed ? `${action.title} changed ${changed} frame${changed === 1 ? '' : 's'}${result.added ? ` (${result.added} added)` : ''}${result.skipped ? ` · ${result.skipped} with locked objects skipped` : ''}.`
      : `${action.title} changed nothing here.`);
    return true;
  } catch (error) {
    showError(`${action.title}: ${error.message}`);
    return false;
  } finally { busy = false; renderPluginPanel(); }
}
