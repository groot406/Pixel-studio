import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { blankProject, validateProject, compositeFrame } from '../src/domain/project.js';
import { MAX_LAYERS, MAX_TOTAL_PIXELS } from '../src/domain/limits.js';
import { projectCapacity } from '../src/domain/project-capacity.js';
import { addObjectContainer } from '../src/domain/objects.js';
import { createObjectFromPixels } from '../src/domain/object-create.js';
import { copyObject, pasteObject } from '../src/domain/object-clipboard.js';
import { decodeAIProject, encodeAIProject } from '../src/formats/pxa.js';
import { encodePixelProject, decodePixelProject } from '../src/formats/pxs.js';
import { projectLimitsMarkup } from '../src/editor/project-limits.js';

function layeredProject(count, width = 2, height = 1) {
  const p = blankProject('Capacity', width, height);
  p.layers = Array.from({ length: count }, (_, i) => ({ id: `layer-${String(i).padStart(94, 'x')}`, name: `Layer ${i}`, visible: true, locked: false, group: false }));
  p.animations[0].frames[0].cels = p.layers.map((layer, i) => ({ layerId: layer.id, pixels: Array(width * height).fill(i % p.palette.length) }));
  return p;
}
const target = p => ({ animationId: p.animations[0].id, frameId: p.animations[0].frames[0].id, layerId: p.layers[0].id });

test('objects can use 320 containers, with a clear error on the next allocation', () => {
  assert.equal(MAX_LAYERS, 320);
  const p = layeredProject(319);
  const added = addObjectContainer(p, p.layers[0].id, 'Last layer').project;
  assert.equal(added.layers.length, 320);
  assert.equal(p.layers.length, 319);
  assert.throws(() => addObjectContainer(added, added.layers[0].id, 'Too many'), /Layer limit reached \(320\/320\).*Group or merge/);
  assert.throws(() => validateProject(layeredProject(321)), /1–320 layers/);
  const clipboard = copyObject(p, target(p), '@group');
  assert.equal(pasteObject(p, target(p), clipboard).project.layers.length, 320);
  assert.throws(() => pasteObject(added, target(added), clipboard), /Layer limit reached/);
  assert.throws(() => createObjectFromPixels(added, target(added), { mask: [0] }), /Layer limit reached/);
});

test('the pixel budget counts hidden layers, transparent cels and all animations independently of the layer limit', () => {
  const p = layeredProject(1, 1024, 1024);
  p.layers[0].visible = false;
  p.animations[0].frames[0].cels[0].pixels.fill(-1);
  p.animations.push({ ...structuredClone(p.animations[0]), id: 'second-animation', frames: Array.from({ length: 3 }, (_, i) => ({ ...structuredClone(p.animations[0].frames[0]), id: `second-${i}` })) });
  assert.deepEqual(projectCapacity(p), { frames: 4, layers: 1, storedPixels: MAX_TOTAL_PIXELS, nextLayerPixels: MAX_TOTAL_PIXELS * 2 });
  assert.doesNotThrow(() => validateProject(p));
  assert.throws(() => addObjectContainer(p, p.layers[0].id, 'Too big'), /Project pixel limit reached: 4,194,304 of 4,194,304 pixels used.*8,388,608 pixels total \(1024 × 1024 × 4 frames × 2 layers\)/);
});

for (const version of [1, 2]) test(`PXA ${version} round trips 320 layers and complete stack orders`, () => {
  const p = layeredProject(320);
  const a = p.animations[0], f = a.frames[0];
  a.layerOrder = p.layers.map(l => l.id).reverse();
  f.layerOrder = [...a.layerOrder.slice(1), a.layerOrder[0]];
  const text = encodeAIProject(p, { version });
  if (version === 2) assert.ok(text.match(/^ORDER .+$/m)[0].length > 4096);
  const result = decodeAIProject(text);
  assert.equal(result.layers.length, 320);
  assert.deepEqual(compositeFrame(result, result.animations[0].frames[0]), compositeFrame(p, f));
  assert.deepEqual(result.animations[0].frames[0].cels.map(c => c.pixels), f.cels.map(c => c.pixels));
  if (version === 2) {
    assert.deepEqual(result.animations[0].layerOrder, a.layerOrder);
    assert.deepEqual(result.animations[0].frames[0].layerOrder, f.layerOrder);
  }
});

for (const [count, width] of [[255, 2], [256, 2], [320, 2], [320, 600]]) test(`PXS round trips ${count} layers at width ${width} without truncating counts or indices`, async () => {
  const p = layeredProject(count, width);
  const a = p.animations[0], f = a.frames[0];
  a.layerOrder = p.layers.map(l => l.id).reverse();
  f.layerOrder = [...a.layerOrder.slice(1), a.layerOrder[0]];
  const bytes = await encodePixelProject(p);
  const payload = bytes[5] ? gunzipSync(bytes.subarray(20)) : bytes.subarray(20);
  assert.equal(payload[0], count > 255 ? 6 : 4);
  const result = await decodePixelProject(bytes);
  assert.equal(result.layers.length, count);
  assert.deepEqual(result.animations[0].layerOrder, a.layerOrder);
  assert.deepEqual(result.animations[0].frames[0].layerOrder, f.layerOrder);
  assert.deepEqual(result.animations[0].frames[0].cels, f.cels);
  assert.deepEqual(compositeFrame(result, result.animations[0].frames[0]), compositeFrame(p, f));
});

test('the limits page explains current usage and the remaining pixel constraint', () => {
  const markup = projectLimitsMarkup(layeredProject(320));
  assert.match(markup, /320 \/ 320/);
  assert.match(markup, /640 \/ 4,194,304/);
  assert.match(markup, /The layer limit is already reached/);
  assert.match(markup, /transparent pixels and hidden layers/);
  assert.match(markup, /Cloud storage is a separate limit/);
});

function rawContainer(template, payload) {
  const bytes = new Uint8Array(20 + payload.length);
  bytes.set(template.subarray(0, 20)); bytes[5] = 0; bytes.set(payload, 20);
  const header = new DataView(bytes.buffer);
  header.setUint32(8, payload.length, true); header.setUint32(12, payload.length, true);
  let crc = 0xffffffff;
  for (const value of payload) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  header.setUint32(16, (crc ^ 0xffffffff) >>> 0, true);
  return bytes;
}

test('PXS schema 6 rejects excess layer counts and corrupt 16-bit stack indices', async () => {
  const p = layeredProject(320), bytes = await encodePixelProject(p);
  const original = bytes[5] ? new Uint8Array(gunzipSync(bytes.subarray(20))) : bytes.slice(20);
  const excess = original.slice();
  new DataView(excess.buffer).setUint16(6, 321, true);
  await assert.rejects(decodePixelProject(rawContainer(bytes, excess)), /1–320 layers/);
  const view = new DataView(original.buffer);
  let offset = 9;
  const skipString = () => { offset += 2 + view.getUint16(offset, true); };
  skipString(); offset += p.palette.length * 3;
  for (const _layer of p.layers) { skipString(); skipString(); offset++; }
  skipString(); skipString(); offset += 8 + 2;
  for (const index of [0, 320]) {
    const corrupt = original.slice();
    new DataView(corrupt.buffer).setUint16(offset + 2, index, true);
    await assert.rejects(decodePixelProject(rawContainer(bytes, corrupt)), /Animation layer order/);
  }
});
