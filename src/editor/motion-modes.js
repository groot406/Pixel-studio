/**
 * Motion modes: direct-manipulation animation of placed objects on the canvas (src/domain/animate.js). A mode floats a
 * bar over the canvas (#motion-bar), takes the canvas pointer and keys while open, draws ghosts and handles on the
 * canvas overlay and plays its candidate result in the Live Preview (state.previewOverride). Enter applies the
 * candidate as one undo step, Esc cancels. IK poses and smears commit as they go (undoable); Enter/Esc finish them.
 */
import { tweenObject, tweenToPose, bounceInPlace, autoSquashStretch, springFollow, ikLimb, setPivotAt, limbJoints, smearFrame, canInsertFrames, motionPath } from '../domain/animate.js';
import { editScope, editScopeText } from './edit-scope.js';
import { ease, solveTwoBone } from '../domain/motion.js';
import { instanceBox, instancePivot, instancePixel } from '../domain/geometry.js';
import { frameObjects } from '../domain/objects.js';
import { renderParts } from '../domain/artwork.js';
import { markKinds } from '../domain/timing.js';

const PINK = '#ff2d87';
const EASES = [['easeInOut', 'Smooth'], ['easeIn', 'Speed up'], ['easeOut', 'Slow down'], ['backOut', 'Overshoot'], ['bounceOut', 'Bounce'], ['elasticOut', 'Elastic'], ['linear', 'Linear']];
const FOLLOW = { tail: ['Tail', 'swings', { stiffness: .3, damping: .5 }], hair: ['Hair', 'soft', { stiffness: .2, damping: .7 }], cape: ['Cape', 'heavy', { stiffness: .12, damping: .8, delay: 1 }], antenna: ['Antenna', 'bouncy', { stiffness: .5, damping: .15 }] };
const FORMATS = { squash: v => `${Math.round(v * 100)}%`, lag: v => (v ? `${v} frame${v === 1 ? '' : 's'}` : 'None'), steps: v => (v ? String(v) : 'Auto') };

let d, m = null, frameRequest = 0;
const imageCache = new WeakMap(), rigs = [];

const st = () => d.state;
const animation = () => d.currentAnimation();
/** IK in 'all' mode: every frame, or the frames picked in the timeline when the Edit switch is on Selected. */
const ikFrames = () => { const s = editScope(d.state); return Array.isArray(s) ? s : undefined; };
const same = (a, b) => Boolean(a && b) && a.layerId === b.layerId && a.key === b.key;
const opIn = (frame, item) => frame?.cels.find(c => c.layerId === item.layerId)?.source?.ops.find(op => op.type === 'use' && op.id === item.key);
const frameIn = (project, id) => project?.animations.find(a => a.id === st().animationId)?.frames.find(f => f.id === id);
const here = (item = m.item) => item && opIn(d.currentFrame(), item);
const partOf = op => st().project.parts.find(p => p.id === op.partId);
const imageOf = (project, op) => { if (!imageCache.has(project.parts)) imageCache.set(project.parts, renderParts(project.parts)); return imageCache.get(project.parts).get(op.partId); };
const boxOf = op => instanceBox(op, partOf(op));
const pivotOf = op => instancePivot(op, partOf(op));
const target = item => ({ animationId: animation().id, layerId: item.layerId, instanceId: item.key });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const frameNo = id => animation().frames.findIndex(f => f.id === id) + 1;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sig = op => JSON.stringify([op.x, op.y, op.width, op.height, op.angle || 0, op.skew || 0, op.tilt || 0, op.deform || 0, op.transform || 'N']);
const quote = item => `“${d.escapeHTML(item.name)}”`;
/** Whether the object's pose changes over the animation's frames. */
const moves = item => new Set(animation().frames.map(f => opIn(f, item)).filter(Boolean).map(sig)).size > 1;

/** Visible placed objects of the current frame, bottom to top. */
function placed() {
  const list = [];
  for (const { layer, children } of frameObjects(st().project, animation(), d.currentFrame())) if (layer.visible) {
    for (const n of children) if (n.instance && n.instance.visible !== false) list.push({ layerId: layer.id, key: n.key, name: n.name, op: n.instance });
  }
  return list;
}
const itemOf = o => ({ layerId: o.layerId, key: o.key, name: o.name });
/** Placed objects showing a pixel at (or, failing that, near) canvas point p, topmost first. */
function objectsAt(p, exclude) {
  const x = Math.floor(p.x), y = Math.floor(p.y), list = placed().reverse().filter(o => !same(o, exclude) && !o.op.locked);
  for (const r of [0, 1, 2]) {
    const hits = list.filter(o => {
      const image = imageOf(st().project, o.op);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (instancePixel(o.op, image, { x: x + dx, y: y + dy }) >= 0) return true;
      return false;
    });
    if (hits.length) return hits;
  }
  return [];
}
function selectedInstance() {
  const selection = st().objectSelection;
  return selection && !st().inPlaceEdit ? placed().find(o => same(o, selection)) : null;
}
/** Canvas pixels an instance shows. */
function pixelsOf(project, op) {
  const image = imageOf(project, op), b = instanceBox(op, image), out = [];
  for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) if (instancePixel(op, image, { x, y }) >= 0) out.push({ x, y });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Overlay drawing (CSS px; one canvas pixel = state.scale)

/** An onion ghost of an instance pose: its pixels faded, with a pink silhouette like the selection highlight. */
function ghost(c, project, op, alpha) {
  const image = imageOf(project, op), b = instanceBox(op, image), s = st().scale, on = new Set();
  c.globalAlpha = alpha;
  for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) {
    const v = instancePixel(op, image, { x, y });
    if (v >= 0) { on.add(`${x},${y}`); c.fillStyle = project.palette[v]; c.fillRect(x * s, y * s, s, s); }
  }
  c.beginPath();
  for (const key of on) {
    const [x, y] = key.split(',').map(Number), px = x * s, py = y * s;
    if (!on.has(`${x},${y - 1}`)) { c.moveTo(px, py); c.lineTo(px + s, py); }
    if (!on.has(`${x},${y + 1}`)) { c.moveTo(px, py + s); c.lineTo(px + s, py + s); }
    if (!on.has(`${x - 1},${y}`)) { c.moveTo(px, py); c.lineTo(px, py + s); }
    if (!on.has(`${x + 1},${y}`)) { c.moveTo(px + s, py); c.lineTo(px + s, py + s); }
  }
  c.globalAlpha = Math.min(1, alpha + .25); c.lineWidth = 1; c.strokeStyle = PINK; c.stroke();
  c.globalAlpha = 1;
  return b;
}
function outline(c, b, dash = [5, 4]) {
  const s = st().scale, W = st().project.width * s, H = st().project.height * s;
  const x0 = Math.max(1, b.x * s - 1.5), y0 = Math.max(1, b.y * s - 1.5), args = [x0, y0, Math.min(W - 1, (b.x + b.width) * s + 1.5) - x0, Math.min(H - 1, (b.y + b.height) * s + 1.5) - y0];
  c.lineWidth = 1.5; c.setLineDash([]); c.strokeStyle = '#fff'; c.strokeRect(...args);
  c.strokeStyle = PINK; c.setLineDash(dash); c.strokeRect(...args); c.setLineDash([]);
}
function line(c, points, dash = []) {
  const s = st().scale;
  c.beginPath(); points.forEach((p, i) => (i ? c.lineTo(p.x * s, p.y * s) : c.moveTo(p.x * s, p.y * s)));
  c.lineCap = c.lineJoin = 'round'; c.setLineDash([]); c.strokeStyle = '#fff'; c.lineWidth = 4; c.stroke();
  c.setLineDash(dash); c.strokeStyle = PINK; c.lineWidth = 2; c.stroke(); c.setLineDash([]);
}
function handle(c, p, { r = 6, filled = false } = {}) {
  const s = st().scale;
  c.beginPath(); c.arc(p.x * s, p.y * s, r, 0, Math.PI * 2);
  c.fillStyle = filled ? PINK : '#fff'; c.fill(); c.lineWidth = 2; c.strokeStyle = filled ? '#fff' : PINK; c.stroke();
  if (!filled) { c.beginPath(); c.arc(p.x * s, p.y * s, r + 2, 0, Math.PI * 2); c.lineWidth = 1; c.strokeStyle = '#ff2d8755'; c.stroke(); }
}
function tag(c, p, text, { dx = 0, dy = 0 } = {}) {
  const s = st().scale;
  c.font = '600 10px system-ui, sans-serif';
  const w = c.measureText(text).width + 10, x = Math.round(p.x * s + dx - w / 2), y = Math.round(p.y * s + dy - 8);
  c.fillStyle = PINK; c.beginPath(); c.roundRect ? c.roundRect(x, y, w, 16, 8) : c.rect(x, y, w, 16); c.fill();
  c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, x + w / 2, y + 8.5);
}
function crosshair(c, p) {
  const s = st().scale, x = p.x * s, y = p.y * s;
  c.lineWidth = 4; c.strokeStyle = '#fff'; c.beginPath(); c.moveTo(x - 11, y); c.lineTo(x + 11, y); c.moveTo(x, y - 11); c.lineTo(x, y + 11); c.stroke();
  c.lineWidth = 2; c.strokeStyle = PINK; c.stroke();
  handle(c, p, { r: 5 });
}
/** Label a box above it, or below/inside when the canvas edge would clip it. */
const boxTag = (c, b, text, below = false) => {
  const s = st().scale, h = st().project.height, top = b.y * s >= 20, bottom = (h - b.y - b.height) * s >= 20;
  if (top && !(below && bottom)) tag(c, { x: b.x + b.width / 2, y: b.y }, text, { dy: -12 });
  else tag(c, { x: b.x + b.width / 2, y: Math.min(b.y + b.height, h) }, text, { dy: bottom ? 12 : -12 });
};
const hoverTag = (c, item, text) => { const op = here(item); if (op) { const b = boxOf(op); outline(c, b); boxTag(c, b, text); } };

// ---------------------------------------------------------------------------------------------
// Modes

/** Move: ends, path and bend handle of the move from the current pose. */
function moveGeometry() {
  const op = here(), part = partOf(op);
  const end = m.to ? opIn(frameIn(st().project, m.to), m.item) || op : { ...op, x: op.x + m.dx, y: op.y + m.dy };
  const a = instancePivot(op, part), c = instancePivot(end, part), len = dist(a, c);
  const n = len ? { x: -(c.y - a.y) / len, y: (c.x - a.x) / len } : { x: 0, y: -1 }, centre = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
  const mid = { x: centre.x + n.x * m.bend, y: centre.y + n.y * m.bend };
  return { op, end, a, c, n, centre, mid, len, path: m.bend && len ? { kind: 'arc', via: mid } : undefined };
}
const gapTo = id => animation().frames.findIndex(f => f.id === id) - animation().frames.findIndex(f => f.id === st().frameId);
function easeIcon(name) {
  const points = Array.from({ length: 21 }, (_, i) => `${(1 + i * .8).toFixed(1)},${(13 - ease(name, i / 20) * 10).toFixed(1)}`).join(' ');
  return `<svg class="motion-curve" viewBox="0 0 18 16" aria-hidden="true"><polyline points="${points}"/></svg>`;
}

const MODES = {
  move: {
    title: 'Animate a move', icon: 'tween',
    init() {
      const op = here(), b = boxOf(op);
      const right = st().project.width - b.x - b.width, left = b.x, room = Math.max(right, left);
      const dx = Math.sign(right >= left ? 1 : -1) * Math.max(4, Math.min(b.width + 2, room));
      const later = animation().frames.slice(animation().frames.findIndex(f => f.id === st().frameId) + 1).find(f => opIn(f, m.item) && sig(opIn(f, m.item)) !== sig(op));
      Object.assign(m, { dx, dy: 0, bend: 0, frames: 6, easing: 'easeInOut', squash: false, orient: false, to: null, keyframe: later?.id || null });
    },
    hint: () => (m.to ? `Moves to its pose in frame ${frameNo(m.to)}. Drag the round handle to curve the path.` : `<b>Drag the ghost</b> to where ${quote(m.item)} ends up. Drag the round handle to curve the path.`),
    controls() {
      const min = m.to ? Math.max(2, gapTo(m.to)) : 2;
      return `${stepper('frames', 'Frames', m.frames, min, 24)}${chips('easing', EASES.map(([v, label]) => [v, `${easeIcon(v)}<span class="motion-label">${label}</span>`, false, label]), m.easing)}
        ${toggle('squash', 'Squash & stretch', m.squash)}${toggle('orient', 'Turn along path', m.orient, !m.bend, 'Curve the path first')}
        ${m.keyframe ? toggle('to', `To frame ${frameNo(m.keyframe)}`, Boolean(m.to), false, 'Use the pose it already has in that frame as the end') : ''}`;
    },
    param(name, value) {
      if (name === 'to') { m.to = value ? m.keyframe : null; if (m.to) m.frames = Math.max(m.frames, 2, gapTo(m.to)); return true; }
      if (name === 'frames' && m.to) { m.frames = Math.max(value, gapTo(m.to)); return true; }
    },
    compute() {
      const g = moveGeometry(), from = st().frameId;
      const common = { ...target(m.item), fromFrameId: from, easing: m.easing, path: g.path, orient: m.orient && Boolean(g.path), autoSquash: m.squash ? { strength: .5 } : undefined };
      if (m.to) {
        const gap = gapTo(m.to), r = tweenObject(st().project, { ...common, toFrameId: m.to, insert: Math.max(0, m.frames - gap) });
        markKinds(r.project, st().animationId, { key: [from, m.to], inbetween: r.frameIds });
        m.ghosts = r.frameIds; m.info = `${plural(r.frameIds.length, 'in-between')}${r.inserted.length ? ` (${r.inserted.length} new)` : ''} up to the pose in frame ${frameNo(m.to)}`;
        return r.project;
      }
      if (!m.dx && !m.dy) throw new Error('Drag the ghost to where the move should end.');
      const r = tweenToPose(st().project, { ...common, endPose: { x: g.end.x, y: g.end.y }, frames: m.frames });
      markKinds(r.project, st().animationId, { key: [from, r.endFrameId], inbetween: r.frameIds });
      m.ghosts = r.frameIds;
      const at = frameNo(from);
      m.info = `Adds frames ${at + 1}–${at + m.frames} after frame ${at}; the ghost is the last one`;
      return r.project;
    },
    overlay(c) {
      const g = moveGeometry(), route = motionPath(g.a, g.c, g.path), cand = m.candidate;
      line(c, Array.from({ length: 33 }, (_, i) => route(i / 32)), [6, 5]);
      const shown = (m.ghosts || []).map(id => opIn(frameIn(cand, id), m.item)).filter(Boolean);
      shown.forEach(op => ghost(c, cand, op, .4));
      const b = ghost(c, st().project, g.end, .62);
      outline(c, b);
      shown.forEach((op, k) => tag(c, instancePivot(op, partOf(op)), String(k + 1)));
      handle(c, g.a, { r: 3.5, filled: true });
      if (g.len) handle(c, g.mid, { filled: m.drag?.kind === 'bend' });
      boxTag(c, b, m.to ? `Frame ${frameNo(m.to)}` : 'End');
    },
    cursor(p) { const g = moveGeometry(); return g.len && dist(p, g.mid) * st().scale <= 12 ? 'grab' : inside(p, boxOf(g.end), 1) ? 'move' : 'crosshair'; },
    down(p) {
      const g = moveGeometry();
      if (g.len && dist(p, g.mid) * st().scale <= 12) { m.drag = { kind: 'bend' }; return; }
      if (m.to) { m.dx = g.end.x - g.op.x; m.dy = g.end.y - g.op.y; m.to = null; renderBar(); }
      m.drag = inside(p, boxOf(g.end), 1) ? { kind: 'end', gx: p.x - g.end.x, gy: p.y - g.end.y } : { kind: 'end', gx: g.c.x - g.end.x, gy: g.c.y - g.end.y };
      this.move(p);
    },
    move(p) {
      const g = moveGeometry();
      if (m.drag.kind === 'bend') { const bend = (p.x - g.centre.x) * g.n.x + (p.y - g.centre.y) * g.n.y; m.bend = Math.abs(bend) < 1 ? 0 : Math.round(bend * 2) / 2; }
      else { m.dx = Math.round(p.x - m.drag.gx - g.op.x); m.dy = Math.round(p.y - m.drag.gy - g.op.y); }
      if (!m.bend && m.orient) { m.orient = false; renderBar(); }
      schedule();
    },
    up() { renderBar(); },
    key(key, shift) {
      const delta = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[key];
      if (!delta) return;
      if (m.to) { const g = moveGeometry(); m.dx = g.end.x - g.op.x; m.dy = g.end.y - g.op.y; m.to = null; renderBar(); }
      m.dx += delta[0] * (shift ? 8 : 1); m.dy += delta[1] * (shift ? 8 : 1); schedule();
    },
    done: () => `Move added: ${plural(m.ghosts.length + (m.to ? 0 : 1), 'frame')}. Press Space in the preview to play it.`,
  },

  bounce: {
    title: 'Bounce · squash & stretch', icon: 'squash',
    init() {
      const b = boxOf(here());
      Object.assign(m, { preset: 'place', height: clamp(Math.round(b.height * 1.5), 2, Math.max(2, b.y)), frames: 8, squash: .5, moving: moves(m.item) });
    },
    hint: () => (m.preset === 'place' ? '<b>Drag the round handle</b> up or down to set how high it bounces.' : m.moving ? 'Stretches with speed and squashes where it lands' : `${quote(m.item)} doesn’t move between frames yet`),
    controls() {
      return `${chips('preset', [['place', 'Bounce in place'], ['motion', 'Add to existing motion', !m.moving, m.moving ? 'Stretch with speed, squash where it lands' : 'It doesn’t move between frames yet: animate a move first']], m.preset)}
        ${m.preset === 'place' ? stepper('frames', 'Frames', m.frames, 3, 24) : ''}${slider('squash', m.preset === 'place' ? 'Squash' : 'Amount', 0, 1, .05, m.squash)}`;
    },
    compute() {
      if (m.preset === 'place') {
        const r = bounceInPlace(st().project, { ...target(m.item), fromFrameId: st().frameId, height: m.height, frames: m.frames, squash: m.squash });
        m.ghosts = r.frameIds.slice(1);
        m.info = `${plural(m.frames, 'frame')} that loop · this frame is the squashed landing, ${m.frames - 1} new after it`;
        return r.project;
      }
      if (!m.moving) { m.offerMove = true; throw new Error(`Nothing to squash yet: use “Bounce in place”, or animate a move first.`); }
      const r = autoSquashStretch(st().project, { ...target(m.item), strength: Math.max(.1, m.squash * 1.2), max: .6, impact: m.squash * .6, loop: animation().frames.length > 2 });
      m.ghosts = r.frames.map(f => f.frameId).filter(id => id !== st().frameId);
      const landings = r.frames.filter(f => f.impact).length;
      m.info = `Squash & stretch over ${plural(r.frames.length, 'frame')}${landings ? `, ${plural(landings, 'landing')}` : ''}`;
      return r.project;
    },
    overlay(c) {
      const cand = m.candidate;
      for (const id of m.ghosts || []) { const op = opIn(frameIn(cand, id), m.item); if (op) ghost(c, cand, op, .3); }
      if (m.preset !== 'place') return;
      const b = boxOf(here()), ground = b.y + b.height, cx = b.x + b.width / 2, top = { x: cx, y: b.y - m.height };
      line(c, [{ x: b.x - 3, y: ground }, { x: b.x + b.width + 3, y: ground }], [4, 3]);
      line(c, [{ x: cx, y: b.y }, top], [3, 4]);
      handle(c, top, { filled: Boolean(m.drag) });
      tag(c, top, `${m.height} px high`, { dx: 0, dy: -16 });
    },
    cursor: () => (m.preset === 'place' ? 'ns-resize' : 'default'),
    down(p) { if (m.preset === 'place') { m.drag = { kind: 'height' }; this.move(p); } },
    move(p) { const b = boxOf(here()); m.height = clamp(Math.round(b.y - p.y), 1, 256); schedule(); },
    key(key, shift) { if (m.preset === 'place' && (key === 'arrowup' || key === 'arrowdown')) { m.height = clamp(m.height + (key === 'arrowup' ? 1 : -1) * (shift ? 8 : 1), 1, 256); schedule(); } },
    done: () => (m.preset === 'place' ? `Bounce added: ${plural(m.frames, 'looping frame')}.` : 'Squash & stretch added.'),
  },

  follow: {
    title: 'Follow-through', icon: 'follow',
    init() { Object.assign(m, { step: 'leader', leader: null, preset: 'tail', lag: 0, loop: animation().frames.length > 2, pivot: null }); },
    hint: () => (m.step === 'leader' ? `<b>Click the object</b> ${quote(m.item)} should follow (what it hangs from).` : `Swings after ${quote(m.leader)}. Drag the pink pivot to where it is attached, or click another object to follow it instead.`),
    controls() {
      if (m.step === 'leader') return '';
      return `${chips('preset', Object.entries(FOLLOW).map(([v, [label, how]]) => [v, `${label} <small>${how}</small>`]), m.preset)}
        ${slider('lag', 'Lag', 0, 3, 1, m.lag)}${toggle('loop', 'Loop', m.loop)}`;
    },
    param(name, value) { if (name === 'preset') { m.preset = value; m.lag = FOLLOW[value][2].delay || 0; return true; } },
    compute() {
      if (!m.leader) { m.info = ''; return null; }
      if (!here(m.leader)) throw new Error(`${m.leader.name} isn’t in this frame.`);
      m.still = !moves(m.leader);
      if (m.still) throw new Error(`“${m.leader.name}” doesn’t move yet, so there is nothing to follow.`);
      let project = st().project;
      if (m.pivot) project = setPivotAt(project, { ...target(m.item), frameId: st().frameId, point: m.pivot }).project;
      const r = springFollow(project, { ...target(m.item), leaderId: m.leader.key, leaderLayerId: m.leader.layerId, property: 'swing', ...FOLLOW[m.preset][2], delay: m.lag, loop: m.loop });
      m.ghosts = r.frameIds.filter(id => id !== st().frameId);
      m.info = `${FOLLOW[m.preset][0]}: trails ${quote(m.leader)} over ${plural(r.frameIds.length, 'frame')}`;
      return r.project;
    },
    overlay(c) {
      if (m.step === 'leader') { if (m.hover) hoverTag(c, m.hover, 'Follow this'); return; }
      const cand = m.candidate, leader = here(m.leader);
      for (const id of m.ghosts || []) { const op = opIn(frameIn(cand, id), m.item); if (op) ghost(c, cand, op, .3); }
      if (leader) { const b = boxOf(leader); outline(c, b, [2, 3]); boxTag(c, b, 'Leader', true); }
      if (m.hover && !same(m.hover, m.leader)) hoverTag(c, m.hover, 'Follow this instead');
      crosshair(c, this.pivot());
    },
    pivot: () => m.pivot || pivotOf(here()),
    cursor(p) { return m.step !== 'leader' && dist(p, this.pivot()) * st().scale <= 12 ? 'move' : m.hover ? 'pointer' : 'default'; },
    hover: () => true,
    down(p) {
      if (m.step !== 'leader' && dist(p, this.pivot()) * st().scale <= 12) { m.drag = { kind: 'pivot' }; return; }
      const hit = objectsAt(p, m.item)[0];
      if (!hit) { if (m.step === 'leader') d.toast('Click another object: the one this should follow.'); return; }
      m.leader = itemOf(hit); m.step = 'tune';
      m.pivot = here().pivot ? null : attachPoint(here(), hit.op);
      renderBar(); schedule();
    },
    move(p) { m.pivot = { x: Math.floor(p.x) + .5, y: Math.floor(p.y) + .5 }; schedule(); },
    done: () => `${m.item.name} now follows ${m.leader.name}.`,
  },

  ik: {
    title: 'IK limb', icon: 'ik', anyItem: true,
    init() {
      m.all = st().objectScope !== 'frame'; m.bend = null;
      const selected = selectedInstance(), rig = rigs.find(r => (!selected || same(r.upper, selected) || same(r.lower, selected)) && here(r.upper) && here(r.lower));
      Object.assign(m, rig ? { step: 'pose', upper: rig.upper, lower: rig.lower } : { step: 'shoulder', upper: null, lower: null });
    },
    hint() {
      if (m.step === 'shoulder') return '<b>Click the shoulder</b> (or hip): on the upper part, where it joins the body';
      if (m.step === 'elbow') return `<b>Click the elbow</b> (or knee): on the lower part, where it meets ${quote(m.upper)}`;
      return '<b>Drag the hand</b> to pose the limb · change frame and pose again';
    },
    steps: () => ['Shoulder', 'Elbow', 'Drag hand'].map((label, i) => `<li class="${i < ['shoulder', 'elbow', 'pose'].indexOf(m.step) ? 'done' : i === ['shoulder', 'elbow', 'pose'].indexOf(m.step) ? 'now' : ''}">${label}</li>`).join(''),
    controls() {
      if (m.step !== 'pose') return '';
      const frames = animation().frames, i = frames.findIndex(f => f.id === st().frameId);
      return `${chips('all', [['', 'This frame'], ['1', 'All frames']], m.all ? '1' : '')}${button('flip', 'Flip bend', { icon: 'swap' })}
        <span class="motion-frames">${button('prev', '', { icon: 'left', title: 'Previous frame (←)' })}<span>Frame ${i + 1} / ${frames.length}</span>${button('next', '', { icon: 'left', title: 'Next frame (→)', className: 'flip-x' })}</span>
        ${button('rerig', 'Re-rig', { title: 'Choose the shoulder and elbow again' })}`;
    },
    param(name, value) { if (name === 'all') { m.all = Boolean(value); return true; } },
    compute: () => { m.info = m.step === 'pose' ? (m.all ? (st().objectScope === 'selected' ? `Poses ${editScopeText(st(), animation())} showing both parts` : 'Poses every frame showing both parts') : `Poses frame ${frameNo(st().frameId)} only`) : ''; return null; },
    joints: () => limbJoints(st().project, { animationId: animation().id, frameId: st().frameId, layerId: m.upper.layerId, upperId: m.upper.key, lowerId: m.lower.key, lowerLayerId: m.lower.layerId }),
    overlay(c) {
      if (m.step !== 'pose') {
        if (m.upper && here(m.upper)) { outline(c, boxOf(here(m.upper)), []); handle(c, pivotOf(here(m.upper)), { r: 5, filled: true }); }
        if (m.hover && !(m.step === 'elbow' && same(m.hover, m.upper))) hoverTag(c, m.hover, m.step === 'shoulder' ? 'Upper part' : 'Lower part');
        return;
      }
      const j = this.joints();
      if (!j) return;
      if (m.drag) {
        const s = st().scale, reach = dist(j.shoulder, j.elbow) + dist(j.elbow, j.hand);
        c.beginPath(); c.arc(j.shoulder.x * s, j.shoulder.y * s, reach * s, 0, Math.PI * 2); c.setLineDash([3, 5]); c.lineWidth = 1; c.strokeStyle = '#ff2d8788'; c.stroke(); c.setLineDash([]);
      }
      line(c, [j.shoulder, j.elbow, j.hand]);
      handle(c, j.shoulder, { r: 4, filled: true }); handle(c, j.elbow, { r: 5 }); handle(c, j.hand, { r: 7, filled: Boolean(m.drag) });
      if (!m.drag) tag(c, j.hand, 'Drag', { dy: -18 });
    },
    cursor(p) { return m.step === 'pose' ? (m.drag ? 'grabbing' : 'grab') : m.hover ? 'pointer' : 'crosshair'; },
    hover: () => m.step !== 'pose',
    down(p) {
      if (m.step === 'shoulder' || m.step === 'elbow') {
        const hit = objectsAt(p, m.step === 'elbow' ? m.upper : null)[0];
        if (!hit) { d.toast(m.step === 'shoulder' ? 'Click on the upper part of the limb.' : 'Click on the lower part, where it meets the upper part.'); return; }
        if (m.step === 'elbow' && dist(p, pivotOf(here(m.upper))) < 1) { d.toast('Click the elbow a little away from the shoulder.'); return; }
        try { d.mutate(() => { st().project = setPivotAt(st().project, { ...target(hit), frameId: st().frameId, point: p }).project; }); }
        catch (error) { d.toast(error.message); return; }
        if (m.step === 'shoulder') { m.upper = itemOf(hit); m.step = 'elbow'; }
        else { m.lower = itemOf(hit); m.step = 'pose'; rigs.unshift({ upper: m.upper, lower: m.lower }); rigs.length = Math.min(rigs.length, 8); }
        m.hover = null; renderBar(); d.renderAll();
        return;
      }
      const j = this.joints();
      if (!j) { d.toast('Both parts must be in this frame.'); return; }
      m.drag = { kind: 'hand', before: d.snapshot() };
      if (m.bend === null) m.bend = nearestBend(j, p);
      this.move(p);
    },
    move(p) {
      try {
        st().project = ikLimb(m.drag.before.project, { animationId: animation().id, layerId: m.upper.layerId, upperId: m.upper.key, lowerId: m.lower.key, lowerLayerId: m.lower.layerId, frameIds: m.all ? ikFrames() : [st().frameId], target: p, bend: m.bend }).project;
      } catch (error) { st().project = m.drag.before.project; m.drag = null; d.toast(error.message); }
      schedule();
    },
    up() { d.remember(m.drag.before); m.drag = null; d.renderAll(); },
    key(key) { if (m.step === 'pose' && (key === 'arrowleft' || key === 'arrowright')) act(key === 'arrowleft' ? 'prev' : 'next'); },
  },

  smear: {
    title: 'Smear', icon: 'smear', commits: true,
    init() {
      Object.assign(m, { steps: 0, color: 'source', insert: canInsertFrames(st().project, animation().id, 1), options: false, result: null, reason: '' });
      const frames = animation().frames, i = frames.findIndex(f => f.id === st().frameId);
      if (frames.length < 2) { m.reason = 'Smear needs a move to the next frame. Animate a move first.'; return; }
      const to = frames[(i + 1) % frames.length], a = opIn(frames[i], m.item), b = opIn(to, m.item);
      if (!b || dist(pivotOf(a), pivotOf(b)) < 1) { m.reason = `${quote(m.item)} doesn’t move ${i + 1 < frames.length ? 'into the next frame' : 'from the last frame back to the first'}.`; return; }
      Object.assign(m, { from: frames[i].id, to: to.id, before: d.snapshot() });
      smear(true);
    },
    hint: () => (m.reason || (m.result ? `Motion trail added in frame ${frameNo(m.result.frameId)}${m.wrap ? ' (the loop back to frame 1)' : ''}` : '')),
    controls() {
      if (m.reason) return button('to-move', 'Animate a move', { icon: 'tween' });
      const open = button('options', `Options ${m.options ? '▴' : '▾'}`, { extra: ` aria-expanded="${m.options}"` });
      if (!m.options) return open;
      return `${open}${slider('steps', 'Trail steps', 0, 16, 1, m.steps)}${chips('color', [['source', 'Object’s colours'], ['active', 'Active colour']], m.color)}
        ${chips('insert', [['1', 'New frame', !canInsertFrames(m.before.project, animation().id, 1)], ['', `Replace frame ${frameNo(m.to) || ''}`]], m.insert ? '1' : '')}`;
    },
    param(name, value) { m[name] = name === 'insert' ? Boolean(value) : value; smear(false); return true; },
  },
};

const inside = (p, b, pad = 0) => p.x >= b.x - pad && p.y >= b.y - pad && p.x < b.x + b.width + pad && p.y < b.y + b.height + pad;
/** The follower pixel nearest the leader's pixels (pixel centre), its natural attachment point. */
function attachPoint(op, leaderOp) {
  const own = pixelsOf(st().project, op), lead = pixelsOf(st().project, leaderOp);
  let best = null, bestD = Infinity;
  for (const a of own) for (const b of lead) { const dd = (a.x - b.x) ** 2 + (a.y - b.y) ** 2; if (dd < bestD) { bestD = dd; best = a; } }
  return best && { x: best.x + .5, y: best.y + .5 };
}
/** IK bend side that keeps the elbow nearest where it is now. */
function nearestBend(j, p) {
  const l1 = dist(j.shoulder, j.elbow), l2 = dist(j.elbow, j.hand);
  return [1, -1].map(s => [s, dist(solveTwoBone(j.shoulder, p, l1, l2, s).joint, j.elbow)]).sort((a, b) => a[1] - b[1])[0][0];
}
/** (Re)make the smear from the mode's base snapshot, replacing the previous attempt's undo step. */
function smear(first) {
  const { state } = d;
  if (!first && state.undo.at(-1) === m.before) state.undo.pop();
  const frames = m.before.project.animations.find(a => a.id === state.animationId).frames;
  m.wrap = frames.findIndex(f => f.id === m.to) === 0;
  try {
    const r = smearFrame(m.before.project, { ...target(m.item), fromFrameId: m.from, toFrameId: m.to, instanceId: m.item.key, steps: m.steps || undefined, color: m.color === 'active' ? state.color : 'source', insert: m.insert });
    state.project = r.project; state.frameId = r.frameId; m.result = r; m.error = '';
    d.remember(m.before);
  } catch (error) { Object.assign(state, { project: m.before.project, frameId: m.before.frameId }); m.result = null; m.error = error.message; }
  if (!first) { renderBar(); d.renderAll(); }
}

// ---------------------------------------------------------------------------------------------
// Bar

function button(act, label, { primary = false, icon, disabled = false, title = '', className = '', extra = '' } = {}) {
  return `<button type="button" class="button small${primary ? ' primary' : ''}${className ? ` ${className}` : ''}" data-act="${act}"${disabled ? ' disabled' : ''}${title ? ` title="${title}" aria-label="${title}"` : ''}${extra}>${icon ? d.icon(icon) : ''}${label}</button>`;
}
function chips(param, options, value) {
  return `<span class="motion-chips" role="radiogroup">${options.map(([v, label, disabled, title]) => `<button type="button" class="motion-chip${v === value ? ' active' : ''}" role="radio" aria-checked="${v === value}" data-param="${param}" data-value="${v}"${disabled ? ' disabled' : ''}${title ? ` title="${title}"` : ''}>${label}</button>`).join('')}</span>`;
}
function toggle(param, label, on, disabled = false, title = '') {
  return `<button type="button" class="motion-chip motion-toggle${on ? ' active' : ''}" aria-pressed="${on}" data-param="${param}" data-toggle${disabled ? ' disabled' : ''}${title ? ` title="${title}"` : ''}><i aria-hidden="true"></i>${label}</button>`;
}
function stepper(param, label, value, min, max) {
  return `<span class="motion-field"><span>${label}</span><span class="motion-stepper"><button type="button" data-param="${param}" data-step="-1" data-min="${min}" data-max="${max}" aria-label="Fewer ${label.toLowerCase()}"${value <= min ? ' disabled' : ''}>−</button><output>${value}</output><button type="button" data-param="${param}" data-step="1" data-min="${min}" data-max="${max}" aria-label="More ${label.toLowerCase()}"${value >= max ? ' disabled' : ''}>+</button></span></span>`;
}
function slider(param, label, min, max, step, value) {
  const format = FORMATS[param] || String;
  return `<label class="motion-field"><span>${label}</span><input type="range" data-param="${param}" min="${min}" max="${max}" step="${step}" value="${value}"><output>${format(value)}</output></label>`;
}

function renderBar() {
  const bar = d.$('motion-bar');
  if (!m) { bar.hidden = true; bar.innerHTML = ''; return; }
  const mode = MODES[m.name], picking = m.step === 'pick';
  const hint = picking ? `<b>Click the object</b> to ${m.name === 'move' ? 'move' : m.name === 'bounce' ? 'bounce' : m.name === 'follow' ? 'give follow-through' : 'smear'}` : mode.hint();
  const actions = m.name === 'ik' && m.step === 'pose' ? button('done', 'Done <kbd>Enter</kbd>', { primary: true, icon: 'check' })
    : m.name === 'smear' && !picking ? (m.result ? `${button('undo', 'Undo <kbd>Esc</kbd>', { icon: 'undo' })}${button('done', 'Keep <kbd>Enter</kbd>', { primary: true, icon: 'check' })}` : button('done', 'Close <kbd>Esc</kbd>'))
    : `${button('cancel', 'Cancel <kbd>Esc</kbd>')}${m.name === 'ik' || picking ? '' : button('apply', 'Apply <kbd>Enter</kbd>', { primary: true, icon: 'check', disabled: !m.candidate })}`;
  const controls = picking ? '' : mode.controls();
  bar.innerHTML = `<div class="motion-head"><span class="motion-title">${d.icon(mode.icon)}<strong>${mode.title}</strong></span>
    ${m.name === 'ik' && !picking ? `<ol class="motion-steps">${mode.steps()}</ol>` : ''}<span class="motion-hint">${hint}</span><span class="motion-actions">${actions}</span></div>
    ${controls.trim() ? `<div class="motion-controls">${controls}</div>` : ''}<p class="motion-info" aria-live="polite"></p>`;
  bar.hidden = false;
  placeBar(); updateInfo();
}
/** Dock the bar in the stage's left gutter when it fits there, else float it at the bottom (never shifts the canvas). */
function placeBar() {
  const bar = d.$('motion-bar');
  if (bar.hidden) return;
  const wrap = bar.parentElement.getBoundingClientRect(), canvas = d.$('pixel-canvas').getBoundingClientRect();
  bar.classList.toggle('docked', canvas.left - wrap.left >= 276 && wrap.height >= 360);
}
function updateInfo() {
  const bar = d.$('motion-bar'), info = bar.querySelector('.motion-info');
  if (!m || !info) return;
  const error = m.error && !(m.name === 'follow' && !m.leader);
  info.classList.toggle('is-error', Boolean(error));
  const fix = m.name === 'follow' && m.still ? button('lead-first', `Animate “${d.escapeHTML(m.leader.name)}” first`, { icon: 'tween' })
    : m.name === 'bounce' && m.offerMove && error ? button('to-move', 'Animate a move', { icon: 'tween' }) : '';
  info.innerHTML = `${d.escapeHTML(error ? m.error : m.info || '')}${fix}`;
  info.hidden = !info.textContent && !fix;
  const apply = bar.querySelector('[data-act="apply"]');
  if (apply) apply.disabled = !m.candidate;
}

// ---------------------------------------------------------------------------------------------
// Lifecycle

/** Recompute the candidate from the current project, frame and parameters. */
function recompute() {
  const { state } = d;
  m.base = state.project; m.frameId = state.frameId;
  if (m.step === 'pick' || MODES[m.name].commits) return;
  Object.assign(m, { error: '', info: '', ghosts: [], candidate: null, offerMove: false });
  if (!here()) m.error = `${m.item.name} isn’t in this frame. Go to a frame that shows it.`;
  else try { m.candidate = MODES[m.name].compute() || null; } catch (error) { m.error = error.message; }
  state.previewOverride = m.candidate;
}
function schedule() {
  if (frameRequest) return;
  frameRequest = requestAnimationFrame(() => {
    frameRequest = 0;
    if (!m) return;
    recompute(); d.renderCanvas(); d.renderPreview(); updateInfo();
  });
}

/** Open a motion mode for the selected object (or with a "click the object" step). */
export function openMode(name) {
  const { state } = d;
  if (state.inPlaceEdit) { d.toast('Finish editing the object on the canvas first.'); return; }
  if (m) close({ render: false });
  d.finishDrawing();
  const selected = selectedInstance();
  m = { name, item: selected && itemOf(selected), playing: state.playing, base: null };
  Object.assign(state, { selection: null, cursor: null, playing: true, previewTime: 0, previewIndex: 0 });
  d.$('workbench').classList.add('motion-active'); d.$('workbench').dataset.motion = name;
  if (!m.item && !MODES[name].anyItem) m.step = 'pick';
  else MODES[name].init();
  recompute(); renderBar(); d.renderAll();
}
function close({ render = true } = {}) {
  if (!m) return;
  const { state } = d, playing = m.playing;
  m = null;
  Object.assign(state, { previewOverride: null, playing, previewTime: 0, previewIndex: Math.max(0, animation().frames.findIndex(f => f.id === state.frameId)) });
  d.$('workbench').classList.remove('motion-active'); delete d.$('workbench').dataset.motion;
  d.$('pixel-canvas').style.cursor = '';
  renderBar();
  if (render) d.renderAll();
}
export const closeMotionMode = () => close();
export const activeMotionMode = () => m?.name || null;

function apply() {
  if (!m) return;
  if (MODES[m.name].commits || m.name === 'ik') { close(); return; }
  if (!m.candidate) { d.toast(m.error || 'Nothing to apply yet.'); return; }
  const project = m.candidate, message = MODES[m.name].done();
  close({ render: false });
  try { d.mutate(() => { d.state.project = project; }); d.toast(message); }
  catch (error) { d.toast(error.message); d.renderAll(); }
}
function cancel() {
  if (m?.name === 'smear' && m.result && d.state.undo.at(-1) === m.before) { close({ render: false }); d.undo(); d.toast('Smear removed.'); return; }
  close();
}

function act(name) {
  const { state } = d;
  if (name === 'apply' || name === 'done') return apply();
  if (name === 'cancel') return cancel();
  if (name === 'undo') return cancel();
  if (name === 'options') { m.options = !m.options; renderBar(); return; }
  if (name === 'to-move') { close({ render: false }); openMode('move'); return; }
  if (name === 'lead-first') { const leader = m.leader; close({ render: false }); d.selectObject({ ...leader, type: 'instance' }); openMode('move'); return; }
  if (name === 'rerig') { Object.assign(m, { step: 'shoulder', upper: null, lower: null, bend: null }); renderBar(); d.renderCanvas(); return; }
  if (name === 'prev' || name === 'next') { const i = animation().frames.findIndex(f => f.id === state.frameId); d.selectFrameAt(i + (name === 'prev' ? -1 : 1)); return; }
  if (name === 'flip') {
    const j = MODES.ik.joints();
    if (!j) return;
    m.bend = -(m.bend ?? nearestBend(j, j.hand));
    try { d.mutate(() => { state.project = ikLimb(state.project, { animationId: animation().id, layerId: m.upper.layerId, upperId: m.upper.key, lowerId: m.lower.key, lowerLayerId: m.lower.layerId, frameIds: m.all ? ikFrames() : [state.frameId], target: j.hand, bend: m.bend }).project; }); }
    catch (error) { d.toast(error.message); }
  }
}
function setParam(name, value, rerender = true) {
  const mode = MODES[m.name];
  if (!mode.param?.(name, value)) m[name] = value;
  if (mode.commits) return;
  if (rerender) renderBar();
  schedule();
}

/** Keep the open mode in step with project, frame and selection changes (called by renderAll). */
export function syncMotionMode() {
  if (!m) return;
  const { state } = d;
  if (state.inPlaceEdit) { close({ render: false }); return; }
  if (m.name !== 'ik' && !m.drag) {
    const selected = selectedInstance();
    if (selected && !same(selected, m.item) && !(m.name === 'smear' && m.result)) { m.item = itemOf(selected); m.step = null; MODES[m.name].init(); m.base = null; renderBar(); }
  }
  if (state.project !== m.base || state.frameId !== m.frameId) { recompute(); if (m.name === 'ik' || m.name === 'smear') renderBar(); else updateInfo(); }
}

/** Draw the open mode's ghosts, paths and handles on the canvas overlay. */
export function drawMotionOverlay(c) {
  if (!m) return;
  placeBar();
  if (m.step !== 'pick' && !MODES[m.name].anyItem && !here()) return;
  c.save();
  try {
    if (m.step === 'pick') { if (m.hover) hoverTag(c, m.hover, 'Click to animate'); }
    else MODES[m.name].overlay?.(c);
  } finally { c.restore(); }
}

// ---------------------------------------------------------------------------------------------
// Input

function setCursor(p) {
  const mode = MODES[m.name], canvas = d.$('pixel-canvas');
  canvas.style.cursor = m.step === 'pick' ? (m.hover ? 'pointer' : 'crosshair') : (here() || mode.anyItem) ? mode.cursor?.(p) || 'default' : 'default';
}
function pointer(event) {
  if (!m) return;
  const type = event.type;
  event.stopImmediatePropagation();
  if (type === 'dblclick' || type === 'contextmenu') { event.preventDefault(); return; }
  if (event.button > 0 && type === 'pointerdown') return;
  const p = d.canvasPosition(event), mode = MODES[m.name];
  if (type === 'pointerdown') {
    event.preventDefault();
    d.$('canvas-stage').setPointerCapture?.(event.pointerId);
    if (m.step === 'pick') {
      const hit = objectsAt(p)[0];
      if (!hit) { d.toast('Click a placed object (a part) on the canvas.'); return; }
      m.item = itemOf(hit); m.step = null; m.hover = null;
      mode.init();
      d.selectObject({ layerId: hit.layerId, key: hit.key, type: 'instance' });
      recompute(); renderBar(); d.renderAll();
      return;
    }
    if (!here() && !mode.anyItem) return;
    mode.down?.call(mode, p);
    if (m) setCursor(p);
  } else if (type === 'pointermove') {
    if (m.drag) { mode.move.call(mode, p); return; }
    if (m.step === 'pick' || mode.hover?.()) {
      const hover = objectsAt(p, m.step === 'pick' ? null : m.name === 'follow' ? m.item : m.step === 'elbow' ? m.upper : null)[0] || null;
      if (!same(hover, m.hover)) { m.hover = hover && itemOf(hover); d.renderCanvas(); }
    }
    setCursor(p);
  } else if (m.drag) {
    if (type === 'pointercancel' && m.drag.before) { d.state.project = m.drag.before.project; m.drag = null; d.renderAll(); return; }
    const drag = m.drag;
    if (mode.up) mode.up.call(mode, p);
    if (m && m.drag === drag) m.drag = null;
    if (m) { schedule(); setCursor(p); }
  }
}
function keydown(event) {
  if (!m || d.$('modal').open) return;
  const key = event.key.toLowerCase(), typing = event.target.closest('textarea,select,input:not([type="range"])');
  if (key === 'escape') { event.preventDefault(); event.stopImmediatePropagation(); if (m.drag) return; return m.name === 'ik' ? close() : cancel(); }
  if (typing || key === 'tab') return;
  if (key === 'enter') { event.preventDefault(); event.stopImmediatePropagation(); if (!m.drag) apply(); return; }
  if (event.ctrlKey || event.metaKey) {
    if (key === 'z' || key === 'y') {
      if (m.name === 'ik') return;
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
    }
    return;
  }
  if (event.target.closest('input[type="range"]')) return;
  event.stopImmediatePropagation();
  if (key.startsWith('arrow') && m.step !== 'pick') { event.preventDefault(); MODES[m.name].key?.(key, event.shiftKey); }
}

export function initMotionModes(deps) {
  d = deps;
  const stage = d.$('canvas-stage'), bar = d.$('motion-bar');
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dblclick', 'contextmenu']) stage.addEventListener(type, pointer, true);
  stage.addEventListener('pointerleave', () => { if (m?.hover) { m.hover = null; d.renderCanvas(); } });
  document.addEventListener('keydown', keydown, true);
  bar.addEventListener('click', event => {
    const b = event.target.closest('button');
    if (!b || !m || b.disabled) return;
    if (b.dataset.act) { act(b.dataset.act); return; }
    const name = b.dataset.param;
    if (!name) return;
    const value = 'step' in b.dataset ? clamp(m[name] + Number(b.dataset.step), Number(b.dataset.min), Number(b.dataset.max)) : 'toggle' in b.dataset ? !m[name] : b.dataset.value;
    setParam(name, value);
  });
  bar.addEventListener('input', event => {
    const input = event.target.closest('input[data-param]');
    if (!input || !m) return;
    const value = Number(input.value);
    input.nextElementSibling.textContent = (FORMATS[input.dataset.param] || String)(value);
    if (MODES[m.name].commits) m[input.dataset.param] = value; else setParam(input.dataset.param, value, false);
  });
  bar.addEventListener('change', event => { const input = event.target.closest('input[data-param]'); if (input && m && MODES[m.name].commits) setParam(input.dataset.param, Number(input.value)); });
}
