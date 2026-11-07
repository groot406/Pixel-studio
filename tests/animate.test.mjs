import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProject, blankProject, compositeFrame, makeLayeredFrame } from '../src/domain/project.js';
import { instancePivot, instancePixel, withPivot } from '../src/domain/geometry.js';
import { renderParts } from '../src/domain/artwork.js';
import { poseOf, applyPose } from '../src/domain/motion.js';
import { tweenObject, autoSquashStretch, springFollow, ikLimb, waveAnimate, smearFrame, motionPath, tweenToPose, bounceInPlace, setPivotAt, limbJoints } from '../src/domain/animate.js';
import { encodeAIProject, decodeAIProject } from '../src/formats/pxa.js';
import { encodePixelProject, decodePixelProject } from '../src/formats/pxs.js';
import { copyObject, pasteObject } from '../src/domain/object-clipboard.js';

const T = { animationId: 'A', layerId: 'L' };
/** 48×48 project, frames f0..f(n-1), one layer L; `ops(k)` gives frame k's source ops. Parts: art 6×4, bone 9×1. */
function scene(n, ops) {
  const p = blankProject('anim', 48, 48);
  p.version = 3;
  p.parts = [
    { id: 'art', width: 6, height: 4, ops: [{ type: 'rect', x: 0, y: 0, width: 6, height: 4, color: 2 }, { type: 'span', x: 0, y: 0, values: [5, 6] }] },
    { id: 'bone', width: 9, height: 1, ops: [{ type: 'rect', x: 0, y: 0, width: 9, height: 1, color: 9 }] },
  ];
  const a = p.animations[0];
  a.id = 'A'; p.layers[0].id = 'L';
  a.frames = Array.from({ length: n }, (_, k) => ({ id: `f${k}`, duration: 100, cels: [{ layerId: 'L', pixels: Array(48 * 48).fill(-1), source: { ops: ops(k), overrides: [] } }] }));
  return validateProject(p);
}
const use = (pose, id = 'o', partId = 'art') => ({ type: 'use', id, partId, transform: 'N', ...pose });
const op = (p, k, id = 'o') => p.animations[0].frames[k].cels[0].source.ops.find(o => o.id === id);
const opaque = (p, k) => p.animations[0].frames[k].cels[0].pixels.filter(v => v >= 0).length;
const part = p => p.parts.find(x => x.id === 'art');

test('poseOf/applyPose convert between instances and flat poses, omitting defaults', () => {
  const p = scene(1, () => []), art = part(p);
  const inst = use({ x: 1, y: 2, angle: 30, skew: { x: 5, y: 0 }, deform: { kind: 'wave', axis: 'x', amplitude: 2, wavelength: 8, phase: 350 } });
  assert.deepEqual(poseOf(inst, art), { x: 1, y: 2, width: 6, height: 4, angle: 30, skewX: 5, skewY: 0, tiltX: 0, tiltY: 0, phase: 350 });
  const back = applyPose(inst, { width: 6, height: 4, angle: 0, skewX: 0, skewY: 0, phase: 370 }, art);
  assert.deepEqual(back, { type: 'use', id: 'o', partId: 'art', transform: 'N', x: 1, y: 2, deform: { ...inst.deform, phase: 10 } });
  assert.deepEqual(applyPose(use({ x: 0, y: 0, deform: { kind: 'twist', angle: 40 } }), { twist: 0, width: 8, height: 3 }, art), use({ x: 0, y: 0, width: 8, height: 3 }));
});

test('tweenObject fills in-betweens with eased position, angle, size, skew and wave phase', () => {
  const wave = phase => ({ kind: 'wave', axis: 'x', amplitude: 1, wavelength: 8, phase });
  const p = scene(5, k => (k === 0 ? [use({ x: 0, y: 10, deform: wave(330) })] : k === 4 ? [use({ x: 20, y: 10, angle: 40, width: 10, skew: { x: 20, y: 0 }, deform: wave(50) })] : k === 2 ? [] : [use({ x: 0, y: 0 })]));
  const { project, frameIds, inserted } = tweenObject(p, { ...T, instanceId: 'o', fromFrameId: 'f0', toFrameId: 'f4' });
  assert.deepEqual([frameIds, inserted], [['f1', 'f2', 'f3'], []]);
  assert.deepEqual([1, 2, 3].map(k => [op(project, k).x, op(project, k).angle, op(project, k).width, op(project, k).skew.x, op(project, k).deform.phase]),
    [[5, 10, 7, 5, 350], [10, 20, 8, 10, 10], [15, 30, 9, 15, 30]]);
  // The object was missing in f2 and is added; a raster in-between becomes retained too.
  assert.equal(project.animations[0].frames[2].cels[0].source.ops.length, 1);
  const eased = tweenObject(p, { ...T, instanceId: 'o', fromFrameId: 'f0', toFrameId: 'f4', easing: 'easeIn' }).project;
  assert.ok(op(eased, 1).x < 5 && op(eased, 3).x < 15);
  // Inserting in-betweens between adjacent keys.
  const two = scene(2, k => [use({ x: k * 12, y: 4 })]);
  const ins = tweenObject(two, { ...T, instanceId: 'o', fromFrameId: 'f0', toFrameId: 'f1', insert: 3 });
  assert.equal(ins.inserted.length, 3);
  assert.deepEqual(ins.project.animations[0].frames.map(f => f.id), ['f0', ...ins.inserted, 'f1']);
  assert.deepEqual([1, 2, 3].map(k => op(ins.project, k).x), [3, 6, 9]);
  assert.throws(() => tweenObject(two, { ...T, instanceId: 'o', fromFrameId: 'f0', toFrameId: 'f1' }), /no frames between/);
  assert.throws(() => tweenObject(two, { ...T, instanceId: 'o', fromFrameId: 'f1', toFrameId: 'f0', insert: 1 }), /before/);
  assert.throws(() => tweenObject(two, { ...T, instanceId: 'o', fromFrameId: 'f0', toFrameId: 'f1', insert: 1, easing: 'wobble' }), /Unknown easing/);
});

test('tweenObject follows arcs and curves with the pivot, optionally turning along the path', () => {
  const p = scene(5, k => [use({ x: k === 4 ? 30 : 0, y: 30, pivot: { x: 2, y: 3 } })]);
  const via = { x: 17.5, y: 13.5 }, { project } = tweenObject(p, { ...T, instanceId: 'o', fromFrameId: 'f0', toFrameId: 'f4', path: { kind: 'arc', via } });
  const pivots = [0, 1, 2, 3, 4].map(k => instancePivot(op(project, k), part(project)));
  // Points lie on the circle through start, via and end (to the rounding of a pixel).
  const route = motionPath(pivots[0], pivots[4], { kind: 'arc', via });
  assert.ok(pivots[2].y < 20 && Math.abs(pivots[2].x - 17.5) <= 1, JSON.stringify(pivots));
  assert.ok(Math.abs(route(0.5).y - pivots[2].y) <= 1);
  const turned = tweenObject(p, { ...T, instanceId: 'o', fromFrameId: 'f0', toFrameId: 'f4', path: { kind: 'bezier', controls: [{ x: 2, y: 10 }, { x: 30, y: 10 }] }, orient: true }).project;
  assert.ok(op(turned, 1).angle > 0 && op(turned, 3).angle > 90, `${op(turned, 1).angle} ${op(turned, 3).angle}`);
  assert.throws(() => tweenObject(p, { ...T, instanceId: 'o', fromFrameId: 'f0', toFrameId: 'f4', path: { kind: 'arc' } }), /arc needs/);
});

test('autoSquashStretch stretches along motion, keeps the area and squashes on landing', () => {
  const xs = [0, 0, 10, 20, 20];
  const p = scene(5, k => [use({ x: 4 + xs[k], y: 20 })]);
  const { project, frames } = autoSquashStretch(p, { ...T, instanceId: 'o', strength: 1, tilt: false });
  assert.equal(frames.length, 5);
  for (const f of frames.slice(1, 4)) { assert.ok(f.width > 6 && f.height < 4); assert.ok(Math.abs(f.width * f.height - 24) <= 4); }
  // The centre stays put.
  const c = k => { const o = op(project, k), s = poseOf(o, part(project)); return o.x + s.width / 2; };
  assert.ok(Math.abs(c(2) - (4 + 10 + 3)) <= 0.5);
  // A fall that stops: the last frame squashes wider with the bottom edge kept.
  const ys = [0, 6, 14, 24, 24], fall = scene(5, k => [use({ x: 20, y: ys[k] })]);
  const landed = autoSquashStretch(fall, { ...T, instanceId: 'o', strength: 0.5, impact: 0.5, tilt: false });
  const hit = landed.frames.find(f => f.impact);
  assert.equal(hit.frameId, 'f3');
  const o = op(landed.project, 3);
  assert.ok(o.width > 6 && o.height < 4 && o.y + o.height === 24 + 4);
  // Moving along a diagonal tilts the stretch onto the motion.
  const diag = scene(3, k => [use({ x: 8 * k, y: 8 * k })]);
  assert.ok(autoSquashStretch(diag, { ...T, instanceId: 'o' }).frames[1].angle !== 0);
});

test('springFollow lags behind the leader, and loops seamlessly', () => {
  const lead = [0, 40, 40, 40, 40, 40, 40, 40];
  const p = scene(8, k => [use({ x: 10, y: 10, angle: lead[k] }, 'body'), use({ x: 10, y: 20 })]);
  const { project, values } = springFollow(p, { ...T, instanceId: 'o', leaderId: 'body', stiffness: 0.3, damping: 0.5 });
  assert.equal(values[0], 0);
  assert.ok(values[1] > 0 && values[1] < 40);
  assert.ok(values.some(v => v > 40), 'overshoots');
  assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 6, 7].map(k => op(project, k).angle || 0));
  const swing = [0, 30, 0, -30];
  const looped = springFollow(scene(4, k => [use({ x: 10, y: 10, angle: swing[k] }, 'body'), use({ x: 10, y: 20 })]), { ...T, instanceId: 'o', leaderId: 'body', loop: true }).values;
  assert.equal(looped.length, 4);
  // Position follow: the follower trails a moving leader.
  const pos = scene(4, k => [use({ x: 10 * k, y: 10 }, 'body'), use({ x: 0, y: 20 })]);
  const moved = springFollow(pos, { ...T, instanceId: 'o', leaderId: 'body', property: 'position', stiffness: 0.5, damping: 0.5 }).project;
  assert.ok(op(moved, 1).x > 0 && op(moved, 1).x < 10 && op(moved, 1).y === 20);
  assert.throws(() => springFollow(pos, { ...T, instanceId: 'o', leaderId: 'o' }), /different/);
});

test('ikLimb bends a two-bone limb to the target and keeps the joint connected', () => {
  const p = scene(2, () => [use({ x: 10, y: 20, pivot: { x: 0, y: 0 } }, 'upper', 'bone'), use({ x: 18, y: 20, pivot: { x: 0, y: 0 } }, 'lower', 'bone')]);
  const target = [{ x: 20, y: 30 }, { x: 14.5, y: 28 }];
  const { project, frames } = ikLimb(p, { ...T, upperId: 'upper', lowerId: 'lower', target, bend: 1 });
  const bone = project.parts.find(x => x.id === 'bone');
  frames.forEach((f, k) => {
    assert.equal(f.reached, true);
    const up = op(project, k, 'upper'), low = op(project, k, 'lower');
    const root = instancePivot(up, bone), r = (up.angle || 0) * Math.PI / 180, elbow = { x: root.x + 8 * Math.cos(r), y: root.y + 8 * Math.sin(r) };
    const joint = instancePivot(low, bone);
    assert.ok(Math.hypot(joint.x - elbow.x, joint.y - elbow.y) <= 1, 'joint stays on the elbow');
    const l = (low.angle || 0) * Math.PI / 180, hand = { x: joint.x + 8.5 * Math.cos(l), y: joint.y + 8.5 * Math.sin(l) };
    assert.ok(Math.hypot(hand.x - target[k].x, hand.y - target[k].y) <= 1.5, JSON.stringify({ hand, t: target[k] }));
  });
  const other = ikLimb(p, { ...T, upperId: 'upper', lowerId: 'lower', target: target[0], bend: -1 }).frames[0];
  assert.notEqual(Math.sign(other.upper - frames[0].upper), 0);
  assert.equal(ikLimb(p, { ...T, upperId: 'upper', lowerId: 'lower', target: { x: 60, y: 20 } }).frames[0].reached, false);
  assert.throws(() => ikLimb(p, { ...T, upperId: 'upper', lowerId: 'lower', target: [target[0]] }), /one per frame/);
});

test('waveAnimate steps the phase and reports seamless loops', () => {
  const p = scene(4, () => [use({ x: 10, y: 10 })]);
  const r = waveAnimate(p, { ...T, instanceId: 'o', speed: 90, wave: { axis: 'y', amplitude: 1, wavelength: 6 } });
  assert.deepEqual([0, 1, 2, 3].map(k => op(r.project, k).deform), [0, 90, 180, 270].map(phase => ({ kind: 'wave', axis: 'y', amplitude: 1, wavelength: 6, phase })));
  assert.deepEqual([r.seamless, r.loopFrames], [true, 4]);
  const odd = waveAnimate(r.project, { ...T, instanceId: 'o', speed: 50 });
  assert.deepEqual([odd.seamless, odd.loopFrames, op(odd.project, 3).deform.phase], [false, 36, 150]);
});

test('smearFrame inserts a trail frame that keeps the objects and stores the trail as local edits', () => {
  const p = scene(2, k => [use({ x: 4 + 20 * k, y: 10 })]);
  const { project, frameId, offset } = smearFrame(p, { ...T, fromFrameId: 'f0', toFrameId: 'f1', instanceId: 'o' });
  assert.deepEqual(offset, { x: 20, y: 0 });
  assert.deepEqual(project.animations[0].frames.map(f => f.id), ['f0', frameId, 'f1']);
  const cel = project.animations[0].frames[1].cels[0];
  assert.deepEqual(cel.source.ops, project.animations[0].frames[2].cels[0].source.ops);
  assert.ok(cel.source.overrides.length > 0 && opaque(project, 1) > opaque(project, 2) * 3);
  // Only the moving object is smeared: a still object in the same container keeps its pixels.
  const two = scene(2, k => [use({ x: 4 + 20 * k, y: 10 }), use({ x: 12, y: 11 }, 'still')]), trail = smearFrame(two, { ...T, fromFrameId: 'f0', toFrameId: 'f1', instanceId: 'o' }).project;
  const [before, after] = [two.animations[0].frames[1], trail.animations[0].frames[1]].map(f => f.cels[0].pixels);
  const stillAt = [...before.keys()].filter(i => i % 48 >= 12 && i % 48 < 18 && before[i] >= 0);
  assert.ok(stillAt.length && stillAt.every(i => after[i] === before[i]) && after.slice(14 * 48, 14 * 48 + 12).every(v => v < 0));
  // Without an instance the pixel centroid gives the motion; insert:false smears the frame itself.
  const raster = smearFrame(p, { ...T, fromFrameId: 'f0', toFrameId: 'f1', insert: false, steps: 2 });
  assert.deepEqual([raster.frameId, raster.offset, raster.project.animations[0].frames.length], ['f1', { x: 20, y: 0 }, 2]);
  assert.throws(() => smearFrame(scene(2, () => [use({ x: 4, y: 4 })]), { ...T, fromFrameId: 'f0', toFrameId: 'f1' }), /Nothing moves/);
});

test('tweenToPose animates a move from a single frame: inserted copies, end pose, eased in-betweens on a path', () => {
  const p = scene(2, k => [use({ x: 2, y: 20 }), use({ x: 30, y: 30 }, 'still')]);
  const r = tweenToPose(p, { ...T, instanceId: 'o', fromFrameId: 'f0', endPose: { x: 26, y: 20 }, frames: 4, easing: 'linear' });
  const ids = r.project.animations[0].frames.map(f => f.id);
  assert.deepEqual(ids, ['f0', ...r.inserted, 'f1']);
  assert.equal(r.endFrameId, r.inserted[3]);
  assert.deepEqual([1, 2, 3, 4].map(k => op(r.project, k).x), [8, 14, 20, 26]);
  assert.ok([1, 2, 3, 4].every(k => op(r.project, k, 'still').x === 30), 'other objects are copied unchanged');
  assert.equal(op(r.project, 5).x, 2, 'later frames are untouched');
  const arc = tweenToPose(p, { ...T, instanceId: 'o', fromFrameId: 'f0', endPose: { x: 26, y: 20 }, frames: 4, path: { kind: 'arc', via: { x: 17, y: 10 } } });
  assert.ok(op(arc.project, 2).y < 14, 'the arc lifts the middle of the move');
  assert.equal(tweenToPose(p, { ...T, instanceId: 'o', fromFrameId: 'f0', endPose: { x: 9, y: 1 }, frames: 1 }).frameIds.length, 0);
  assert.throws(() => tweenToPose(p, { ...T, instanceId: 'x', fromFrameId: 'f0', endPose: { x: 0, y: 0 } }), /must appear/);
  assert.throws(() => tweenToPose(p, { ...T, instanceId: 'o', fromFrameId: 'f0', endPose: { x: 0, y: 0 }, frames: 0 }), /1 to 64/);
});

test('bounceInPlace builds a looping bounce from one frame: squashed contact, kept area, continuous loop', () => {
  const p = scene(1, () => [use({ x: 20, y: 30 })]), W = 6, H = 4, ground = 34;
  const r = bounceInPlace(p, { ...T, instanceId: 'o', fromFrameId: 'f0', height: 12, frames: 8, squash: 0.6 });
  assert.equal(r.project.animations[0].frames.length, 8);
  assert.deepEqual(r.frameIds, ['f0', ...r.inserted]);
  const ops = [...Array(8).keys()].map(k => op(r.project, k)), size = o => ({ w: o.width ?? W, h: o.height ?? H });
  const contact = size(ops[0]);
  assert.ok(contact.w > W && contact.h < H && ops[0].y + contact.h === ground, 'contact frame squashed on the ground');
  for (const o of ops) assert.ok(Math.abs(size(o).w * size(o).h - W * H) <= Math.max(size(o).w, size(o).h), 'area kept');
  assert.equal(ops[4].y + size(ops[4]).h, ground - 12, 'the top of the bounce');
  assert.deepEqual([ops[7].y + size(ops[7]).h, ops[7].x + size(ops[7]).w / 2], [ops[1].y + size(ops[1]).h, ops[1].x + size(ops[1]).w / 2], 'last frame mirrors the first rise: loops');
  assert.ok(size(ops[1]).h > H, 'fast frames stretch upright');
  assert.throws(() => bounceInPlace(p, { ...T, instanceId: 'o', fromFrameId: 'f0', frames: 2 }), /3 to 32/);
});

test('setPivotAt keeps rotated art in place; limbJoints reads the limb; swing follow trails a moving leader', () => {
  const p = scene(2, k => [use({ x: 10 + k * 6, y: 10 }, 'body'), use({ x: 16 + k * 6, y: 11, angle: 30 }, 'tail', 'bone')]);
  const images = renderParts(p.parts), art = o => {
    const shown = [...Array(48 * 48).keys()].filter(i => instancePixel(o, images.get('bone'), { x: i % 48, y: Math.floor(i / 48) }) >= 0);
    return [shown.reduce((a, i) => a + i % 48, 0) / shown.length, shown.reduce((a, i) => a + Math.floor(i / 48), 0) / shown.length];
  };
  const near = (a, b) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1, `${a} ≈ ${b}`);
  const pivoted = setPivotAt(p, { ...T, instanceId: 'tail', frameId: 'f0', point: instancePivot(op(p, 0, 'tail'), p.parts[1]) });
  assert.deepEqual(op(pivoted.project, 0, 'tail').pivot, pivoted.pivot);
  near(art(op(pivoted.project, 0, 'tail')), art(op(p, 0, 'tail')));
  near(art(withPivot(op(p, 0, 'tail'), p.parts[1], { x: 8, y: 0 })), art(op(p, 0, 'tail')));
  assert.notDeepEqual(op(p, 0, 'tail').x, withPivot(op(p, 0, 'tail'), p.parts[1], { x: 8, y: 0 }).x, 'the position compensates');
  const joints = limbJoints(p, { animationId: 'A', frameId: 'f0', layerId: 'L', upperId: 'body', lowerId: 'tail' });
  assert.ok(joints && Math.abs(joints.hand.x - joints.elbow.x) > 3);
  const flat = scene(4, k => [use({ x: 10, y: 10 + k * 6 }, 'body'), use({ x: 16, y: 11 + k * 6, pivot: { x: 0, y: 0 } }, 'tail', 'bone')]);
  const swing = springFollow(flat, { ...T, instanceId: 'tail', leaderId: 'body', property: 'swing', stiffness: 0.3, damping: 0.5 });
  const tail = k => op(swing.project, k, 'tail'), body = k => op(swing.project, k, 'body');
  assert.ok([1, 2, 3].every(k => Math.abs(instancePivot(tail(k), p.parts[1]).y - body(k).y - 1.5) <= 1), 'pivot stays attached to the leader');
  assert.ok(swing.values.slice(1).some(a => a !== 0), 'the tail swings as the body moves');
});

test('smearFrame from the last frame into the first appends the smear (loop)', () => {
  const p = scene(2, k => [use({ x: 4 + 20 * k, y: 10 })]);
  const { project, frameId } = smearFrame(p, { ...T, fromFrameId: 'f1', toFrameId: 'f0', instanceId: 'o' });
  assert.deepEqual(project.animations[0].frames.map(f => f.id), ['f0', 'f1', frameId]);
});

test('animated pivots, skew, deforms, sizes and RotSprite round-trip through PXA 2, PXS, the clipboard and frame copies', async () => {
  const p = scene(2, k => [use(k ? { x: 30, y: 26, angle: 60, width: 9, height: 3, pivot: { x: 1, y: 2 }, skew: { x: -20, y: 10 }, deform: { kind: 'wave', axis: 'x', amplitude: 2, wavelength: 6, phase: 120 }, sampling: 'rotsprite' }
    : { x: 4, y: 8, pivot: { x: 1, y: 2 }, deform: { kind: 'wave', axis: 'x', amplitude: 2, wavelength: 6, phase: 0 }, sampling: 'rotsprite' })]);
  let { project } = tweenObject(p, { ...T, instanceId: 'o', fromFrameId: 'f0', toFrameId: 'f1', insert: 4, easing: 'easeInOut', path: { kind: 'arc', via: { x: 20, y: 4 } } });
  project = waveAnimate(project, { ...T, instanceId: 'o', speed: 30 }).project;
  project = autoSquashStretch(project, { ...T, instanceId: 'o', strength: 0.3 }).project;
  const frames = project.animations[0].frames;
  assert.equal(new Set(frames.map(f => JSON.stringify(f.cels[0].source.ops[0]))).size, 6);
  assert.deepEqual(decodeAIProject(encodeAIProject(project)), project);
  const pxs = await decodePixelProject(await encodePixelProject(project));
  frames.forEach((f, k) => assert.deepEqual(compositeFrame(pxs, pxs.animations[0].frames[k]), compositeFrame(project, f)));
  const copy = copyObject(project, { ...T, frameId: 'f0' }, 'o');
  const pasted = pasteObject(project, { ...T, frameId: 'f0' }, JSON.parse(JSON.stringify(copy)), { intoGroup: false });
  pasted.project.animations[0].frames.forEach((f, k) => {
    const a = { ...frames[k].cels[0].source.ops[0] }, b = { ...f.cels.find(c => c.layerId === pasted.layerId).source.ops[0] };
    for (const o of [a, b]) { delete o.id; delete o.name; delete o.visible; delete o.locked; }
    assert.deepEqual(b, a);
  });
  const dup = makeLayeredFrame(project, frames[3]);
  assert.deepEqual(dup.cels, frames[3].cels);
});
