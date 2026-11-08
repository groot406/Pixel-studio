/**
 * Object pose controls in the Transform panel: pivot (reset, or drag the crosshair on the canvas), skew, 3D turn, deform and
 * sampling (Nearest, RotSprite or Smooth AA) of the selected placed object(s). Values are stored on the instances (objects.setObjectEffects)
 * in the Edit scope; sliders preview live and commit one undo step on release.
 */
import { setObjectEffects } from '../domain/objects.js';
import { editScope, editFrameIds, editScopeText } from './edit-scope.js';
import { instancePivot, pivotUnder, withPivot, DEFAULT_PERSPECTIVE } from '../domain/geometry.js';

let d, live = null, pivotDrag = null;
const DEFORM_DEFAULTS = { wave: { axis: 'x', amplitude: 2, wavelength: 8, phase: 0 }, bulge: { strength: 50 }, pinch: { strength: 50 }, twist: { angle: 90 } };

export function initObjectPose(deps) {
  d = deps;
  const { $ } = d;
  for (const axis of ['x', 'y']) {
    const range = $(`pose-skew-${axis}`), number = $(`pose-skew-${axis}-value`);
    const read = el => Math.max(-60, Math.min(60, Math.round(Number(el.value) || 0)));
    range.oninput = () => { number.value = range.value; preview({ skew: skewValue() }); };
    number.oninput = () => { if (number.value === '' || number.value === '-') return; range.value = String(read(number)); preview({ skew: skewValue() }); };
    range.onchange = number.onchange = () => { number.value = range.value = String(read(number === document.activeElement ? number : range)); commit({ skew: skewValue() }); };
  }
  for (const [id, lo, hi] of [['pose-tilt-y', -180, 180], ['pose-tilt-x', -180, 180], ['pose-perspective', 0, 100]]) {
    const range = $(id), number = $(`${id}-value`), read = el => Math.max(lo, Math.min(hi, Math.round(Number(el.value) || 0)));
    range.oninput = () => { number.value = range.value; preview({ tilt: tiltValue() }); };
    number.oninput = () => { if (number.value === '' || number.value === '-') return; range.value = String(read(number)); preview({ tilt: tiltValue() }); };
    range.onchange = number.onchange = () => { number.value = range.value = String(read(number === document.activeElement ? number : range)); commit({ tilt: tiltValue() }); };
  }
  $('pose-tilt-reset').onclick = () => apply({ tilt: null });
  $('pose-deform').onchange = () => { const kind = $('pose-deform').value; apply({ deform: kind === 'none' ? null : deformFrom(kind, DEFORM_DEFAULTS[kind]) }); };
  $('pose-deform-params').addEventListener('input', event => { if (event.target.matches('[data-param]')) { syncParam(event.target, false); preview({ deform: readDeform() }); } });
  $('pose-deform-params').addEventListener('change', event => { if (event.target.matches('[data-param]')) { syncParam(event.target, true); commit({ deform: readDeform() }); } });
  $('pose-sampling').onchange = () => { const v = $('pose-sampling').value; apply({ sampling: v === 'nearest' ? null : v }); };
  $('pose-pivot-reset').onclick = () => setPivot(null);
  const marker = $('pivot-marker');
  if (!marker.firstChild) marker.append(document.createElement('i'));
  marker.addEventListener('pointerdown', beginPivotDrag);
  marker.addEventListener('pointermove', movePivotDrag);
  marker.addEventListener('pointerup', event => endPivotDrag(event, false));
  marker.addEventListener('pointercancel', event => endPivotDrag(event, true));
}

function skewValue() {
  const x = Number(d.$('pose-skew-x').value) || 0, y = Number(d.$('pose-skew-y').value) || 0;
  return x || y ? { x, y } : null;
}
/** 3D turn from the sliders; null when flat (perspective alone changes nothing). */
function tiltValue() {
  const { $ } = d, x = Number($('pose-tilt-x').value) || 0, y = Number($('pose-tilt-y').value) || 0;
  return x || y ? { x, y, perspective: Number($('pose-perspective').value) || 0 } : null;
}
function deformFrom(kind, values) {
  if (kind === 'wave') return { kind: 'wave', axis: values.axis, amplitude: values.amplitude, wavelength: values.wavelength, phase: values.phase };
  if (kind === 'twist') return { kind: 'twist', angle: values.angle };
  return { kind: 'bulge', strength: kind === 'pinch' ? -Math.abs(values.strength) : Math.abs(values.strength) };
}
function readDeform() {
  const kind = d.$('pose-deform').value, values = {};
  if (kind === 'none') return null;
  for (const el of d.$('pose-deform-params').querySelectorAll('[data-param]')) if (el.type !== 'number') values[el.dataset.param] = el.tagName === 'SELECT' ? el.value : Number(el.value);
  return deformFrom(kind, values);
}
function syncParam(el, final) {
  const twin = d.$('pose-deform-params').querySelector(`[data-param="${el.dataset.param}"]:not([type="${el.type}"])`);
  if (!twin) return;
  if (el.type === 'number') { const v = Math.max(Number(el.min), Math.min(Number(el.max), Math.round(Number(el.value) || 0))); twin.value = String(v); if (final) el.value = String(v); }
  else twin.value = el.value;
}

/** The primary object's instance (and the objects the pose applies to). */
function poseTarget() {
  const object = d.resizableObject(), items = d.transformItems();
  if (!object || !items.length) return null;
  return { object, items, op: object.node.instance, target: d.objectTarget(object.item.layerId) };
}

/** Live preview while a slider moves: re-apply from the project as it was before the drag. */
function preview(changes) {
  const pose = poseTarget();
  if (!pose) return;
  live ||= d.snapshot();
  try {
    d.state.project = setObjectEffects(live.project, pose.target, pose.items, changes, editScope(d.state));
    d.$('pose-scope').classList.remove('error');
    d.renderCanvas(); d.renderPreview();
  } catch (error) { d.state.project = live.project; showError(error); }
}
function commit(changes) {
  preview(changes);
  const before = live; live = null;
  if (before) d.remember(before);
  d.renderAll();
}
function apply(changes) {
  const pose = poseTarget();
  if (!pose) return;
  try { d.mutate(() => { d.state.project = setObjectEffects(d.state.project, pose.target, pose.items, changes, editScope(d.state)); }); d.renderAll(); }
  catch (error) { showError(error); d.renderAll(); }
}
function showError(error) { d.toast(error.message); }

/** Show the pose of the selected object; called from renderTransformControls. */
export function renderObjectPose() {
  const { $, state } = d, block = $('object-pose'), pose = poseTarget();
  block.hidden = !pose;
  if (!pose) return;
  const { op, items, object } = pose, count = items.length;
  $('object-pose-count').textContent = count > 1 ? `· ${count} objects` : `· ${object.node?.name || object.part?.name || 'object'}`;
  $('pose-pivot-value').textContent = op.pivot ? `${op.pivot.x}, ${op.pivot.y} px` : 'Centre';
  $('pose-pivot-reset').disabled = !op.pivot;
  $('pose-pivot-hint').textContent = ['object', 'resize'].includes(state.tool)
    ? 'Drag the pink crosshair on the canvas to move the pivot. Rotation, skew, 3D turns and twist turn around it.'
    : 'Choose the Object or Transform tool to drag the pivot crosshair on the canvas.';
  if (!live) {
    for (const axis of ['x', 'y']) for (const id of [`pose-skew-${axis}`, `pose-skew-${axis}-value`]) if (document.activeElement !== $(id)) $(id).value = String(op.skew?.[axis] || 0);
    const tilt = { x: op.tilt?.x || 0, y: op.tilt?.y || 0, perspective: op.tilt?.perspective ?? DEFAULT_PERSPECTIVE };
    for (const [id, value] of [['pose-tilt-x', tilt.x], ['pose-tilt-y', tilt.y], ['pose-perspective', tilt.perspective]])
      for (const el of [$(id), $(`${id}-value`)]) if (document.activeElement !== el) el.value = String(value);
    const kind = op.deform ? (op.deform.kind === 'bulge' && op.deform.strength < 0 ? 'pinch' : op.deform.kind) : 'none';
    $('pose-deform').value = kind;
    renderDeformParams(kind, op.deform);
  }
  const flat = !op.tilt;
  $('pose-tilt-value').textContent = flat ? 'Flat' : [op.tilt.y && `turned ${op.tilt.y}°`, op.tilt.x && `tipped ${op.tilt.x}°`].filter(Boolean).join(', ');
  $('pose-tilt-reset').disabled = flat;
  $('pose-sampling').value = op.sampling || 'nearest';
  const frames = d.currentAnimation().frames.length;
  $('pose-scope').textContent = `${count > 1 ? 'Applies to each selected object' : 'Applies'} in ${editScopeText(state, d.currentAnimation())} (Edit switch above the canvas).`;
}

function renderDeformParams(kind, deform) {
  const { $ } = d, host = $('pose-deform-params');
  if (host.dataset.kind === kind && host.contains(document.activeElement)) return;
  host.dataset.kind = kind;
  const v = { ...DEFORM_DEFAULTS[kind], ...(deform || {}) };
  const slider = (param, label, min, max, value, unit = '') => `<label class="pose-row"><span class="pose-label">${label}</span><input type="range" data-param="${param}" min="${min}" max="${max}" step="1" value="${value}" aria-label="${label}${unit}"><input class="pose-number" type="number" data-param="${param}" min="${min}" max="${max}" step="1" value="${value}" aria-label="${label}${unit}"></label>`;
  host.innerHTML = kind === 'wave'
    ? `<label class="pose-row"><span class="pose-label">Along</span><select data-param="axis" aria-label="Wave direction"><option value="x"${v.axis === 'x' ? ' selected' : ''}>Rows sway sideways</option><option value="y"${v.axis === 'y' ? ' selected' : ''}>Columns sway up and down</option></select><span></span></label>`
      + slider('amplitude', 'Size', 1, 32, v.amplitude, ' in pixels') + slider('wavelength', 'Length', 2, 64, Math.min(64, v.wavelength), ' in pixels') + slider('phase', 'Phase', 0, 359, v.phase, ' in degrees')
    : kind === 'bulge' || kind === 'pinch' ? slider('strength', 'Amount', 1, 100, Math.abs(v.strength), ' percent')
    : kind === 'twist' ? slider('angle', 'Angle', -360, 360, v.angle, ' in degrees') : '';
}

// ---------------------------------------------------------------------------------------------
// Pivot crosshair

/** Position the pivot crosshair over the selected object (Object and Transform tools). */
export function renderPivotMarker() {
  const { $, state } = d, marker = $('pivot-marker');
  const object = ['object', 'resize'].includes(state.tool) && !state.drawing && d.resizableObject();
  if (!object && !pivotDrag) { marker.hidden = true; return; }
  if (!object) return;
  const p = pivotDrag?.at || instancePivot(object.node.instance, object.part), s = state.scale;
  marker.hidden = false;
  marker.style.left = `${p.x * s}px`; marker.style.top = `${p.y * s}px`;
}

/**
 * Set (or reset with null) the pivot and move each instance so its artwork stays where it is: changing the point a
 * transform turns around shifts the art by (I − M)·Δ, which the position undoes (to the nearest whole pixel).
 */
function pivotProject(project, pose, pivot) {
  const { state } = d, scope = editScope(state), inScope = new Set(editFrameIds(state, state.project.animations.find(a => a.id === pose.target.animationId)));
  const next = setObjectEffects(project, pose.target, pose.items, { pivot }, scope);
  const keys = new Set(pose.items.map(item => `${item.layerId}:${item.key}`));
  const before = project.animations.find(a => a.id === pose.target.animationId), after = next.animations.find(a => a.id === pose.target.animationId);
  after.frames.forEach((frame, index) => {
    if (!inScope.has(frame.id)) return;
    for (const cel of frame.cels) for (const op of cel.source?.ops || []) {
      if (op.type !== 'use' || !keys.has(`${cel.layerId}:${op.id}`) || (!op.angle && !op.skew && !op.tilt)) continue;
      const old = before.frames[index].cels.find(c => c.layerId === cel.layerId).source.ops.find(o => o.type === 'use' && o.id === op.id);
      const moved = withPivot(old, next.parts.find(p => p.id === op.partId), op.pivot);
      op.x = moved.x; op.y = moved.y;
    }
  });
  return next;
}
function setPivot(pivot) {
  const pose = poseTarget();
  if (!pose) return;
  try { d.mutate(() => { d.state.project = pivotProject(d.state.project, pose, pivot); }); d.renderAll(); d.toast(pivot ? 'Pivot moved. The object turns around it now.' : 'Pivot back in the centre.'); }
  catch (error) { d.toast(error.message); d.renderAll(); }
}

function beginPivotDrag(event) {
  if (event.button !== 0) return;
  const pose = poseTarget();
  if (!pose) return;
  event.preventDefault(); event.stopPropagation();
  const marker = d.$('pivot-marker');
  marker.setPointerCapture(event.pointerId); marker.classList.add('dragging');
  pivotDrag = { pointerId: event.pointerId, before: d.snapshot(), pose, at: null };
}
function movePivotDrag(event) {
  if (pivotDrag?.pointerId !== event.pointerId) return;
  const at = d.canvasPosition(event), { pose, before } = pivotDrag;
  const pivot = pivotUnder(pose.op, pose.object.part, at);
  pivotDrag.at = { x: at.x, y: at.y };
  try { d.state.project = pivotProject(before.project, pose, pivot); pivotDrag.pivot = pivot; } catch { d.state.project = before.project; }
  d.renderCanvas(); d.renderPreview();
  d.$('pose-pivot-value').textContent = `${pivot.x}, ${pivot.y} px`;
}
function endPivotDrag(event, cancel) {
  if (pivotDrag?.pointerId !== event.pointerId) return;
  const drag = pivotDrag; pivotDrag = null;
  const marker = d.$('pivot-marker');
  marker.classList.remove('dragging');
  if (marker.hasPointerCapture(event.pointerId)) marker.releasePointerCapture(event.pointerId);
  if (cancel || !drag.pivot) d.state.project = drag.before.project;
  else if (d.remember(drag.before)) d.toast(`Pivot at ${drag.pivot.x}, ${drag.pivot.y} px. Rotation, skew, 3D turns and twist turn around it now.`);
  d.renderAll();
}
