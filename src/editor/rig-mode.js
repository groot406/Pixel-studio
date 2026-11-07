/**
 * Skeleton mode: rig placed objects into bone trees and pose them on the canvas (src/domain/skeleton.js). Rig step:
 * click a child part, then its parent where they join (or drag from the child onto the parent). Pose step: drag a part
 * to turn it about its joint (FK, children follow), drag a hand or foot to solve the chain (IK), drag the root to move
 * the figure; key frames, pose clipboard and in-betweens live in the bar (#rig-bar). Every drag is one undo step.
 */
import {
  attachBone, removeBone, renameBone, setBoneLimit, setRestPose, rotateBone, moveSkeleton, ikChain, copyPose, pastePose,
  mirrorPose, resetPose, tweenPoses, rigView, boneOf,
} from '../domain/skeleton.js';
import { instanceBox, instancePixel } from '../domain/geometry.js';
import { frameObjects } from '../domain/objects.js';
import { renderParts } from '../domain/artwork.js';
import { closeMotionMode } from './motion-modes.js';

const PINK = '#ff2d87';
const EASES = [['easeInOut', 'Smooth'], ['easeIn', 'Speed up'], ['easeOut', 'Slow down'], ['linear', 'Linear']];
let d, r = null, clipboard = null;
const imageCache = new WeakMap();

const st = () => d.state;
const animation = () => d.currentAnimation();
const same = (a, b) => Boolean(a && b) && a.layerId === b.layerId && a.key === b.key;
const imageOf = op => { const parts = st().project.parts; if (!imageCache.has(parts)) imageCache.set(parts, renderParts(parts)); return imageCache.get(parts).get(op.partId); };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const frameIndex = () => animation().frames.findIndex(f => f.id === st().frameId);
const scopeIds = () => (st().objectScope === 'frame' ? [st().frameId] : animation().frames.map(f => f.id));
const view = () => rigView(st().project, animation().id, st().frameId);
const bones = () => st().project.bones || [];
const boneName = b => d.escapeHTML(b?.name || b?.id || '');
const boneFor = item => item && boneOf(st().project, item.layerId, item.key);

/** Visible, unlocked placed objects showing a pixel at (or near) canvas point p, topmost first. */
function objectsAt(p, exclude) {
  const list = [];
  for (const { layer, children } of frameObjects(st().project, animation(), d.currentFrame())) if (layer.visible && !layer.locked) {
    for (const n of children) if (n.instance && n.instance.visible !== false && !n.instance.locked) list.push({ layerId: layer.id, key: n.key, name: n.name, op: n.instance });
  }
  const x = Math.floor(p.x), y = Math.floor(p.y), candidates = list.reverse().filter(o => !same(o, exclude));
  for (const reach of [0, 1, 2]) {
    const hits = candidates.filter(o => { for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) if (instancePixel(o.op, imageOf(o.op), { x: x + dx, y: y + dy }) >= 0) return true; return false; });
    if (hits.length) return hits;
  }
  return [];
}
const itemOf = o => o && { layerId: o.layerId, key: o.key, name: o.name };
const opOf = item => d.currentFrame().cels.find(c => c.layerId === item.layerId)?.source?.ops.find(op => op.type === 'use' && op.id === item.key);

// ---------------------------------------------------------------------------------------------
// Overlay

function outline(c, item, dash = [5, 4]) {
  const op = item && opOf(item);
  if (!op) return null;
  const b = instanceBox(op, imageOf(op)), s = st().scale, args = [b.x * s - 1.5, b.y * s - 1.5, b.width * s + 3, b.height * s + 3];
  c.lineWidth = 1.5; c.setLineDash([]); c.strokeStyle = '#fff'; c.strokeRect(...args);
  c.strokeStyle = PINK; c.setLineDash(dash); c.strokeRect(...args); c.setLineDash([]);
  return b;
}
function tag(c, p, text, dy = -16) {
  const s = st().scale;
  c.font = '600 10px system-ui, sans-serif';
  const w = c.measureText(text).width + 10, x = Math.round(p.x * s - w / 2), y = Math.round(p.y * s + dy - 8);
  c.fillStyle = PINK; c.beginPath(); c.roundRect ? c.roundRect(x, y, w, 16, 8) : c.rect(x, y, w, 16); c.fill();
  c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, x + w / 2, y + 8.5);
}
/** A bone as a tapered wedge from joint a (wide) to b (point), white-edged like the motion modes. */
function wedge(c, a, b, { strong = false } = {}) {
  const s = st().scale, ax = a.x * s, ay = a.y * s, bx = b.x * s, by = b.y * s, len = Math.hypot(bx - ax, by - ay);
  if (len < 2) return;
  const w = Math.min(5, Math.max(2.5, len / 6)), nx = -(by - ay) / len * w, ny = (bx - ax) / len * w, mx = ax + (bx - ax) * .15, my = ay + (by - ay) * .15;
  c.beginPath(); c.moveTo(ax, ay); c.lineTo(mx + nx, my + ny); c.lineTo(bx, by); c.lineTo(mx - nx, my - ny); c.closePath();
  c.lineJoin = 'round'; c.lineWidth = 2.5; c.strokeStyle = '#ffffffb0'; c.stroke();
  c.fillStyle = strong ? '#ff2d87d0' : '#ff2d8740'; c.fill(); c.lineWidth = 1; c.strokeStyle = strong ? PINK : '#ff2d87c0'; c.stroke();
}
function joint(c, p, { root = false, strong = false } = {}) {
  const s = st().scale, rad = root ? 6 : 4.5;
  c.beginPath(); c.arc(p.x * s, p.y * s, rad, 0, Math.PI * 2);
  c.fillStyle = root || strong ? PINK : '#fff'; c.fill(); c.lineWidth = 2; c.strokeStyle = root || strong ? '#fff' : PINK; c.stroke();
  if (root) { c.beginPath(); c.arc(p.x * s, p.y * s, rad + 3, 0, Math.PI * 2); c.lineWidth = 1.5; c.strokeStyle = PINK; c.stroke(); }
}
function drawBones(c) {
  const list = view(), active = r.drag?.bone || r.bone, hover = boneFor(r.hover)?.id;
  for (const v of list) {
    const kids = list.filter(k => k.bone.parent === v.bone.id && k.anchor), strong = v.bone.id === active || v.bone.id === hover;
    if (kids.length) kids.forEach(k => wedge(c, v.joint, k.anchor, { strong }));
    else wedge(c, v.joint, v.tip, { strong });
  }
  for (const v of list) joint(c, v.joint, { root: v.root, strong: v.bone.id === active });
  return list;
}

/** Draw the rig and the current gesture on the canvas overlay. */
export function drawRigOverlay(c) {
  if (!r) return;
  placeBar();
  c.save();
  try {
    if (r.step === 'rig') {
      drawBones(c);
      if (r.child) { const b = outline(c, r.child, []); if (b && !r.drag) tag(c, { x: b.x + b.width / 2, y: b.y }, `Child: ${r.child.name}`); }
      if (r.drag?.kind === 'link') {
        const s = st().scale, a = r.drag.from, b = r.drag.to;
        c.beginPath(); c.moveTo(a.x * s, a.y * s); c.lineTo(b.x * s, b.y * s); c.setLineDash([5, 4]); c.lineWidth = 2; c.strokeStyle = PINK; c.stroke(); c.setLineDash([]);
        if (r.hover) outline(c, r.hover);
        joint(c, b, { strong: true });
        tag(c, b, r.hover ? `Join to ${r.hover.name}` : 'Drop on the parent');
      } else if (r.hover && !same(r.hover, r.child)) {
        const b = outline(c, r.hover);
        if (b && r.point) tag(c, r.point, r.child ? `Joint on ${r.hover.name}` : `Child: ${r.hover.name}`);
        if (r.child && r.point) joint(c, r.point);
      }
      return;
    }
    if (r.hover && !r.drag) outline(c, r.hover);
    const list = drawBones(c);
    if (r.drag?.kind === 'ik') { const s = st().scale; c.beginPath(); c.arc(r.drag.to.x * s, r.drag.to.y * s, 5, 0, Math.PI * 2); c.lineWidth = 2; c.strokeStyle = PINK; c.stroke(); }
    if (r.hover && !r.drag && r.point) {
      const v = list.find(x => x.bone.id === boneFor(r.hover)?.id);
      tag(c, r.point, !v ? 'Not rigged' : gesture(v, r.shift) === 'move' ? 'Move figure' : gesture(v, r.shift) === 'ik' ? 'IK drag' : 'Rotate', -18);
    }
  } finally { c.restore(); }
}
/** What dragging this bone does: move the figure (root), IK (leaves while IK is on, or with Shift) or FK rotate. */
function gesture(v, shift) {
  if (v.root) return 'move';
  return (r.ik && v.leaf) !== Boolean(shift) && (r.ik || shift) ? 'ik' : 'rotate';
}

// ---------------------------------------------------------------------------------------------
// Bar

const button = (act, label, { primary = false, icon, disabled = false, title = '', className = '' } = {}) =>
  `<button type="button" class="button small${primary ? ' primary' : ''}${className ? ` ${className}` : ''}" data-act="${act}"${disabled ? ' disabled' : ''}${title ? ` title="${title}"` : ''}${!label && title ? ` aria-label="${title}"` : ''}>${icon ? d.icon(icon) : ''}${label}</button>`;
const chips = (param, options, value) => `<span class="motion-chips" role="radiogroup">${options.map(([v, label, title]) => `<button type="button" class="motion-chip${String(v) === String(value) ? ' active' : ''}" role="radio" aria-checked="${String(v) === String(value)}" data-param="${param}" data-value="${v}"${title ? ` title="${title}"` : ''}>${label}</button>`).join('')}</span>`;
const toggle = (param, label, on, title = '') => `<button type="button" class="motion-chip motion-toggle${on ? ' active' : ''}" aria-pressed="${on}" data-param="${param}" data-toggle${title ? ` title="${title}"` : ''}><i aria-hidden="true"></i>${label}</button>`;
const stepper = (param, label, value, min, max) => `<span class="motion-field"><span>${label}</span><span class="motion-stepper"><button type="button" data-param="${param}" data-step="-1" data-min="${min}" data-max="${max}" aria-label="Fewer ${label.toLowerCase()}"${value <= min ? ' disabled' : ''}>−</button><output>${value}</output><button type="button" data-param="${param}" data-step="1" data-min="${min}" data-max="${max}" aria-label="More ${label.toLowerCase()}"${value >= max ? ' disabled' : ''}>+</button></span></span>`;

function boneList() {
  const list = bones();
  if (!list.length) return '<p class="rig-empty">No bones yet.</p>';
  const depth = b => { let n = 0; for (let at = b; at?.parent; at = list.find(x => x.id === at.parent)) n++; return n; };
  const ordered = [], visit = parent => list.filter(b => b.parent === parent).forEach(b => { ordered.push(b); visit(b.id); });
  visit(null);
  return `<ul class="rig-bones" aria-label="Bones">${ordered.map(b => `<li class="rig-bone${b.id === r.bone ? ' active' : ''}" style="--depth:${depth(b)}" data-bone="${b.id}">
    <span class="rig-dot${b.parent ? '' : ' root'}" aria-hidden="true"></span><input type="text" class="rig-name" value="${boneName(b)}" maxlength="60" data-bone="${b.id}" data-field="name" aria-label="Bone name">
    ${b.parent ? `<button type="button" class="rig-mini${b.limit ? ' on' : ''}" data-act="limit" data-bone="${b.id}" title="${b.limit ? `Limit ${b.limit.min}° to ${b.limit.max}° (click to clear)` : 'Limit how far it bends'}">${b.limit ? `${b.limit.min}…${b.limit.max}°` : '±°'}</button>` : '<span class="rig-root">root</span>'}
    <button type="button" class="rig-mini" data-act="unbone" data-bone="${b.id}" title="Remove this bone" aria-label="Remove ${boneName(b)}">${d.icon('close')}</button>
    ${b.id === r.limitBone ? `<span class="rig-limit"><label>min <input type="number" min="-180" max="180" value="${b.limit?.min ?? -90}" data-bone="${b.id}" data-field="min"></label><label>max <input type="number" min="-180" max="180" value="${b.limit?.max ?? 90}" data-bone="${b.id}" data-field="max"></label>${button('set-limit', 'Set', { primary: true })}</span>` : ''}</li>`).join('')}</ul>`;
}
function hint() {
  if (st().inPlaceEdit) return 'Finish editing the object on the canvas first.';
  if (r.step === 'rig') return r.child ? `<b>Click ${d.escapeHTML(r.child.name)}’s parent</b> right where they join (the joint), or click it again to cancel.`
    : bones().length ? '<b>Click a part</b>, then its parent at the joint. Or drag from a part onto its parent.' : '<b>Click a child part</b> (say an upper arm), then click its parent (the body) where they join. Or drag from child to parent.';
  if (!bones().length) return 'Rig some parts first.';
  return '<b>Drag a part</b> to bend it at its joint · drag a hand or foot to reach (IK) · drag the root to move the figure.';
}
function controls() {
  if (r.step === 'rig') return `<div class="rig-list">${boneList()}</div>
    <span class="rig-row">${button('rest', 'Set rest pose', { disabled: !bones().length, title: 'Remember this frame’s pose; Reset returns to it' })}${button('pose', 'Pose', { primary: true, icon: 'ik', disabled: !bones().length })}</span>`;
  const frames = animation().frames, i = frameIndex(), later = frames.slice(i + 1);
  const rot = bones().length && bones().every(b => !opOf({ layerId: b.layerId, key: b.instanceId }) || opOf({ layerId: b.layerId, key: b.instanceId }).sampling === 'rotsprite');
  const tween = r.tween ? `<div class="rig-tween"><span class="motion-field"><span>To key frame</span><select data-field="tween-to" aria-label="Target key frame">${later.map((f, k) => `<option value="${f.id}"${f.id === r.tween.to ? ' selected' : ''}>Frame ${i + k + 2}</option>`).join('')}</select></span>
      ${stepper('count', 'Add', r.tween.count, 0, 24)}${chips('easing', EASES.map(([v, label]) => [v, label]), r.tween.easing)}${button('tween-apply', 'Insert in-betweens', { primary: true, icon: 'check', disabled: !r.tween.candidate })}${button('tween-close', 'Close')}</div>` : '';
  return `<span class="rig-row"><span class="motion-frames">${button('prev', '', { icon: 'left', title: 'Previous frame (←)' })}<span>Frame ${i + 1} / ${frames.length}</span>${button('next', '', { icon: 'left', title: 'Next frame (→)', className: 'flip-x' })}</span>
    ${button('key', 'New key frame', { icon: 'plus', title: 'Duplicate this frame after it, ready to pose (D)' })}</span>
    <span class="rig-row"><span class="motion-label">Angle</span>${chips('snap', [[0, 'Free'], [5, '5°'], [15, '15°']], r.snap)}${toggle('rotsprite', 'RotSprite', rot, 'Smooth rotated pixels (RotSprite sampling)')}</span>
    <span class="rig-row">${toggle('ik', 'IK hands & feet', r.ik, 'Drag the end of a limb to reach; Shift-drag switches between IK and rotate')}${r.ik ? chips('chain', [['auto', 'Limb'], [2, '2'], [3, '3'], ['all', 'All']], r.chain) : ''}</span>
    <span class="rig-row rig-pose">${button('copy', 'Copy', { icon: 'copy', title: 'Copy this frame’s pose' })}${button('paste', 'Paste', { icon: 'paste', disabled: !clipboard, title: 'Paste the copied pose' })}${button('mirror', 'Mirror', { icon: 'flip-h', title: 'Flip the pose left-right (front views)' })}${button('swap', 'Swap L/R', { icon: 'swap', title: 'Exchange left and right limbs (side-view walk cycles); pairs bones named L/R or left/right' })}${button('reset', 'Reset', { icon: 'undo', title: 'Back to the rest pose' })}</span>
    ${button('tween', 'In-between…', { icon: 'tween', disabled: !later.length, className: r.tween ? 'active' : '', title: later.length ? 'Fill frames between this key pose and a later one' : 'Add a later key frame first' })}${tween}`;
}
function renderBar() {
  const bar = d.$('rig-bar');
  if (!r) { bar.hidden = true; bar.innerHTML = ''; return; }
  const focus = document.activeElement?.closest?.('#rig-bar input[data-field="name"]')?.dataset.bone;
  const steps = ['Rig', 'Pose'].map((label, i) => `<li class="${(r.step === 'pose') === Boolean(i) ? 'now' : ''}"><button type="button" data-param="step" data-value="${label.toLowerCase()}">${label}</button></li>`).join('');
  bar.innerHTML = `<div class="motion-head"><span class="motion-title">${d.icon('bone')}<strong>Skeleton</strong></span><ol class="motion-steps rig-steps">${steps}</ol>
    <span class="motion-hint">${hint()}</span><span class="motion-actions">${button('done', 'Done <kbd>Enter</kbd>', { primary: true, icon: 'check' })}</span></div>
    <div class="motion-controls">${controls()}</div><p class="motion-info" aria-live="polite"></p>`;
  bar.hidden = false;
  bar.querySelector('.rig-tween')?.scrollIntoView({ block: 'nearest' });
  if (focus) bar.querySelector(`input[data-bone="${focus}"][data-field="name"]`)?.focus();
  placeBar(); info();
}
function placeBar() {
  const bar = d.$('rig-bar');
  if (bar.hidden) return;
  const wrap = bar.parentElement.getBoundingClientRect(), canvas = d.$('pixel-canvas').getBoundingClientRect();
  bar.classList.toggle('docked', canvas.left - wrap.left >= 276 && wrap.height >= 360);
}
function info(text = r?.info) {
  const el = d.$('rig-bar').querySelector('.motion-info');
  if (!el || !r) return;
  el.classList.toggle('is-error', Boolean(r.error));
  el.textContent = r.error || text || (r.step === 'pose' ? `${st().objectScope === 'frame' ? `Poses frame ${frameIndex() + 1} only` : 'Poses every frame (Edit: All frames)'} · ${bones().length} bones` : `${bones().length} bones`);
}

// ---------------------------------------------------------------------------------------------
// Lifecycle and actions

/** Open (or close, when open) Skeleton mode. */
export function toggleRigMode() { if (r) closeRigMode(); else openRigMode(); }
export function openRigMode() {
  const { state } = d;
  if (state.inPlaceEdit) { d.toast('Finish editing the object on the canvas first.'); return; }
  closeMotionMode(); d.finishDrawing();
  r = { step: bones().length ? 'pose' : 'rig', snap: 0, ik: true, chain: 'auto', playing: state.playing, scope: state.objectScope, tween: null };
  Object.assign(state, { selection: null, cursor: null, objectSelection: null, playing: true, previewTime: 0, objectScope: 'frame' });
  d.$('workbench').classList.add('motion-active'); d.$('workbench').dataset.motion = 'rig';
  renderBar(); d.renderAll();
}
export function closeRigMode({ render = true } = {}) {
  if (!r) return;
  const { state } = d, { playing, scope } = r;
  r = null;
  Object.assign(state, { previewOverride: null, playing, objectScope: scope, previewTime: 0, previewIndex: Math.max(0, frameIndex()) });
  d.$('workbench').classList.remove('motion-active'); delete d.$('workbench').dataset.motion;
  d.$('pixel-canvas').style.cursor = '';
  renderBar();
  if (render) d.renderAll();
}
export const rigModeOpen = () => Boolean(r);

/** Keep the mode in step with the project (called by renderAll). */
export function syncRigMode() {
  if (!r) return;
  if (st().inPlaceEdit) { closeRigMode({ render: false }); return; }
  if (r.bone && !bones().some(b => b.id === r.bone)) r.bone = null;
  if (st().frameId !== r.seenFrame) r.info = '';
  if (r.tween) computeTween();
  if (st().project !== r.seen || st().frameId !== r.seenFrame || st().objectScope !== r.seenScope) {
    Object.assign(r, { seen: st().project, seenFrame: st().frameId, seenScope: st().objectScope });
    if (!r.drag) renderBar();
  }
}
function computeTween() {
  const frames = animation().frames, i = frameIndex();
  if (!frames.slice(i + 1).some(f => f.id === r.tween.to)) r.tween.to = frames[i + 1]?.id;
  r.tween.candidate = null; r.error = '';
  if (!r.tween.to) { st().previewOverride = null; return; }
  try {
    const result = tweenPoses(st().project, { animationId: animation().id, fromFrameId: st().frameId, toFrameId: r.tween.to, insert: r.tween.count, easing: r.tween.easing });
    r.tween.candidate = result.project; r.info = `${result.frameIds.length} in-between${result.frameIds.length === 1 ? '' : 's'} (${result.inserted.length} new frames) · Live Preview shows the result`;
  } catch (error) { r.error = error.message; }
  st().previewOverride = r.tween.candidate;
}
function commit(change, message) {
  try { d.mutate(() => { st().project = change(st().project); }); if (message) d.toast(message); }
  catch (error) { d.toast(error.message); d.renderAll(); }
}
const poseOpts = () => ({ animationId: animation().id, frameId: st().frameId, frameIds: scopeIds() });
function act(name, el) {
  const { state } = d;
  if (name === 'done') return closeRigMode();
  if (name === 'pose') { Object.assign(r, { step: 'pose', child: null, info: '' }); renderBar(); d.renderAll(); return; }
  if (name === 'prev' || name === 'next') { d.selectFrameAt(frameIndex() + (name === 'prev' ? -1 : 1)); return; }
  if (name === 'key') { d.addFrame(true); return; }
  if (name === 'rest') return commit(p => setRestPose(p, poseOpts()), 'Rest pose saved: Reset returns here.');
  if (name === 'copy') { clipboard = copyPose(state.project, poseOpts()); renderBar(); d.toast('Pose copied. Go to another frame and Paste.'); return; }
  if (name === 'paste') return commit(p => pastePose(p, { ...poseOpts(), pose: clipboard }).project);
  if (name === 'mirror' || name === 'swap') return commit(p => mirrorPose(p, { ...poseOpts(), swap: name === 'swap' }).project);
  if (name === 'reset') return commit(p => resetPose(p, poseOpts()).project);
  if (name === 'tween') { r.tween = r.tween ? null : { count: 3, easing: 'easeInOut', to: animation().frames[frameIndex() + 1]?.id }; if (!r.tween) state.previewOverride = null; else computeTween(); renderBar(); d.renderCanvas(); d.renderPreview(); return; }
  if (name === 'tween-close') { r.tween = null; r.error = ''; state.previewOverride = null; renderBar(); d.renderPreview(); return; }
  if (name === 'tween-apply') {
    const project = r.tween.candidate, count = r.tween.count;
    if (!project) return;
    r.tween = null; state.previewOverride = null;
    return commit(() => project, `In-betweens added${count ? ` (${count} new frames)` : ''}. Pose the next key frame.`);
  }
  if (name === 'unbone') return commit(p => removeBone(p, el.dataset.bone), 'Bone removed.');
  if (name === 'limit') {
    const bone = bones().find(b => b.id === el.dataset.bone);
    if (bone?.limit) return commit(p => setBoneLimit(p, bone.id, null), 'Limit cleared.');
    r.limitBone = r.limitBone === el.dataset.bone ? null : el.dataset.bone; renderBar(); return;
  }
  if (name === 'set-limit') {
    const row = el.closest('.rig-bone'), min = Number(row.querySelector('[data-field="min"]').value), max = Number(row.querySelector('[data-field="max"]').value);
    r.limitBone = null;
    return commit(p => setBoneLimit(p, row.dataset.bone, { min: Math.min(min, max), max: Math.max(min, max) }));
  }
}
function setParam(name, value) {
  if (name === 'step') { Object.assign(r, { step: value, child: null, tween: null, info: '' }); st().previewOverride = null; renderBar(); d.renderAll(); return; }
  if (name === 'rotsprite') {
    const ids = new Set(bones().map(b => `${b.layerId}/${b.instanceId}`));
    return commit(p => { for (const f of p.animations.find(a => a.id === animation().id).frames) for (const cel of f.cels) for (const op of cel.source?.ops || []) if (op.type === 'use' && ids.has(`${cel.layerId}/${op.id}`)) { if (value) op.sampling = 'rotsprite'; else delete op.sampling; } return p; });
  }
  if (['count', 'easing'].includes(name)) { r.tween[name] = value; computeTween(); renderBar(); d.renderPreview(); return; }
  r[name] = value; renderBar(); d.renderCanvas();
}

// ---------------------------------------------------------------------------------------------
// Input

function attach(child, parent, point) {
  let id;
  commit(p => { const out = attachBone(p, { animationId: animation().id, frameId: st().frameId, child: { layerId: child.layerId, instanceId: child.key }, parent: { layerId: parent.layerId, instanceId: parent.key }, point }); id = out.boneId; return out.project; });
  if (id) { r.bone = id; r.child = null; r.info = `${child.name} now hangs from ${parent.name}. Next: another part, or Pose.`; renderBar(); d.renderCanvas(); }
}
function down(p, event) {
  const hit = itemOf(objectsAt(p)[0]);
  if (r.step === 'rig') {
    if (!hit) { r.child = null; d.toast('Click a placed part (drag one from Parts onto the canvas first).'); renderBar(); d.renderCanvas(); return; }
    r.drag = { kind: 'link', child: r.child || hit, from: p, to: p, picked: !r.child };
    return;
  }
  const bone = boneFor(hit), v = bone && view().find(x => x.bone.id === bone.id);
  if (!v) { d.toast(hit ? `${hit.name} isn’t rigged. Switch to Rig to attach it.` : 'Drag a rigged part.'); return; }
  const kind = gesture(v, event.shiftKey);
  r.bone = bone.id;
  r.drag = { kind, bone: bone.id, from: p, to: p, before: d.snapshot(), joint: v.joint };
  r.error = '';
}
function move(p) {
  const g = r.drag;
  g.to = p;
  if (g.kind === 'link') {
    const over = objectsAt(p, g.child)[0];
    r.hover = dist(g.from, p) > 1.5 && over ? itemOf(over) : null;
    d.renderCanvas(); return;
  }
  const base = g.before.project, opts = { ...poseOpts(), boneId: g.bone, step: r.snap || undefined };
  try {
    if (g.kind === 'move') st().project = moveSkeleton(base, { ...opts, dx: Math.round(p.x - g.from.x), dy: Math.round(p.y - g.from.y) }).project;
    else if (g.kind === 'rotate') {
      const a0 = Math.atan2(g.from.y - g.joint.y, g.from.x - g.joint.x), a1 = Math.atan2(p.y - g.joint.y, p.x - g.joint.x);
      st().project = rotateBone(base, { ...opts, delta: (a1 - a0) * 180 / Math.PI }).project;
    } else {
      const chainLength = r.chain === 'auto' ? undefined : r.chain === 'all' ? 256 : Number(r.chain);
      const out = ikChain(base, { ...opts, endBoneId: g.bone, chainLength, target: p, grab: g.from });
      st().project = out.project; r.info = out.reached ? '' : 'Out of reach: the limb stretches toward the pointer.';
    }
  } catch (error) { st().project = base; r.error = error.message; }
  d.renderCanvas(); d.renderPreview(); info();
}
function up(p) {
  const g = r.drag;
  r.drag = null;
  if (g.kind === 'link') {
    r.hover = null;
    if (dist(g.from, p) > 1.5) {
      const parent = itemOf(objectsAt(p, g.child)[0]);
      if (parent) { attach(g.child, parent, p); return; }
      if (g.picked) { r.child = null; d.toast('Drop onto the parent part, where they join.'); }
    } else if (g.picked) r.child = g.child;
    else {
      const parent = itemOf(objectsAt(p, r.child)[0]);
      if (!parent || same(parent, r.child)) r.child = null;
      else { attach(r.child, parent, p); return; }
    }
    renderBar(); d.renderCanvas(); return;
  }
  d.remember(g.before); d.renderAll();
}
function setCursor() {
  const canvas = d.$('pixel-canvas');
  if (r.step === 'rig') { canvas.style.cursor = r.hover ? 'pointer' : 'crosshair'; return; }
  const v = r.hover && view().find(x => x.bone.id === boneFor(r.hover)?.id);
  canvas.style.cursor = r.drag ? (r.drag.kind === 'move' ? 'move' : 'grabbing') : v ? (gesture(v, r.shift) === 'move' ? 'move' : 'grab') : 'default';
}
function pointer(event) {
  if (!r) return;
  const type = event.type;
  event.stopImmediatePropagation();
  if (type === 'dblclick' || type === 'contextmenu') { event.preventDefault(); return; }
  if (event.button > 0 && type === 'pointerdown') return;
  const p = d.canvasPosition(event);
  r.shift = event.shiftKey;
  if (type === 'pointerdown') {
    event.preventDefault();
    d.$('canvas-stage').setPointerCapture?.(event.pointerId);
    down(p, event);
  } else if (type === 'pointermove') {
    if (r.drag) { move(p); return; }
    const over = itemOf(objectsAt(p, r.step === 'rig' ? r.child : null)[0]) || null;
    r.point = p;
    if (!same(over, r.hover) || r.step === 'rig' || over) { r.hover = over; d.renderCanvas(); }
  } else if (r.drag) {
    if (type === 'pointercancel') { if (r.drag.before) st().project = r.drag.before.project; r.drag = null; d.renderAll(); return; }
    up(p);
  }
  if (r) setCursor();
}
function keydown(event) {
  if (!r || d.$('modal').open) return;
  const key = event.key.toLowerCase(), typing = event.target.closest('textarea,select,input');
  if (key === 'escape') {
    event.preventDefault(); event.stopImmediatePropagation();
    if (r.drag) return;
    if (r.child || r.tween || r.limitBone) { r.child = null; r.limitBone = null; if (r.tween) act('tween-close'); renderBar(); d.renderCanvas(); return; }
    closeRigMode(); return;
  }
  if (typing || key === 'tab' || event.ctrlKey || event.metaKey || event.altKey) return;
  if (key === 'enter') { event.preventDefault(); event.stopImmediatePropagation(); if (!r.drag) closeRigMode(); return; }
  if (key === 'shift') { r.shift = true; setCursor(); d.renderCanvas(); return; }
  if (!['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'j', 'd', 'delete', 'backspace', 'v', 'k'].includes(key)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (key === 'arrowleft' || key === 'arrowright') act(key === 'arrowleft' ? 'prev' : 'next');
  else if (key === 'j') closeRigMode();
  else if (key === 'd') act('key');
}

export function initRigMode(deps) {
  d = deps;
  const stage = d.$('canvas-stage'), bar = d.$('rig-bar');
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dblclick', 'contextmenu']) stage.addEventListener(type, pointer, true);
  stage.addEventListener('pointerleave', () => { if (r?.hover && !r.drag) { r.hover = null; d.renderCanvas(); } });
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('keyup', event => { if (r && event.key === 'Shift') { r.shift = false; setCursor(); d.renderCanvas(); } });
  bar.addEventListener('click', event => {
    const b = event.target.closest('button');
    if (!b || !r || b.disabled) return;
    if (b.dataset.act) { act(b.dataset.act, b); return; }
    const name = b.dataset.param;
    if (name) setParam(name, 'step' in b.dataset ? Math.max(Number(b.dataset.min), Math.min(Number(b.dataset.max), r.tween[name] + Number(b.dataset.step))) : 'toggle' in b.dataset ? !b.classList.contains('active') : /^\d+$/.test(b.dataset.value) ? Number(b.dataset.value) : b.dataset.value);
    else if (b.closest('.rig-bone')) { r.bone = b.closest('.rig-bone').dataset.bone; d.renderCanvas(); }
  });
  bar.addEventListener('change', event => {
    const el = event.target;
    if (!r) return;
    if (el.dataset.field === 'name') commit(p => renameBone(p, el.dataset.bone, el.value));
    if (el.dataset.field === 'tween-to') { r.tween.to = el.value; computeTween(); renderBar(); d.renderPreview(); }
  });
  bar.addEventListener('focusin', event => { const row = event.target.closest('.rig-bone'); if (row && r && r.bone !== row.dataset.bone) { r.bone = row.dataset.bone; d.renderCanvas(); } });
  bar.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.dataset?.field === 'name') { event.preventDefault(); event.target.blur(); } });
}
