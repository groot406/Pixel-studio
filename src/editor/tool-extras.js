/**
 * Drawing extras for the canvas: the Gradient tool (palette-only gradient fill), clean line slopes and Tile mode
 * (strokes wrap around the edges, the repeat shows faded around the canvas, seams are counted and can be offset).
 * The maths lives in src/domain/effects.js and pixel-fx.js; this module owns their options UI and previews.
 */
import { applyGradient, applyPixelEffect, gradientStops, strokePoints, toolLinePoints, tileSeams } from '../domain/effects.js';
import { gradientFill, applyMask, wrapPoint } from '../domain/pixel-fx.js';
import { rampFromPalette } from '../domain/colour.js';
import { brushPoints, snapLineEnd } from '../domain/toolbox.js';

let d;
const SHAPE_NAMES = { linear: 'Linear', radial: 'Radial', diamond: 'Diamond', angle: 'Angle' };

/** Selection in the shape applyPixelEffect takes: a 0/1 mask (wand) or a rect; null without a selection. */
export function selectionTarget(selection, width, height) {
  if (!selection) return {};
  if (selection.mask) { const mask = new Uint8Array(width * height); for (const i of selection.mask) mask[i] = 1; return { mask }; }
  return { rect: { ...selection.rect } };
}

/** Wire the tool options, tile toggle and status chip. */
export function initToolExtras(deps) {
  d = deps;
  const { state, $ } = d;
  state.gradient = { shape: 'linear', style: 'bands', matrix: 4, repeat: 'clamp', region: 'flood', to: null };
  state.cleanLines = false;
  state.tileMode = false;
  for (const button of document.querySelectorAll('[data-gradient-shape]')) button.onclick = () => { state.gradient.shape = button.dataset.gradientShape; renderToolExtras(); };
  document.querySelector('.gradient-options .seg-control').addEventListener('keydown', event => {
    const keys = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const shapes = Object.keys(SHAPE_NAMES), next = shapes[(shapes.indexOf(state.gradient.shape) + keys[event.key] + shapes.length) % shapes.length];
    state.gradient.shape = next; renderToolExtras();
    document.querySelector(`[data-gradient-shape="${next}"]`).focus();
  });
  $('gradient-style').onchange = e => { state.gradient.style = e.target.value; renderToolExtras(); };
  $('gradient-matrix').onchange = e => { state.gradient.matrix = Number(e.target.value); renderToolExtras(); };
  $('gradient-repeat').onchange = e => { state.gradient.repeat = e.target.value; renderToolExtras(); };
  $('gradient-region').onchange = e => { state.gradient.region = e.target.value; renderToolExtras(); };
  $('gradient-to').onclick = () => { const picker = $('gradient-to-picker'); picker.hidden = !picker.hidden; renderToolExtras(); if (!picker.hidden) picker.querySelector('.selected')?.focus(); };
  $('gradient-to-picker').addEventListener('click', event => {
    const swatch = event.target.closest('[data-index]');
    if (!swatch) return;
    state.gradient.to = Number(swatch.dataset.index);
    $('gradient-to-picker').hidden = true; renderToolExtras(); $('gradient-to').focus();
  });
  $('clean-lines').onchange = e => { state.cleanLines = e.target.checked; d.renderTools(); };
  $('toggle-tile').onclick = () => { d.finishDrawing(); state.tileMode = !state.tileMode; d.renderTools(); d.renderCanvas(); if (!state.tileMode) $('tile-ghost').hidden = true; };
  $('tile-offset').onclick = offsetHalf;
  $('canvas-stage').addEventListener('scroll', () => { if (state.tileMode) renderTileGhost(); }, { passive: true });
  new ResizeObserver(() => { if (state.tileMode) renderTileGhost(); }).observe($('canvas-stage'));
}

/** The gradient's end colour: the chosen one, else the far end of the active colour's ramp. */
function gradientTo() {
  const { state } = d, palette = state.project.palette;
  if (Number.isInteger(state.gradient.to) && state.gradient.to < palette.length) return state.gradient.to;
  const ramp = rampFromPalette(palette, state.color), far = ramp.at(-1) === state.color ? ramp[0] : ramp.at(-1);
  return far !== state.color ? far : (state.color + 1) % palette.length;
}
function gradientColors() { return gradientStops(d.state.project.palette, d.state.color, gradientTo()); }

/** Show the options that belong to the active tool; called from renderTools. */
export function renderToolExtras() {
  const { state, $ } = d, inPlace = Boolean(state.inPlaceEdit);
  $('clean-line-row').hidden = state.tool !== 'line' || inPlace;
  $('clean-lines').checked = state.cleanLines;
  const gradient = state.tool === 'gradient';
  $('gradient-options').hidden = !gradient;
  if (gradient) {
    const g = state.gradient, palette = state.project.palette;
    for (const button of document.querySelectorAll('[data-gradient-shape]')) {
      const on = button.dataset.gradientShape === g.shape;
      button.classList.toggle('active', on); button.setAttribute('aria-checked', String(on)); button.tabIndex = on ? 0 : -1;
    }
    if (g.region === 'mask' && !state.selection) g.region = 'flood';
    $('gradient-region').querySelector('[value="mask"]').disabled = !state.selection;
    $('gradient-region').value = g.region;
    $('gradient-style').value = g.style; $('gradient-matrix').value = String(g.matrix); $('gradient-repeat').value = g.repeat;
    $('gradient-matrix').disabled = g.style !== 'dither';
    const to = gradientTo(), colors = state.color >= 0 ? gradientColors() : [];
    $('gradient-stops').innerHTML = colors.map(i => `<i style="--swatch:${i < 0 ? 'transparent' : palette[i]}"></i>`).join('');
    $('gradient-stops').title = `${colors.length} palette colour${colors.length === 1 ? '' : 's'}: from the active colour to the end colour`;
    $('gradient-to').style.setProperty('--swatch', palette[to]);
    $('gradient-to').title = `End colour ${to + 1} · ${palette[to].toUpperCase()}`;
    $('gradient-to').setAttribute('aria-expanded', String(!$('gradient-to-picker').hidden));
    if (!$('gradient-to-picker').hidden) $('gradient-to-picker').innerHTML = palette.map((c, i) => `<button type="button" class="swatch${i === to ? ' selected' : ''}" style="--swatch:${c}" data-index="${i}" aria-label="Colour ${i + 1} ${c}" title="${c.toUpperCase()}"></button>`).join('');
  } else $('gradient-to-picker').hidden = true;
  $('toggle-tile').classList.toggle('active', state.tileMode);
  $('toggle-tile').setAttribute('aria-pressed', String(state.tileMode));
  $('workbench').classList.toggle('tile-mode', state.tileMode);
  $('tile-status').hidden = !state.tileMode || inPlace;
}

/** Status text for the gradient tool in the canvas footer. */
export function gradientStatus() { const g = d.state.gradient; return `${SHAPE_NAMES[g.shape]}${g.style === 'dither' ? ' · dithered' : ''}`; }

/** True while a stroke may leave the canvas because it wraps (tile mode) or extends a gradient. */
export function unclampedDrawing(drawing) {
  return Boolean(drawing) && (drawing.tool === 'gradient' || (d.state.tileMode && ['pencil', 'eraser', 'dither', 'shade', 'line'].includes(drawing.tool)));
}

/** Points of the line tool, optionally with clean slopes. */
export function lineToolPoints(from, to) {
  return toolLinePoints(from.x, from.y, to.x, to.y, { clean: d.state.cleanLines });
}

/** Brush footprint for tile mode: stamped around each point, mirrored, then wrapped into the canvas. */
export function wrappedFootprint(points, size, shape, symmetry) {
  const { width, height } = d.state.project, span = 2 * size + 1;
  const stamp = brushPoints([{ x: size, y: size }], size, shape, span, span, 'none').map(p => ({ x: p.x - size, y: p.y - size }));
  const raw = [];
  for (const point of points) for (const o of stamp) {
    const x = point.x + o.x, y = point.y + o.y;
    raw.push({ x, y });
    if (symmetry === 'x' || symmetry === 'both') raw.push({ x: width - 1 - x, y });
    if (symmetry === 'y' || symmetry === 'both') raw.push({ x, y: height - 1 - y });
    if (symmetry === 'both') raw.push({ x: width - 1 - x, y: height - 1 - y });
  }
  return strokePoints(raw, { wrap: true, width, height });
}
/** Canvas index of a point, wrapping when tile mode is on. */
export function wrappedIndex(point) {
  const { width, height } = d.state.project, p = d.state.tileMode ? wrapPoint(point.x, point.y, width, height) : point;
  return p.y * width + p.x;
}

// ---------------------------------------------------------------------------------------------
// Gradient drag

function gradientOptions(drawing, end) {
  const { state } = d, g = state.gradient;
  return { from: drawing.origin, to: end, shape: g.shape, style: g.style, matrix: g.matrix, repeat: g.repeat, colors: gradientColors(), region: g.region, seed: drawing.origin };
}
/** Start a gradient drag on the active cel; the preview repaints the cel, the release applies it in the Edit scope. */
export function beginGradient(drawing) {
  const { state } = d;
  if (state.color < 0) throw new Error('Pick a palette colour to start the gradient.');
  drawing.end = drawing.origin;
  drawing.finish = () => finishGradient(drawing);
  return drawing;
}
export function moveGradient(drawing, point, event) {
  const { state } = d, { width, height } = state.project;
  const end = event.shiftKey ? snapLineEnd(drawing.origin, point) : point;
  drawing.end = end;
  if (end.x === drawing.origin.x && end.y === drawing.origin.y) { drawing.cel.pixels = [...drawing.base]; return; }
  const options = gradientOptions(drawing, end), target = selectionTarget(state.selection, width, height);
  const mask = options.region === 'mask' ? (target.mask || rectMask(target.rect, width, height)) : null;
  drawing.cel.pixels = gradientFill(drawing.base, width, height, { ...options, mask });
  if (mask && options.region !== 'mask') drawing.cel.pixels = applyMask(drawing.base, drawing.cel.pixels, mask);
}
function rectMask(rect, width, height) {
  if (!rect) return null;
  const mask = new Uint8Array(width * height);
  for (let y = rect.y; y < rect.y + rect.height; y++) mask.fill(1, y * width + rect.x, y * width + rect.x + rect.width);
  return mask;
}
function finishGradient(drawing) {
  const { state } = d, { width, height } = state.project;
  if (drawing.end.x === drawing.origin.x && drawing.end.y === drawing.origin.y) { state.project = drawing.before.project; d.toast('Drag across the canvas to set the gradient’s direction and length.'); return; }
  const target = { ...d.objectTarget(), scope: state.objectScope, ...(state.gradient.region === 'mask' ? selectionTarget(state.selection, width, height) : {}) };
  const result = applyGradient(drawing.before.project, target, gradientOptions(drawing, drawing.end));
  state.project = result.project;
  if (result.skipped) d.toast(`Gradient applied except in ${result.skipped} frame${result.skipped === 1 ? '' : 's'} with locked objects.`);
}

// ---------------------------------------------------------------------------------------------
// Canvas overlays

/** Drawn on top of the canvas by renderCanvas: the gradient line and tile seam marks. */
export function drawCanvasOverlay(context) {
  const { state } = d, s = state.scale, drawing = state.drawing;
  if (drawing?.tool === 'gradient' && drawing.end) {
    const a = { x: (drawing.origin.x + .5) * s, y: (drawing.origin.y + .5) * s }, b = { x: (drawing.end.x + .5) * s, y: (drawing.end.y + .5) * s };
    context.save();
    context.lineWidth = 3; context.strokeStyle = '#ffffff'; context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
    context.lineWidth = 1.5; context.strokeStyle = '#285b47'; context.setLineDash([5, 4]); context.stroke(); context.setLineDash([]);
    if (state.gradient.shape !== 'linear') {
      const r = Math.hypot(b.x - a.x, b.y - a.y);
      context.beginPath();
      if (state.gradient.shape === 'radial') context.arc(a.x, a.y, r, 0, Math.PI * 2);
      else if (state.gradient.shape === 'diamond') { const dx = Math.abs(b.x - a.x) + Math.abs(b.y - a.y); context.moveTo(a.x, a.y - dx); context.lineTo(a.x + dx, a.y); context.lineTo(a.x, a.y + dx); context.lineTo(a.x - dx, a.y); context.closePath(); }
      if (state.gradient.shape !== 'angle') { context.strokeStyle = '#285b4799'; context.setLineDash([3, 4]); context.stroke(); context.setLineDash([]); }
    }
    for (const [p, fill] of [[a, state.project.palette[state.color]], [b, state.project.palette[gradientTo()]]]) {
      context.beginPath(); context.arc(p.x, p.y, 6, 0, Math.PI * 2);
      context.fillStyle = fill; context.fill(); context.lineWidth = 2; context.strokeStyle = '#ffffff'; context.stroke();
      context.lineWidth = 1; context.strokeStyle = '#285b47'; context.stroke();
    }
    context.restore();
  }
  if (state.tileMode && !state.inPlaceEdit) drawSeams(context);
}
/** Mark edge pixels that differ from the pixel they meet across the wrap. */
function drawSeams(context) {
  const { state } = d, { width, height } = state.project, s = state.scale, pixels = d.canvasPixels();
  context.save(); context.fillStyle = '#e8622c';
  const mark = 2;
  for (let y = 0; y < height; y++) if (pixels[y * width] !== pixels[y * width + width - 1]) { context.fillRect(0, y * s, mark, s); context.fillRect(width * s - mark, y * s, mark, s); }
  for (let x = 0; x < width; x++) if (pixels[x] !== pixels[(height - 1) * width + x]) { context.fillRect(x * s, 0, s, mark); context.fillRect(x * s, height * s - mark, s, mark); }
  context.restore();
}

/** Tile mode: paint the 8 neighbouring repeats, faded, around the canvas (over the stage, never over the art). */
export function renderTileGhost() {
  const { state, $ } = d, ghost = $('tile-ghost');
  if (!state.tileMode || state.inPlaceEdit) { ghost.hidden = true; return; }
  const stage = $('canvas-stage'), wrap = stage.parentElement, art = $('pixel-canvas');
  const stageRect = stage.getBoundingClientRect(), wrapRect = wrap.getBoundingClientRect(), artRect = art.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2), w = stage.clientWidth, h = stage.clientHeight;
  ghost.hidden = false;
  Object.assign(ghost.style, { left: `${stageRect.left - wrapRect.left + stage.clientLeft}px`, top: `${stageRect.top - wrapRect.top + stage.clientTop}px`, width: `${w}px`, height: `${h}px` });
  if (ghost.width !== Math.round(w * ratio) || ghost.height !== Math.round(h * ratio)) { ghost.width = Math.round(w * ratio); ghost.height = Math.round(h * ratio); }
  const context = ghost.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, w, h);
  const { width, height, palette } = state.project, pixels = d.canvasPixels();
  const tile = document.createElement('canvas'); tile.width = width; tile.height = height;
  const image = tile.getContext('2d').createImageData(width, height);
  pixels.forEach((v, i) => {
    if (v < 0) return;
    const hex = palette[v], o = i * 4;
    image.data[o] = parseInt(hex.slice(1, 3), 16); image.data[o + 1] = parseInt(hex.slice(3, 5), 16); image.data[o + 2] = parseInt(hex.slice(5, 7), 16); image.data[o + 3] = 255;
  });
  tile.getContext('2d').putImageData(image, 0, 0);
  const x0 = artRect.left - stageRect.left - stage.clientLeft, y0 = artRect.top - stageRect.top - stage.clientTop, tw = artRect.width, th = artRect.height;
  context.imageSmoothingEnabled = false;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    if (!i && !j) continue;
    const x = x0 + i * tw, y = y0 + j * th;
    context.globalAlpha = 1; context.fillStyle = '#f2f4ed'; context.fillRect(x, y, tw, th);
    context.globalAlpha = .45; context.drawImage(tile, x, y, tw, th);
  }
  context.globalAlpha = 1; context.strokeStyle = '#285b4740'; context.lineWidth = 1;
  context.strokeRect(x0 - tw + .5, y0 - th + .5, tw * 3 - 1, th * 3 - 1);
  const seams = tileSeams(pixels, width, height);
  $('tile-seams').innerHTML = seams ? `<span class="seams-bad">${seams}</span> seam pixel${seams === 1 ? '' : 's'} don’t match across the edges` : '<span class="seams-ok">Seamless</span> edges match';
}

/** Offset by half (wrap-around), in the Edit scope, to bring the seams into the middle for fixing. */
function offsetHalf() {
  const { state } = d;
  if (!d.canEditPixels()) { d.toast('Show and unlock this pixel object to offset it.'); return; }
  try {
    let skipped = 0;
    d.mutate(() => { const result = applyPixelEffect(state.project, { ...d.objectTarget(), scope: state.objectScope }, 'offsetWrap', {}); state.project = result.project; skipped = result.skipped; });
    d.toast(`Offset by half the canvas${state.objectScope === 'animation' ? ' in every frame' : ''}. The seams are now in the middle.${skipped ? ` ${skipped} frame${skipped === 1 ? '' : 's'} with locked objects skipped.` : ''}`);
  } catch (error) { d.toast(error.message); }
}
