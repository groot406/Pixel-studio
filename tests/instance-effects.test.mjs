import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProject, compositeFrame, blankProject } from '../src/domain/project.js';
import { objectBounds, hitTestObject, celObjects, turnObjects, rotateObjects, setObjectEffects, updateObject } from '../src/domain/objects.js';
import { growPart } from '../src/domain/parts.js';
import { canvasToPartPoint, instancePivot, instancePixel, instanceBox, waveShift } from '../src/domain/geometry.js';
import { scale2x, rotspriteImage } from '../src/domain/rotsprite.js';
import { renderParts } from '../src/domain/artwork.js';
import { encodeAIProject, decodeAIProject } from '../src/formats/pxa.js';
import { copyObject, pasteObject } from '../src/domain/object-clipboard.js';

const colour = (x, y, w = 6) => 1 + (y * w + x) % 24;
// 6×4 part, every pixel a distinct palette index (1..24), placed at (12,12) in frames f0..f2 of a 32×32 canvas.
function scene(pose = {}, w = 6, h = 4) {
  const p = blankProject('fx', 32, 32);
  p.palette = Array.from({ length: 25 }, (_, i) => `#${(i * 10).toString(16).padStart(2, '0')}2040`);
  p.version = 3;
  p.parts = [{ id: 'art', width: w, height: h, ops: Array.from({ length: h }, (_, y) => ({ type: 'span', x: 0, y, values: Array.from({ length: w }, (_, x) => colour(x, y, w)) })) }];
  const a = p.animations[0];
  a.id = 'A'; p.layers[0].id = 'L'; a.frames[0].cels[0].layerId = 'L';
  a.frames = ['f0', 'f1', 'f2'].map(id => ({ ...structuredClone(a.frames[0]), id }));
  for (const f of a.frames) f.cels[0].source = { ops: [{ type: 'use', id: 'o', partId: 'art', x: 12, y: 12, transform: 'N', ...structuredClone(pose) }], overrides: [] };
  return { p: validateProject(p), target: { animationId: a.id, frameId: 'f0', layerId: p.layers[0].id }, items: [{ layerId: p.layers[0].id, key: 'o' }] };
}
const canvas = (p, frame = 0) => compositeFrame(p, p.animations[0].frames[frame]);
const op = (p, frame = 0) => p.animations[0].frames[frame].cels[0].source.ops[0];
const image = p => renderParts(p.parts).get('art');

test('defaults are not stored and render byte-identically', () => {
  const plain = scene({ angle: 30 }).p;
  const reset = scene({ angle: 30, pivot: null, skew: { x: 0, y: 0 }, deform: { kind: 'bulge', strength: 0 }, sampling: 'nearest' }).p;
  assert.deepEqual(reset, plain);
  assert.deepEqual(scene({ deform: { kind: 'twist', angle: 0 } }).p, scene().p);
  // Raw zero effects are exact identities of the mapping too.
  const part = image(plain);
  for (const fx of [{ skew: { x: 0, y: 0 } }, { deform: { kind: 'bulge', strength: 0 } }, { deform: { kind: 'twist', angle: 0 } }])
    for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++)
      assert.deepEqual(canvasToPartPoint({ x: 0, y: 0, transform: 'N', ...fx }, part, { x, y }), { x, y }, JSON.stringify(fx));
});

test('rotation and skew turn about a pivot pixel, which stays fixed', () => {
  for (const pivot of [{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: -2, y: 7 }]) for (const angle of [17, 90, -135, 180]) {
    const { p } = scene({ angle, pivot, skew: { x: 20, y: -10 } }), part = image(p), o = op(p);
    assert.deepEqual(instancePivot(o, part), { x: 12 + pivot.x + .5, y: 12 + pivot.y + .5 });
    const inside = pivot.x >= 0 && pivot.y >= 0 && pivot.x < 6 && pivot.y < 4;
    assert.deepEqual(canvasToPartPoint(o, part, { x: 12 + pivot.x, y: 12 + pivot.y }), pivot);
    if (inside) assert.equal(canvas(p)[(12 + pivot.y) * 32 + 12 + pivot.x], colour(pivot.x, pivot.y));
  }
  // Every drawn pixel lies inside the box and hit-tests through the same mapping.
  const { p } = scene({ angle: 33, pivot: { x: 0, y: 0 }, skew: { x: 30, y: 15 } }), box = objectBounds(p, celObjects(p.animations[0].frames[0].cels[0])[0]);
  let drawn = 0;
  canvas(p).forEach((v, i) => {
    if (v < 0) return;
    const x = i % 32, y = Math.floor(i / 32); drawn++;
    assert.ok(x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height);
    assert.equal(hitTestObject(p, p.animations[0], p.animations[0].frames[0], x, y)?.key, 'o');
  });
  assert.ok(drawn >= 20);
});

test('skew shears rows by tan(angle) about the pivot', () => {
  const { p } = scene({ skew: { x: 45, y: 0 }, pivot: { x: 0, y: 0 } }), px = canvas(p);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) assert.equal(px[(12 + y) * 32 + 12 + x + y], colour(x, y));
  assert.deepEqual(instanceBox(op(p), image(p)), { x: 11, y: 12, width: 11, height: 4 }, 'continuous corners bound the sheared pixels');
});

test('wave shifts whole rows (or columns) and widens the box by its amplitude', () => {
  const deform = { kind: 'wave', axis: 'x', amplitude: 2, wavelength: 4, phase: 0 };
  assert.deepEqual([0, 1, 2, 3].map(y => waveShift(deform, y)), [0, 2, 0, -2]);
  const { p } = scene({ deform }), px = canvas(p);
  for (const [y, shift] of [[0, 0], [1, 2], [2, 0], [3, -2]]) for (let x = 0; x < 6; x++) assert.equal(px[(12 + y) * 32 + 12 + x + shift], colour(x, y));
  assert.deepEqual(objectBounds(p, celObjects(p.animations[0].frames[0].cels[0])[0]), { x: 10, y: 12, width: 10, height: 4 });
  const column = scene({ deform: { ...deform, axis: 'y', phase: 90 } }).p, cpx = canvas(column);
  for (let x = 0; x < 6; x++) { const s = waveShift({ ...deform, phase: 90 }, x); for (let y = 0; y < 4; y++) assert.equal(cpx[(12 + y + s) * 32 + 12 + x], colour(x, y)); }
});

test('bulge and twist stay inside the box and keep the part', () => {
  for (const deform of [{ kind: 'bulge', strength: 80 }, { kind: 'bulge', strength: -60 }, { kind: 'twist', angle: 120 }]) {
    const { p } = scene({ deform }, 9, 9), px = canvas(p);
    assert.deepEqual(objectBounds(p, celObjects(p.animations[0].frames[0].cels[0])[0]), { x: 12, y: 12, width: 9, height: 9 });
    px.forEach((v, i) => { if (v >= 0) assert.ok(i % 32 >= 12 && i % 32 < 21 && i >= 12 * 32 && i < 21 * 32); });
    assert.equal(px[16 * 32 + 16], colour(4, 4, 9), 'the centre pixel stays');
    assert.notDeepEqual(px, canvas(scene({}, 9, 9).p));
  }
});

test('RotSprite: Scale2x upscale, identical to nearest without free angles, smooth and deterministic otherwise', () => {
  // Scale2x rounds a diagonal step but keeps solid areas solid.
  assert.deepEqual([...scale2x([1, -1, 1, 1], 2, 2)], [1, 1, -1, -1, 1, 1, 1, -1, 1, 1, 1, 1, 1, 1, 1, 1]);
  const solid = rotspriteImage({ width: 2, height: 2, pixels: [3, 3, 3, 3] });
  assert.equal(solid.width, 16); assert.ok([...solid.pixels].every(v => v === 3));
  const nearest = scene({}, 5, 5).p, smooth = scene({ sampling: 'rotsprite' }, 5, 5).p;
  assert.equal(op(smooth).sampling, 'rotsprite');
  assert.deepEqual(canvas(smooth), canvas(nearest));
  assert.deepEqual(canvas(scene({ angle: 90, sampling: 'rotsprite' }, 5, 5).p), canvas(scene({ transform: 'R90' }, 5, 5).p));
  const tilted = scene({ angle: 30, sampling: 'rotsprite' }, 5, 5).p, again = scene({ angle: 30, sampling: 'rotsprite' }, 5, 5).p;
  assert.deepEqual(canvas(tilted), canvas(again));
  assert.ok(canvas(tilted).every(v => v >= -1 && v <= 25));
  const part = image(tilted), box = instanceBox(op(tilted), part);
  for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
    const v = instancePixel(op(tilted), part, { x, y });
    if (v >= 0) assert.equal(hitTestObject(tilted, tilted.animations[0], tilted.animations[0].frames[0], x, y)?.key, 'o');
  }
});

test('PXA 2 round trips every effect, including FRAME FROM deltas that animate the wave phase', () => {
  const { p } = scene({ angle: 20, pivot: { x: 1, y: 2 }, skew: { x: -15, y: 5 }, deform: { kind: 'wave', axis: 'y', amplitude: 3, wavelength: 8, phase: 0 }, sampling: 'rotsprite' });
  const frames = p.animations[0].frames;
  frames[1].cels[0].source.ops[0].deform.phase = 90;
  delete frames[1].cels[0].source.ops[0].pivot;
  Object.assign(frames[2].cels[0].source.ops[0], { pivot: undefined, deform: { ...frames[1].cels[0].source.ops[0].deform, phase: 180 }, skew: undefined });
  const project = validateProject(p), text = encodeAIProject(project);
  for (const line of ['PIVOT o 1 2', 'SKEW o -15 5', 'DEFORM o WAVE Y 3 8 0', 'SAMPLE o ROTSPRITE', 'DEFORM o WAVE Y 3 8 90', 'PIVOT o CENTER', 'DEFORM o WAVE Y 3 8 180', 'SKEW o 0 0'])
    assert.ok(text.includes(line), `${line}\n${text}`);
  assert.match(text, /FRAME f1 \d+ FROM f0\nCEL \w+\nPIVOT o CENTER\nDEFORM o WAVE Y 3 8 90\n/);
  assert.deepEqual(decodeAIProject(text), project);
  for (const deform of [{ kind: 'bulge', strength: -40 }, { kind: 'twist', angle: -45 }, { kind: 'wave', axis: 'x', amplitude: 32, wavelength: 256, phase: 359 }, undefined]) {
    const q = scene({ deform, angle: 5 }).p;
    assert.deepEqual(decodeAIProject(encodeAIProject(q)), q);
  }
  const nearest = scene({ angle: 10, sampling: 'rotsprite' }).p;
  delete nearest.animations[0].frames[1].cels[0].source.ops[0].sampling;
  assert.match(encodeAIProject(nearest), /FRAME f1 \d+ FROM f0\nCEL L\nSAMPLE o NEAREST\n/);
  assert.deepEqual(decodeAIProject(encodeAIProject(nearest)), validateProject(nearest));
  const removed = text.replace('DEFORM o WAVE Y 3 8 180', 'DEFORM o NONE');
  assert.equal(op(decodeAIProject(removed), 2).deform, undefined);
});

test('invalid effect values are rejected', () => {
  for (const pose of [{ pivot: { x: 513, y: 0 } }, { pivot: { x: 0 } }, { skew: { x: 61, y: 0 } }, { skew: { x: 0, y: -61 } }, { skew: { x: 1.5, y: 0 } },
    { deform: { kind: 'wave', axis: 'x', amplitude: 0, wavelength: 4, phase: 0 } }, { deform: { kind: 'wave', axis: 'x', amplitude: 33, wavelength: 4, phase: 0 } },
    { deform: { kind: 'wave', axis: 'z', amplitude: 1, wavelength: 4, phase: 0 } }, { deform: { kind: 'wave', axis: 'x', amplitude: 1, wavelength: 1, phase: 0 } },
    { deform: { kind: 'bulge', strength: 101 } }, { deform: { kind: 'twist', angle: 361 } }, { deform: { kind: 'swirl' } }, { sampling: 'bilinear' }])
    assert.throws(() => scene(pose), undefined, JSON.stringify(pose));
  const base = encodeAIProject(scene().p).replace('END', '');
  for (const line of ['SAMPLE o LINEAR', 'DEFORM o WAVE Z 1 4 0', 'DEFORM o WAVE X 1 4', 'DEFORM o SPIN 3', 'PIVOT o 1', 'SKEW o 70 0', 'DEFORM o BULGE 200'])
    assert.throws(() => decodeAIProject(`${base}${line}\nEND\n`), undefined, line);
});

test('clipboard, flips, effect updates and part growth keep the effects', () => {
  const pose = { angle: 25, pivot: { x: 1, y: 1 }, skew: { x: 10, y: -5 }, deform: { kind: 'wave', axis: 'x', amplitude: 1, wavelength: 6, phase: 30 }, sampling: 'rotsprite' };
  const { p, target, items } = scene(pose), copy = copyObject(p, target, 'o');
  assert.deepEqual(copy.instance.skew, pose.skew);
  const pasted = pasteObject(p, target, JSON.parse(JSON.stringify(copy)), { offset: 2 });
  const added = pasted.project.animations[0].frames[0].cels.find(c => c.layerId === pasted.layerId).source.ops.find(o => o.id === pasted.key);
  for (const key of Object.keys(pose)) assert.deepEqual(added[key], pose[key], key);
  // A horizontal flip of a skewed, pivoted object mirrors it exactly (wave aside).
  const { p: q, target: t, items: i } = scene({ ...pose, deform: undefined, sampling: undefined }), before = canvas(q), after = canvas(turnObjects(q, t, i, 'FX'));
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) assert.equal(after[y * 32 + x], before[y * 32 + (2 * 12 + 6 - 1 - x)] ?? -1);
  assert.deepEqual(canvas(rotateObjects(rotateObjects(q, t, i, 40), t, i, -40)), before);
  // Growing the part keeps pivoted and centre-skewed instances in place.
  assert.deepEqual(canvas(growPart(q, 'art', { left: 2, top: 1 })), before);
  const centred = scene({ skew: { x: 20, y: 0 } }).p;
  assert.deepEqual(canvas(growPart(centred, 'art', { left: 2, right: 2 })), canvas(centred));
  // Effects can be set and reset per object in every frame of the scope.
  const set = setObjectEffects(scene().p, target, items, { skew: { x: 5, y: 0 }, sampling: 'rotsprite' });
  assert.deepEqual([op(set, 2).skew, op(set, 2).sampling], [{ x: 5, y: 0 }, 'rotsprite']);
  const cleared = updateObject(set, target, 'o', { skew: null, sampling: null });
  assert.deepEqual(cleared, scene().p);
  assert.throws(() => setObjectEffects(set, target, items, { angle: 3 }), /Unsupported/);
});
