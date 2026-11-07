import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAIProject } from '../src/formats/pxa.js';
import { validateProject, compositeFrame, blankProject } from '../src/domain/project.js';
import { celObjects } from '../src/domain/objects.js';
import { createObjectFromPixels, splitIntoObjects, partIdFromName } from '../src/domain/object-create.js';
import { connectedRegion, findIslands, shadeIndex, pixelPerfectStep, ditherCell } from '../src/domain/toolbox.js';
import { sparklePxa } from './fixtures/pxa-v2.mjs';

function scene(frames = 1) {
  const p = blankProject('t', 8, 8);
  const a = p.animations[0];
  while (a.frames.length < frames) a.frames.push({ ...structuredClone(a.frames[0]), id: `f${a.frames.length}` });
  for (const f of a.frames) {
    const px = f.cels[0].pixels;
    px[1 * 8 + 1] = 2; px[1 * 8 + 2] = 2; px[2 * 8 + 2] = 3; // shape A
    px[5 * 8 + 6] = 4; // shape B
  }
  const v = validateProject(p);
  return { p: v, target: { animationId: v.animations[0].id, frameId: v.animations[0].frames[0].id, layerId: v.layers[0].id } };
}

test('making an object from a selection trims it, keeps the image and leaves unselected pixels', () => {
  const { p, target } = scene();
  const before = compositeFrame(p, p.animations[0].frames[0]);
  const r = createObjectFromPixels(p, target, { rect: { x: 0, y: 0, width: 4, height: 4 }, name: 'Left Eye' });
  assert.deepEqual(compositeFrame(r.project, r.project.animations[0].frames[0]), before);
  const part = r.project.parts.find(x => x.id === 'left-eye');
  assert.deepEqual([part.width, part.height], [2, 2]);
  assert.notEqual(r.layerId, target.layerId, 'ungrouped artwork gets its own object');
  const op = r.project.animations[0].frames[0].cels.find(c => c.layerId === r.layerId).source.ops.at(-1);
  assert.deepEqual([op.type, op.x, op.y, op.name, op.id], ['use', 1, 1, 'Left Eye', r.key]);
  const rest = r.project.animations[0].frames[0].cels.find(c => c.layerId === target.layerId).pixels;
  assert.equal(rest[1 * 8 + 1], -1); assert.equal(rest[5 * 8 + 6], 4);
  assert.throws(() => createObjectFromPixels(p, target, { rect: { x: 4, y: 0, width: 2, height: 2 } }), /empty/);
});

test('every-frame objects share identical parts and source objects emptied everywhere are removed', () => {
  const { p, target } = scene(3);
  p.animations[0].frames[2].cels[0].pixels[1 * 8 + 1] = 5;
  const r = createObjectFromPixels(validateProject(p), target, { rect: { x: 0, y: 0, width: 8, height: 8 }, name: 'Hero', scope: 'animation' });
  assert.equal(r.frames, 3); assert.equal(r.parts, 2);
  assert.equal(r.project.layers.length, 1, 'the emptied source object is removed');
  const ids = r.project.animations[0].frames.map(f => f.cels[0].source.ops.find(o => o.type === 'use'));
  assert.ok(ids.every(o => o.id === r.key));
  assert.equal(ids[0].partId, ids[1].partId); assert.notEqual(ids[0].partId, ids[2].partId);
});

test('mask selections and grouped artwork keep objects in the same group', () => {
  const p = decodeAIProject(sparklePxa), t = { animationId: 'idle', frameId: 'f0', layerId: 'effects' };
  const before = compositeFrame(p, p.animations[0].frames[0]);
  const cel = p.animations[0].frames[0].cels[1];
  const index = cel.pixels.findIndex(v => v >= 0);
  const r = createObjectFromPixels(p, t, { mask: [index], name: 'Dot' });
  assert.equal(r.layerId, 'effects');
  assert.deepEqual(compositeFrame(r.project, r.project.animations[0].frames[0]), before);
  assert.ok(celObjects(r.project.animations[0].frames[0].cels[1]).some(n => n.key === r.key));
});

test('split into objects makes a group with one object per separate shape', () => {
  const { p, target } = scene();
  const key = celObjects(p.animations[0].frames[0].cels[0])[0]?.key ?? 'pixels-0';
  const before = compositeFrame(p, p.animations[0].frames[0]);
  const r = splitIntoObjects(p, target, key, { name: 'Gem' });
  assert.equal(r.keys.length, 2);
  const group = r.project.layers.find(l => l.id === r.layerId);
  assert.equal(group.group, true); assert.equal(group.name, 'Gem');
  assert.deepEqual(compositeFrame(r.project, r.project.animations[0].frames[0]), before);
  assert.deepEqual(r.project.parts.map(x => [x.id, x.width, x.height]), [['gem-1', 2, 2], ['gem-2', 1, 1]]);
});

test('wand regions, islands, shading, dither and pixel-perfect strokes', () => {
  const px = [0, 0, -1, -1, 0, 1, -1, 2, -1, -1, -1, 2];
  assert.deepEqual(connectedRegion(px, 4, 3, 0, 0, 'shape').indices, [0, 1, 4, 5]);
  assert.deepEqual(connectedRegion(px, 4, 3, 0, 0, 'color').indices, [0, 1, 4]);
  assert.equal(connectedRegion(px, 4, 3, 2, 0), null);
  assert.deepEqual(findIslands(px, 4, 3).map(i => i.indices.length), [4, 2]);
  assert.deepEqual(connectedRegion([0, -1, -1, 0], 2, 2, 0, 0).indices, [0, 3], 'diagonal pixels are one shape');
  const palette = ['#000000', '#444444', '#888888', '#ff0000'];
  assert.equal(shadeIndex(palette, 2, -1), 1); assert.equal(shadeIndex(palette, 1, 1), 2);
  assert.equal(shadeIndex(palette, 0, -1), 0);
  assert.ok(ditherCell(0, 0) && !ditherCell(1, 0) && ditherCell(1, 1));
  const path = [];
  assert.equal(pixelPerfectStep(path, { x: 0, y: 0 }), null);
  assert.equal(pixelPerfectStep(path, { x: 1, y: 0 }), null);
  assert.deepEqual(pixelPerfectStep(path, { x: 1, y: 1 }), { x: 1, y: 0 });
  assert.deepEqual(path, [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  assert.equal(partIdFromName('  Left Eye! '), 'left-eye');
});

test('masked selections move only their own pixels', async () => {
  const { moveMaskedPixels, maskBounds } = await import('../src/domain/selection.js');
  const px = [1, 2, -1, 3, -1, -1, -1, -1, -1];
  const r = moveMaskedPixels(px, 3, 3, [0, 3], 1, 0);
  assert.deepEqual(r.pixels, [-1, 1, -1, -1, 3, -1, -1, -1, -1].map((v, i) => i === 1 ? 1 : v));
  assert.deepEqual(r.mask, [1, 4]);
  assert.deepEqual(maskBounds([1, 4], 3), { x: 1, y: 0, width: 1, height: 2 });
  assert.equal(moveMaskedPixels(px, 3, 3, [0, 3], 5, 0).dx, 2, 'moves clamp at the canvas edge');
});
