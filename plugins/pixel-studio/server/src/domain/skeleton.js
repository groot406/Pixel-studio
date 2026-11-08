/**
 * Skeleton rigging over placed objects. `project.bones` (version 3) links instances — stable across frames by
 * layerId + instance id — into trees: a bone's joint is its instance's pivot, pinned to `anchor`, a point in the
 * parent's part pixels (so it travels with the parent through moves, turns, flips, resizes and rotation). A frame's
 * pose is just its instances' angles and positions; operations work on relative angles (child − parent) and then
 * lay the tree out from the roots, so every result is computed fresh from the frame (no accumulated rounding).
 * Every exported operation is pure: (project, options) → { project, … }.
 */
import { validateProject, makeLayeredFrame } from './project.js';
import { renderParts } from './artwork.js';
import { instancePivot, instanceSize, transformedSize, instanceBox, instancePixel, pivotUnder, withPivot, poseVector, deformPoint, TRANSFORM_MATRICES, resizeSeam, axisToPart, axisFromPart } from './geometry.js';
import { normalizeAngle, angleDelta, roundInt, solveChain, ease } from './motion.js';

const cels = frame => frame.cels;
const opIn = (frame, layerId, id) => cels(frame).find(c => c.layerId === layerId)?.source?.ops.find(op => op.type === 'use' && op.id === id);
const partOf = (p, op) => p.parts.find(part => part.id === op.partId);
const absOf = op => op.angle || 0;
function animationOf(p, animationId) {
  const animation = p.animations.find(a => a.id === animationId);
  if (!animation) throw new Error('This animation no longer exists.');
  return animation;
}
function frameOf(animation, frameId) {
  const frame = animation.frames.find(f => f.id === frameId);
  if (!frame) throw new Error('This frame no longer exists.');
  return frame;
}
function boneById(p, boneId) {
  const bone = (p.bones || []).find(b => b.id === boneId);
  if (!bone) throw new Error('This bone no longer exists.');
  return bone;
}
/** Frames an operation touches: `frameIds` (timeline order) or the single `frameId`. */
function framesOf(animation, { frameIds, frameId }) {
  const wanted = new Set(frameIds || [frameId]), list = animation.frames.filter(f => wanted.has(f.id));
  if (!list.length) throw new Error('Choose a frame to pose.');
  return list;
}

// ---- Space conversions ------------------------------------------------------------------------------------------

/** Continuous part-pixel point → transformed box point (resize, then flip/turn). */
export function partToBox(op, part, pt) {
  const size = instanceSize(op, part), [a, b, c, d] = TRANSFORM_MATRICES[op.transform];
  const seam = resizeSeam(op, part), w = size.width, h = size.height;
  const u = axisFromPart(pt.x, w, part.width, seam.x), v = axisFromPart(pt.y, h, part.height, seam.y);
  return { x: a*u + b*v + (a < 0 ? w : 0) + (b < 0 ? h : 0), y: c*u + d*v + (c < 0 ? w : 0) + (d < 0 ? h : 0) };
}
/** Inverse of partToBox. */
export function boxToPart(op, part, pt) {
  const size = instanceSize(op, part), [a, b, c, d] = TRANSFORM_MATRICES[op.transform], w = size.width, h = size.height;
  const X = pt.x - (a < 0 ? w : 0) - (b < 0 ? h : 0), Y = pt.y - (c < 0 ? w : 0) - (d < 0 ? h : 0);
  const seam = resizeSeam(op, part);
  return { x: axisToPart(a*X + c*Y, w, part.width, seam.x), y: axisToPart(b*X + d*Y, h, part.height, seam.y) };
}
const pivotOffset = (op, part) => { const c = instancePivot(op, part); return { x: c.x - op.x, y: c.y - op.y }; };
/** Box point → canvas point as rendered: deformed (wave, bulge, twist), skewed, 3D-turned and rotated about the pivot. */
export function boxToWorld(op, part, pt) {
  const off = pivotOffset(op, part), d = deformPoint(op, part, pt), v = poseVector(op, part, { x: d.x - off.x, y: d.y - off.y });
  return { x: op.x + off.x + v.x, y: op.y + off.y + v.y };
}
/** Canvas point → box point (inverse of boxToWorld). */
export function worldToBox(op, part, pt) {
  const off = pivotOffset(op, part), v = poseVector(op, part, { x: pt.x - op.x - off.x, y: pt.y - op.y - off.y }, true);
  return deformPoint(op, part, { x: off.x + v.x, y: off.y + v.y }, true);
}
/** Canvas joint of a placed bone: where its pivot pixel is drawn, so a deform that moves that pixel moves the joint. */
export function jointWorld(op, part) {
  const off = pivotOffset(op, part);
  return op.deform ? boxToWorld(op, part, off) : { x: op.x + off.x, y: op.y + off.y };
}
/** Canvas point of a parent-part anchor as the parent is posed. */
export const anchorWorld = (op, part, anchor) => boxToWorld(op, part, partToBox(op, part, anchor));
/** Box-space tip of a part seen from its pivot: the farthest box-edge midpoint. */
function tipBox(op, part) {
  const box = transformedSize(op, part), off = pivotOffset(op, part);
  return [[0, box.height / 2], [box.width, box.height / 2], [box.width / 2, 0], [box.width / 2, box.height]]
    .map(([x, y]) => ({ x, y })).reduce((a, b) => Math.hypot(b.x - off.x, b.y - off.y) > Math.hypot(a.x - off.x, a.y - off.y) + 1e-9 ? b : a);
}

// ---- Rig structure ------------------------------------------------------------------------------------------------

/** Bones in tree order (every parent before its children). */
function ordered(p) {
  const bones = p.bones || [], out = [], visit = parent => { for (const b of bones) if (b.parent === parent) { out.push(b); visit(b.id); } };
  visit(null);
  return out;
}
/** The bone of a placed instance, or null. */
export function boneOf(project, layerId, instanceId) {
  return (project.bones || []).find(b => b.layerId === layerId && b.instanceId === instanceId) || null;
}
/** Ids of a bone and everything below it (tree order). */
export function subtree(p, boneId) {
  const ids = new Set([boneId]);
  for (const b of ordered(p)) if (b.parent && ids.has(b.parent)) ids.add(b.id);
  return ids;
}
/** Instances carried along with an instance (its descendants), as [{layerId, instanceId}]. */
export function boneDescendants(project, layerId, instanceId) {
  const bone = boneOf(project, layerId, instanceId);
  if (!bone) return [];
  const ids = subtree(project, bone.id);
  return (project.bones || []).filter(b => b.id !== bone.id && ids.has(b.id)).map(b => ({ layerId: b.layerId, instanceId: b.instanceId }));
}
/** The root above a bone. */
export function rootOf(project, boneId) {
  let bone = boneById(project, boneId);
  while (bone.parent) bone = boneById(project, bone.parent);
  return bone;
}

// ---- Frame poses --------------------------------------------------------------------------------------------------

/** Bones placed in `frame` (tree order) → {bone, op, part, parent}; a bone whose parent is missing here acts as a root. */
export function placed(p, frame) {
  const map = new Map();
  for (const bone of ordered(p)) {
    const op = opIn(frame, bone.layerId, bone.instanceId);
    if (!op) continue;
    const parent = bone.parent && map.get(bone.parent);
    map.set(bone.id, { bone, op, part: partOf(p, op), parent: parent || null });
  }
  return map;
}
/** Relative angle of every placed bone (absolute for a frame root). */
export function relPose(p, frame) {
  return new Map([...placed(p, frame)].map(([id, s]) => [id, s.parent ? normalizeAngle(absOf(s.op) - absOf(s.parent.op)) : absOf(s.op)]));
}
function setAngle(op, angle) {
  const a = normalizeAngle(roundInt(angle));
  if (a) op.angle = a; else delete op.angle;
}
/**
 * Write a frame pose: each bone's absolute angle = parent's + relative angle (`rels`, otherwise its current one) and
 * its position puts its pivot on the parent's anchor. `roots` optionally moves frame roots ({id: {x,y}} pivot points).
 */
export function layoutFrame(p, frame, rels = new Map(), roots = {}) {
  const map = placed(p, frame), current = relPose(p, frame), locked = new Set(p.layers.filter(l => l.locked).map(l => l.id));
  for (const [id, s] of map) {
    const before = { x: s.op.x, y: s.op.y, angle: absOf(s.op) }, rel = rels.has(id) ? rels.get(id) : current.get(id);
    setAngle(s.op, s.parent ? absOf(s.parent.op) + rel : rel);
    const goal = s.parent ? anchorWorld(s.parent.op, s.parent.part, s.bone.anchor) : roots[id];
    // A child's drawn joint (deform included) sits on the anchor; roots place their pivot.
    if (goal) { const j = s.parent ? jointWorld(s.op, s.part) : instancePivot(s.op, s.part), off = { x: j.x - s.op.x, y: j.y - s.op.y }; s.op.x = roundInt(goal.x - off.x); s.op.y = roundInt(goal.y - off.y); }
    if ((s.op.locked || locked.has(s.bone.layerId)) && (before.x !== s.op.x || before.y !== s.op.y || before.angle !== absOf(s.op))) throw new Error('Unlock the rigged objects first.');
  }
}
const clampLimit = (v, limit) => limit ? Math.max(limit.min, Math.min(limit.max, v)) : v;
const snap = (v, step) => step > 1 ? Math.round(v / step) * step : v;

/**
 * Canvas view of the rig in one frame (for overlays and hit-testing): per placed bone its joint (pivot), the parent
 * joint, the anchor point on the parent, the tip of the part and whether it is a root/leaf.
 */
export function rigView(project, animationId, frameId) {
  const animation = project.animations.find(a => a.id === animationId), frame = animation?.frames.find(f => f.id === frameId);
  if (!frame || !project.bones?.length) return [];
  const map = placed(project, frame), parents = new Set(project.bones.map(b => b.parent).filter(Boolean));
  return [...map.values()].map(({ bone, op, part, parent }) => ({
    bone, layerId: bone.layerId, instanceId: bone.instanceId, root: !parent, leaf: !parents.has(bone.id), angle: absOf(op),
    joint: jointWorld(op, part), parentJoint: parent ? jointWorld(parent.op, parent.part) : null,
    anchor: parent ? anchorWorld(parent.op, parent.part, bone.anchor) : null, tip: boxToWorld(op, part, tipBox(op, part)),
  }));
}

// ---- Rigging ------------------------------------------------------------------------------------------------------

const slug = text => String(text || 'bone').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bone';
function newBone(p, layerId, instanceId, op) {
  const ids = new Set((p.bones || []).map(b => b.id)), base = slug(op.id);
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  return { id, name: (op.name || op.partId).slice(0, 60), layerId, instanceId, parent: null };
}
/** Nearest opaque canvas pixel of a placed instance to `point` (its centre), or null. */
function nearestPixel(op, image, point) {
  const box = instanceBox(op, image);
  let best = null, bestD = Infinity;
  for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
    if (instancePixel(op, image, { x, y }) < 0) continue;
    const d = Math.hypot(x + .5 - point.x, y + .5 - point.y);
    if (d < bestD) { bestD = d; best = { x: x + .5, y: y + .5 }; }
  }
  return best;
}

/**
 * Join `child` ({layerId, instanceId}) to `parent` at canvas `point` as shown in `frameId`: the point snaps to the
 * nearest pixel of the child, which becomes the child's pivot in every frame (art kept in place), and the matching
 * point on the parent becomes the anchor. The parent becomes a root bone if it is not rigged yet. The child's subtree is
 * then laid out in every frame placing both. Returns { project, boneId, parentId }.
 */
export function attachBone(project, { animationId, frameId, child, parent, point, name }) {
  const p = validateProject(project), frame = frameOf(animationOf(p, animationId), frameId);
  if (child.layerId === parent.layerId && child.instanceId === parent.instanceId) throw new Error('Pick two different parts.');
  const childOp = opIn(frame, child.layerId, child.instanceId), parentOp = opIn(frame, parent.layerId, parent.instanceId);
  if (!childOp || !parentOp) throw new Error('Both parts must appear in this frame.');
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw new Error('Click where the parts join.');
  if (p.layers.some(l => l.locked && (l.id === child.layerId || l.id === parent.layerId)) || childOp.locked) throw new Error('Unlock both parts first.');
  const childPart = partOf(p, childOp), image = renderParts([childPart]).get(childPart.id);
  const at = nearestPixel(childOp, image, point);
  if (!at) throw new Error('This part has no pixels to join.');
  const pivot = pivotUnder(childOp, childPart, at);
  for (const animation of p.animations) for (const f of animation.frames) {
    const op = opIn(f, child.layerId, child.instanceId);
    if (op && op.partId === childOp.partId) Object.assign(op, withPivot(op, childPart, pivot));
  }
  p.bones ||= [];
  let parentBone = boneOf(p, parent.layerId, parent.instanceId), childBone = boneOf(p, child.layerId, child.instanceId);
  if (childBone && parentBone && subtree(p, childBone.id).has(parentBone.id)) throw new Error('That would make a loop: the parent hangs below this part.');
  if (!parentBone) { parentBone = newBone(p, parent.layerId, parent.instanceId, parentOp); if (absOf(parentOp)) parentBone.rest = absOf(parentOp); p.bones.push(parentBone); }
  if (!childBone) { childBone = newBone(p, child.layerId, child.instanceId, childOp); p.bones.push(childBone); }
  const joint = jointWorld(childOp, childPart), parentPart = partOf(p, parentOp), anchor = boxToPart(parentOp, parentPart, worldToBox(parentOp, parentPart, joint));
  const rest = normalizeAngle(absOf(childOp) - absOf(parentOp));
  Object.assign(childBone, { parent: parentBone.id, anchor: { x: Math.round(anchor.x * 1000) / 1000, y: Math.round(anchor.y * 1000) / 1000 } });
  if (rest) childBone.rest = rest; else delete childBone.rest;
  if (name) childBone.name = String(name).slice(0, 60);
  for (const animation of p.animations) for (const f of animation.frames) if (opIn(f, child.layerId, child.instanceId) && opIn(f, parent.layerId, parent.instanceId)) layoutFrame(p, f);
  return { project: validateProject(p), boneId: childBone.id, parentId: parentBone.id };
}
/** Remove a bone; its children become roots (roots left without children disappear). */
export function removeBone(project, boneId) {
  const p = validateProject(project);
  boneById(p, boneId);
  p.bones = p.bones.filter(b => b.id !== boneId).map(b => b.parent === boneId ? (({ anchor, ...rest }) => ({ ...rest, parent: null }))(b) : b);
  return validateProject(p);
}
/** Rename a bone (shown in the rig list; L/R names pair bones for mirrorPose). */
export function renameBone(project, boneId, name) {
  const p = validateProject(project), text = String(name ?? '').trim().slice(0, 60);
  if (!text) throw new Error('Give the bone a name.');
  boneById(p, boneId).name = text;
  return validateProject(p);
}
/** Limit a bone's angle relative to its parent (a root: its own angle); null clears. */
export function setBoneLimit(project, boneId, limit) {
  const p = validateProject(project), bone = boneById(p, boneId);
  if (limit) bone.limit = { min: limit.min, max: limit.max }; else delete bone.limit;
  return validateProject(p);
}
/** Remember the frame's pose as the rest pose (resetPose returns to it). */
export function setRestPose(project, { animationId, frameId }) {
  const p = validateProject(project), rels = relPose(p, frameOf(animationOf(p, animationId), frameId));
  for (const bone of p.bones || []) if (rels.has(bone.id)) { const r = rels.get(bone.id); if (r) bone.rest = r; else delete bone.rest; }
  return validateProject(p);
}

// ---- Posing -------------------------------------------------------------------------------------------------------

/** Pose each chosen frame with `change(rels, map, frame)` (mutating the relative angles), then lay it out. */
function posing(project, opts, change) {
  const p = validateProject(project), animation = animationOf(p, opts.animationId);
  if (!p.bones?.length) throw new Error('Rig the parts first.');
  for (const frame of framesOf(animation, opts)) {
    const map = placed(p, frame), rels = relPose(p, frame), roots = {};
    change(rels, map, frame, roots);
    layoutFrame(p, frame, rels, roots);
  }
  return validateProject(p);
}
/**
 * Forward kinematics: turn a bone about its joint by `delta` degrees (or to absolute `angle`), clamped to its limit and
 * snapped to `step` degrees; everything below follows. Returns { project }.
 */
export function rotateBone(project, { boneId, delta, angle, step, ...opts }) {
  boneById(project, boneId);
  return { project: posing(project, opts, (rels, map) => {
    const s = map.get(boneId);
    if (!s) return;
    const now = rels.get(boneId), parentAbs = s.parent ? absOf(s.parent.op) : 0;
    const goal = angle !== undefined ? normalizeAngle(angle - parentAbs) : now + delta;
    rels.set(boneId, clampLimit(snap(normalizeAngle(roundInt(goal)), step), s.bone.limit));
  }) };
}
/** Move a bone's whole skeleton (its root) by whole pixels dx, dy. Returns { project }. */
export function moveSkeleton(project, { boneId, dx, dy, ...opts }) {
  if (!Number.isInteger(dx) || !Number.isInteger(dy)) throw new Error('Skeletons move by whole pixels.');
  const root = rootOf(project, boneId);
  return { project: posing(project, opts, (rels, map, frame, roots) => {
    const s = map.get(root.id);
    if (s) { const c = instancePivot(s.op, s.part); roots[root.id] = { x: c.x + dx, y: c.y + dy }; }
  }) };
}
/** The chain from `endBoneId` upward: `chainLength` bones, up to `rootBoneId`, or up to (not including) the root. */
function chainOf(p, endBoneId, chainLength, rootBoneId) {
  const chain = [boneById(p, endBoneId)];
  while (chain[0].parent && (chainLength ? chain.length < chainLength : chain[0].id !== rootBoneId)) {
    const up = boneById(p, chain[0].parent);
    if (!chainLength && !rootBoneId && !up.parent) break;
    chain.unshift(up);
  }
  return chain;
}
/**
 * Inverse kinematics: turn the bones of a chain ending at `endBoneId` (see chainOf) so the grabbed point — canvas
 * `grab` in the first chosen frame, default the end part's tip — reaches canvas `target`. The chain's top joint stays
 * pinned; limits are honoured and relative angles snap to `step`. Returns { project, reached }.
 */
export function ikChain(project, { endBoneId, chainLength, rootBoneId, target, grab, step, ...opts }) {
  if (!Number.isFinite(target?.x) || !Number.isFinite(target?.y)) throw new Error('Drag to an IK target.');
  const chain = chainOf(validateProject(project), endBoneId, chainLength, rootBoneId), end = chain.at(-1);
  if (chain.length === 1 && !end.parent && !chainLength) throw new Error('Drag a limb, not the root, to solve IK.');
  let grabBox = null, reached = true;
  const out = posing(project, opts, (rels, map) => {
    const states = chain.map(b => map.get(b.id));
    if (states.some(s => !s)) return;
    const e = states.at(-1);
    grabBox ||= grab ? worldToBox(e.op, e.part, grab) : tipBox(e.op, e.part);
    const points = [...states.map(s => instancePivot(s.op, s.part)), boxToWorld(e.op, e.part, grabBox)];
    const limits = states.map(s => s.bone.limit ? { min: s.bone.limit.min - rels.get(s.bone.id), max: s.bone.limit.max - rels.get(s.bone.id) } : null);
    const solved = solveChain(points, target, { limits });
    reached &&= solved.reached;
    states.forEach((s, i) => rels.set(s.bone.id, clampLimit(snap(normalizeAngle(roundInt(rels.get(s.bone.id) + solved.deltas[i])), step), s.bone.limit)));
  });
  return { project: out, reached };
}
/** A frame's pose to paste elsewhere: { bones: {id: relative angle} }. */
export function copyPose(project, { animationId, frameId }) {
  return { bones: Object.fromEntries(relPose(project, frameOf(animationOf(project, animationId), frameId))) };
}
/** Apply a copied pose's angles (positions of roots stay). Returns { project }. */
export function pastePose(project, { pose, ...opts }) {
  if (!pose?.bones) throw new Error('Copy a pose first.');
  return { project: posing(project, opts, rels => { for (const [id, r] of Object.entries(pose.bones)) if (rels.has(id) && Number.isFinite(r)) rels.set(id, r); }) };
}
/** Return each bone to its rest angle (roots keep their place). Returns { project }. */
export function resetPose(project, opts) {
  return { project: posing(project, opts, (rels, map) => { for (const [id, s] of map) rels.set(id, s.bone.rest || 0); }) };
}
const SIDE = /(^|[^a-z])(left|right|l|r)(?=[^a-z]|$)/i;
/** Name with its side word blanked, and the side ('l'/'r'), for pairing left/right bones. */
function sideOf(name) {
  const m = String(name || '').match(SIDE);
  return m ? { key: name.toLowerCase().replace(SIDE, '$1#'), side: m[2][0].toLowerCase() } : null;
}
/** Left/right bone pairs [leftId, rightId], paired by name ("arm L"/"arm R", "left leg"/"right leg"). */
export function sidePairs(project) {
  const pairs = [], bones = project.bones || [];
  for (const a of bones) {
    const sa = sideOf(a.name ?? a.id);
    if (!sa || sa.side !== 'l') continue;
    const b = bones.find(x => { const sb = sideOf(x.name ?? x.id); return sb && sb.side === 'r' && sb.key === sa.key; });
    if (b) pairs.push([a.id, b.id]);
  }
  return pairs;
}
/**
 * Mirror a pose left-right: left/right bone pairs (paired by name: "arm L"/"arm R", "left leg"/"right leg") swap angles
 * and every angle is negated, so a front-facing figure's pose flips. `swap: true` only exchanges the pairs (side views:
 * the other step of a walk). Returns { project, pairs }.
 */
export function mirrorPose(project, { swap = false, ...opts }) {
  const p = validateProject(project), pairs = sidePairs(p);
  if (swap && !pairs.length) throw new Error('Name bones with L/R or left/right to swap them.');
  return { project: posing(p, opts, rels => {
    for (const [a, b] of pairs) if (rels.has(a) && rels.has(b)) { const t = rels.get(a); rels.set(a, rels.get(b)); rels.set(b, t); }
    if (!swap) for (const [id, r] of rels) rels.set(id, normalizeAngle(-r));
  }), pairs };
}

/**
 * Key poses → in-betweens. Insert `insert` copies of the from-frame after it, then pose every frame strictly between
 * `fromFrameId` and `toFrameId`: each bone's relative angle turns the short way and each root's pivot moves in a straight
 * line, eased by `easing` at t = steps / key distance. Other objects keep their frames. Returns { project, frameIds, inserted }.
 */
export function tweenPoses(project, { animationId, fromFrameId, toFrameId, insert = 0, easing = 'linear' }) {
  if (!Number.isInteger(insert) || insert < 0 || insert > 64) throw new Error('Insert 0 to 64 in-betweens.');
  ease(easing, 0);
  const p = validateProject(project), animation = animationOf(p, animationId);
  if (!p.bones?.length) throw new Error('Rig the parts first.');
  let i = animation.frames.findIndex(f => f.id === fromFrameId), j = animation.frames.findIndex(f => f.id === toFrameId);
  if (i < 0 || j < 0) throw new Error('Choose two key frames in this animation.');
  if (i >= j) throw new Error('The first key frame must come before the second.');
  const from = animation.frames[i], to = animation.frames[j];
  const inserted = Array.from({ length: insert }, () => ({ ...makeLayeredFrame(p, from), duration: from.duration }));
  animation.frames.splice(i + 1, 0, ...inserted);
  j += insert;
  if (j - i < 2) throw new Error('There are no frames between these key frames. Insert some in-betweens.');
  const A = placed(p, from), B = placed(p, to), relA = relPose(p, from), relB = relPose(p, to), frameIds = [];
  for (let k = i + 1; k < j; k++) {
    const frame = animation.frames[k], e = ease(easing, (k - i) / (j - i)), map = placed(p, frame), rels = relPose(p, frame), roots = {};
    for (const [id, s] of map) {
      if (!relA.has(id) || !relB.has(id)) continue;
      rels.set(id, relA.get(id) + angleDelta(relA.get(id), relB.get(id)) * e);
      if (!s.parent) {
        const a = instancePivot(A.get(id).op, A.get(id).part), b = instancePivot(B.get(id).op, B.get(id).part);
        roots[id] = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
      }
    }
    layoutFrame(p, frame, rels, roots);
    frameIds.push(frame.id);
  }
  return { project: validateProject(p), frameIds, inserted: inserted.map(f => f.id) };
}
