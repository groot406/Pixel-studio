import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProject, compositeFrame, blankProject } from '../src/domain/project.js';
import { resizeObject, objectBounds, hitTestObject, celObjects } from '../src/domain/objects.js';
import { growPart } from '../src/domain/parts.js';
import { sampleIndex } from '../src/domain/geometry.js';
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
