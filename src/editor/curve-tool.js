/**
 * Curve tool (P): a cubic Bézier curve — drag start → end, then bend it by dragging the curve or its two handles
 * (Alt mirrors the other handle for a symmetric arc) — or a smooth Path through clicked points, optionally closed and
 * filled. The pending curve floats on the canvas overlay; Enter, a double-click or a click away commits it as one
 * undo step with the brush size, mirror mode, colour and selection, Esc cancels. Maths in src/domain/curves.js.
 */
import { curvePixels, pathPixels, sampleCubic, samplePath, straightHandles, bendThrough, mirrorHandle, polygonFill, distanceToSamples } from '../domain/curves.js';
import { brushPoints, snapLineEnd } from '../domain/toolbox.js';
import { antialiasStroke } from '../domain/antialias.js';
import { beginInPlaceStroke, moveInPlaceStroke, finishInPlaceStroke } from '../features/objects/in-place-edit.js';

let d, active = null, drag = null;
const HIT = 9, GREEN = '#285b47';
const HINTS = {
  curve: 'Drag from start to end, then drag the curve or its round handles to bend it (Alt mirrors the other handle). Enter, double-click or click away applies; Esc cancels.',
  path: 'Click to add points; a smooth line runs through them. Drag a point to move it, Backspace removes the last. Double-click, Enter or click the first point to finish; Esc cancels.',
};

/** Wire the curve options. */
export function initCurveTool(deps) {
  d = deps;
  const { state, $ } = d;
  state.curve = { mode: 'curve', closed: false, fill: false, antialias: false };
  for (const button of document.querySelectorAll('[data-curve-mode]')) button.onclick = () => { commitCurve(); state.curve.mode = button.dataset.curveMode; d.renderTools(); d.renderCanvas(); };
  $('curve-closed').onchange = e => { state.curve.closed = e.target.checked; d.renderTools(); d.renderCanvas(); };
  $('curve-fill').onchange = e => { state.curve.fill = e.target.checked; d.renderTools(); d.renderCanvas(); };
  $('curve-antialias').onchange = e => { state.curve.antialias = e.target.checked; d.renderTools(); d.renderCanvas(); };
  $('curve-apply').onclick = () => { commitCurve(); d.renderAll(); };
  $('curve-cancel').onclick = () => { cancelCurve(); d.renderAll(); };
  $('pixel-canvas').addEventListener('dblclick', () => { if (active && d.state.tool === 'curve') { commitCurve(); d.renderAll(); } });
}

/** True while a curve or path waits to be applied. */
export const curvePending = () => Boolean(active);

/** Options row and hint; a pending curve is applied when another tool is chosen. */
export function renderCurveOptions() {
  const { state, $ } = d, on = state.tool === 'curve', c = state.curve;
  if (!on && active) queueMicrotask(() => { if (active && d.state.tool !== 'curve') { commitCurve(); d.renderAll(); } });
  $('curve-options').hidden = !on;
  if (!on) return;
  for (const button of document.querySelectorAll('[data-curve-mode]')) {
    const selected = button.dataset.curveMode === c.mode;
    button.classList.toggle('active', selected); button.setAttribute('aria-checked', String(selected));
  }
  $('tool-hint').textContent = HINTS[c.mode];
  $('curve-closed-row').hidden = c.mode !== 'path';
  $('curve-fill-row').hidden = c.mode !== 'path' || !c.closed || Boolean(state.inPlaceEdit);
  $('curve-aa-row').hidden = Boolean(state.inPlaceEdit);
  $('curve-closed').checked = c.closed; $('curve-fill').checked = c.fill; $('curve-antialias').checked = c.antialias;
  $('curve-aa-row').title = state.brushSize > 1 ? 'Anti-aliasing works on 1 px curves' : 'Soften the stair steps with in-between palette colours';
  $('curve-antialias').disabled = state.brushSize > 1;
  $('curve-actions').hidden = !active;
}

// ---------------------------------------------------------------------------------------------
// Geometry of the pending curve

const closedPath = () => active?.mode === 'path' && (d.state.curve.closed || active.close) && active.points.length > 2;
function samples() {
  if (!active) return [];
  return active.mode === 'curve' ? sampleCubic(active.p0, active.c1, active.c2, active.p3) : samplePath(active.points, { closed: closedPath() });
}
/** 1px stroke pixels of the pending curve. */
function stroke() {
  if (!active) return [];
  return active.mode === 'curve' ? curvePixels(active.p0, active.c1, active.c2, active.p3) : pathPixels(active.points, { closed: closedPath() });
}
/** Pixels inside a closed, filled path. */
function fillPixels() {
  const { width, height } = d.state.project;
  return closedPath() && d.state.curve.fill ? polygonFill(samples(), width, height) : [];
}
/** Pointer position in pixel-centre coordinates (pixel x,y has its centre at x,y). */
function position(event) { const p = d.canvasPosition(event); return { x: p.x - .5, y: p.y - .5 }; }
const near = (a, b, s) => Math.hypot(a.x - b.x, a.y - b.y) * s <= HIT;
const pixel = p => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** Why the curve cannot be drawn here, or ''. */
function blocked() {
  const { state } = d, layer = d.currentLayer();
  if (state.inPlaceEdit) return '';
  if (!layer.visible || layer.locked) return `“${layer.name}” is ${layer.locked ? 'locked. Unlock it' : 'hidden. Show it'} before drawing.`;
  if (!d.canEditPixels()) return 'Unlock objects in this group before painting local pixel edits.';
  return '';
}

// ---------------------------------------------------------------------------------------------
// Pointer and keys (called from app.js before the generic tool handling)

/** Pointer down with the Curve tool; returns true when handled. */
export function curvePointerDown(event) {
  const { state } = d, s = state.scale, at = position(event), point = pixel(at), { width, height } = state.project;
  const onCanvas = point.x >= 0 && point.y >= 0 && point.x < width && point.y < height;
  if (event.altKey && !(active?.mode === 'curve' && !active.straight && ['c1', 'c2'].some(k => near(active[k], at, s)))) return false;
  event.preventDefault();
  if (event.button !== 0) return true;
  if (active?.mode === 'curve') {
    const hit = ['c1', 'c2', 'p0', 'p3'].find(k => near(active[k], at, s));
    if (hit) drag = { kind: hit, last: at };
    else if (distanceToSamples(samples(), at) * s <= HIT) drag = { kind: 'bend' };
    else { commitCurve(); d.renderAll(); return startCurve(event, point, onCanvas); }
  } else if (active?.mode === 'path') {
    const index = active.points.findIndex(p => near(p, at, s));
    if (index === 0 && active.points.length > 2 && !state.curve.closed) { active.close = true; commitCurve(); d.renderAll(); return true; }
    if (index >= 0) drag = { kind: 'point', index };
    else { active.points.push(point); drag = { kind: 'point', index: active.points.length - 1 }; }
  } else return startCurve(event, point, onCanvas);
  capture(event); d.renderCanvas();
  return true;
}
function startCurve(event, point, onCanvas) {
  const { state } = d;
  if (!onCanvas) return true;
  const reason = blocked();
  if (reason) { d.toast(reason); return true; }
  active = state.curve.mode === 'curve' ? { mode: 'curve', p0: point, p3: point, c1: point, c2: point, straight: true } : { mode: 'path', points: [point] };
  drag = state.curve.mode === 'curve' ? { kind: 'p3' } : { kind: 'point', index: 0 };
  capture(event); d.renderTools(); d.renderCanvas();
  return true;
}
function capture(event) { drag.pointerId = event.pointerId; d.$('pixel-canvas').setPointerCapture(event.pointerId); }

/** Pointer move while dragging part of the curve; returns true when handled. */
export function curvePointerMove(event) {
  if (!drag || event.pointerId !== drag.pointerId || !active) return false;
  const at = position(event), point = pixel(at);
  if (active.mode === 'path') active.points[drag.index] = point;
  else if (active.straight) {
    active.p3 = event.shiftKey ? snapLineEnd(active.p0, point) : point;
    [active.c1, active.c2] = straightHandles(active.p0, active.p3);
  } else if (drag.kind === 'bend') active.c1 = active.c2 = bendThrough(active.p0, active.p3, at);
  else if (drag.kind === 'c1' || drag.kind === 'c2') {
    active[drag.kind] = at;
    if (event.altKey) active[drag.kind === 'c1' ? 'c2' : 'c1'] = mirrorHandle(active.p0, active.p3, at);
  } else {
    const handle = drag.kind === 'p0' ? 'c1' : 'c2', moved = drag.kind === 'p0' ? active.p0 : active.p3;
    active[handle] = { x: active[handle].x + point.x - moved.x, y: active[handle].y + point.y - moved.y };
    active[drag.kind] = point;
  }
  d.renderCanvas();
  return true;
}

/** Pointer up; returns true when handled. */
export function curvePointerUp(event) {
  if (!drag || event.pointerId !== drag.pointerId) return false;
  if (d.$('pixel-canvas').hasPointerCapture(event.pointerId)) d.$('pixel-canvas').releasePointerCapture(event.pointerId);
  drag = null;
  if (active?.straight) {
    if (active.p0.x === active.p3.x && active.p0.y === active.p3.y) active = null;
    else active.straight = false;
  }
  if (event.type === 'pointercancel') active = null;
  d.renderTools(); d.renderCanvas();
  return true;
}

/** Enter applies, Esc cancels, Backspace removes the last path point, Ctrl/⌘ Z cancels; returns true when handled. */
export function curveKey(event) {
  if (!active || d.state.tool !== 'curve') return false;
  const key = event.key.toLowerCase();
  if (key === 'enter') { event.preventDefault(); commitCurve(); d.renderAll(); return true; }
  if (key === 'escape' || ((event.ctrlKey || event.metaKey) && key === 'z')) { event.preventDefault(); cancelCurve(); d.renderAll(); return true; }
  if ((key === 'backspace' || key === 'delete') && active.mode === 'path') {
    event.preventDefault();
    if (active.points.length > 1) active.points.pop(); else active = null;
    d.renderTools(); d.renderCanvas(); return true;
  }
  return false;
}

export function cancelCurve() { active = null; drag = null; }

// ---------------------------------------------------------------------------------------------
// Applying

/** Mask of the pixel selection (Set of indices), or null. */
function selectionAllows() {
  const sel = d.state.selection, width = d.state.project.width;
  if (!sel || d.state.inPlaceEdit) return null;
  if (sel.mask) return new Set(sel.mask);
  const out = new Set(), r = sel.rect;
  for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) out.add(y * width + x);
  return out;
}

/** Paint the pending curve into the active pixel object as one undo step. */
export function commitCurve() {
  if (!active) return;
  const { state } = d, points = stroke(), fill = fillPixels();
  active = null; drag = null;
  if (!points.length) return;
  if (state.inPlaceEdit) { commitInPlace(points); return; }
  const reason = blocked();
  if (reason) { d.toast(reason); return; }
  const { width, height, palette } = state.project, layer = d.currentLayer(), cel = d.currentFrame().cels.find(c => c.layerId === layer.id);
  const drawing = { pointerId: -1, tool: 'curve', before: d.snapshot(), cel, base: [...cel.pixels], color: state.color, touched: new Set(), footprint: new Set(), path: [] };
  state.drawing = drawing;
  for (const { x, y } of fill) { const i = y * width + x; cel.pixels[i] = state.color; drawing.footprint.add(i); }
  d.drawPoints(points, state.color);
  const allowed = selectionAllows();
  if (allowed) for (const i of [...drawing.footprint]) if (!allowed.has(i)) { cel.pixels[i] = drawing.base[i]; drawing.footprint.delete(i); }
  if (state.curve.antialias && state.brushSize === 1 && state.color >= 0) {
    const inside = points.filter(p => p.x >= 0 && p.y >= 0 && p.x < width && p.y < height && (!allowed || allowed.has(p.y * width + p.x)));
    const smoothed = antialiasStroke(cel.pixels, width, height, inside, state.color, palette, { under: d.canvasPixels() });
    smoothed.forEach((v, i) => { if (v !== cel.pixels[i] && (!allowed || allowed.has(i))) { cel.pixels[i] = v; drawing.footprint.add(i); } });
  }
  d.finishDrawing();
}

/** In-place object editing: the curve becomes one pencil stroke in the draft (fill is not available there). */
function commitInPlace(points) {
  const { state } = d, session = state.inPlaceEdit.session;
  try {
    const s = beginInPlaceStroke(session, points[0], { tool: 'pencil', color: state.color, brushSize: state.brushSize, brushShape: state.brushShape, symmetry: state.symmetry });
    if (!s) return;
    for (const p of points.slice(1)) moveInPlaceStroke(session, s, p);
    finishInPlaceStroke(session, s);
    state.inPlaceEdit.error = null;
  } catch (error) { state.inPlaceEdit.error = error.message; }
}

// ---------------------------------------------------------------------------------------------
// Overlay

/** The pending curve's pixels (brush, mirror and fill included) and its guide, handles and points. */
export function drawCurveOverlay(context) {
  if (!active || d.state.tool !== 'curve') return;
  const { state } = d, s = state.scale, { width, height, palette } = state.project;
  const footprint = brushPoints(stroke(), state.brushSize, state.brushShape, width, height, state.symmetry);
  const colour = state.color >= 0 ? palette[state.color] : '#ffffff';
  context.save();
  context.globalAlpha = state.color >= 0 ? 1 : .7;
  context.fillStyle = colour;
  for (const { x, y } of [...fillPixels(), ...footprint]) context.fillRect(x * s, y * s, s, s);
  context.globalAlpha = 1;
  const screen = p => ({ x: (p.x + .5) * s, y: (p.y + .5) * s }), line = (pts, dash) => {
    if (pts.length < 2) return;
    context.beginPath(); pts.map(screen).forEach((p, i) => (i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)));
    context.lineWidth = 3; context.strokeStyle = '#ffffffcc'; context.setLineDash([]); context.stroke();
    context.lineWidth = 1.25; context.strokeStyle = GREEN; context.setLineDash(dash); context.stroke(); context.setLineDash([]);
  };
  const dot = (p, fill, r = 5.5) => { const q = screen(p); context.beginPath(); context.arc(q.x, q.y, r, 0, Math.PI * 2); context.fillStyle = fill; context.fill(); context.lineWidth = 2; context.strokeStyle = '#fff'; context.stroke(); context.lineWidth = 1; context.strokeStyle = GREEN; context.stroke(); };
  const square = p => { const q = screen(p); context.fillStyle = '#fff'; context.fillRect(q.x - 5, q.y - 5, 10, 10); context.lineWidth = 1.5; context.strokeStyle = GREEN; context.strokeRect(q.x - 4.25, q.y - 4.25, 8.5, 8.5); };
  line(samples(), [4, 3]);
  if (active.mode === 'curve') {
    if (!active.straight) { line([active.p0, active.c1], [2, 3]); line([active.p3, active.c2], [2, 3]); dot(active.c1, GREEN); dot(active.c2, GREEN); }
    square(active.p0); square(active.p3);
  } else {
    const last = active.points.at(-1);
    if (state.cursor && !drag && !closedPath()) line([last, state.cursor], [2, 4]);
    active.points.forEach((p, i) => (i === 0 && active.points.length > 2 && !state.curve.closed ? dot(p, '#ffd166', 6.5) : square(p)));
  }
  context.restore();
}
