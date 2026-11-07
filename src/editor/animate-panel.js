/**
 * Animate panel: launchers for the canvas motion modes (motion-modes.js: move, bounce, follow-through, IK limb, smear)
 * and the Wave motion dialog, which previews its result live and applies as one undo step.
 */
import { waveAnimate } from '../domain/animate.js';
import { compositeFrame } from '../domain/project.js';
import { celObjects } from '../domain/objects.js';
import { openMode, closeMotionMode, activeMotionMode } from './motion-modes.js';

let d;
const MODES = { tween: 'move', squash: 'bounce', follow: 'follow', ik: 'ik', smear: 'smear' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function initAnimatePanel(deps) {
  d = deps;
  for (const [row, mode] of Object.entries(MODES)) d.$(`animate-${row}`).onclick = () => (activeMotionMode() === mode ? closeMotionMode() : openMode(mode));
  d.$('animate-wave').onclick = () => { closeMotionMode(); waveDialog(); };
}

/** The selected placed object in the current frame, and whether the frame has any. */
function context() {
  const { state } = d, animation = d.currentAnimation(), frame = d.currentFrame(), objects = [];
  for (const layer of state.project.layers) {
    const cel = frame.cels.find(c => c.layerId === layer.id);
    if (cel) for (const node of celObjects(cel)) if (node.instance) objects.push({ layerId: layer.id, key: node.key, op: node.instance, name: node.name });
  }
  const item = state.objectSelection, primary = item && !state.inPlaceEdit && objects.find(o => o.layerId === item.layerId && o.key === item.key);
  return { animation, frame, objects, primary };
}

/** Launchers are enabled whenever the frame has a placed object; the open mode's row is marked. */
export function renderAnimatePanel() {
  const { $, state } = d, { objects, primary } = context(), active = activeMotionMode();
  $('animate-hint').textContent = state.inPlaceEdit ? 'Finish editing the object on the canvas to animate it.'
    : !objects.length ? 'Place a part on the canvas (drag one from Parts) to animate it.'
    : primary ? `Animate “${primary.name}”: pick a motion, then work on the canvas.` : 'Pick a motion, then click the object on the canvas.';
  for (const row of [...Object.keys(MODES), 'wave']) {
    const button = $(`animate-${row}`), on = MODES[row] && active === MODES[row];
    button.disabled = Boolean(state.inPlaceEdit) || !objects.length || (row === 'wave' && !primary);
    button.classList.toggle('active', Boolean(on));
    button.setAttribute('aria-pressed', String(Boolean(on)));
    button.title = row === 'wave' && !primary && objects.length ? 'Select an object first' : '';
  }
}

// ---------------------------------------------------------------------------------------------
// Dialog scaffolding

const formatters = {};
const slider = (id, label, min, max, step, value, format = v => v) => (formatters[id] = format) && `<label class="field"><span class="field-label">${label}</span><span class="field-row"><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"><output for="${id}" id="${id}-out">${format(Number(value))}</output></span></label>`;
const check = (id, label, checked) => `<label class="check-row"><input id="${id}" type="checkbox"${checked ? ' checked' : ''}> ${label}</label>`;
/**
 * Open a maths dialog. `run(form)` applies the change to state.project (inside mutate) and returns a toast message.
 */
function mathsDialog({ title, intro, body, submit, icon, run, update }) {
  const { $ } = d;
  d.openDialog(title, `<form id="maths-form" class="maths-form"><p class="modal-body-text">${intro}</p>${body}<p id="maths-error" class="maths-error" role="alert"></p><div class="modal-actions"><button type="button" id="maths-cancel" class="button">Cancel</button><button type="submit" class="button primary">${icon ? d.icon(icon) : ''} ${submit}</button></div></form>`, 'ANIMATE');
  const form = $('maths-form');
  const refresh = () => {
    for (const input of form.querySelectorAll('input[type="range"]')) { const out = $(`${input.id}-out`); if (out) out.textContent = (formatters[input.id] || (v => v))(Number(input.value)); }
    update?.(form);
  };
  form.addEventListener('input', refresh); form.addEventListener('change', refresh); refresh();
  $('maths-cancel').onclick = () => $('modal').close();
  form.onsubmit = event => {
    event.preventDefault();
    let message;
    try { d.mutate(() => { message = run(form); }); }
    catch (error) { $('maths-error').textContent = error.message; return; }
    $('modal').close(); d.renderAll(); if (message) d.toast(message);
  };
}

// ---------------------------------------------------------------------------------------------
// Wave motion

const gcd = (a, b) => b ? gcd(b, a % b) : a;
function waveDialog() {
  const { animation, primary } = context();
  if (!primary) return;
  const count = animation.frames.length, has = primary.op.deform?.kind === 'wave', fit = 360 % count === 0 && count > 1 ? 360 / count : 45;
  mathsDialog({
    title: 'Wave motion', icon: 'wave', submit: 'Animate',
    intro: `Ripple “${d.escapeHTML(primary.name)}” by moving its wave a step further in each frame: flags, water, hair, grass.`,
    body: `<canvas id="wave-preview" class="wave-preview" role="img" aria-label="Live preview of the wave"></canvas>${slider('wave-speed', 'Speed per frame', -180, 180, 5, fit, v => `${v}°`)}
      ${has ? '<p class="maths-info">Uses the object’s wave deform (Transform panel → Deform).</p>' : `<div class="form-grid"><label class="field"><span class="field-label">Sway</span><select id="wave-axis"><option value="x">Rows sideways</option><option value="y">Columns up and down</option></select></label>
      <label class="field"><span class="field-label">Size</span><input id="wave-amplitude" type="number" min="1" max="32" value="2"></label></div>
      <label class="field"><span class="field-label">Wavelength (pixels)</span><input id="wave-length" type="number" min="2" max="256" value="8"></label>`}
      <p id="wave-info" class="maths-info" aria-live="polite"></p>`,
    update() {
      const { $, state } = d, speed = Number($('wave-speed').value);
      try { state.previewOverride = waveAnimate(state.project, { animationId: animation.id, layerId: primary.layerId, instanceId: primary.key, speed, wave: has ? undefined : readWave() }).project; }
      catch { state.previewOverride = null; }
      const loop = speed ? 360 / gcd(360, Math.abs(speed)) : 1;
      d.$('wave-info').innerHTML = !speed ? 'A speed of 0° keeps the wave still.'
        : count % loop === 0 ? `<strong>Seamless loop</strong> · one cycle takes ${plural(loop, 'frame')}, this animation has ${count}.`
        : `Not seamless: one cycle takes ${plural(loop, 'frame')}, this animation has ${count}.${360 % count === 0 && count > 1 ? ` Use ${360 / count}° to loop in ${count}.` : ''}`;
    },
    run() {
      const { state } = d, speed = Number(d.$('wave-speed').value);
      if (!speed) throw new Error('Choose a speed other than 0°.');
      const result = waveAnimate(state.project, { animationId: animation.id, layerId: primary.layerId, instanceId: primary.key, speed, wave: has ? undefined : readWave() });
      state.project = result.project;
      return `Wave over ${plural(result.frameIds.length, 'frame')} · ${result.seamless ? 'loops seamlessly' : `loops every ${result.loopFrames} frames`}.`;
    }
  });
  playPreview(d.$('wave-preview'));
}
const readWave = () => ({ axis: d.$('wave-axis').value, amplitude: Math.max(1, Number(d.$('wave-amplitude').value) || 1), wavelength: Math.max(2, Number(d.$('wave-length').value) || 2) });

/** Play state.previewOverride in a dialog canvas (and the Live Preview) until the dialog closes. */
function playPreview(canvas) {
  const { state } = d, started = performance.now();
  const tick = time => {
    const project = state.previewOverride || state.project, frames = project.animations.find(a => a.id === state.animationId)?.frames;
    if (!d.$('modal').open || !canvas.isConnected) { state.previewOverride = null; d.renderPreview(); return; }
    if (frames?.length) {
      const fps = project.animations.find(a => a.id === state.animationId).fps, frame = frames[Math.floor((time - started) / (1000 / fps)) % frames.length];
      d.paintSprite(canvas, compositeFrame(project, frame), project.palette, true, project.width, project.height);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

