import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateProject, blankProject } from '../src/domain/project.js';
import { instancePivot } from '../src/domain/geometry.js';
import { solveChain, normalizeAngle } from '../src/domain/motion.js';
import { tweenToPose } from '../src/domain/animate.js';
import { translateObject, translateObjects, rotateObjects } from '../src/domain/objects.js';
import {
  attachBone, removeBone, renameBone, setBoneLimit, setRestPose, rotateBone, moveSkeleton, ikChain, copyPose, pastePose,
  resetPose, mirrorPose, tweenPoses, rigView, anchorWorld, boneDescendants,
} from '../src/domain/skeleton.js';
import { encodePXA2, decodePXA2 } from '../src/formats/pxa-v2.js';
import { copyObject, copyObjects, pasteObject } from '../src/domain/object-clipboard.js';
import { savePose, applyPose } from '../src/domain/poses.js';

/** 64×64, layer L, frames f0..; body 4×8 at (20,10), upper arm 2×6 at (24,10), lower arm 2×6 at (24,16). */
function scene(n = 1, extra = []) {
  const p = blankProject('rig', 64, 64);
  p.version = 3;
  p.parts = [
    { id: 'body', width: 4, height: 8, ops: [{ type: 'rect', x: 0, y: 0, width: 4, height: 8, color: 2 }] },
    { id: 'limb', width: 2, height: 6, ops: [{ type: 'rect', x: 0, y: 0, width: 2, height: 6, color: 3 }] },
  ];
  p.animations[0].id = 'A'; p.layers[0].id = 'L';
  const ops = () => [
    { type: 'use', id: 'body', partId: 'body', x: 20, y: 10, transform: 'N' },
    { type: 'use', id: 'up', partId: 'limb', x: 24, y: 10, transform: 'N' },
    { type: 'use', id: 'low', partId: 'limb', x: 24, y: 16, transform: 'N' },
    ...extra.map(o => ({ ...o })),
  ];
  p.animations[0].frames = Array.from({ length: n }, (_, k) => ({ id: `f${k}`, duration: 100, cels: [{ layerId: 'L', pixels: Array(64 * 64).fill(-1), source: { ops: ops(), overrides: [] } }] }));
  return validateProject(p);
}
const at = { animationId: 'A', frameId: 'f0' };
const ref = id => ({ layerId: 'L', instanceId: id });
const op = (p, id, k = 0) => p.animations[0].frames[k].cels[0].source.ops.find(o => o.id === id);
const pivot = (p, id, k = 0) => instancePivot(op(p, id, k), p.parts.find(x => x.id === op(p, id, k).partId));
/** Rig body → up → low with joints at the top-left pixel of each arm. */
function rigged(n = 1, extra) {
  let p = attachBone(scene(n, extra), { ...at, child: ref('up'), parent: ref('body'), point: { x: 24.5, y: 10.5 } }).project;
  p = attachBone(p, { ...at, child: ref('low'), parent: ref('up'), point: { x: 24.6, y: 16.2 } }).project;
  return p;
}
/** Distance from each child's joint to its anchor on the parent. */
function jointGaps(p, k = 0) {
  return rigView(p, 'A', `f${k}`).filter(v => v.anchor).map(v => Math.hypot(v.joint.x - v.anchor.x, v.joint.y - v.anchor.y));
}

test('attachBone builds a tree: the click snaps to the child, becomes its pivot, and the parent becomes a root', () => {
  const p = rigged();
  assert.deepEqual(p.bones.map(b => [b.id, b.parent]), [['body', null], ['up', 'body'], ['low', 'up']]);
  assert.deepEqual(op(p, 'up').pivot, { x: 0, y: 0 });
  assert.deepEqual(op(p, 'low').pivot, { x: 0, y: 0 });
  assert.deepEqual(p.bones[1].anchor, { x: 4.5, y: 0.5 });
  assert.deepEqual([op(p, 'up').x, op(p, 'up').y, op(p, 'low').x, op(p, 'low').y], [24, 10, 24, 16]);
  assert.deepEqual(boneDescendants(p, 'L', 'body'), [ref('up'), ref('low')]);
  assert.throws(() => attachBone(p, { ...at, child: ref('body'), parent: ref('low'), point: { x: 21, y: 11 } }), /loop/);
  const outside = attachBone(scene(), { ...at, child: ref('low'), parent: ref('body'), point: { x: 40, y: 18 } }).project;
  assert.deepEqual(op(outside, 'low').pivot, { x: 1, y: 1 }, 'a click off the part snaps to its nearest pixel');
});

test('validation keeps bones with the project and prunes what no longer fits', () => {
  const p = rigged(), copy = structuredClone(p);
  assert.deepEqual(validateProject(copy).bones, p.bones);
  copy.animations[0].frames[0].cels[0].source.ops = copy.animations[0].frames[0].cels[0].source.ops.filter(o => o.id !== 'low');
  assert.deepEqual(validateProject(copy).bones.map(b => b.id), ['body', 'up'], 'a bone without its instance is dropped');
  copy.bones[1].parent = 'missing';
  assert.equal(validateProject(copy).bones, undefined, 'orphans become roots and lone roots disappear');
  const loop = structuredClone(p);
  loop.bones[0] = { ...loop.bones[0], parent: 'low', anchor: { x: 1, y: 1 } };
  assert.ok(validateProject(loop).bones.some(b => !b.parent), 'a cycle is broken into a root');
  assert.throws(() => validateProject({ ...p, bones: [{ ...p.bones[0] }, { ...p.bones[0] }] }), /Duplicate bone/);
  assert.equal(validateProject(removeBone(p, 'up')).bones, undefined);
  assert.equal(renameBone(p, 'up', 'arm L').bones[1].name, 'arm L');
});

test('forward kinematics turns a bone about its joint, children follow, and turning back restores the pose exactly', () => {
  const p = rigged();
  let q = rotateBone(p, { ...at, boneId: 'up', delta: 90 }).project;
  assert.equal(op(q, 'up').angle, 90);
  assert.equal(op(q, 'low').angle, 90, 'the child keeps its relative angle');
  assert.deepEqual(pivot(q, 'up'), pivot(p, 'up'), 'the joint stays put');
  const elbow = pivot(q, 'low');
  assert.ok(Math.hypot(elbow.x - 18.5, elbow.y - 10.5) <= .75, `elbow swung round the shoulder (${elbow.x},${elbow.y})`);
  assert.ok(jointGaps(q).every(g => g <= .75));
  for (const d of [37, -113, 64, 11, -5, 170]) q = rotateBone(q, { ...at, boneId: ['up', 'low', 'body'][Math.abs(d) % 3], delta: d }).project;
  for (const id of ['body', 'up', 'low']) q = rotateBone(q, { ...at, boneId: id, angle: 0 }).project;
  assert.deepEqual(q.animations, p.animations, 'no drift after many turns');
  q = rotateBone(setBoneLimit(p, 'low', { min: -30, max: 30 }), { ...at, boneId: 'low', delta: 90 }).project;
  assert.equal(op(q, 'low').angle, 30, 'limits clamp the relative angle');
  assert.equal(op(rotateBone(p, { ...at, boneId: 'up', delta: 7, step: 15 }).project, 'up').angle, undefined, 'step snapping');
});

test('moving a root carries the skeleton: moveSkeleton, translateObject(s), rotateObjects and animated moves', () => {
  const p = rigged(2), moved = moveSkeleton(p, { ...at, boneId: 'low', dx: 3, dy: -2 }).project;
  assert.deepEqual(['body', 'up', 'low'].map(id => [op(moved, id).x, op(moved, id).y]), [[23, 8], [27, 8], [27, 14]]);
  const t = translateObject(p, { animationId: 'A', frameId: 'f0', layerId: 'L' }, 'body', 5, 1, 'frame');
  assert.deepEqual(['body', 'up', 'low'].map(id => [op(t, id).x, op(t, id).y]), [[25, 11], [29, 11], [29, 17]]);
  assert.deepEqual([op(t, 'low', 1).x, op(t, 'low', 1).y], [24, 16], 'frame scope leaves other frames');
  const both = translateObjects(p, { animationId: 'A', frameId: 'f0' }, [{ layerId: 'L', key: 'body' }, { layerId: 'L', key: 'up' }], 1, 0, 'animation').project;
  assert.deepEqual(['body', 'up', 'low'].map(id => op(both, id, 1).x), [21, 25, 25], 'a selected child is not moved twice');
  const turned = rotateObjects(p, { animationId: 'A', frameId: 'f0', layerId: 'L' }, [{ layerId: 'L', key: 'body' }], 90, 'frame');
  assert.equal(op(turned, 'up').angle, 90);
  assert.ok(jointGaps(turned).every(g => g <= .75), 'children stay on their joints when the root turns');
  const tween = tweenToPose(p, { animationId: 'A', layerId: 'L', instanceId: 'body', fromFrameId: 'f0', endPose: { x: 30, angle: 20 }, frames: 4 });
  const end = tween.project.animations[0].frames.findIndex(f => f.id === tween.endFrameId);
  assert.equal(op(tween.project, 'up', end).angle, 20);
  assert.ok([1, 2, end].every(k => jointGaps(tween.project, k).every(g => g <= .75)), 'in-betweens carry the limbs');
});

test('solveChain reaches targets with any number of joints, pins the base and honours limits', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
  const out = solveChain(pts, { x: 10, y: 20 });
  assert.ok(out.reached);
  assert.deepEqual(out.points[0], { x: 0, y: 0 });
  assert.ok(Math.hypot(out.points[3].x - 10, out.points[3].y - 20) <= .25);
  const far = solveChain(pts, { x: 0, y: 100 });
  assert.equal(far.reached, false);
  assert.ok(Math.abs(far.points[3].x) < 1 && far.points[3].y > 29, 'unreachable targets stretch toward the target');
  const held = solveChain(pts, { x: 0, y: 30 }, { limits: [{ min: -10, max: 10 }, null, null] });
  assert.ok(held.deltas[0] >= -10 - 1e-9 && held.deltas[0] <= 10 + 1e-9);
});

test('ikChain bends the chain so the hand reaches the target with the shoulder pinned', () => {
  const p = rigged(), target = { x: 30, y: 15 };
  const { project: q, reached } = ikChain(p, { ...at, endBoneId: 'low', target });
  assert.ok(reached);
  const v = rigView(q, 'A', 'f0').find(x => x.bone.id === 'low');
  assert.ok(Math.hypot(v.tip.x - target.x, v.tip.y - target.y) <= 1.5, `tip ${v.tip.x},${v.tip.y}`);
  assert.deepEqual(pivot(q, 'up'), pivot(p, 'up'));
  assert.equal(op(q, 'body').angle, undefined, 'the root is not turned by default');
  assert.ok(jointGaps(q).every(g => g <= .75));
  const grabbed = ikChain(p, { ...at, endBoneId: 'low', target: { x: 24, y: 23 }, grab: { x: 25, y: 19 }, chainLength: 1 }).project;
  assert.equal(op(grabbed, 'up').angle, undefined, 'chainLength 1 only turns the end bone');
  assert.ok(op(grabbed, 'low').angle > 0);
  const limited = ikChain(setBoneLimit(p, 'up', { min: -20, max: 20 }), { ...at, endBoneId: 'low', target: { x: 10, y: 10 } }).project;
  assert.ok(Math.abs(op(limited, 'up').angle || 0) <= 20);
});

test('poses copy, paste, mirror by L/R names and reset to rest', () => {
  let p = attachBone(rigged(2, [{ type: 'use', id: 'arm2', partId: 'limb', x: 18, y: 10, transform: 'N' }]), { ...at, child: ref('arm2'), parent: ref('body'), point: { x: 18.5, y: 10.5 } });
  p = renameBone(renameBone(p.project, 'up', 'arm L'), 'arm2', 'arm R');
  const posed = rotateBone(p, { ...at, boneId: 'up', delta: 45 }).project;
  const pose = copyPose(posed, at);
  assert.equal(pose.bones.up, 45);
  const pasted = pastePose(posed, { animationId: 'A', frameId: 'f1', pose }).project;
  assert.equal(op(pasted, 'up', 1).angle, 45);
  assert.equal(op(pasted, 'low', 1).angle, 45);
  const swapped = mirrorPose(posed, { ...at, swap: true });
  assert.deepEqual(swapped.pairs, [['up', 'arm2']]);
  assert.equal(op(swapped.project, 'arm2').angle, 45);
  assert.equal(op(swapped.project, 'up').angle, undefined);
  const mirrored = mirrorPose(rotateBone(posed, { ...at, boneId: 'low', delta: 20 }).project, at).project;
  assert.equal(op(mirrored, 'arm2').angle, -45, 'mirror reflects: the pair swaps and every angle flips sign');
  assert.equal(op(mirrored, 'low').angle, -20);
  assert.deepEqual(resetPose(posed, at).project.animations, p.animations);
  const rest = setRestPose(posed, at);
  assert.equal(op(resetPose(rotateBone(rest, { ...at, boneId: 'up', delta: 30 }).project, at).project, 'up').angle, 45);
});

test('tweenPoses inserts in-betweens that turn each bone the short way and move the root', () => {
  let p = rigged(2);
  p = rotateBone(p, { animationId: 'A', frameId: 'f0', boneId: 'up', angle: 170 }).project;
  p = rotateBone(p, { animationId: 'A', frameId: 'f1', boneId: 'up', angle: -150 }).project;
  p = rotateBone(p, { animationId: 'A', frameId: 'f1', boneId: 'low', delta: 60 }).project;
  p = moveSkeleton(p, { animationId: 'A', frameId: 'f1', boneId: 'body', dx: 8, dy: 0 }).project;
  const { project: q, frameIds, inserted } = tweenPoses(p, { animationId: 'A', fromFrameId: 'f0', toFrameId: 'f1', insert: 3 });
  assert.equal(q.animations[0].frames.length, 5);
  assert.deepEqual(frameIds, inserted);
  assert.deepEqual([1, 2, 3].map(k => op(q, 'up', k).angle), [180, -170, -160], 'short way across ±180');
  assert.deepEqual([1, 2, 3].map(k => normalizeAngle(op(q, 'low', k).angle - op(q, 'up', k).angle)), [15, 30, 45], 'relative angles tween');
  assert.deepEqual([1, 2, 3].map(k => op(q, 'body', k).x), [22, 24, 26]);
  assert.ok([1, 2, 3].every(k => jointGaps(q, k).every(g => g <= .75)));
  assert.throws(() => tweenPoses(p, { animationId: 'A', fromFrameId: 'f1', toFrameId: 'f0' }), /before/);
});

test('PXA2 BONE lines round-trip, and a missing JOINT comes from the child pivot', () => {
  const p = setBoneLimit(renameBone(rigged(), 'up', 'arm "L"'), 'low', { min: -90, max: 5 }), text = encodePXA2(p);
  assert.match(text, /BONE up L up PARENT body JOINT 4.5 0.5 NAME "arm \\"L\\""/);
  assert.match(text, /BONE low L low PARENT up JOINT 0.5 6.5 LIMIT -90 5/);
  assert.deepEqual(decodePXA2(text).bones, p.bones);
  const bare = text.replace(/ JOINT [\d.]+ [\d.]+/g, '');
  assert.deepEqual(decodePXA2(bare).bones.map(b => b.anchor), p.bones.map(b => b.anchor));
  assert.throws(() => decodePXA2(text.replace('PARENT body', 'PARENT body WOBBLE')), /Unknown BONE option/);
  const v = rigView(p, 'A', 'f0'), low = v.find(x => x.bone.id === 'low');
  assert.ok(low.leaf && !low.root && v[0].root);
  assert.deepEqual(anchorWorld(op(p, 'up'), p.parts[1], p.bones[2].anchor), { x: 24.5, y: 16.5 });
});

test('the Stick puppet sample loads rigged, with its key poses laid out on the joints', async () => {
  const p = decodePXA2(await readFile(new URL('../public/samples/puppet.pxa', import.meta.url), 'utf8'));
  assert.equal(p.bones.length, 10);
  assert.deepEqual(p.bones.filter(b => !b.parent).map(b => b.name), ['torso']);
  for (const animation of p.animations) for (const frame of animation.frames) {
    for (const v of rigView(p, animation.id, frame.id)) if (v.anchor) assert.ok(Math.hypot(v.joint.x - v.anchor.x, v.joint.y - v.anchor.y) <= .75);
  }
});

test('joints follow a part’s skew and 3D turn', () => {
  const base = rigged(), p = structuredClone(base);
  Object.assign(op(p, 'up'), { skew: { x: 20, y: 0 }, tilt: { x: 40, y: 0 } });
  const posed = validateProject(p), anchor = q => rigView(q, 'A', 'f0').find(v => v.bone.id === 'low').anchor;
  const plain = anchor(base), bent = anchor(posed);
  assert.ok(Math.abs(bent.x - plain.x) > 1 && plain.y - bent.y > .5, `the elbow moves with the shear and the turn: ${JSON.stringify([plain, bent])}`);
  for (const delta of [35, -50]) assert.ok(jointGaps(rotateBone(posed, { ...at, boneId: 'up', delta }).project).every(g => g <= .75));
  assert.ok(jointGaps(moveSkeleton(posed, { ...at, boneId: 'body', dx: 3, dy: 2 }).project).every(g => g <= .75));
});

test('joints follow a part’s wave, bulge and twist deform', () => {
  const base = rigged(), anchor = q => rigView(q, 'A', 'f0').find(v => v.bone.id === 'low').anchor;
  const deformed = deform => { const p = structuredClone(base); op(p, 'up').deform = deform; return validateProject(p); };
  // A wave shifting the upper arm's last row 2px left carries the elbow with it.
  const waved = deformed({ kind: 'wave', axis: 'x', amplitude: 2, wavelength: 12, phase: 90 });
  assert.ok(Math.abs(anchor(waved).x - anchor(base).x + 2) < 1e-9 && anchor(waved).y === anchor(base).y, JSON.stringify([anchor(base), anchor(waved)]));
  for (const deform of [{ kind: 'wave', axis: 'x', amplitude: 2, wavelength: 12, phase: 90 }, { kind: 'twist', angle: 90 }, { kind: 'bulge', strength: 80 }]) {
    const p = deformed(deform);
    for (const delta of [0, 35, -50]) assert.ok(jointGaps(rotateBone(p, { ...at, boneId: 'up', delta }).project).every(g => g <= .75), JSON.stringify(deform));
  }
  // A child's own deform moves its drawn pivot pixel; layout puts that pixel (the joint) on the anchor.
  const own = structuredClone(base);
  op(own, 'low').deform = { kind: 'wave', axis: 'x', amplitude: 2, wavelength: 12, phase: 90 };
  const laid = rotateBone(validateProject(own), { ...at, boneId: 'up', delta: 0 }).project, view = rigView(laid, 'A', 'f0').find(v => v.bone.id === 'low');
  assert.equal(op(laid, 'low').x, 22);
  assert.ok(Math.hypot(view.joint.x - view.anchor.x, view.joint.y - view.anchor.y) <= .75);
});

test('copying rigged parts copies their bones: duplicate, partial copies, groups, other animations and projects', () => {
  const p = setBoneLimit(renameBone(rigged(), 'up', 'arm L'), 'low', { min: -90, max: 10 }), all = ['body', 'up', 'low'].map(id => ({ layerId: 'L', key: id }));
  const clip = copyObjects(p, { ...at, layerId: 'L' }, all);
  assert.equal(clip.bones.length, 3);
  // Duplicate (Ctrl+D): the copies, 2px down-right, get their own skeleton with the same joints and limits.
  const dup = pasteObject(p, { ...at, layerId: 'L' }, clip, { offset: 2, fill: false }).project, copies = dup.bones.slice(3);
  assert.deepEqual(copies.map(b => [b.id, b.name, b.instanceId, b.parent]), [['body-2', 'body 2', 'body', null], ['up-2', 'arm L 2', 'up', 'body-2'], ['low-2', 'limb 2', 'low', 'up-2']]);
  assert.ok(copies.every(b => b.layerId !== 'L'), 'each copy is a new object');
  const placedOp = (q, bone) => q.animations[0].frames[0].cels.find(c => c.layerId === bone.layerId).source.ops.find(o => o.id === bone.instanceId);
  assert.deepEqual([copies[1].anchor, copies[2].anchor, copies[2].limit], [p.bones[1].anchor, p.bones[2].anchor, { min: -90, max: 10 }]);
  assert.ok(jointGaps(dup).every(g => g <= .75));
  const turned = rotateBone(dup, { ...at, boneId: 'up-2', delta: 40 }).project;
  for (const id of ['body', 'up', 'low']) assert.deepEqual(op(turned, id), op(dup, id), 'posing the copy leaves the original alone');
  assert.equal(placedOp(turned, copies[1]).angle, 40);
  assert.equal(placedOp(dup, copies[0]).x, op(p, 'body').x + 2);
  assert.ok(jointGaps(turned).every(g => g <= .75));
  // A library pose saved on the original applies to the chosen copy by bone name (the copy number is ignored).
  const saved = savePose(rotateBone(dup, { ...at, boneId: 'up', delta: 30 }).project, { ...at, rootBoneId: 'body', name: 'wave' });
  const posedCopy = applyPose(dup, { ...at, pose: saved.project.poses[0], rootBoneId: 'body-2' }).project;
  assert.equal(placedOp(posedCopy, copies[1]).angle, 30);
  assert.equal(op(posedCopy, 'up').angle, undefined);
  // Inside a group the copies join it under fresh instance ids.
  const grouped = structuredClone(p); grouped.layers[0].group = true;
  const inGroup = pasteObject(validateProject(grouped), { ...at, layerId: 'L' }, clip, { offset: 2, fill: false }).project;
  assert.deepEqual(inGroup.bones.slice(3).map(b => [b.layerId, b.instanceId, b.parent]), [['L', 'body_2', null], ['L', 'up_2', 'body-2'], ['L', 'low_2', 'up-2']]);
  // A copied subtree whose parent stays behind gets its own root; a lone part brings no bones.
  const arm = pasteObject(p, { ...at, layerId: 'L' }, copyObjects(p, { ...at, layerId: 'L' }, all.slice(1)), { offset: 2, fill: false }).project;
  assert.deepEqual(arm.bones.slice(3).map(b => [b.id, b.parent, b.anchor]), [['up-2', null, undefined], ['low-2', 'up-2', p.bones[2].anchor]]);
  assert.equal(pasteObject(p, { ...at, layerId: 'L' }, copyObject(p, { ...at, layerId: 'L' }, 'low'), { offset: 2, fill: false }).project.bones.length, 3);
  // The whole group in another animation (Copy to animation): a new object with the same instance ids, bones mapped onto it.
  const two = structuredClone(p);
  two.animations.push({ id: 'B', name: 'Walk', fps: 8, frames: [{ id: 'g0', duration: 100, cels: [{ layerId: 'L', pixels: Array(64 * 64).fill(-1) }] }] });
  const group = copyObject(validateProject(two), { ...at, layerId: 'L' }, '@group');
  const moved = pasteObject(validateProject(two), { animationId: 'B', frameId: 'g0', layerId: 'L' }, group).project, layer = moved.layers.at(-1).id;
  assert.deepEqual(moved.bones.slice(3).map(b => [b.layerId, b.instanceId, b.parent]), [[layer, 'body', null], [layer, 'up', 'body-2'], [layer, 'low', 'up-2']]);
  assert.equal(rigView(moved, 'B', 'g0').length, 3);
  // Another project tab: the clipboard is plain JSON carrying the bones.
  const other = blankProject('other', 64, 64), pasted = pasteObject(other, { animationId: other.animations[0].id, frameId: other.animations[0].frames[0].id, layerId: other.layers[0].id }, JSON.parse(JSON.stringify(clip))).project;
  assert.deepEqual(pasted.bones.map(b => [b.id, b.name, b.parent]), [['body', 'body', null], ['up', 'arm L', 'body'], ['low', 'limb', 'up']]);
});
