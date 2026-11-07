/**
 * Motion plans: a small JSON command language that turns "make him wave twice" into existing animation tools.
 * A plan is `{ name?, mode?: 'new'|'append'|'replace', steps: [{ op, …params }] }`; normalizePlan checks and clamps it,
 * runMotionPlan executes the steps in order on a copy of the project (templates.js, animate.js, poses.js, skeleton.js)
 * and returns { project, animationId, frameIds, summary, warnings, plan }. Targets are object, part, bone or role names
 * (fuzzy), pronouns or nothing (the selection, else the first character, else the largest object).
 */
import { validateProject, makeLayeredFrame, compositeFrame } from './project.js';
import { tweenToPose, bounceInPlace, autoSquashStretch, springFollow, waveAnimate, spin3d } from './animate.js';
import { TEMPLATES, generateTemplate } from './templates.js';
import { applyPose as applyLibraryPose, rigDescriptor, detectRoles, nameRole, nameSimilarity, ROLES } from './poses.js';
import { rotateBone, moveSkeleton, ikChain, tweenPoses, boneOf, rootOf, rigView } from './skeleton.js';
import { EASINGS, poseOf } from './motion.js';
import { instancePivot, transformedSize } from './geometry.js';

export const MOTION_PLAN_FORMAT = 'pixel-studio-motion';
export const MAX_PLAN_STEPS = 32;

/** Every step op with its parameters (for validation, the AI prompt and docs). */
export const MOTION_OPS = {
  template: 'Rig cycle: name walk|run|jump|idle|wave|hover, target (character), frames, times, speed, amplitude (degrees), height (px), exaggeration, facing (auto|left|right|front), by {x,y} (travel while cycling)',
  bounce: 'Bounce in place: target, height (px), frames (per bounce), times, squash (0..1), speed',
  move: 'Tween a move: target, by {x,y} or to {x,y} (canvas point for its pivot), frames, easing, path (line|arc), arc (px, arc height), yoyo (and back), times, squash (true: stretch along the motion)',
  spin: '3D spin like a coin: target, axis (y: turn, x: flip head over heels), turns (whole, negative: backwards), frames (per turn), times',
  turn: '3D turn by degrees (180 = face the other way): target, axis (x|y), degrees, frames, easing, yoyo',
  rotate: 'Rotate a bone (joint) or object about its pivot: target (bone/role/object), degrees (+ clockwise), frames, easing, yoyo, times',
  pose: 'Tween a rig into a pose: name (saved pose) or angles {bone or role: degrees relative to parent}, target (character), frames, easing, mirror, amount (0..1), hold (frames), yoyo',
  reach: 'IK: move a hand or foot bone: target (bone/role), to {x,y} or by {x,y}, frames, easing, yoyo',
  shake: 'Shake: target (bone → rotate, object → move), amount (degrees or px), times, frames',
  follow: 'Follow-through: target (follower), leader, property (angle|position|swing), stiffness, damping, loop',
  squash: 'Squash & stretch on the previous step’s frames: target, strength (0..1), impact (0..4)',
  ripple: 'Wave deform ripple (flag, water): target, speed (degrees per frame), frames',
  hold: 'Hold the last frame: frames',
  repeat: 'Play the previous step(s) again: times (total), steps (how many previous steps, default 1)',
  newAnimation: 'Start a new animation from the base frame: name',
};
const ALIASES = {
  spin3d: 'spin', flip: 'spin', rotatejoint: 'rotate', rotatebone: 'rotate', tween: 'move', slide: 'move', wait: 'hold', pause: 'hold',
  squashstretch: 'squash', newanimation: 'newAnimation', animation: 'newAnimation', loop: 'repeat', cycle: 'template', ik: 'reach', wavedeform: 'ripple',
};
const TEMPLATE_OPS = { walk: 'walk', run: 'run', jump: 'jump', idle: 'idle', breathe: 'idle', wave: 'wave', hover: 'hover', bob: 'hover', float: 'hover' };
const DEFAULT_FRAMES = { bounce: 8, move: 6, spin: 8, turn: 6, rotate: 4, pose: 4, reach: 4, shake: 2, ripple: 8, hold: 2 };
const SPEED_WORDS = { 'very slow': .4, slowly: .6, slow: .6, gentle: .7, normal: 1, fast: 1.6, quick: 1.6, quickly: 1.6, 'very fast': 2.2 };
const PRONOUNS = new Set(['', 'him', 'her', 'it', 'them', 'he', 'she', 'they', 'character', 'the character', 'sprite', 'the sprite', 'everything', 'all', 'puppet', 'guy', 'figure', 'hero', 'player', 'object', 'the object', 'me']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, lo, hi, fallback) => { const n = Number(v); return Number.isFinite(n) ? clamp(n, lo, hi) : fallback; };
const int = (v, lo, hi, fallback) => { const n = num(v, lo, hi, fallback); return n === undefined ? n : Math.round(n); };
const point = (v, partial) => v && typeof v === 'object' && (Number.isFinite(Number(v.x ?? NaN)) || Number.isFinite(Number(v.y ?? NaN))) ? { x: num(v.x ?? NaN, -4096, 4096, partial ? undefined : 0), y: num(v.y ?? NaN, -4096, 4096, partial ? undefined : 0) } : undefined;
const text = (v, max = 80) => typeof v === 'string' ? v.trim().slice(0, max) : v == null ? '' : String(v).slice(0, max);
const norm = s => String(s || '').toLowerCase().replace(/^(the|his|her|its|their|my|a|an)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** An easing name in any spelling ("ease in-out", "ease_out") → an EASINGS key, or undefined. */
export function easingName(value) {
  if (!value) return undefined;
  const key = String(value).toLowerCase().replace(/[^a-z]/g, '').replace(/^ease(?=(in|out|inout)?$)/, 'ease');
  const map = { linear: 'linear', none: 'linear', ease: 'easeInOut', smooth: 'easeInOut', easein: 'easeIn', easeout: 'easeOut', easeinout: 'easeInOut', in: 'easeIn', out: 'easeOut', inout: 'easeInOut' };
  return map[key] || Object.keys(EASINGS).find(k => k.toLowerCase() === key);
}
/** A speed multiplier from a number or word (slow/fast). */
export function speedValue(value) {
  if (value === undefined || value === null || value === '') return 1;
  if (typeof value === 'string' && SPEED_WORDS[value.trim().toLowerCase()]) return SPEED_WORDS[value.trim().toLowerCase()];
  return num(value, .1, 8, 1);
}

/** Check and clamp a plan (an array of steps, {steps}, or {plan: {steps}}). Throws with a readable message. */
export function normalizePlan(input) {
  const raw = Array.isArray(input) ? { steps: input } : input?.plan && !input.steps ? input.plan : input;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) throw new Error('A motion plan needs a list of steps.');
  if (!raw.steps.length) throw new Error('This motion plan has no steps.');
  if (raw.steps.length > MAX_PLAN_STEPS) throw new Error(`A motion plan holds at most ${MAX_PLAN_STEPS} steps.`);
  const mode = ['new', 'append', 'replace'].includes(raw.mode) ? raw.mode : undefined;
  return { name: text(raw.name) || undefined, ...(mode ? { mode } : {}), steps: raw.steps.map((s, i) => normalizeStep(s, i)) };
}
function normalizeStep(input, index) {
  if (!input || typeof input !== 'object') throw new Error(`Step ${index + 1} must be an object with an "op".`);
  const given = String(input.op ?? input.type ?? '').trim(), key = given.toLowerCase().replace(/[^a-z0-9]/g, '');
  let op = MOTION_OPS[given] ? given : ALIASES[key] || Object.keys(MOTION_OPS).find(k => k.toLowerCase() === key);
  const s = { op };
  if (!op && TEMPLATE_OPS[key]) { op = s.op = 'template'; s.name = TEMPLATE_OPS[key]; }
  if (!op && key === 'nod') Object.assign(s, { op: op = 'rotate', target: 'head', degrees: 12, yoyo: true });
  if (!op) throw new Error(`Step ${index + 1}: unknown motion “${given || '?'}”. Use one of: ${Object.keys(MOTION_OPS).join(', ')}.`);
  const p = input, target = text(p.target ?? p.bone ?? p.object ?? p.part ?? p.character, 60);
  if (target || p.target !== undefined) s.target = target;
  if (op === 'template') {
    s.name = TEMPLATE_OPS[String(p.name ?? p.template ?? s.name ?? '').toLowerCase()];
    if (!s.name) throw new Error(`Step ${index + 1}: templates are ${Object.keys(TEMPLATES).join(', ')}.`);
  }
  const frames = int(p.frames, 1, 64);
  if (frames !== undefined) s.frames = frames;
  else if (DEFAULT_FRAMES[op]) s.frames = DEFAULT_FRAMES[op];
  const set = (k, v) => { if (v !== undefined && v !== '' && !(typeof v === 'number' && Number.isNaN(v))) s[k] = v; };
  set('times', int(p.times ?? p.count ?? p.repeat, 1, 16));
  if (p.speed !== undefined) set('speed', speedValue(p.speed));
  set('duration', int(p.duration, 16, 60000));
  set('easing', easingName(p.easing));
  if (p.easing && !s.easing) throw new Error(`Step ${index + 1}: unknown easing “${p.easing}”. Use ${Object.keys(EASINGS).join(', ')}.`);
  for (const k of ['yoyo', 'mirror', 'loop']) if (p[k] !== undefined) s[k] = Boolean(p[k]);
  set('by', point(p.by));
  set('to', point(p.to, true));
  if (op === 'template') { set('amplitude', num(p.amplitude, 0, 180)); set('height', num(p.height ?? p.bounce, 0, 128)); set('exaggeration', num(p.exaggeration, .1, 3)); set('facing', ['auto', 'left', 'right', 'front'].includes(p.facing) ? p.facing : undefined); }
  if (op === 'bounce') { s.height = num(p.height, 1, 256, 8); set('squash', num(p.squash, 0, 1)); s.frames = clamp(s.frames, 3, 32); }
  if (op === 'move') { set('path', p.path === 'arc' || p.arc ? 'arc' : undefined); set('arc', num(p.arc ?? p.arcHeight, -256, 256)); if (p.squash !== undefined) s.squash = Boolean(p.squash); if (!s.by && !s.to) throw new Error(`Step ${index + 1}: a move needs "by" {x,y} or "to" {x,y}.`); }
  if (op === 'spin') { s.axis = p.axis === 'x' ? 'x' : 'y'; s.turns = int(p.turns, -8, 8, 1) || 1; s.frames = clamp(s.frames, 2, 64); }
  if (op === 'turn') { s.axis = p.axis === 'x' ? 'x' : 'y'; s.degrees = num(p.degrees ?? p.angle, -720, 720, 180); }
  if (op === 'rotate') { s.degrees = num(p.degrees ?? p.angle ?? p.delta ?? s.degrees, -720, 720, NaN); if (!Number.isFinite(s.degrees)) throw new Error(`Step ${index + 1}: rotate needs "degrees".`); }
  if (op === 'pose') {
    set('name', text(p.name ?? p.pose, 60) || undefined);
    if (p.angles && typeof p.angles === 'object') s.angles = Object.fromEntries(Object.entries(p.angles).slice(0, 64).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [text(k, 60), clamp(Number(v), -360, 360)]));
    if (!s.name && !s.angles) throw new Error(`Step ${index + 1}: a pose needs a saved pose "name" or "angles".`);
    set('amount', num(p.amount, 0, 1)); set('hold', int(p.hold, 0, 64));
  }
  if (op === 'reach' && !s.to && !s.by) throw new Error(`Step ${index + 1}: reach needs "to" or "by" {x,y}.`);
  if (op === 'shake') { s.amount = num(p.amount, 1, 90, 0) || undefined; if (!s.amount) delete s.amount; s.times ??= 2; }
  if (op === 'follow') { s.leader = text(p.leader, 60); set('property', ['angle', 'position', 'swing'].includes(p.property) ? p.property : undefined); set('stiffness', num(p.stiffness, .01, 1)); set('damping', num(p.damping, .01, 1)); if (!s.leader) throw new Error(`Step ${index + 1}: follow needs a "leader".`); }
  if (op === 'squash') { set('strength', num(p.strength, 0, 2)); set('impact', num(p.impact, 0, 4)); }
  if (op === 'ripple') { const deg = typeof p.speed === 'number' && Math.abs(p.speed) > 8; set('rippleSpeed', int(p.rippleSpeed ?? (deg ? p.speed : undefined), -360, 360)); if (deg) delete s.speed; }
  if (op === 'repeat') { s.times = int(p.times, 2, 16, 2); s.steps = int(p.steps, 1, MAX_PLAN_STEPS, 1); delete s.frames; }
  if (op === 'newAnimation') { s.name = text(p.name) || 'Motion'; delete s.frames; }
  return s;
}

const LABELS = { bounce: 'Bounce', move: 'Move', spin: 'Spin', turn: 'Turn', rotate: 'Rotate', pose: 'Pose', reach: 'Reach', shake: 'Shake', follow: 'Follow-through', squash: 'Squash & stretch', ripple: 'Ripple', hold: 'Hold', repeat: 'Repeat', newAnimation: 'New animation' };
/** Short readable label of a step: "Wave ×2 · 8 frames · fast". */
export function describeStep(s) {
  const head = s.op === 'template' ? TEMPLATES[s.name]?.label || s.name : s.op === 'pose' && s.name ? `Pose “${s.name}”` : LABELS[s.op] || s.op;
  const bits = [], dir = v => v && [v.x ? `${v.x > 0 ? '→' : '←'} ${Math.abs(v.x)}` : '', v.y ? `${v.y > 0 ? '↓' : '↑'} ${Math.abs(v.y)}` : ''].filter(Boolean).join(' ');
  if (s.target) bits.push(s.target);
  if (s.op === 'move' || s.op === 'reach') bits.push(s.by ? `${dir(s.by)} px` : `to ${s.to.x ?? '–'},${s.to.y ?? '–'}`);
  if (s.op === 'template' && s.by) bits.push(`travel ${dir(s.by)} px`);
  if (s.op === 'rotate' || s.op === 'turn') bits.push(`${s.degrees > 0 ? '+' : ''}${s.degrees}°`);
  if (s.op === 'spin') bits.push(`${s.axis === 'x' ? 'flip' : 'turn'}${Math.abs(s.turns) > 1 ? ` ×${Math.abs(s.turns)}` : ''}${s.turns < 0 ? ' backwards' : ''}`);
  if (s.op === 'bounce') bits.push(`${s.height} px high`);
  if (s.op === 'follow') bits.push(`after ${s.leader}`);
  if (s.op === 'newAnimation') bits.push(`“${s.name}”`);
  if (s.frames) bits.push(`${s.frames} frame${s.frames === 1 ? '' : 's'}`);
  if (s.easing && s.easing !== 'linear') bits.push(s.easing.replace(/([A-Z])/g, ' $1').toLowerCase());
  if (s.yoyo) bits.push('and back');
  if (s.speed && s.speed !== 1) bits.push(s.speed > 1 ? 'fast' : 'slow');
  return `${head}${s.times > 1 ? ` ×${s.times}` : ''}${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
}

// ---- Scene: what a plan can address -------------------------------------------------------------------------------

/**
 * Everything a plan can name in one frame: objects [{name, layerId, instanceId, partId, boneId}], characters [{rootBoneId,
 * name, facing, roles: {role: boneId}}], bones [{id, name, role}], poses, animations, canvas size.
 */
export function motionTargets(project, { animationId, frameId } = {}) {
  const animation = project.animations.find(a => a.id === animationId) || project.animations[0];
  const frame = animation.frames.find(f => f.id === frameId) || animation.frames[0], objects = [];
  for (const layer of project.layers) {
    const cel = frame.cels.find(c => c.layerId === layer.id);
    for (const op of cel?.source?.ops || []) if (op.type === 'use') {
      const part = project.parts?.find(x => x.id === op.partId), bone = boneOf(project, layer.id, op.id);
      if (part) objects.push({ name: op.name || part.name || op.partId, layerId: layer.id, instanceId: op.id, partId: op.partId, ...(bone ? { boneId: bone.id } : {}), op, part, locked: Boolean(layer.locked || op.locked), hidden: !layer.visible });
    }
  }
  const roleOf = new Map(), characters = [];
  for (const root of (project.bones || []).filter(b => !b.parent && objects.some(o => o.boneId === b.id))) {
    let found = { roles: {}, facing: 'side' };
    try { found = detectRoles(rigDescriptor(project, { animationId: animation.id, frameId: frame.id, rootBoneId: root.id })); } catch { /* not fully placed */ }
    for (const [role, id] of Object.entries(found.roles)) roleOf.set(id, role);
    characters.push({ rootBoneId: root.id, name: root.name || root.id, facing: found.facing, roles: found.roles });
  }
  const bones = (project.bones || []).filter(b => objects.some(o => o.boneId === b.id)).map(b => ({ id: b.id, name: b.name || b.id, parent: b.parent || null, ...(roleOf.has(b.id) ? { role: roleOf.get(b.id) } : {}) }));
  return {
    width: project.width, height: project.height, animation: { id: animation.id, name: animation.name, frames: animation.frames.length, fps: animation.fps }, frameIndex: animation.frames.indexOf(frame),
    objects, characters, bones, poses: (project.poses || []).map(p => ({ id: p.id, name: p.name })),
    animations: project.animations.map(a => ({ id: a.id, name: a.name, frames: a.frames.length })),
  };
}

const ROLE_LABEL = Object.fromEntries(ROLES);
function score(ref, label) {
  const a = norm(ref), b = norm(label);
  if (!a || !b) return 0;
  if (a === b) return 3;
  const ta = a.split(' '), tb = b.split(' ');
  if (ta.every(t => tb.includes(t)) || tb.every(t => ta.includes(t))) return 2.2;
  if (b.replace(/ /g, '').includes(a.replace(/ /g, '')) || a.replace(/ /g, '').includes(b.replace(/ /g, ''))) return 2;
  return 1 + nameSimilarity(a, b);
}
/** The role a phrase names ("left arm" → upperArmL, "head", "right hand"), using the character's roles. */
function roleBone(roles, ref) {
  const { kind, side } = nameRole(ref);
  if (!kind) return null;
  const k = kind === 'neck' ? 'head' : kind, sides = side ? [side] : ['R', 'L'];
  if (k === 'head' || k === 'spine' || k === 'root') return roles[k] || null;
  for (const sd of sides) for (const r of k === 'hand' ? ['hand', 'lowerArm'] : k === 'foot' ? ['foot', 'lowerLeg'] : [k]) if (roles[r + sd]) return roles[r + sd];
  return null;
}
/** Resolve a target phrase to an object of the scene. `want`: 'object' | 'bone' | 'character' (a rig root if rigged). */
export function resolveTarget(scene, ref, { want = 'object', selection, project } = {}) {
  const objects = scene.objects.filter(o => !o.hidden);
  if (!objects.length) throw new Error('Place a part on the canvas first: there is nothing to animate in this frame.');
  const byBone = id => objects.find(o => o.boneId === id);
  const toRoot = o => (want === 'character' && o?.boneId && project ? byBone(rootOf(project, o.boneId).id) || o : o);
  const r = norm(ref);
  if (PRONOUNS.has(r) || (ref == null)) {
    const sel = selection && objects.find(o => o.layerId === selection.layerId && o.instanceId === selection.key);
    if (sel) return toRoot(sel);
    if (scene.characters.length) return byBone(scene.characters[0].rootBoneId);
    return objects.reduce((a, b) => { const sa = transformedSize(a.op, a.part), sb = transformedSize(b.op, b.part); return sb.width * sb.height > sa.width * sa.height ? b : a; });
  }
  for (const c of scene.characters) {
    const id = roleBone(c.roles, ref);
    if (id && byBone(id) && (want === 'bone' || !objects.some(o => score(ref, o.name) >= 3))) return toRoot(byBone(id));
  }
  let best = null, bestScore = 0;
  for (const o of objects) {
    const bone = o.boneId && scene.bones.find(b => b.id === o.boneId);
    const labels = [o.name, o.instanceId, o.partId, bone?.name, bone?.id, bone?.role && ROLE_LABEL[bone.role]].filter(Boolean);
    const sc = Math.max(...labels.map(l => score(ref, l))) + (want === 'bone' && o.boneId ? .05 : 0);
    if (sc > bestScore) { best = o; bestScore = sc; }
  }
  for (const c of scene.characters) if (score(ref, c.name) > bestScore) { best = byBone(c.rootBoneId); bestScore = score(ref, c.name); }
  if (!best || bestScore < 1.55) {
    const names = [...new Set([...objects.map(o => o.name), ...scene.bones.map(b => b.name)])].slice(0, 10);
    throw new Error(`No object, part or bone called “${ref}” in this frame. Try ${names.map(n => `“${n}”`).join(', ')}.`);
  }
  return toRoot(best);
}

// ---- Executor -----------------------------------------------------------------------------------------------------

const animOf = st => st.p.animations.find(a => a.id === st.animId);
const frameIndex = (st, id) => animOf(st).frames.findIndex(f => f.id === id);
const frameById = (st, id) => animOf(st).frames.find(f => f.id === id);
const opOf = (frame, o) => frame.cels.find(c => c.layerId === o.layerId)?.source?.ops.find(op => op.type === 'use' && op.id === o.instanceId);
function totalFrames(p) { return p.animations.reduce((n, a) => n + a.frames.length, 0); }
/** Insert a copy of frame `sourceId` (default `afterId`) after `afterId`; returns its id. */
function insertCopy(st, afterId, sourceId = afterId) {
  const animation = animOf(st), source = frameById(st, sourceId);
  if (animation.frames.length >= 256 || totalFrames(st.p) >= 1024) throw new Error('This animation has reached its frame limit. Use fewer frames or repeats.');
  const frame = makeLayeredFrame(st.p, source);
  animation.frames.splice(frameIndex(st, afterId) + 1, 0, frame);
  return frame.id;
}
/** The frame a step starts from: the unused seed, a fresh copy of the cursor (`modifies`), or the cursor itself. */
function start(st, modifies) {
  if (st.seed) { const id = st.seed; st.seed = null; return { id, own: true }; }
  return modifies ? { id: insertCopy(st, st.cursor), own: true } : { id: st.cursor, own: false };
}
/** Append copies of `ids` (in order) `times − 1` more times after the cursor; returns all ids. */
function repeatFrames(st, ids, times) {
  const out = [...ids];
  for (let n = 1; n < times; n++) for (const id of ids) out.push(insertCopy(st, out.at(-1), id));
  return out;
}
function newAnimation(st, name) {
  const p = st.p, base = st.baseFrame, used = new Set([...p.animations.map(a => a.id), ...p.layers.map(l => l.id), ...p.animations.flatMap(a => a.frames.map(f => f.id))]);
  const stem = String(name || 'motion').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'motion';
  let id = stem;
  for (let n = 2; used.has(id); n++) id = `${stem}-${n}`;
  const after = p.animations.findIndex(a => a.id === (st.animId || st.baseAnimationId)), seed = makeLayeredFrame(p, base);
  seed.duration = st.frameMs;
  p.animations.splice(after + 1, 0, { id, name: String(name || 'Motion').slice(0, 80), fps: Math.round(1000 / st.frameMs), ...(st.baseLayerOrder ? { layerOrder: [...st.baseLayerOrder] } : {}), frames: [seed] });
  Object.assign(st, { animId: id, seed: seed.id, cursor: seed.id, last: null, history: [] });
  st.created.push(id); st.seeded.add(id);
}
const scene = st => motionTargets(st.p, { animationId: st.animId, frameId: st.cursor });
const target = (st, ref, want) => resolveTarget(scene(st), ref, { want, selection: st.selection, project: st.p });
const warnOnce = (st, message) => { if (!st.warnings.includes(message)) st.warnings.push(message); };
function scaleDurations(st, ids, s) {
  const speed = s.speed || 1;
  if (!s.duration && speed === 1) return;
  for (const id of ids) { const f = frameById(st, id); if (f) f.duration = clamp(Math.round(s.duration || f.duration / speed), 16, 60000); }
}

/** Tween a rig from the start frame into `change(project, keyFrameId)`, optionally back again. */
function rigTween(st, s, change) {
  const from = start(st, false), key = insertCopy(st, from.id);
  st.p = change(st.p, key);
  const ease = s.easing || 'easeInOut', ids = [];
  const leg = (a, b) => {
    const n = Math.max(1, s.frames) - 1;
    const out = n ? tweenPoses(st.p, { animationId: st.animId, fromFrameId: a, toFrameId: b, insert: n, easing: ease }) : null;
    if (out) st.p = out.project;
    ids.push(...(out?.inserted || []), b);
  };
  leg(from.id, key);
  if (s.hold) { let at = key; for (let n = 0; n < s.hold; n++) ids.push(at = insertCopy(st, at, key)); }
  if (s.yoyo) leg(ids.at(-1), insertCopy(st, ids.at(-1), from.id));
  return from.own ? [from.id, ...ids] : ids;
}
/** Tween an object to `endPose(startPose)` from the cursor; returns produced frame ids. */
function objectTween(st, s, o, endPose, extra = {}) {
  const from = start(st, false), op = opOf(frameById(st, from.id), o);
  if (!op) throw new Error(`“${o.name}” is not in this frame.`);
  const begin = poseOf(op, o.part), ids = [], easing = s.easing || 'easeInOut';
  const leg = (fromId, pose, more = {}) => {
    const out = tweenToPose(st.p, { animationId: st.animId, layerId: o.layerId, instanceId: o.instanceId, fromFrameId: fromId, endPose: pose, frames: Math.max(1, s.frames), easing, ...more });
    st.p = out.project; ids.push(...out.inserted);
    return out.endFrameId;
  };
  const end = leg(from.id, endPose(begin), extra);
  if (s.yoyo) leg(end, { x: begin.x, y: begin.y, angle: begin.angle, tiltX: begin.tiltX, tiltY: begin.tiltY });
  return from.own ? [from.id, ...ids] : ids;
}
const rigged = o => Boolean(o.boneId);

const RUN = {
  template(st, s) {
    const o = target(st, s.target, 'character');
    if (!rigged(o)) {
      warnOnce(st, `“${o.name}” has no skeleton, so ${TEMPLATES[s.name].label.toLowerCase()} uses a simpler motion. Rig it (J) for a full ${s.name} cycle.`);
      if (s.name === 'jump') return RUN.bounce(st, { ...s, op: 'bounce', height: s.height || 10, frames: s.frames || 10 });
      if (s.name === 'wave') return RUN.ripple(st, { ...s, op: 'ripple', frames: s.frames || 8 });
      if (s.name === 'walk' || s.name === 'run') return RUN.bounce(st, { ...s, op: 'bounce', height: s.name === 'run' ? 3 : 1, frames: Math.max(3, Math.min(32, s.frames || 8)), squash: .2 });
      return RUN.move(st, { ...s, op: 'move', by: { x: 0, y: -Math.max(1, Math.round(s.height || 2)) }, frames: Math.max(1, Math.round((s.frames || 8) / 2)), yoyo: true });
    }
    const def = TEMPLATES[s.name], from = st.seed ? { id: st.seed, own: true } : { id: st.cursor, own: false };
    const out = generateTemplate(st.p, {
      animationId: st.animId, frameId: from.id, rootBoneId: o.boneId, template: s.name, frames: s.frames, frameMs: s.duration || def.frameMs / (s.speed || 1),
      amplitude: s.amplitude, bounce: s.height, exaggeration: s.exaggeration, facing: s.facing || 'auto', mode: 'new', name: 'motion-temp',
    });
    const p = out.project, temp = p.animations.find(a => a.id === out.animationId);
    p.animations.splice(p.animations.indexOf(temp), 1);
    st.p = p;
    const animation = animOf(st), at = frameIndex(st, from.id);
    animation.frames.splice(at + 1, 0, ...temp.frames);
    if (from.own) { animation.frames.splice(at, 1); st.seed = null; }
    let ids = repeatFrames(st, temp.frames.map(f => f.id), s.times || 1);
    if (s.by) ids.forEach((id, k) => { const f = (k + 1) / ids.length; st.p = moveSkeleton(st.p, { boneId: o.boneId, dx: Math.round(s.by.x * f), dy: Math.round(s.by.y * f), animationId: st.animId, frameIds: [id] }).project; });
    st.timesDone = true;
    return ids;
  },
  bounce(st, s) {
    const o = target(st, s.target, 'character'), from = start(st, true);
    const out = bounceInPlace(st.p, { animationId: st.animId, layerId: o.layerId, instanceId: o.instanceId, fromFrameId: from.id, height: s.height || 8, frames: clamp(s.frames || 8, 3, 32), squash: s.squash ?? (rigged(o) ? 0 : .5) });
    st.p = out.project;
    return out.frameIds;
  },
  move(st, s) {
    const o = target(st, s.target, 'character');
    return loopRuns(st, s, () => objectTween(st, s, o, begin => {
      const op = opOf(frameById(st, st.cursor), o) || o.op, c = instancePivot(op, o.part), d = s.by || offsetTo(s.to, c);
      return { x: begin.x + Math.round(d.x), y: begin.y + Math.round(d.y) };
    }, s.path === 'arc' || s.arc ? { path: { kind: 'arc', via: arcVia(st, o, s) } } : {}));
  },
  spin(st, s) {
    const o = target(st, s.target, 'character'), from = start(st, false), times = s.times || 1;
    if (rigged(o) && st.p.bones?.some(b => b.parent && rootOf(st.p, b.id).id === o.boneId)) warnOnce(st, `The 3D spin turns “${o.name}”; how its rigged parts follow depends on the skeleton.`);
    const out = spin3d(st.p, { animationId: st.animId, layerId: o.layerId, instanceId: o.instanceId, fromFrameId: from.id, frames: clamp((s.frames || 8) * times, 2, 64), axis: s.axis, turns: clamp(s.turns * times, -8, 8) });
    st.p = out.project; st.timesDone = true;
    return from.own ? out.frameIds : out.inserted;
  },
  turn(st, s) {
    const o = target(st, s.target, 'character'), field = s.axis === 'x' ? 'tiltX' : 'tiltY';
    return loopRuns(st, s, () => objectTween(st, s, o, begin => ({ [field]: begin[field] + s.degrees })));
  },
  rotate(st, s) {
    const o = target(st, s.target, 'bone');
    if (rigged(o)) return loopRuns(st, s, () => rigTween(st, s, (p, key) => rotateBone(p, { boneId: o.boneId, delta: s.degrees, animationId: st.animId, frameIds: [key] }).project));
    const chunks = Math.max(1, Math.ceil(Math.abs(s.degrees) / 90)), step = s.degrees / chunks;
    return loopRuns(st, s, () => {
      const ids = [];
      for (let k = 0; k < chunks; k++) { ids.push(...objectTween(st, { ...s, yoyo: false, frames: Math.max(1, Math.round(s.frames / chunks)), easing: chunks > 1 ? 'linear' : s.easing }, o, begin => ({ angle: begin.angle + step }))); st.cursor = ids.at(-1); }
      if (s.yoyo) ids.push(...objectTween(st, { ...s, yoyo: false }, o, begin => ({ angle: begin.angle - s.degrees })));
      return ids;
    });
  },
  pose(st, s) {
    const o = target(st, s.target, 'character');
    if (!rigged(o)) throw new Error(`“${o.name}” has no skeleton to pose. Rig it first (J).`);
    let pose;
    if (s.name) {
      const list = st.p.poses || [], found = list.map(x => ({ x, sc: Math.max(score(s.name, x.name), score(s.name, x.id)) })).sort((a, b) => b.sc - a.sc)[0];
      if (!found || found.sc < 1.55) throw new Error(list.length ? `No saved pose called “${s.name}”. Saved poses: ${list.map(x => `“${x.name}”`).join(', ')}.` : 'This project has no saved poses yet. Save one in Skeleton mode, or give angles.');
      pose = found.x;
    } else {
      const sc = scene(st), bones = {};
      for (const [name, deg] of Object.entries(s.angles)) bones[resolveTarget(sc, name, { want: 'bone', project: st.p }).boneId ?? fail(name)] = deg;
      pose = { bones };
    }
    return loopRuns(st, s, () => rigTween(st, s, (p, key) => applyLibraryPose(p, { pose, mirror: s.mirror, amount: s.amount ?? 1, animationId: st.animId, frameIds: [key] }).project));
  },
  reach(st, s) {
    const o = target(st, s.target ?? 'hand', 'bone');
    if (!rigged(o)) throw new Error(`“${o.name}” is not a rigged limb. Reach moves a hand or foot of a skeleton.`);
    const tip = rigView(st.p, st.animId, st.cursor).find(v => v.bone.id === o.boneId)?.tip;
    const goal = s.to || { x: tip.x + s.by.x, y: tip.y + s.by.y };
    return loopRuns(st, s, () => rigTween(st, s, (p, key) => ikChain(p, { endBoneId: o.boneId, target: goal, animationId: st.animId, frameIds: [key] }).project));
  },
  shake(st, s) {
    const o = target(st, s.target, 'bone'), bone = rigged(o) && st.p.bones.find(b => b.id === o.boneId)?.parent;
    const a = s.amount || (bone ? 12 : 2), frames = Math.max(1, s.frames || 2), ids = [];
    const legs = [a, -2 * a, a];
    for (let n = 0; n < (s.times || 2); n++) for (const v of legs) {
      const leg = { ...s, frames: v === a ? frames : frames * 2, easing: 'easeInOut', yoyo: false, times: 1 };
      ids.push(...(bone ? rigTween(st, leg, (p, key) => rotateBone(p, { boneId: o.boneId, delta: v, animationId: st.animId, frameIds: [key] }).project) : objectTween(st, leg, rigged(o) ? target(st, s.target, 'character') : o, begin => ({ x: begin.x + v }))));
      st.cursor = ids.at(-1);
    }
    st.timesDone = true;
    return ids;
  },
  follow(st, s) {
    const o = target(st, s.target, 'object'), leader = target(st, s.leader, 'object');
    const out = springFollow(st.p, { animationId: st.animId, layerId: o.layerId, instanceId: o.instanceId, leaderId: leader.instanceId, leaderLayerId: leader.layerId, property: s.property || 'angle', stiffness: s.stiffness ?? .25, damping: s.damping ?? .7, loop: s.loop ?? true });
    st.p = out.project;
    return [];
  },
  squash(st, s) {
    if (!st.last?.ids.length) throw new Error('Squash & stretch needs a motion before it, such as a bounce or a move.');
    const o = s.target !== undefined ? target(st, s.target, 'object') : st.lastObject || target(st, '', 'character');
    const ids = [st.last.from, ...st.last.ids].filter((id, i, a) => id && a.indexOf(id) === i);
    st.p = autoSquashStretch(st.p, { animationId: st.animId, layerId: o.layerId, instanceId: o.instanceId, strength: s.strength ?? .5, impact: s.impact ?? 0, frameIds: ids, apply: st.last.ids }).project;
    return [];
  },
  ripple(st, s) {
    const o = target(st, s.target, 'object');
    let ids;
    if (st.last?.ids.length >= 2) ids = st.last.ids;
    else { const from = start(st, false); ids = [from.id]; for (let k = 1; k < (s.frames || 8); k++) ids.push(insertCopy(st, ids.at(-1))); if (!from.own) ids.shift(); }
    const speed = s.rippleSpeed ?? Math.round(360 / Math.max(2, ids.length));
    st.p = waveAnimate(st.p, { animationId: st.animId, layerId: o.layerId, instanceId: o.instanceId, speed, frameIds: ids }).project;
    return st.last?.ids === ids ? [] : ids;
  },
  hold(st, s) {
    const from = start(st, false), ids = from.own ? [from.id] : [];
    let at = from.id;
    for (let k = from.own ? 1 : 0; k < (s.frames || 2); k++) ids.push(at = insertCopy(st, at, from.id));
    return ids;
  },
  repeat(st, s) {
    const ids = st.history.slice(-s.steps).flat();
    if (!ids.length) throw new Error('Repeat needs a motion before it.');
    const all = repeatFrames(st, ids, s.times);
    return all.slice(ids.length);
  },
  newAnimation(st, s) { newAnimation(st, s.name); return []; },
};
const offsetTo = (to, c) => ({ x: to.x === undefined ? 0 : to.x - c.x, y: to.y === undefined ? 0 : to.y - c.y });
const fail = name => { throw new Error(`No bone called “${name}”.`); };
function arcVia(st, o, s) {
  const op = opOf(frameById(st, st.seed || st.cursor), o) || o.op, c = instancePivot(op, o.part), d = s.by || offsetTo(s.to, c);
  const h = s.arc ?? Math.max(4, Math.round(Math.hypot(d.x, d.y) / 2));
  return { x: c.x + d.x / 2, y: c.y + d.y / 2 - h };
}
/** Run a non-looping step `times` times in a row, each from where the last ended. */
function loopRuns(st, s, once) {
  const ids = [];
  for (let n = 0; n < (s.times || 1); n++) { const got = once(); ids.push(...got); if (got.length) st.cursor = got.at(-1); }
  st.timesDone = true;
  return ids;
}
function sameFrame(p, a, b) {
  const x = compositeFrame(p, a), y = compositeFrame(p, b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Execute a motion plan from frame `frameId` of `animationId`. `mode` (default plan.mode or 'new'): 'new' builds a new
 * animation starting from a copy of that frame, 'append' adds frames after the animation's last frame, 'replace'
 * rebuilds the current animation from that frame. `selection` ({layerId, key}) is the default target.
 * Returns { project, animationId (to show), animationIds (changed or added), frameIds (added), summary: [{label, frames}],
 * warnings, plan (normalized) }.
 */
export function runMotionPlan(project, input, { animationId, frameId, selection, mode, name } = {}) {
  const plan = normalizePlan(input), p = validateProject(project);
  const base = p.animations.find(a => a.id === animationId) || p.animations[0], baseFrame = base.frames.find(f => f.id === frameId) || base.frames[0];
  const how = mode || plan.mode || 'new';
  const st = { p, animId: null, cursor: null, seed: null, last: null, history: [], warnings: [], summary: [], created: [], seeded: new Set(), selection, baseFrame: structuredClone(baseFrame), baseAnimationId: base.id, frameMs: Math.round(1000 / (base.fps >= 6 ? base.fps : 12)), baseLayerOrder: base.layerOrder, added: [] };
  if (how === 'new') newAnimation(st, name || plan.name || describeStep(plan.steps[0]).split(' · ')[0].replace(/ ×\d+$/, ''));
  else if (how === 'replace') {
    const seed = makeLayeredFrame(p, baseFrame);
    seed.duration = st.frameMs; base.fps = Math.round(1000 / st.frameMs);
    base.frames = [seed];
    Object.assign(st, { animId: base.id, seed: seed.id, cursor: seed.id });
    st.seeded.add(base.id);
  } else Object.assign(st, { animId: base.id, cursor: base.frames.at(-1).id });
  plan.steps.forEach((s, i) => {
    let ids;
    st.timesDone = false;
    const before = st.cursor;
    try {
      ids = RUN[s.op](st, s);
      if (!st.timesDone && s.times > 1 && ids.length && !['repeat', 'hold'].includes(s.op)) ids = repeatFrames(st, ids, s.times);
      if (s.op !== 'template') {
        // Motion frames play at the animation's rate (a slow 1 fps still frame would crawl), then speed scales them.
        if (s.op !== 'repeat') for (const id of ids) { const f = frameById(st, id); if (f) f.duration = st.frameMs; }
        scaleDurations(st, ids, s);
      }
    } catch (error) { throw new Error(`Step ${i + 1} (${describeStep(s).split(' · ')[0]}): ${error.message}`); }
    if (ids.length) {
      st.cursor = ids.at(-1);
      st.last = { from: frameById(st, before) ? before : ids[0], ids };
      st.history.push(ids); st.added.push(...ids);
    }
    if (['bounce', 'move', 'spin', 'turn', 'rotate', 'template'].includes(s.op)) { try { st.lastObject = target(st, s.target, s.op === 'rotate' ? 'object' : 'character'); } catch { /* resolved above */ } }
    st.summary.push({ label: describeStep(s), frames: ids.length, op: s.op });
  });
  for (const id of st.seeded) {
    const animation = st.p.animations.find(a => a.id === id);
    if (animation.frames.length > 2 && sameFrame(st.p, animation.frames[0], animation.frames.at(-1))) {
      const dropped = animation.frames.pop();
      st.added = st.added.filter(x => x !== dropped.id);
    }
  }
  const out = validateProject(st.p), shown = st.animId;
  return {
    project: out, animationId: shown, animationIds: [...new Set([...st.created, shown])], frameIds: st.added.filter(id => out.animations.some(a => a.frames.some(f => f.id === id))),
    summary: st.summary, warnings: st.warnings, plan,
  };
}
