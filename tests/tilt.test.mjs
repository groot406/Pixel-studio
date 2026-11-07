import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProject, compositeFrame, blankProject } from '../src/domain/project.js';
import { turnObjects, tiltObjects, setObjectEffects } from '../src/domain/objects.js';
import { canvasToPartPoint, instancePivot, instancePixel, instanceBox } from '../src/domain/geometry.js';
import { renderParts } from '../src/domain/artwork.js';
import { encodeAIProject, decodeAIProject } from '../src/formats/pxa.js';
import { tweenPose, poseOf, applyPose } from '../src/domain/motion.js';
import { spin3d } from '../src/domain/animate.js';

const colour = (x, y, w) => 1 + (y * w + x) % 24;
// w×h part, distinct-ish palette indices, placed at (16,16) in frames f0..f2 of a 48×48 canvas.
function scene(pose = {}, w = 8, h = 6) {
  const p = blankProject('tilt', 48, 48);
  p.palette = Array.from({ length: 25 }, (_, i) => `#${(i * 10).toString(16).padStart(2, '0')}2040`);
  p.version = 3;
  p.parts = [{ id: 'art', width: w, height: h, ops: Array.from({ length: h }, (_, y) => ({ type: 'span', x: 0, y, values: Array.from({ length: w }, (_, x) => colour(x, y, w)) })) }];
  const a = p.animations[0];
  a.id = 'A'; p.layers[0].id = 'L'; a.frames[0].cels[0].layerId = 'L';
  a.frames = ['f0', 'f1', 'f2'].map(id => ({ ...structuredClone(a.frames[0]), id }));
  for (const f of a.frames) f.cels[0].source = { ops: [{ type: 'use', id: 'o', partId: 'art', x: 16, y: 16, transform: 'N', ...structuredClone(pose) }], overrides: [] };
  return { p: validateProject(p), target: { animationId: 'A', frameId: 'f0', layerId: 'L' }, items: [{ layerId: 'L', key: 'o' }] };
}
const canvas = (p, frame = 0) => compositeFrame(p, p.animations[0].frames[frame]);
const op = (p, frame = 0) => p.animations[0].frames[frame].cels[0].source.ops[0];
const image = p => renderParts(p.parts).get('art');
/** Opaque canvas pixels as {x,y}. */
const opaque = pixels => pixels.flatMap((v, i) => (v >= 0 ? [{ x: i % 48, y: Math.floor(i / 48) }] : []));
const span = (points, axis) => points.length ? Math.max(...points.map(p => p[axis])) - Math.min(...points.map(p => p[axis])) + 1 : 0;

test('no 3D turn is not stored and renders identically', () => {
  assert.deepEqual(scene({ tilt: { x: 0, y: 0, perspective: 80 } }).p, scene().p);
  const part = image(scene().p);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++)
    assert.deepEqual(canvasToPartPoint({ x: 0, y: 0, transform: 'N', tilt: { x: 0, y: 0 } }, part, { x, y }), { x, y });
  // The default perspective is not stored either.
  assert.deepEqual(op(scene({ tilt: { x: 10, y: 20, perspective: 30 } }).p).tilt, { x: 10, y: 20 });
});

test('a half turn about y or x is an exact mirror, with or without perspective', () => {
  for (const perspective of [0, 30, 100]) {
    assert.deepEqual(canvas(scene({ tilt: { x: 0, y: 180, perspective } }).p), canvas(scene({ transform: 'FX' }).p), `y ${perspective}`);
    assert.deepEqual(canvas(scene({ tilt: { x: 180, y: 0, perspective } }).p), canvas(scene({ transform: 'FY' }).p), `x ${perspective}`);
    assert.deepEqual(canvas(scene({ tilt: { x: 0, y: -180, perspective } }).p), canvas(scene({ transform: 'FX' }).p));
  }
});

test('edge-on at 90° shows nothing, and the box narrows with cos', () => {
  for (const tilt of [{ x: 0, y: 90 }, { x: 0, y: -90 }, { x: 90, y: 0 }]) {
    const { p } = scene({ tilt });
    assert.equal(opaque(canvas(p)).length, 0, JSON.stringify(tilt));
    const box = instanceBox(op(p), image(p));
    assert.ok(tilt.x ? box.height <= 1 : box.width <= 1, JSON.stringify(box));
  }
  const flat = { perspective: 0 };
  const sixty = opaque(canvas(scene({ tilt: { x: 0, y: 60, ...flat } }, 16, 12).p));
  assert.deepEqual([span(sixty, 'x'), span(sixty, 'y')], [8, 12]);
  const tip = opaque(canvas(scene({ tilt: { x: 60, y: 0, ...flat } }, 16, 12).p));
  assert.deepEqual([span(tip, 'x'), span(tip, 'y')], [16, 6]);
  // Past 90° the back shows: the artwork is mirrored.
  const back = scene({ tilt: { x: 0, y: 120, ...flat } }, 16, 12).p, row = 16 + 6;
  const shown = canvas(back).slice(row * 48, row * 48 + 48).filter(v => v >= 0);
  assert.equal(shown.at(0) > shown.at(-1), true, 'colours run right to left');
});

test('perspective shortens the far edge and lengthens the near edge', () => {
  const columnHeight = (pixels, x) => opaque(pixels).filter(p => p.x === x).length;
  const { p } = scene({ tilt: { x: 0, y: 50, perspective: 100 } }, 16, 16), px = opaque(canvas(p));
  const left = Math.min(...px.map(p => p.x)), right = Math.max(...px.map(p => p.x));
  // Positive y turns the right side away.
  assert.ok(columnHeight(canvas(p), right) < 16 && columnHeight(canvas(p), left) > 16, `${columnHeight(canvas(p), left)} / ${columnHeight(canvas(p), right)}`);
  const tipped = canvas(scene({ tilt: { x: 50, y: 0, perspective: 100 } }, 16, 16).p), tp = opaque(tipped);
  const rowWidth = y => tp.filter(p => p.y === y).length, top = Math.min(...tp.map(p => p.y)), bottom = Math.max(...tp.map(p => p.y));
  assert.ok(rowWidth(top) < 16 && rowWidth(bottom) > 16, `${rowWidth(top)} / ${rowWidth(bottom)}`);
  // The box bounds every pixel drawn.
  for (const tilt of [{ x: 0, y: 50, perspective: 100 }, { x: 35, y: -70, perspective: 60 }, { x: 150, y: 20 }]) {
    const q = scene({ tilt, angle: 25, skew: { x: 10, y: 0 } }, 16, 16).p, box = instanceBox(op(q), image(q));
    for (const { x, y } of opaque(canvas(q))) assert.ok(x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height, JSON.stringify({ tilt, x, y, box }));
  }
});

test('the axis passes through the pivot, which stays fixed', () => {
  const pivot = { x: 2, y: 3 };
  for (const tilt of [{ x: 0, y: 60 }, { x: 45, y: 0 }, { x: 30, y: -50, perspective: 100 }]) {
    const { p } = scene({ pivot, tilt }), part = image(p), o = op(p), c = instancePivot(o, part);
    assert.deepEqual(c, instancePivot({ ...o, tilt: undefined }, part));
    assert.equal(instancePixel(o, part, { x: Math.floor(c.x), y: Math.floor(c.y) }), colour(2, 3, 8), JSON.stringify(tilt));
    assert.deepEqual(canvasToPartPoint(o, part, { x: Math.floor(c.x), y: Math.floor(c.y) }), pivot);
  }
});

test('flips and quarter turns keep the 3D turn, tiltObjects adds and wraps, effects reset it', () => {
  const { p, target, items } = scene({ tilt: { x: 20, y: 40, perspective: 50 } });
  assert.deepEqual(op(turnObjects(p, target, items, 'FX')).tilt, { x: 20, y: -40, perspective: 50 });
  assert.deepEqual(op(turnObjects(p, target, items, 'FY')).tilt, { x: -20, y: 40, perspective: 50 });
  assert.deepEqual(op(turnObjects(p, target, items, 'R90')).tilt, { x: -40, y: 20, perspective: 50 });
  assert.deepEqual(op(turnObjects(turnObjects(p, target, items, 'R90'), target, items, 'R270')).tilt, op(p).tilt);
  // A pure y turn rotated a quarter is a pure x turn, drawn as the quarter-turned image.
  const y = scene({ tilt: { x: 0, y: 60 } }, 8, 8);
  assert.deepEqual(canvas(turnObjects(y.p, y.target, y.items, 'R180')), canvas(scene({ tilt: { x: 0, y: -60 }, transform: 'R180' }, 8, 8).p));
  const spun = tiltObjects(p, target, items, { x: 0, y: 150 }, 'frame');
  assert.deepEqual([op(spun).tilt, op(spun, 1).tilt], [{ x: 20, y: -170, perspective: 50 }, { x: 20, y: 40, perspective: 50 }]);
  assert.equal(op(tiltObjects(p, target, items, { x: -20, y: -40 })).tilt, undefined);
  assert.equal(op(setObjectEffects(p, target, items, { tilt: null }), 2).tilt, undefined);
  assert.throws(() => tiltObjects(p, target, items, { x: 0.5, y: 0 }));
  for (const tilt of [{ x: 181, y: 0 }, { x: 0, y: 1.5 }, { x: 10, y: 0, perspective: 101 }, 'flip'])
    assert.throws(() => scene({ tilt }), undefined, JSON.stringify(tilt));
});

test('PXA 2 round trips TILT and its perspective', () => {
  const { p } = scene({ tilt: { x: 10, y: -45, perspective: 70 }, sampling: 'rotsprite' });
  op(p, 1).tilt = { x: 0, y: 90 };
  delete op(p, 2).tilt;
  const project = validateProject(p), text = encodeAIProject(project);
  for (const line of ['TILT o 10 -45 PERSPECTIVE 70', 'TILT o 0 90\n', 'TILT o 0 0\n']) assert.ok(text.includes(line), `${line}\n${text}`);
  assert.deepEqual(decodeAIProject(text), project);
  const base = encodeAIProject(scene().p).replace('END', '');
  for (const line of ['TILT o 10', 'TILT o 10 0 PERSPECTIVE', 'TILT o 200 0', 'TILT o 0 0 DEPTH 3', 'TILT o 5 5 PERSPECTIVE 101'])
    assert.throws(() => decodeAIProject(`${base}${line}\nEND\n`), undefined, line);
});

test('poses tween the 3D turn linearly, so 0 → 360 spins once', () => {
  assert.equal(tweenPose({ tiltY: 0 }, { tiltY: 360 }, 0.5).tiltY, 180);
  assert.equal(tweenPose({ tiltY: 0 }, { tiltY: 360 }, 0.75).tiltY, -90);
  assert.equal(tweenPose({ tiltX: 10 }, { tiltX: 50 }, 0.5).tiltX, 30);
  const { p } = scene({ tilt: { x: 5, y: 10, perspective: 0 } }), part = image(p);
  assert.deepEqual([poseOf(op(p), part).tiltX, poseOf(op(p), part).tiltY], [5, 10]);
  assert.deepEqual(applyPose(op(p), { tiltY: 190 }, part).tilt, { x: 5, y: -170, perspective: 0 });
  assert.equal(applyPose(op(p), { tiltX: 0, tiltY: 360 }, part).tilt, undefined);
});

test('spin3d inserts a seamless loop turning the object about one axis', () => {
  const { p } = scene({ tilt: { x: 0, y: 10 } });
  const { project, frameIds, inserted } = spin3d(p, { animationId: 'A', layerId: 'L', instanceId: 'o', fromFrameId: 'f0', frames: 4 });
  assert.equal(inserted.length, 3);
  assert.deepEqual(frameIds, ['f0', ...inserted]);
  const frames = project.animations[0].frames;
  assert.deepEqual(frameIds.map(id => frames.find(f => f.id === id).cels[0].source.ops[0].tilt?.y), [10, 100, -170, -80]);
  assert.equal(frames.length, 6);
  const tip = spin3d(p, { animationId: 'A', layerId: 'L', instanceId: 'o', fromFrameId: 'f1', frames: 2, axis: 'x', turns: -1 });
  assert.deepEqual(tip.project.animations[0].frames[2].cels[0].source.ops[0].tilt, { x: 180, y: 10 });
  assert.throws(() => spin3d(p, { animationId: 'A', layerId: 'L', instanceId: 'o', fromFrameId: 'f0', frames: 1 }));
  assert.throws(() => spin3d(p, { animationId: 'A', layerId: 'L', instanceId: 'o', fromFrameId: 'f0', axis: 'z' }));
});
