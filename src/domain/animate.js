/**
 * Animation use cases: motion maths (motion.js) applied to placed objects across the frames of one animation.
 * Every function is pure — (project, options) → { project, …info } — and validates its result. An object is addressed
 * by `{animationId, layerId, instanceId}`; instance ids are stable across frames, so one id is one object over time.
 */
import { validateProject, makeLayeredFrame, getLayerPixels, MAX_TOTAL_PIXELS } from './project.js';
import { sourceForCel, hasLockedInstances, writeCelPixels, renderParts } from './artwork.js';
import { instancePivot, instancePixel, transformedSize, swapsAxes, pivotUnder, withPivot } from './geometry.js';
import {
  ease, tweenPose, poseOf, applyPose, squashStretch, impactSquash, linePath, arcThrough, bezierPoint, pathLengthParam,
  springFollow as springSeries, loopSpring, overlapDelay, solveTwoBone, normalizeAngle, roundInt, rotatePoint,
} from './motion.js';
import { smear } from './pixel-fx.js';

const MAX_FRAMES_PER_ANIMATION = 256, MAX_TOTAL_FRAMES = 1024, DEG = 180 / Math.PI;

function animationOf(p, animationId) {
  const animation = p.animations.find(a => a.id === animationId);
  if (!animation) throw new Error('This animation no longer exists.');
  return animation;
}
function editableLayer(p, layerId) {
  const layer = p.layers.find(l => l.id === layerId);
  if (!layer) throw new Error('This object no longer exists.');
  if (layer.locked) throw new Error('Unlock this object or its group first.');
  return layer;
}
const celOf = (frame, layerId) => frame.cels.find(c => c.layerId === layerId);
const opIn = (frame, layerId, id) => celOf(frame, layerId)?.source?.ops.find(op => op.type === 'use' && op.id === id);
const partOf = (p, op) => p.parts.find(part => part.id === op.partId);
function unlockedOp(op) {
  if (op.locked) throw new Error('Unlock this object first.');
  return op;
}
/** Frames of the animation (optionally limited to `frameIds`, kept in timeline order) that place `instanceId`. */
function appearances(p, animation, layerId, instanceId, frameIds) {
  const wanted = frameIds && new Set(frameIds);
  const list = animation.frames.filter(f => !wanted || wanted.has(f.id)).map(frame => ({ frame, op: opIn(frame, layerId, instanceId) })).filter(a => a.op);
  if (!list.length) throw new Error('This object does not appear in the chosen frames.');
  return list;
}
/** Replace the stored op with `next` (same id and stack position). */
function writeOp(frame, layerId, next) {
  const ops = celOf(frame, layerId).source.ops, i = ops.findIndex(op => op.type === 'use' && op.id === next.id);
  ops[i] = next;
}
const offsetOf = (op, part) => { const c = instancePivot(op, part); return { x: c.x - op.x, y: c.y - op.y }; };

/** Room for `count` more frames in this animation and project. */
export function canInsertFrames(project, animationId, count = 1) {
  const animation = animationOf(project, animationId), total = project.animations.reduce((n, a) => n + a.frames.length, 0);
  return animation.frames.length + count <= MAX_FRAMES_PER_ANIMATION && total + count <= MAX_TOTAL_FRAMES
    && (total + count) * project.width * project.height * project.layers.length <= MAX_TOTAL_PIXELS;
}
/** Insert `count` copies of `sourceFrame` (all layers, its duration unless given) after index `at`; mutates `p`, returns the new frames. */
function insertCopies(p, animation, at, sourceFrame, count, duration) {
  if (!Number.isInteger(count) || count < 0) throw new Error('Insert a whole number of frames.');
  if (count && !canInsertFrames(p, animation.id, count)) throw new Error('This project has reached its frame limit.');
  const frames = Array.from({ length: count }, () => ({ ...makeLayeredFrame(p, sourceFrame), ...(duration ? { duration } : {}) }));
  animation.frames.splice(at + 1, 0, ...frames);
  return frames;
}

/** Path for the pivot from a to c: 'line' (default), 'arc' through `via`, or 'bezier' with `controls: [c1, c2]`. */
export function motionPath(a, c, path) {
  const kind = path?.kind ?? 'line';
  if (kind === 'line') return linePath(a, c);
  const point = (v, label) => { if (!Number.isFinite(v?.x) || !Number.isFinite(v?.y)) throw new Error(`${label} needs x and y.`); return v; };
  if (kind === 'arc') { const b = point(path.via, 'An arc'); return arcThrough(a, b, c); }
  if (kind === 'bezier') {
    const [c1, c2] = path.controls || [];
    point(c1, 'A curve control'); point(c2, 'A curve control');
    return t => bezierPoint(a, c1, c2, c, t);
  }
  throw new Error('Motion paths are line, arc or bezier.');
}

/**
 * Fill the in-betweens of one object between two keyframes. Every frame strictly between `fromFrameId` and
 * `toFrameId` (timeline order) gets the eased tween of the two key poses at t = frame steps / key distance: position,
 * size, angle (short way), skew and the deform's wave phase / bulge / twist. `insert: n` first adds n copies of the
 * from-frame directly after it. A frame that lacks the object gets a copy of the from-frame instance (raster cels become
 * retained). `path` moves the pivot along a line, an arc through `via` or a bezier (`controls`), at constant speed along
 * the path; `orient: true` adds the path's turning to the angle. `autoSquash: {strength,max,tilt}` then applies
 * motion squash & stretch to the in-betweens.
 * Returns { project, frameIds (in-betweens, in order), inserted (new frame ids) }.
 */
export function tweenObject(project, { animationId, layerId, instanceId, fromFrameId, toFrameId, easing = 'linear', insert = 0, path, orient = false, autoSquash }) {
  const p = validateProject(project), animation = animationOf(p, animationId);
  editableLayer(p, layerId);
  ease(easing, 0);
  let i = animation.frames.findIndex(f => f.id === fromFrameId), j = animation.frames.findIndex(f => f.id === toFrameId);
  if (i < 0 || j < 0) throw new Error('Choose two keyframes in this animation.');
  if (i >= j) throw new Error('The first keyframe must come before the second.');
  const fromOp = opIn(animation.frames[i], layerId, instanceId), toOp = opIn(animation.frames[j], layerId, instanceId);
  if (!fromOp || !toOp) throw new Error('The object must appear in both keyframes.');
  const inserted = insertCopies(p, animation, i, animation.frames[i], insert).map(f => f.id);
  j += inserted.length;
  if (j - i < 2) throw new Error('There are no frames between these keyframes. Insert some in-betweens.');
  const part = partOf(p, fromOp), toPart = partOf(p, toOp), a = poseOf(fromOp, part), b = poseOf(toOp, toPart);
  const pa = instancePivot(fromOp, part), pc = instancePivot(toOp, toPart);
  const route = path && path.kind !== 'line' ? motionPath(pa, pc, path) : null, along = route && pathLengthParam(route);
  const heading = u => { const q = along(Math.max(0, u - .01)), r = along(Math.min(1, u + .01)); return Math.atan2(r.y - q.y, r.x - q.x) * DEG; };
  const frameIds = [];
  for (let k = i + 1; k < j; k++) {
    const frame = animation.frames[k], t = (k - i) / (j - i), e = ease(easing, t);
    const cel = celOf(frame, layerId);
    if (!cel.source) { cel.source = sourceForCel(cel, p.width); p.version = 3; }
    let op = opIn(frame, layerId, instanceId);
    if (!op) { op = structuredClone(fromOp); cel.source.ops.splice(Math.min(celOf(animation.frames[i], layerId).source.ops.indexOf(fromOp), cel.source.ops.length), 0, op); }
    unlockedOp(op);
    // Discrete settings (transform, pivot, deform kind, sampling) hold the from-key's until the to-key.
    const base = { ...structuredClone(fromOp), id: op.id, partId: op.partId }, opPart = partOf(p, op);
    for (const key of ['name', 'visible', 'locked']) if (key in op) base[key] = op[key]; else delete base[key];
    let next = applyPose(base, tweenPose(a, b, t, easing), opPart);
    if (route) {
      if (orient) next = applyPose(next, { angle: (next.angle || 0) + angleTurn(heading(0), heading(e)) }, opPart);
      const goal = along(e), off = offsetOf(next, opPart);
      next = { ...next, x: roundInt(goal.x - off.x), y: roundInt(goal.y - off.y) };
    }
    writeOp(frame, layerId, next);
    frameIds.push(frame.id);
  }
  let out = validateProject(p);
  if (autoSquash) out = autoSquashStretch(out, { animationId, layerId, instanceId, ...autoSquash, frameIds: [fromFrameId, ...frameIds, toFrameId], apply: frameIds }).project;
  return { project: out, frameIds, inserted };
}
const angleTurn = (a, b) => normalizeAngle(b - a);

/**
 * Animate a move from one frame: insert `frames` copies of the from-frame after it, give the object `endPose` (pose
 * fields, see motion.poseOf) in the last copy and tween the copies in between (tweenObject options: easing, path,
 * orient, autoSquash). Returns { project, frameIds (in-betweens), inserted (all new frame ids), endFrameId }.
 */
export function tweenToPose(project, { animationId, layerId, instanceId, fromFrameId, endPose, frames = 6, ...tween }) {
  if (!Number.isInteger(frames) || frames < 1 || frames > 64) throw new Error('A move takes 1 to 64 frames.');
  const p = validateProject(project), animation = animationOf(p, animationId);
  editableLayer(p, layerId);
  const i = animation.frames.findIndex(f => f.id === fromFrameId), from = i < 0 ? null : opIn(animation.frames[i], layerId, instanceId);
  if (!from) throw new Error('The object must appear in the first frame of the move.');
  unlockedOp(from);
  const inserted = insertCopies(p, animation, i, animation.frames[i], frames), end = inserted.at(-1);
  writeOp(end, layerId, applyPose(from, endPose, partOf(p, from)));
  const ids = inserted.map(f => f.id);
  if (frames === 1) return { project: validateProject(p), frameIds: [], inserted: ids, endFrameId: end.id };
  const result = tweenObject(p, { ...tween, animationId, layerId, instanceId, fromFrameId, toFrameId: end.id });
  return { ...result, inserted: ids, endFrameId: end.id };
}

/**
 * A looping bounce from a single frame, where the object rests on the ground. The from-frame becomes the ground
 * contact and `frames − 1` copies follow it: the bottom edge rises by height·4u(1−u) (u = k/frames, a gravity
 * parabola: slowing to the top, speeding up on the way down), so the last frame flows back into the contact. The contact
 * frame is squashed (wider and shorter, bottom on the ground) and fast frames stretch upright, both keeping the area;
 * `squash` (0..1) sets how much. Returns { project, frameIds (the loop, in order), inserted, frames: [{width, height, lift}] }.
 */
export function bounceInPlace(project, { animationId, layerId, instanceId, fromFrameId, height = 8, frames = 8, squash = 0.5 }) {
  if (!Number.isInteger(frames) || frames < 3 || frames > 32) throw new Error('A bounce takes 3 to 32 frames.');
  if (!Number.isFinite(height) || height < 1 || height > 512) throw new Error('Bounce at least 1 pixel high.');
  const p = validateProject(project), animation = animationOf(p, animationId), amount = Math.max(0, Math.min(1, Number(squash) || 0));
  editableLayer(p, layerId);
  const i = animation.frames.findIndex(f => f.id === fromFrameId), base = i < 0 ? null : opIn(animation.frames[i], layerId, instanceId);
  if (!base) throw new Error('The object must appear in this frame.');
  unlockedOp(base);
  const part = partOf(p, base), box = transformedSize(base, part), swap = swapsAxes(base.transform);
  const centre = base.x + box.width / 2, ground = base.y + box.height, lift = k => { const u = (((k % frames) + frames) % frames) / frames; return height * 4 * u * (1 - u); };
  const list = [animation.frames[i], ...insertCopies(p, animation, i, animation.frames[i], frames - 1)];
  const report = list.map((frame, k) => {
    const size = k ? squashStretch({ x: 0, y: (lift(k + 1) - lift(k - 1)) / 2 }, box, { strength: amount, max: amount * .8 }) : impactSquash(box, amount * .8);
    const rise = roundInt(lift(k)), x = roundInt(centre - size.width / 2), y = ground - rise - size.height;
    writeOp(frame, layerId, applyPose(opIn(frame, layerId, instanceId), { x, y, width: swap ? size.height : size.width, height: swap ? size.width : size.height }, part));
    return { width: size.width, height: size.height, lift: rise };
  });
  return { project: validateProject(p), frameIds: list.map(f => f.id), inserted: list.slice(1).map(f => f.id), frames: report };
}

/**
 * Set an object's pivot to the pixel under canvas `point` as it is shown in `frameId`, in every frame placing it (or
 * `frameIds`), each moved so its artwork stays put (geometry.withPivot). Returns { project, pivot }.
 */
export function setPivotAt(project, { animationId, layerId, instanceId, frameId, point, frameIds }) {
  const p = validateProject(project), animation = animationOf(p, animationId);
  editableLayer(p, layerId);
  const here = opIn(animation.frames.find(f => f.id === frameId) || {cels: []}, layerId, instanceId);
  if (!here) throw new Error('The object must appear in this frame.');
  const pivot = pivotUnder(here, partOf(p, here), point);
  for (const { frame, op } of appearances(p, animation, layerId, instanceId, frameIds)) writeOp(frame, layerId, withPivot(unlockedOp(op), partOf(p, op), pivot));
  return { project: validateProject(p), pivot };
}

/** Canvas joints of a two-object limb in one frame (as ikLimb sees them): shoulder and elbow pivots and the hand end. */
export function limbJoints(project, { animationId, frameId, layerId, upperId, lowerId, lowerLayerId = layerId }) {
  const frame = animationOf(project, animationId).frames.find(f => f.id === frameId), up = frame && opIn(frame, layerId, upperId), low = frame && opIn(frame, lowerLayerId, lowerId);
  if (!up || !low) return null;
  return { shoulder: instancePivot(up, partOf(project, up)), elbow: instancePivot(low, partOf(project, low)), hand: limbEnd(low, partOf(project, low)) };
}

/**
 * Motion squash & stretch, area preserving. For each frame placing the object, the velocity of its pivot (central
 * difference of neighbouring frames; `loop` wraps the ends) stretches it along the motion by
 * k = 1 + min(max, strength·speed/√area) and squashes it across by 1/k (motion.squashStretch); `tilt` (default true)
 * leans that axis onto the motion. `impact` (0..4) instead squashes a frame where fast motion stops or reverses (a
 * landing) by (1+impact), keeping its bottom edge. Sizes start from each frame's current size, so apply it once.
 * The pivot pixel stays put (default pivot: centre). `frameIds` limits the sampled frames, `apply` the changed ones.
 * Returns { project, frames: [{frameId, width, height, angle, impact}] }.
 */
export function autoSquashStretch(project, { animationId, layerId, instanceId, strength = 0.5, max = 0.6, impact = 0, tilt = true, loop = false, frameIds, apply }) {
  const p = validateProject(project), animation = animationOf(p, animationId);
  editableLayer(p, layerId);
  const list = appearances(p, animation, layerId, instanceId, frameIds), n = list.length, changed = apply && new Set(apply);
  const centres = list.map(({ op }) => instancePivot(op, partOf(p, op)));
  const at = k => centres[loop ? (k + n) % n : Math.max(0, Math.min(n - 1, k))];
  const report = [];
  list.forEach(({ frame, op }, k) => {
    if (changed && !changed.has(frame.id)) return;
    unlockedOp(op);
    const part = partOf(p, op), swap = swapsAxes(op.transform), box = transformedSize(op, part);
    const vin = { x: at(k).x - at(k - 1).x, y: at(k).y - at(k - 1).y }, vout = { x: at(k + 1).x - at(k).x, y: at(k + 1).y - at(k).y };
    const landing = impact > 0 && Math.hypot(vin.x, vin.y) > 0 && vin.x * vout.x + vin.y * vout.y <= 0 && (loop || k > 0);
    let size, angle = op.angle || 0, anchorBottom = false;
    if (landing) { size = impactSquash(box, impact); anchorBottom = true; }
    else {
      const s = squashStretch({ x: (vin.x + vout.x) / 2, y: (vin.y + vout.y) / 2 }, box, { strength, max });
      size = s; if (tilt) angle += s.angle;
    }
    const next = applyPose(op, { width: swap ? size.height : size.width, height: swap ? size.width : size.height, angle }, part);
    const after = transformedSize(next, part);
    if (anchorBottom) Object.assign(next, { x: op.x + roundInt((box.width - after.width) / 2), y: op.y + box.height - after.height });
    else if (op.pivot) {
      // Scale the pivot pixel with the box so the same artwork pixel stays under it.
      const pivot = { x: Math.floor((op.pivot.x + .5) * after.width / box.width), y: Math.floor((op.pivot.y + .5) * after.height / box.height) };
      Object.assign(next, { pivot, x: op.x + op.pivot.x - pivot.x, y: op.y + op.pivot.y - pivot.y });
    } else Object.assign(next, { x: op.x + roundInt((box.width - after.width) / 2), y: op.y + roundInt((box.height - after.height) / 2) });
    writeOp(frame, layerId, next);
    report.push({ frameId: frame.id, width: after.width, height: after.height, angle: next.angle || 0, impact: landing });
  });
  return { project: validateProject(p), frames: report };
}

/**
 * Secondary motion: the follower copies the leader's motion with a spring lag (follow-through and overlap).
 * property 'angle': follower angle = spring(leader angle + offset); 'position': the follower's pivot springs after the
 * leader's pivot + offset. The offset is their difference in the first shared frame, so that frame keeps its pose.
 * 'swing' (a tail, hair, a cape): the follower's pivot stays attached to the leader (moving and turning with it) and
 * its far end springs after where the leader carries it, so it trails behind moves and turns and swings back.
 * stiffness (0..1, default .25), damping (0..1, default .7), delay (frames of extra overlap), loop (loopSpring: the
 * last frame flows into the first). The leader may be in another container (`leaderLayerId`, default `layerId`).
 * Only frames placing both objects are used. Returns { project, frameIds, values }.
 */
export function springFollow(project, { animationId, layerId, instanceId, leaderId, leaderLayerId = layerId, property = 'angle', stiffness = 0.25, damping = 0.7, delay = 0, loop = false, frameIds }) {
  if (!['angle', 'position', 'swing'].includes(property)) throw new Error('Follow the angle, the position or swing.');
  if (![stiffness, damping].every(v => Number.isFinite(v) && v > 0 && v <= 1)) throw new Error('Stiffness and damping must be between 0 and 1.');
  if (leaderId === instanceId && leaderLayerId === layerId) throw new Error('Choose a different object to follow.');
  const p = validateProject(project), animation = animationOf(p, animationId);
  editableLayer(p, layerId);
  const list = appearances(p, animation, layerId, instanceId, frameIds).map(a => ({ ...a, leader: opIn(a.frame, leaderLayerId, leaderId) })).filter(a => a.leader);
  if (!list.length) throw new Error('The leader must appear in the same frames.');
  const options = { stiffness, damping }, run = (series, angles) => {
    const delayed = delay ? overlapDelay(series, delay, { loop }) : series;
    return loop ? loopSpring(delayed, { ...options, angles }) : springSeries(delayed, { ...options, angles });
  };
  let values;
  if (property === 'angle') {
    const offset = (list[0].op.angle || 0) - (list[0].leader.angle || 0);
    values = run(list.map(a => (a.leader.angle || 0) + offset), true).map(v => normalizeAngle(roundInt(v)));
    list.forEach((a, k) => writeOp(a.frame, layerId, applyPose(unlockedOp(a.op), { angle: values[k] }, partOf(p, a.op))));
  } else if (property === 'swing') {
    const first = list[0], ownPart = partOf(p, first.op), lead = list.map(a => instancePivot(a.leader, partOf(p, a.leader)));
    const a0 = first.leader.angle || 0, attach0 = instancePivot(first.op, ownPart), end0 = limbEnd(first.op, ownPart);
    const length = Math.hypot(end0.x - attach0.x, end0.y - attach0.y), rest = Math.atan2(end0.y - attach0.y, end0.x - attach0.x) * DEG;
    if (length < .5) throw new Error('Move the follower’s pivot to where it is attached.');
    const attach = list.map((a, k) => rotatePoint({ x: lead[k].x + attach0.x - lead[0].x, y: lead[k].y + attach0.y - lead[0].y }, lead[k], (a.leader.angle || 0) - a0));
    const goal = list.map((a, k) => { const r = (rest + (a.leader.angle || 0) - a0) / DEG; return { x: attach[k].x + length * Math.cos(r), y: attach[k].y + length * Math.sin(r) }; });
    const xs = run(goal.map(g => g.x), false), ys = run(goal.map(g => g.y), false);
    values = list.map((_, k) => normalizeAngle(roundInt((first.op.angle || 0) + Math.atan2(ys[k] - attach[k].y, xs[k] - attach[k].x) * DEG - rest)));
    list.forEach((a, k) => {
      const part = partOf(p, a.op), next = applyPose(unlockedOp(a.op), { angle: values[k] }, part), off = offsetOf(next, part);
      writeOp(a.frame, layerId, { ...next, x: roundInt(attach[k].x - off.x), y: roundInt(attach[k].y - off.y) });
    });
  } else {
    const lead = list.map(a => instancePivot(a.leader, partOf(p, a.leader))), own = instancePivot(list[0].op, partOf(p, list[0].op));
    const dx = own.x - lead[0].x, dy = own.y - lead[0].y, xs = run(lead.map(c => c.x + dx), false), ys = run(lead.map(c => c.y + dy), false);
    values = xs.map((x, k) => ({ x, y: ys[k] }));
    list.forEach((a, k) => {
      const off = offsetOf(unlockedOp(a.op), partOf(p, a.op));
      writeOp(a.frame, layerId, { ...a.op, x: roundInt(values[k].x - off.x), y: roundInt(values[k].y - off.y) });
    });
  }
  return { project: validateProject(p), frameIds: list.map(a => a.frame.id), values };
}

/** Bone of an instance about its pivot: rest direction (degrees at angle 0) and length to `point` (canvas, current pose). */
function bone(op, part, point) {
  const pivot = instancePivot(op, part), rest = rotatePoint(point, pivot, -(op.angle || 0));
  return { pivot, length: Math.hypot(rest.x - pivot.x, rest.y - pivot.y), rest: Math.atan2(rest.y - pivot.y, rest.x - pivot.x) * DEG };
}
/** Far end of a limb: the midpoint of its unrotated box edge farthest from the pivot, rotated into place. */
function limbEnd(op, part) {
  const box = transformedSize(op, part), c = instancePivot(op, part);
  const ends = [[0, box.height / 2], [box.width, box.height / 2], [box.width / 2, 0], [box.width / 2, box.height]].map(([x, y]) => ({ x: op.x + x, y: op.y + y }));
  const far = ends.reduce((a, b) => (Math.hypot(b.x - c.x, b.y - c.y) > Math.hypot(a.x - c.x, a.y - c.y) ? b : a));
  return rotatePoint(far, c, op.angle || 0);
}

/**
 * Two-bone IK for a limb of two objects: `upperId` turns about its pivot (shoulder/hip), `lowerId` about its pivot
 * (elbow/knee), which must sit on the upper limb. Bone lengths and rest directions come from the reference frame
 * (first chosen frame): the upper bone runs from the upper pivot to the lower pivot, the lower bone from its pivot to
 * the middle of its farthest box edge (or `reach`: a canvas point in that frame, e.g. the hand). In each frame the
 * angles are solved so the end reaches `target` ({x,y} for all frames, or one point per chosen frame), bending to
 * `bend` (1 or -1); the lower object is moved so its pivot stays on the elbow. Unreachable targets stretch toward them.
 * Returns { project, frames: [{frameId, upper, lower, reached}] }.
 */
export function ikLimb(project, { animationId, layerId, upperId, lowerId, lowerLayerId = layerId, frameIds, target, bend = 1, reach }) {
  const p = validateProject(project), animation = animationOf(p, animationId);
  editableLayer(p, layerId); editableLayer(p, lowerLayerId);
  const list = appearances(p, animation, layerId, upperId, frameIds).map(a => ({ ...a, lower: opIn(a.frame, lowerLayerId, lowerId) })).filter(a => a.lower);
  if (!list.length) throw new Error('Both limb objects must appear in the chosen frames.');
  const targets = Array.isArray(target) ? target : list.map(() => target);
  if (targets.length !== list.length || !targets.every(t => Number.isFinite(t?.x) && Number.isFinite(t?.y))) throw new Error('Give one IK target, or one per frame.');
  const ref = list[0], upperPart = partOf(p, ref.op), lowerPart = partOf(p, ref.lower);
  const upper = bone(ref.op, upperPart, instancePivot(ref.lower, lowerPart)), lower = bone(ref.lower, lowerPart, reach ?? limbEnd(ref.lower, lowerPart));
  if (upper.length < .5 || lower.length < .5) throw new Error('Set the elbow pivot on the upper limb, away from the shoulder pivot.');
  const report = list.map((a, k) => {
    unlockedOp(a.op); unlockedOp(a.lower);
    const root = instancePivot(a.op, partOf(p, a.op)), solved = solveTwoBone(root, targets[k], upper.length, lower.length, bend < 0 ? -1 : 1);
    const upOp = applyPose(a.op, { angle: solved.angle1 - upper.rest }, partOf(p, a.op));
    const turned = (upOp.angle || 0) + upper.rest, elbow = { x: root.x + upper.length * Math.cos(turned / DEG), y: root.y + upper.length * Math.sin(turned / DEG) };
    const lowPart = partOf(p, a.lower), lowOp = applyPose(a.lower, { angle: solved.angle1 + solved.angle2 - lower.rest }, lowPart), off = offsetOf(lowOp, lowPart);
    Object.assign(lowOp, { x: roundInt(elbow.x - off.x), y: roundInt(elbow.y - off.y) });
    writeOp(a.frame, layerId, upOp); writeOp(a.frame, lowerLayerId, lowOp);
    return { frameId: a.frame.id, upper: upOp.angle || 0, lower: lowOp.angle || 0, reached: solved.reached };
  });
  return { project: validateProject(p), frames: report };
}

/**
 * Step the wave phase of an object by `speed` degrees per frame (from its phase in the first chosen frame), so a flag
 * or water ripples. An object without a wave deform gets `wave: {axis, amplitude, wavelength}` (default x, 2, 8).
 * Returns { project, frameIds, seamless (the step after the last frame returns to the first phase), loopFrames
 * (frames for one full cycle: 360/gcd(360,|speed|)) }.
 */
export function waveAnimate(project, { animationId, layerId, instanceId, speed = 45, wave, frameIds }) {
  if (!Number.isInteger(speed) || speed < -360 || speed > 360) throw new Error('Wave speed is whole degrees per frame (-360..360).');
  const p = validateProject(project), animation = animationOf(p, animationId);
  editableLayer(p, layerId);
  const list = appearances(p, animation, layerId, instanceId, frameIds);
  const base = list[0].op.deform?.kind === 'wave' ? list[0].op.deform : { kind: 'wave', axis: 'x', amplitude: 2, wavelength: 8, phase: 0, ...wave };
  list.forEach(({ frame, op }, k) => {
    const d = op.deform?.kind === 'wave' ? op.deform : base;
    writeOp(frame, layerId, { ...unlockedOp(op), deform: { ...d, phase: (((base.phase + k * speed) % 360) + 360) % 360 } });
  });
  const gcd = (a, b) => (b ? gcd(b, a % b) : a), loopFrames = speed % 360 ? 360 / gcd(360, Math.abs(speed) % 360) : 1;
  return { project: validateProject(p), frameIds: list.map(a => a.frame.id), seamless: (list.length * speed) % 360 === 0, loopFrames };
}

function centroid(pixels, width) {
  let x = 0, y = 0, n = 0;
  pixels.forEach((v, i) => { if (v >= 0) { x += i % width; y += Math.floor(i / width); n++; } });
  return n ? { x: x / n, y: y / n } : null;
}

/**
 * Smear frame between two frames of one container: the to-frame's pixels plus a trail swept back to where they were
 * in the from-frame (pixel-fx smear). The motion is the object's pivot movement (`instanceId`) or the shift of the
 * container's pixel centroid. With `insert` (default) a copy of the to-frame (all containers) is inserted just before
 * it (after the last frame when the to-frame is the first: a loop), with `duration` (default the from-frame's);
 * otherwise the to-frame itself becomes the smear. The trail is written
 * like a paint stroke: retained cels keep their objects and get local pixel edits, raster cels get pixels.
 * `steps` (default: the distance) and `color` ('source' or a palette index) style the trail.
 * Returns { project, frameId (the smeared frame), offset }.
 */
export function smearFrame(project, { animationId, layerId, fromFrameId, toFrameId, instanceId, steps, color = 'source', insert = true, duration }) {
  const p = validateProject(project), animation = animationOf(p, animationId), layer = editableLayer(p, layerId);
  if (!layer.visible) throw new Error('Show this container before smearing it.');
  const i = animation.frames.findIndex(f => f.id === fromFrameId), j = animation.frames.findIndex(f => f.id === toFrameId);
  if (i < 0 || j < 0 || i === j) throw new Error('Choose two different frames of this animation.');
  const a = animation.frames[i], b = animation.frames[j];
  let offset;
  if (instanceId) {
    const from = opIn(a, layerId, instanceId), to = opIn(b, layerId, instanceId);
    if (!from || !to) throw new Error('The object must appear in both frames.');
    const s = instancePivot(from, partOf(p, from)), e = instancePivot(to, partOf(p, to));
    offset = { x: roundInt(e.x - s.x), y: roundInt(e.y - s.y) };
  } else {
    const s = centroid(getLayerPixels(a, layerId), p.width), e = centroid(getLayerPixels(b, layerId), p.width);
    if (!s || !e) throw new Error('Both frames need pixels in this container.');
    offset = { x: roundInt(e.x - s.x), y: roundInt(e.y - s.y) };
  }
  if (!offset.x && !offset.y) throw new Error('Nothing moves between these frames.');
  // Smearing from the last frame into the first (a loop) appends the smear at the end.
  const at = j > 0 ? j - 1 : animation.frames.length - 1;
  const frame = insert ? insertCopies(p, animation, at, b, 1, duration ?? a.duration)[0] : b, cel = celOf(frame, layerId);
  if (hasLockedInstances(cel)) throw new Error('Unlock objects in this container before smearing it.');
  writeCelPixels(cel, instanceId ? smearInstance(p, cel, opIn(frame, layerId, instanceId), { offset, steps, color }) : smear(null, cel.pixels, p.width, p.height, { offset, steps, color }), p.width);
  return { project: validateProject(p), frameId: frame.id, offset };
}
/** Smear only one object's pixels: its trail fills empty pixels (and its own) and leaves other objects untouched. */
function smearInstance(p, cel, op, options) {
  const image = renderParts(p.parts).get(op.partId), own = cel.pixels.map((v, i) => (v >= 0 && instancePixel(op, image, { x: i % p.width, y: Math.floor(i / p.width) }) >= 0 ? v : -1));
  const trail = smear(null, own, p.width, p.height, options);
  return cel.pixels.map((v, i) => (trail[i] >= 0 && (v < 0 || own[i] >= 0) ? trail[i] : v));
}
