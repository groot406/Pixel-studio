/**
 * Palette tools: add a hue-shifted shading ramp around the active colour, and colour cycling (palette animation along
 * a ramp of swatches) over existing or new frames. Domain: effects.addShadingRamp / colourCycle, colour.js.
 */
import { addShadingRamp, colourCycle } from '../domain/effects.js';
import { shadingRamp, rampFromPalette, cycleLoopLength } from '../domain/colour.js';

let d;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function initPaletteTools(deps) {
  d = deps;
  d.$('shading-ramp').onclick = rampDialog;
  d.$('colour-cycle').onclick = cycleDialog;
}

function form(id, intro, body, submit, icon, eyebrow, title) {
  d.openDialog(title, `<form id="${id}" class="maths-form"><p class="modal-body-text">${intro}</p>${body}<p id="${id}-error" class="maths-error" role="alert"></p><div class="modal-actions"><button type="button" class="button" data-close>Cancel</button><button type="submit" class="button primary">${d.icon(icon)} ${submit}</button></div></form>`, eyebrow);
  d.$(id).querySelector('[data-close]').onclick = () => d.$('modal').close();
  return d.$(id);
}
function submitWith(el, run) {
  el.onsubmit = event => {
    event.preventDefault();
    let message;
    try { d.mutate(() => { message = run(); }); }
    catch (error) { d.$(`${el.id}-error`).textContent = error.message; return; }
    d.$('modal').close(); d.renderAll(); d.toast(message);
  };
}

function rampDialog() {
  const { state, $ } = d, palette = state.project.palette;
  if (state.color < 0) { d.toast('Pick a palette colour first: the ramp is built around it.'); return; }
  const base = palette[state.color];
  const el = form('ramp-form', `Build shades of <strong>${base.toUpperCase()}</strong>: shadows turn cooler, highlights warmer, the way painters shift hue. Colours already in the palette are reused.`,
    `<div id="ramp-preview" class="ramp-strip" role="img" aria-label="Ramp preview"></div>
    <label class="field"><span class="field-label">Steps</span><span class="field-row"><input id="ramp-steps" type="range" min="2" max="16" step="1" value="5"><output id="ramp-steps-out" for="ramp-steps">5</output></span></label>
    <label class="field"><span class="field-label">Hue shift</span><span class="field-row"><input id="ramp-hue" type="range" min="0" max="60" step="1" value="20"><output id="ramp-hue-out" for="ramp-hue">20°</output></span></label>
    <p id="ramp-info" class="maths-info"></p>`, 'Add to palette', 'ramp', 'PALETTE', 'Shading ramp');
  const update = () => {
    const steps = Number($('ramp-steps').value), hueShift = Number($('ramp-hue').value);
    $('ramp-steps-out').textContent = steps; $('ramp-hue-out').textContent = `${hueShift}°`;
    try {
      const colours = shadingRamp(base, { steps, hueShift }), fresh = colours.filter(c => !palette.includes(c)).length;
      const nearest = colours.reduce((best, c, i) => dist(c, base) < dist(colours[best], base) ? i : best, 0);
      $('ramp-preview').innerHTML = colours.map((c, i) => `<i class="${i === nearest ? 'base' : ''}" style="--swatch:${c}" title="${c.toUpperCase()}"></i>`).join('');
      $('ramp-preview').setAttribute('aria-label', `Ramp preview: ${colours.join(', ')}`);
      $('ramp-info').textContent = `Up to ${plural(fresh, 'new colour')} · the palette has ${palette.length} of 64.`;
      $('ramp-form-error').textContent = '';
    } catch (error) { $('ramp-form-error').textContent = error.message; }
  };
  el.addEventListener('input', update); update();
  submitWith(el, () => {
    const before = state.project.palette.length;
    const result = addShadingRamp(state.project, state.color, { steps: Number($('ramp-steps').value), hueShift: Number($('ramp-hue').value) });
    state.project = result.project;
    const added = result.project.palette.length - before;
    return added ? `Added ${plural(added, 'colour')} to the palette (${result.indices.length}-step ramp).` : 'Every shade of this ramp was already in the palette.';
  });
}
function dist(a, b) { let s = 0; for (const o of [1, 3, 5]) s += (parseInt(a.slice(o, o + 2), 16) - parseInt(b.slice(o, o + 2), 16)) ** 2; return s; }

function cycleDialog() {
  const { state, $ } = d, palette = state.project.palette, animation = d.currentAnimation(), layer = d.currentLayer();
  let ramp = state.color >= 0 ? rampFromPalette(palette, state.color) : [];
  if (ramp.length < 2) ramp = [];
  const el = form('cycle-form', 'Animate colours by stepping every pixel along a ramp of swatches each frame: flowing water, flickering fire, glowing lights.',
    `<div class="field"><span class="field-label" id="cycle-pick-label">Ramp · click swatches in cycle order</span><div id="cycle-pick" class="swatch-pick" role="group" aria-labelledby="cycle-pick-label">${palette.map((c, i) => `<button type="button" class="swatch" style="--swatch:${c}" data-index="${i}" aria-pressed="false" aria-label="Colour ${i + 1} ${c.toUpperCase()}" title="${c.toUpperCase()}"></button>`).join('')}</div></div>
    <div id="cycle-strip" class="ramp-strip" role="img" aria-label="Cycle order"></div>
    <div class="form-grid"><label class="field"><span class="field-label">Steps per frame</span><input id="cycle-steps" type="number" min="1" max="8" step="1" value="1"></label>
    <label class="field"><span class="field-label">Direction</span><select id="cycle-direction"><option value="1">Forward (left to right)</option><option value="-1">Backward</option></select></label></div>
    <div class="form-grid"><label class="field"><span class="field-label">Frames</span><select id="cycle-frames"><option value="loop">New frames: one full loop</option><option value="existing"${animation.frames.length > 1 ? '' : ' disabled'}>The existing ${plural(animation.frames.length, 'frame')}</option><option value="count">New frames: a number</option></select></label>
    <label class="field"><span class="field-label">Number of frames</span><input id="cycle-count" type="number" min="2" max="64" step="1" value="8"></label></div>
    <label class="field"><span class="field-label">Colours in</span><select id="cycle-layer"><option value="layer">“${d.escapeHTML(layer.name)}” only</option><option value="all">Every visible, unlocked container</option></select></label>
    <p id="cycle-info" class="maths-info" aria-live="polite"></p>`, 'Cycle colours', 'cycle', 'PALETTE', 'Colour cycle');
  const update = () => {
    for (const button of $('cycle-pick').querySelectorAll('[data-index]')) button.setAttribute('aria-pressed', String(ramp.includes(Number(button.dataset.index))));
    $('cycle-strip').innerHTML = ramp.map(i => `<i style="--swatch:${palette[i]}"></i>`).join('');
    $('cycle-count').disabled = $('cycle-frames').value !== 'count';
    const steps = Math.max(1, Math.round(Number($('cycle-steps').value) || 1));
    if (ramp.length < 2) { $('cycle-info').textContent = 'Pick at least two colours.'; return; }
    const loop = cycleLoopLength(ramp, steps), mode = $('cycle-frames').value;
    $('cycle-info').textContent = mode === 'loop' ? `Adds ${plural(loop - 1, 'frame')} after this one: a seamless ${loop}-frame loop.`
      : mode === 'existing' ? `${animation.frames.length % loop === 0 ? 'Seamless' : 'Not seamless'}: the cycle repeats every ${plural(loop, 'frame')}, this animation has ${animation.frames.length}.`
      : `Adds ${plural(Math.max(1, Number($('cycle-count').value) - 1), 'frame')} after this one; the cycle repeats every ${plural(loop, 'frame')}.`;
  };
  $('cycle-pick').addEventListener('click', event => {
    const button = event.target.closest('[data-index]');
    if (!button) return;
    const index = Number(button.dataset.index);
    ramp = ramp.includes(index) ? ramp.filter(i => i !== index) : [...ramp, index];
    update();
  });
  el.addEventListener('input', update); el.addEventListener('change', update); update();
  submitWith(el, () => {
    const mode = $('cycle-frames').value, frames = mode === 'count' ? Math.round(Number($('cycle-count').value)) : mode;
    const result = colourCycle(state.project, { animationId: animation.id, frameId: d.currentFrame().id, layerId: $('cycle-layer').value === 'layer' ? layer.id : undefined, rampIndices: ramp, stepsPerFrame: Math.max(1, Math.round(Number($('cycle-steps').value) || 1)), direction: Number($('cycle-direction').value), frames });
    state.project = result.project;
    return `Colour cycle over ${plural(result.frameIds.length, 'frame')} · loops every ${result.loopLength}.`;
  });
}
