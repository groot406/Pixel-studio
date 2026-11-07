/**
 * Effects panel: pixel effects (src/domain/effects.js) on the active container's cel — outline, selective outline,
 * inner glow, rim light, auto shade, dither and line clean-up — in the Edit scope (this frame / every frame), limited
 * to the selection when there is one. Each dialog shows a live before/after preview of the current frame.
 */
import { applyPixelEffect } from '../domain/effects.js';
import { compositeFrame } from '../domain/project.js';
import { rampFromPalette } from '../domain/colour.js';
import { selectionTarget } from './tool-extras.js';

let d;
const EFFECTS = ['outline', 'selOut', 'innerGlow', 'rimLight', 'autoShade', 'dither', 'cleanup'];
const DIRECTIONS = [[-1, -1, 'top left'], [0, -1, 'top'], [1, -1, 'top right'], [-1, 0, 'left'], null, [1, 0, 'right'], [-1, 1, 'bottom left'], [0, 1, 'bottom'], [1, 1, 'bottom right']];
const ARROWS = ['↖', '↑', '↗', '←', '', '→', '↙', '↓', '↘'];

export function initEffectsPanel(deps) {
  d = deps;
  for (const effect of EFFECTS) d.$(`effect-${effect}`).onclick = () => effectDialog(effect);
}

function blockedReason() {
  const { state } = d, layer = d.currentLayer();
  if (state.inPlaceEdit) return 'Finish editing the object first.';
  if (!layer.visible) return `Show “${layer.name}” to use effects.`;
  if (layer.locked) return `Unlock “${layer.name}” to use effects.`;
  if (!d.canEditPixels()) return 'Unlock the objects in this container first.';
  return '';
}
function scopeText() {
  const { state } = d, layer = d.currentLayer(), frames = d.currentAnimation().frames.length;
  return `“${layer.name}”${state.selection ? ', inside the selection,' : ''} in ${state.objectScope === 'animation' && frames > 1 ? `all ${frames} frames` : 'this frame'}`;
}

export function renderEffectsPanel() {
  const { $ } = d, reason = blockedReason();
  $('effects-hint').textContent = reason || `Applies to ${scopeText()}.`;
  $('effects-hint').classList.toggle('maths-reason', Boolean(reason));
  for (const effect of EFFECTS) { const button = $(`effect-${effect}`); button.disabled = Boolean(reason); button.title = reason; }
}

// ---------------------------------------------------------------------------------------------
// Controls

function colourPicker(id, label, selected, { none } = {}) {
  const palette = d.state.project.palette;
  return `<div class="field"><span class="field-label" id="${id}-label">${label}</span><div id="${id}" class="swatch-pick" role="radiogroup" aria-labelledby="${id}-label" data-value="${selected}">${none ? `<button type="button" class="swatch transparent" data-value="any" role="radio" aria-pressed="${selected === 'any'}" aria-checked="${selected === 'any'}" title="${none}" aria-label="${none}"><span>∕</span></button>` : ''}${palette.map((c, i) => `<button type="button" class="swatch" style="--swatch:${c}" data-value="${i}" role="radio" aria-pressed="${i === selected}" aria-checked="${i === selected}" title="Colour ${i + 1} · ${c.toUpperCase()}" aria-label="Colour ${i + 1} ${c.toUpperCase()}"></button>`).join('')}</div></div>`;
}
function lightPicker(id, label, selected, allowNone) {
  return `<div class="field"><span class="field-label" id="${id}-label">${label}</span><div id="${id}" class="light-grid" role="radiogroup" aria-labelledby="${id}-label" data-value="${selected}">${DIRECTIONS.map((dir, i) => dir
    ? `<button type="button" class="seg-option${String(i) === String(selected) ? ' active' : ''}" data-value="${i}" role="radio" aria-checked="${String(i) === String(selected)}" aria-label="Light from the ${dir[2]}" title="Light from the ${dir[2]}">${ARROWS[i]}</button>`
    : allowNone ? `<button type="button" class="seg-option${selected === 'none' ? ' active' : ''}" data-value="none" role="radio" aria-checked="${selected === 'none'}" aria-label="No light direction" title="No light direction: every side alike">·</button>` : '<span class="light-centre" aria-hidden="true">☀</span>').join('')}</div></div>`;
}
const slider = (id, label, min, max, step, value, format = v => v) => `<label class="field"><span class="field-label">${label}</span><span class="field-row"><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"><output id="${id}-out" for="${id}">${format(Number(value))}</output></span></label>`;
const select = (id, label, options, value) => `<label class="field"><span class="field-label">${label}</span><select id="${id}">${options.map(([v, text]) => `<option value="${v}"${String(v) === String(value) ? ' selected' : ''}>${text}</option>`).join('')}</select></label>`;
const check = (id, label, on) => `<label class="check-row"><input id="${id}" type="checkbox"${on ? ' checked' : ''}> ${label}</label>`;
const pick = id => d.$(id).dataset.value;
const lightOf = id => { const v = pick(id); return v === 'none' ? null : { x: DIRECTIONS[v][0], y: DIRECTIONS[v][1] }; };

/** A sensible second colour: the far end of the active colour's ramp, else the darkest other colour. */
function partnerColour(index, darker = true) {
  const palette = d.state.project.palette;
  if (index < 0) return 0;
  const ramp = rampFromPalette(palette, index), at = ramp.indexOf(index);
  const step = darker ? ramp[at - 1] : ramp[at + 1];
  return step ?? ramp[darker ? ramp.length - 1 : 0] ?? (index + 1) % palette.length;
}

function definition(effect) {
  const { state } = d, active = state.color >= 0 ? state.color : 0;
  const darkest = state.project.palette.reduce((best, c, i, all) => lum(c) < lum(all[best]) ? i : best, 0);
  const lightest = state.project.palette.reduce((best, c, i, all) => lum(c) > lum(all[best]) ? i : best, 0);
  const px = v => `${v} px`;
  switch (effect) {
    case 'outline': return {
      title: 'Outline', intro: 'Draw a one-colour line around the artwork (outside) or along its edge (inside).',
      body: colourPicker('fx-color', 'Colour', state.color >= 0 ? state.color : darkest) + `<div class="form-grid">${select('fx-mode', 'Where', [['outside', 'Outside the art'], ['inside', 'Inside the edge']], 'outside')}${slider('fx-thickness', 'Thickness', 1, 4, 1, 1, px)}</div>` + check('fx-corners', 'Fill the corners (square outline)', true),
      options: () => ({ color: Number(pick('fx-color')), mode: d.$('fx-mode').value, thickness: Number(d.$('fx-thickness').value), corners: d.$('fx-corners').checked }) };
    case 'selOut': return {
      title: 'Selective outline', intro: 'Outline each area with a darker shade of its own colour (sel-out), optionally lighter or open on the lit side.',
      body: `<div class="form-grid">${lightPicker('fx-light', 'Light from', 0, true)}<div>${select('fx-lit', 'Lit side', [['omit', 'Leave open'], ['lighter', 'Lighter shade'], ['fill', 'Same as the fill']], 'omit')}${select('fx-mode', 'Where', [['outside', 'Outside the art'], ['inside', 'Inside the edge']], 'inside')}</div></div>` + check('fx-corners', 'Fill the corners', false),
      options: () => ({ light: lightOf('fx-light'), lit: d.$('fx-lit').value, mode: d.$('fx-mode').value, corners: d.$('fx-corners').checked }) };
    case 'innerGlow': return {
      title: 'Inner glow', intro: 'Recolour the pixels just inside the edge of the artwork, like a glow or a soft rim.',
      body: colourPicker('fx-color', 'Colour', lightest) + slider('fx-size', 'Size', 1, 4, 1, 1, px),
      options: () => ({ color: Number(pick('fx-color')), size: Number(d.$('fx-size').value) }) };
    case 'rimLight': return {
      title: 'Rim light', intro: 'Light the edges that face the light, as if a lamp shone from behind the artwork.',
      body: `<div class="form-grid">${lightPicker('fx-light', 'Light from', 2, false)}${slider('fx-size', 'Width', 1, 3, 1, 1, px)}</div>` + colourPicker('fx-color', 'Colour', lightest),
      options: () => ({ color: Number(pick('fx-color')), light: lightOf('fx-light'), size: Number(d.$('fx-size').value) }) };
    case 'autoShade': return {
      title: 'Auto shade', intro: 'Shade each area along its own palette ramp: lighter towards the light, darker away from it, like a bevel.',
      body: `<div class="form-grid">${lightPicker('fx-light', 'Light from', 0, true)}${slider('fx-depth', 'Depth', 1, 8, 1, 3, px)}</div><p class="maths-info">Ramps come from similar hues in the palette. Add a shading ramp in Palette for richer shades.</p>`,
      options: () => ({ light: lightOf('fx-light'), depth: Number(d.$('fx-depth').value) }) };
    case 'dither': return {
      title: 'Dither', intro: 'Mix two palette colours in an ordered checker pattern, to fake a third shade.',
      body: colourPicker('fx-a', 'First colour', active) + colourPicker('fx-b', 'Second colour', partnerColour(active)) + `<div class="form-grid">${slider('fx-ratio', 'Mix', 0, 1, 0.0625, 0.5, v => `${Math.round(v * 100)}%`)}${select('fx-matrix', 'Pattern', [[2, 'Coarse (2×2)'], [4, 'Medium (4×4)'], [8, 'Fine (8×8)']], 4)}</div>` + select('fx-region', 'Where', [['opaque', 'Only on the artwork'], ['all', 'Everywhere']], 'opaque'),
      options: () => ({ a: Number(pick('fx-a')), b: Number(pick('fx-b')), ratio: Number(d.$('fx-ratio').value), matrix: Number(d.$('fx-matrix').value), region: d.$('fx-region').value }) };
    case 'cleanup': return {
      title: 'Clean up lines', intro: 'Remove the doubled pixels at the corners of 1-pixel lines, so they read crisp (pixel-perfect).',
      body: colourPicker('fx-color', 'Only lines of', 'any', { none: 'Any colour' }),
      options: () => { const v = pick('fx-color'); return v === 'any' ? {} : { color: Number(v) }; } };
  }
}
function lum(hex) { return parseInt(hex.slice(1, 3), 16) * .299 + parseInt(hex.slice(3, 5), 16) * .587 + parseInt(hex.slice(5, 7), 16) * .114; }

function effectDialog(effect) {
  const { $, state } = d;
  if (blockedReason()) { d.toast(blockedReason()); return; }
  const def = definition(effect), frame = d.currentFrame(), { width, height } = state.project;
  d.openDialog(def.title, `<form id="fx-form" class="maths-form"><p class="modal-body-text">${def.intro}</p>
    <div class="maths-preview"><figure><figcaption>Before</figcaption><canvas id="fx-before" aria-label="Current frame before the effect"></canvas></figure><figure><figcaption>After</figcaption><canvas id="fx-after" aria-label="Preview with the effect"></canvas></figure></div>
    ${def.body}<p class="maths-info">Applies to ${d.escapeHTML(scopeText())}.</p><p id="fx-error" class="maths-error" role="alert"></p>
    <div class="modal-actions"><button type="button" id="fx-cancel" class="button">Cancel</button><button type="submit" class="button primary">Apply</button></div></form>`, 'EFFECTS');
  const target = () => ({ ...d.objectTarget(), ...selectionTarget(state.selection, width, height) });
  d.paintSprite($('fx-before'), compositeFrame(state.project, frame), state.project.palette, true);
  let queued = false;
  const preview = () => {
    queued = false;
    try {
      const result = applyPixelEffect(state.project, { ...target(), scope: 'frame' }, effect, def.options());
      const after = result.project.animations.find(a => a.id === d.currentAnimation().id).frames.find(f => f.id === frame.id);
      d.paintSprite($('fx-after'), compositeFrame(result.project, after), result.project.palette, true);
      $('fx-error').textContent = '';
    } catch (error) { $('fx-error').textContent = error.message; }
  };
  const refresh = () => {
    for (const input of $('fx-form').querySelectorAll('input[type="range"]')) { const out = $(`${input.id}-out`); if (out) out.textContent = formatOut(input); }
    if (!queued) { queued = true; requestAnimationFrame(preview); }
  };
  const formatOut = input => {
    const v = Number(input.value);
    return input.id === 'fx-ratio' ? `${Math.round(v * 100)}%` : `${v} px`;
  };
  $('fx-form').addEventListener('input', refresh);
  $('fx-form').addEventListener('change', refresh);
  $('fx-form').addEventListener('click', event => {
    const option = event.target.closest('.swatch-pick [data-value], .light-grid [data-value]');
    if (!option) return;
    const group = option.parentElement;
    group.dataset.value = option.dataset.value;
    for (const el of group.querySelectorAll('[data-value]')) { const on = el === option; el.classList.toggle('active', on && el.classList.contains('seg-option')); el.setAttribute('aria-pressed', String(on)); el.setAttribute('aria-checked', String(on)); }
    refresh();
  });
  $('fx-cancel').onclick = () => $('modal').close();
  $('fx-form').onsubmit = event => {
    event.preventDefault();
    let result;
    try { d.mutate(() => { result = applyPixelEffect(state.project, { ...target(), scope: state.objectScope }, effect, def.options()); state.project = result.project; }); }
    catch (error) { $('fx-error').textContent = error.message; return; }
    $('modal').close(); d.renderAll();
    const changed = result.frameIds.length;
    d.toast(changed ? `${def.title} applied to ${changed} frame${changed === 1 ? '' : 's'}${result.skipped ? ` · ${result.skipped} with locked objects skipped` : ''}.` : `${def.title} changed nothing here.`);
  };
  preview();
}
