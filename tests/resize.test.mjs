import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProject, compositeFrame, blankProject } from '../src/domain/project.js';
import { resizeObject, objectBounds, hitTestObject, celObjects, turnObjects, rotateObjects } from '../src/domain/objects.js';
import { growPart } from '../src/domain/parts.js';
import { sampleIndex, composeTransform, transformPoint, TRANSFORM_NAMES } from '../src/domain/geometry.js';
import { resizeBox, keepAreaSide } from '../src/domain/resize.js';
import { repeatPixelChanges, changedIndices } from '../src/domain/toolbox.js';
import { encodeAIProject, decodeAIProject } from '../src/formats/pxa.js';
import { copyObject, pasteObject } from '../src/domain/object-clipboard.js';

// 4×4 part with a distinct color per row (1..4), placed at (2,2) in frames f0 and f1.
function scene() {
  const p = blankProject('r', 16, 16);
  p.palette = ['#000000', '#111111', '#555555', '#999999', '#dddddd'];
  p.version = 3;
  p.parts = [{ id: 'box', width: 4, height: 4, ops: [1, 2, 3, 4].map((c, y) => ({ type: 'rect', x: 0, y, width: 4, height: 1, color: c })) }];
  const a = p.animations[0], layer = p.layers[0];
  a.frames.push({ ...structuredClone(a.frames[0]), id: 'f1' });
  a.frames[0].id = 'f0';
  for (const f of a.frames) f.cels[0].source = { ops: [{ type: 'use', id: 'b', partId: 'box', x: 2, y: 2, transform: 'N' }], overrides: [] };
  return { p: validateProject(p), target: { animationId: a.id, frameId: 'f0', layerId: layer.id } };
}
const rows = (p, frame, box) => {
  const px = compositeFrame(p, p.animations[0].frames[frame]);
  return Array.from({ length: box.height }, (_, y) => px.slice((box.y + y) * p.width + box.x, (box.y + y) * p.width + box.x + box.width));
};

test('centre sampling squashes and stretches with exact integer maths', () => {
  assert.deepEqual([0, 1, 2, 3].map(i => sampleIndex(i, 4, 8)), [1, 3, 5, 7]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(i => sampleIndex(i, 8, 4)), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.deepEqual([0, 1, 2].map(i => sampleIndex(i, 3, 3)), [0, 1, 2]);
  assert.equal(sampleIndex(-1, 4, 8), -1);
  assert.ok(sampleIndex(4, 4, 8) >= 8);
});

test('stretch at pivot adds and drops rows at the pivot, keeps the rest pixel-exact and round-trips', () => {
  const { p, target } = scene(), op = () => p.animations[0].frames[0].cels[0].source.ops[0];
  op().pivot = { x: 1, y: 2 };
  const sized = box => rows(resizeObject(validateProject(p), target, 'b', box, 'frame'), 0, box).map(r => r[0]);
  assert.deepEqual(sized({ x: 2, y: 2, width: 4, height: 2 }), [2, 4], 'without the toggle a pivot does not change even scaling');
  op().stretch = 'pivot';
  const saved = decodeAIProject(encodeAIProject(resizeObject(validateProject(p), target, 'b', { x: 2, y: 2, width: 4, height: 3 }, 'frame')));
  assert.equal(saved.animations[0].frames[0].cels[0].source.ops[0].stretch, 'pivot');
  assert.match(encodeAIProject(saved), /STRETCH b PIVOT/);
  assert.deepEqual(sized({ x: 2, y: 2, width: 4, height: 7 }), [1, 2, 3, 3, 3, 3, 4], 'the pivot row repeats');
  assert.deepEqual(sized({ x: 2, y: 2, width: 4, height: 3 }), [1, 2, 4], 'the pivot row is dropped first');
  op().pivot = { x: 1, y: 3 };
  assert.deepEqual(sized({ x: 2, y: 2, width: 4, height: 2 }), [1, 2], 'a pivot below the new box keeps the top');
  op().transform = 'FY'; op().pivot = { x: 1, y: 0 };
  assert.deepEqual(sized({ x: 2, y: 2, width: 4, height: 6 }), [4, 4, 4, 3, 2, 1], 'flips keep the seam on the pivot');
  delete op().pivot; op().transform = 'N';
  assert.deepEqual(sized({ x: 2, y: 2, width: 4, height: 6 }), [1, 2, 3, 3, 3, 4], 'without a set pivot the middle row stretches');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => sampleIndex(i, 6, 4, 1)), [0, 1, 1, 1, 2, 3]);
});

test('keep-area resizing pushes the artwork sideways and keeps the opposite edge', () => {
  const box = { x: 4, y: 4, width: 8, height: 8 };
  assert.equal(keepAreaSide(64, 4), 16);
  assert.deepEqual(resizeBox(box, 'n', 0, 4, { keepArea: true }), { x: 0, y: 8, width: 16, height: 4 });
  assert.deepEqual(resizeBox(box, 's', 0, 8, { keepArea: true }), { x: 6, y: 4, width: 4, height: 16 });
  assert.deepEqual(resizeBox(box, 'e', 8, 0, { keepArea: true }), { x: 4, y: 8, width: 16, height: 4 });
  // Area is measured against the original, so repeated drags do not drift.
  assert.deepEqual(resizeBox({ x: 0, y: 8, width: 16, height: 4 }, 'n', 0, -4, { keepArea: true, area: 64 }), { x: 4, y: 4, width: 8, height: 8 });
  assert.deepEqual(resizeBox(box, 'nw', 2, 3), { x: 6, y: 7, width: 6, height: 5 });
  assert.deepEqual(resizeBox(box, 'se', 4, 0, { keepRatio: true }), { x: 4, y: 4, width: 12, height: 12 });
  assert.deepEqual(resizeBox(box, 'w', 50, 0), { x: 11, y: 4, width: 1, height: 8 });
});

test('a resized instance renders, hit-tests and bounds at its new size without touching the part', () => {
  const { p, target } = scene();
  const squashed = resizeObject(p, target, 'b', { x: 0, y: 4, width: 8, height: 2 }, 'frame');
  assert.deepEqual(squashed.parts, p.parts);
  const node = celObjects(squashed.animations[0].frames[0].cels[0])[0];
  assert.deepEqual(objectBounds(squashed, node), { x: 0, y: 4, width: 8, height: 2 });
  assert.deepEqual(rows(squashed, 0, { x: 0, y: 4, width: 8, height: 2 }), [Array(8).fill(2), Array(8).fill(4)]);
  assert.equal(hitTestObject(squashed, squashed.animations[0], squashed.animations[0].frames[0], 7, 5)?.key, 'b');
  assert.equal(hitTestObject(squashed, squashed.animations[0], squashed.animations[0].frames[0], 2, 2), null);
  // Frame scope leaves the other frame alone; the part's own size clears the resize.
  assert.equal(squashed.animations[0].frames[1].cels[0].source.ops[0].width, undefined);
  const reset = resizeObject(squashed, target, 'b', { x: 2, y: 2, width: 4, height: 4 }, 'frame');
  assert.deepEqual(reset.animations, p.animations);
  // Rotated instances take the box in canvas orientation.
  const turned = validateProject(structuredClone(p));
  turned.animations[0].frames[0].cels[0].source.ops[0].transform = 'R90';
  const wide = resizeObject(turned, target, 'b', { x: 2, y: 2, width: 8, height: 4 }, 'frame');
  assert.deepEqual(wide.animations[0].frames[0].cels[0].source.ops[0], { type: 'use', id: 'b', partId: 'box', x: 2, y: 2, transform: 'R90', width: 4, height: 8 });
});

test('resizes survive PXA, the object clipboard and part growth', () => {
  const { p, target } = scene();
  const resized = resizeObject(p, target, 'b', { x: 1, y: 3, width: 6, height: 3 }, 'animation');
  assert.match(encodeAIProject(resized), /RESIZE b 6 3/);
  assert.deepEqual(decodeAIProject(encodeAIProject(resized)).animations, resized.animations);
  const pasted = pasteObject(resized, { ...target, frameId: 'f1' }, copyObject(resized, target, 'b'), { scope: 'frame' });
  const op = pasted.project.animations[0].frames[1].cels.find(c => c.layerId === pasted.layerId).source.ops[0];
  assert.deepEqual([op.width, op.height], [6, 3]);
  // Doubling the part's width keeps the instance at 1.5× and the artwork in place.
  const grown = growPart(resized, 'box', { right: 4 });
  const after = grown.animations[0].frames[0].cels[0].source.ops[0];
  assert.deepEqual([after.x, after.y, after.width, after.height], [1, 3, 12, 3]);
  assert.deepEqual(rows(grown, 0, { x: 1, y: 3, width: 6, height: 3 }), rows(resized, 0, { x: 1, y: 3, width: 6, height: 3 }));
});

test('a stroke repeats on another frame by footprint, or by recoloring each frame', () => {
  const base = [-1, 1, 2, -1], edited = [3, 3, 2, -1], other = [2, -1, 1, 4];
  assert.deepEqual(changedIndices(base, edited), [0, 1]);
  assert.deepEqual(repeatPixelChanges([0, 1, 3], edited, other), [3, 3, 1, -1]);
  assert.deepEqual(repeatPixelChanges([0, 2], edited, other, v => v + 10), [12, -1, 11, 4]);
});

const canvas = (p, frame = 0) => compositeFrame(p, p.animations[0].frames[frame]);
const withOp = (p, change) => { const q = structuredClone(p); for (const f of q.animations[0].frames) change(f.cels[0].source.ops[0]); return validateProject(q); };

test('the 8 lossless orientations form a closed group of pixel permutations', () => {
  for (const a of TRANSFORM_NAMES) for (const b of TRANSFORM_NAMES) assert.ok(TRANSFORM_NAMES.includes(composeTransform(a, b)), `${a}·${b}`);
  assert.equal(['R90', 'R90', 'R90', 'R90'].reduce(composeTransform, 'N'), 'N');
  assert.equal(composeTransform('R90', 'FX'), 'R90FX');
  assert.equal(composeTransform('FX', 'FX'), 'N');
  for (const t of TRANSFORM_NAMES) {
    const seen = new Set();
    for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) { const q = transformPoint(t, 3, 2, x, y); seen.add(`${q.x},${q.y}`); }
    assert.equal(seen.size, 6, t);
  }
  const { p } = scene(), transposed = canvas(withOp(p, op => { op.transform = 'R90FX'; }));
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) assert.equal(transposed[(2 + y) * 16 + 2 + x], canvas(p)[(2 + x) * 16 + 2 + y]);
});

test('quarter turns and flips are lossless, keep the centre and undo exactly', () => {
  const { p, target } = scene(), items = [{ layerId: target.layerId, key: 'b' }];
  const once = turnObjects(p, target, items, 'R90');
  assert.equal(once.animations[0].frames[1].cels[0].source.ops[0].transform, 'R90');
  assert.deepEqual(canvas(once), canvas(withOp(p, op => { op.transform = 'R90'; })));
  let back = once; for (let i = 0; i < 3; i++) back = turnObjects(back, target, items, 'R90');
  assert.deepEqual(back, p);
  assert.deepEqual(turnObjects(turnObjects(p, target, items, 'FY'), target, items, 'FY'), p);
  // A 4×3 box turns into a 3×4 box about the same centre and returns after a full turn.
  const flat = resizeObject(p, target, 'b', { x: 2, y: 2, width: 4, height: 3 }, 'frame');
  const turned = turnObjects(flat, target, items, 'R90', 'frame');
  assert.deepEqual(objectBounds(turned, celObjects(turned.animations[0].frames[0].cels[0])[0]), { x: 2, y: 2, width: 3, height: 4 });
  let full = turned; for (let i = 0; i < 3; i++) full = turnObjects(full, target, items, 'R90', 'frame');
  assert.deepEqual(full, flat);
});

test('free rotation samples the untouched part and turns back exactly', () => {
  const { p, target } = scene(), items = [{ layerId: target.layerId, key: 'b' }];
  // 90° about the centre of a square lands on the same pixels as the lossless R90 transform.
  assert.deepEqual(canvas(rotateObjects(p, target, items, 90)), canvas(withOp(p, op => { op.transform = 'R90'; })));
  const tilted = rotateObjects(p, target, items, 30), op = tilted.animations[0].frames[1].cels[0].source.ops[0];
  assert.equal(op.angle, 30);
  assert.deepEqual(tilted.parts, p.parts);
  const px = canvas(tilted), box = objectBounds(tilted, celObjects(tilted.animations[0].frames[0].cels[0])[0]);
  assert.ok(box.width > 4 && box.height > 4);
  px.forEach((v, i) => {
    if (v < 0) return;
    const x = i % 16, y = Math.floor(i / 16);
    assert.ok(x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height);
    assert.equal(hitTestObject(tilted, tilted.animations[0], tilted.animations[0].frames[0], x, y)?.key, 'b');
  });
  assert.deepEqual(rotateObjects(tilted, target, items, -30), p);
  // Flipping a tilted object mirrors it exactly: the flip negates the angle.
  const mirrored = canvas(turnObjects(tilted, target, items, 'FX'));
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) assert.equal(mirrored[y * 16 + x], px[y * 16 + (2 * 2 + 4 - 1 - x)] ?? -1);
  // PXA round trip keeps the angle and the new orientations.
  const both = withOp(tilted, o => { o.transform = 'R270FX'; });
  const decoded = decodeAIProject(encodeAIProject(both));
  assert.deepEqual(decoded.animations[0].frames[0].cels[0].source.ops[0], both.animations[0].frames[0].cels[0].source.ops[0]);
  assert.equal(copyObject(tilted, target, 'b').instance.angle, 30);
  assert.throws(() => resizeObject(tilted, target, 'b', { x: 2, y: 2, width: 4, height: 2 }), /rotation/);
});

test('growing a part keeps a rotated instance in place', () => {
  const { p, target } = scene(), items = [{ layerId: target.layerId, key: 'b' }];
  const turned = rotateObjects(p, target, items, 90), before = canvas(turned);
  assert.deepEqual(canvas(growPart(turned, 'box', { left: 2 })), before);
});
