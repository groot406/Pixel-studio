/**
 * Onion skin: tinted (previous = warm red, next = cool green) or true-colour ghosts of nearby frames painted under the
 * current frame, plus the settings popover (#onion-settings). Which frames show comes from timing.onionPlan. Ghost
 * images are cached per frame object and settings key: every committed change re-validates the project into new frame
 * objects, so the WeakMap drops stale ghosts by itself while strokes and pointer moves reuse them.
 */
import { onionPlan } from '../domain/timing.js';
import { compositeFrame, getLayerPixels } from '../domain/project.js';
import { renderOperations, renderParts } from '../domain/artwork.js';

const STORE = 'pixel-studio.onion.v1';
export const ONION_DEFAULTS = Object.freeze({ before: 1, after: 1, opacity: 0.45, falloff: 0.45, colour: 'tint', keysOnly: false, wrap: true, scope: 'all' });
const TINTS = { prev: [221, 74, 52], next: [38, 150, 112] };
const SCOPES = [['all', 'All layers'], ['layer', 'This layer'], ['object', 'Selected object']];
let d, popover = null, away = null;
const ghosts = new WeakMap(), partImages = new WeakMap();
export const settings = load();

function load() {
  try { const raw = JSON.parse(localStorage.getItem(STORE)); return sanitize({ ...ONION_DEFAULTS, ...raw }); } catch { return { ...ONION_DEFAULTS }; }
}
function sanitize(s) {
  const int = (v, lo, hi, fallback) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : fallback);
  const unit = (v, lo, hi, fallback) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : fallback);
  return {
    before: int(s.before, 0, 5, 1), after: int(s.after, 0, 5, 1), opacity: unit(s.opacity, 0.1, 0.9, 0.45), falloff: unit(s.falloff, 0, 0.8, 0.45),
    colour: s.colour === 'true' ? 'true' : 'tint', keysOnly: s.keysOnly === true, wrap: s.wrap !== false, scope: SCOPES.some(([v]) => v === s.scope) ? s.scope : 'all',
  };
}
function save() { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch { /* private mode: settings last for the session */ } }

/** Pixels a ghost shows for `frame`: the composite, the current layer, or only the selected object (else its layer). */
function ghostPixels(project, frame, layerId, objectKey) {
  if (settings.scope === 'all' || !layerId) return compositeFrame(project, frame);
  const cel = frame.cels.find(c => c.layerId === layerId);
  if (!cel) return [];
  const op = objectKey && cel.source?.ops.find(o => o.type === 'use' && o.id === objectKey);
  if (!op) return objectKey && settings.scope === 'object' && cel.source ? [] : getLayerPixels(frame, layerId);
  if (!partImages.has(project.parts)) partImages.set(project.parts, renderParts(project.parts || [], project.palette));
  return renderOperations([op], project.width, project.height, partImages.get(project.parts));
}
function ghostCanvas(project, frame, side, layerId, objectKey) {
  const key = `${side}|${settings.colour}|${settings.scope}|${layerId}|${objectKey}`;
  let entries = ghosts.get(frame);
  if (!entries) ghosts.set(frame, entries = new Map());
  const hit = entries.get(key);
  if (hit && hit.palette === project.palette && hit.width === project.width) return hit.canvas;
  const pixels = ghostPixels(project, frame, layerId, objectKey), { width, height, palette } = project;
  const canvas = hit?.canvas || document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const image = new ImageData(width, height), data = image.data, tint = TINTS[side];
  const rgb = palette.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
  const colours = rgb.map(([r, g, b]) => {
    if (settings.colour === 'true') return [r, g, b];
    const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return tint.map(c => Math.round(c + (255 - c) * light * 0.55));
  });
  for (let i = 0; i < pixels.length; i++) {
    const c = colours[pixels[i]];
    if (!c) continue;
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
  }
  canvas.getContext('2d').putImageData(image, 0, 0);
  if (entries.size > 3) entries.delete(entries.keys().next().value);
  entries.set(key, { canvas, palette, width });
  return canvas;
}

/** Paint the onion ghosts of the current animation into `context` (scaled to w × h CSS px). */
export function drawOnion(context, w, h) {
  const st = d.state, frames = d.currentAnimation().frames;
  if (!st.onion || st.inPlaceEdit || frames.length < 2) return;
  const index = frames.findIndex(f => f.id === st.frameId), sel = st.objectSelection;
  const layerId = settings.scope === 'all' ? null : sel?.layerId || st.layerId;
  const objectKey = settings.scope === 'object' && sel && sel.key !== '@group' ? sel.key : null;
  const plan = onionPlan(frames.length, index, { ...settings, kinds: frames.map(f => f.kind) });
  for (const g of plan) {
    context.globalAlpha = g.alpha;
    context.drawImage(ghostCanvas(st.project, frames[g.index], g.side, layerId, objectKey), 0, 0, w, h);
  }
  context.globalAlpha = 1;
}

function stepper(name, label, value) {
  return `<div class="onion-row"><span>${label}</span><div class="onion-stepper"><button type="button" class="icon-button" data-step="${name}" data-delta="-1" aria-label="Fewer ${label.toLowerCase()} frames" ${value <= 0 ? 'disabled' : ''}>${d.icon('minus')}</button><output aria-live="polite">${value}</output><button type="button" class="icon-button" data-step="${name}" data-delta="1" aria-label="More ${label.toLowerCase()} frames" ${value >= 5 ? 'disabled' : ''}>${d.icon('plus')}</button></div></div>`;
}
function chips(name, options, value) {
  return `<div class="onion-chips" role="radiogroup">${options.map(([v, label]) => `<button type="button" role="radio" class="onion-chip${v === value ? ' active' : ''}" aria-checked="${v === value}" data-set="${name}" data-value="${v}">${label}</button>`).join('')}</div>`;
}
function popoverHTML() {
  const s = settings, on = d.state.onion;
  return `<div class="onion-head"><strong>Onion skin</strong><label class="onion-switch"><input type="checkbox" data-flag="onion" ${on ? 'checked' : ''}><span>${on ? 'On' : 'Off'}</span></label></div>
    <div class="onion-legend"><span class="onion-swatch prev"></span>${stepper('before', 'Previous', s.before)}</div>
    <div class="onion-legend"><span class="onion-swatch next"></span>${stepper('after', 'Next', s.after)}</div>
    <label class="onion-row"><span>Opacity</span><input type="range" min="10" max="90" step="5" data-range="opacity" value="${Math.round(s.opacity * 100)}" aria-label="Opacity of the nearest ghost"><output>${Math.round(s.opacity * 100)}%</output></label>
    <label class="onion-row"><span>Fade</span><input type="range" min="0" max="80" step="5" data-range="falloff" value="${Math.round(s.falloff * 100)}" aria-label="How much each further frame fades"><output>${Math.round(s.falloff * 100)}%</output></label>
    <div class="onion-label">Colour</div>${chips('colour', [['tint', 'Tinted'], ['true', 'True colour']], s.colour)}
    <div class="onion-label">Show</div>${chips('scope', SCOPES, s.scope)}
    <label class="onion-check"><input type="checkbox" data-flag="keysOnly" ${s.keysOnly ? 'checked' : ''}><span>Key poses only</span></label>
    <label class="onion-check"><input type="checkbox" data-flag="wrap" ${s.wrap ? 'checked' : ''}><span>Loop around (first ↔ last frame)</span></label>`;
}
function changed(enable = true) {
  Object.assign(settings, sanitize(settings)); save();
  if (enable) d.state.onion = true;
  d.renderTools(); d.renderCanvas();
  if (popover) { const focus = document.activeElement?.dataset; popover.innerHTML = popoverHTML(); restoreFocus(focus); }
}
function restoreFocus(focus) {
  if (!focus) return;
  const match = Object.entries(focus).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${v}"]`).join('');
  (match && popover.querySelector(match))?.focus();
}
export function closeOnionSettings() {
  if (!popover) return;
  popover.remove(); popover = null;
  document.removeEventListener('pointerdown', away, true);
  d.$('onion-settings').setAttribute('aria-expanded', 'false');
}
/** Open (or close) the settings popover under the caret next to the onion toggle. */
export function toggleOnionSettings() {
  if (popover) { closeOnionSettings(); return; }
  const button = d.$('onion-settings');
  popover = document.createElement('div');
  popover.className = 'onion-popover'; popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-label', 'Onion skin settings');
  popover.innerHTML = popoverHTML();
  document.body.append(popover);
  const box = button.getBoundingClientRect(), size = popover.getBoundingClientRect();
  popover.style.left = `${Math.max(8, Math.min(innerWidth - size.width - 8, box.right - size.width))}px`;
  popover.style.top = `${Math.min(innerHeight - size.height - 8, box.bottom + 6)}px`;
  button.setAttribute('aria-expanded', 'true');
  popover.addEventListener('click', event => {
    const t = event.target.closest('button');
    if (t?.dataset.step) { settings[t.dataset.step] += Number(t.dataset.delta); changed(); }
    else if (t?.dataset.set) { settings[t.dataset.set] = t.dataset.value; changed(); }
  });
  popover.addEventListener('input', event => {
    const t = event.target;
    if (t.dataset.range) { settings[t.dataset.range] = Number(t.value) / 100; t.nextElementSibling.textContent = `${t.value}%`; Object.assign(settings, sanitize(settings)); save(); d.state.onion = true; d.renderTools(); d.renderCanvas(); }
  });
  popover.addEventListener('change', event => {
    const flag = event.target.dataset.flag;
    if (flag === 'onion') { d.state.onion = event.target.checked; changed(false); }
    else if (flag) { settings[flag] = event.target.checked; changed(); }
  });
  popover.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeOnionSettings(); button.focus(); } });
  popover.querySelector('input,button')?.focus();
  away = event => { if (!popover?.contains(event.target) && !button.contains(event.target)) closeOnionSettings(); };
  document.addEventListener('pointerdown', away, true);
}
export function initOnion(deps) {
  d = deps;
  d.$('onion-settings').onclick = toggleOnionSettings;
}
/** Title for the onion toggle describing what it shows. */
export function onionSummary() {
  const s = settings, parts = [s.before && `${s.before} previous`, s.after && `${s.after} next`].filter(Boolean).join(' + ') || 'no frames';
  return `Onion skin: ${parts}${s.keysOnly ? ' key poses' : ''} (O) · Shift O for settings`;
}
