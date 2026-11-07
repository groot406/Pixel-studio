import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProject, blankProject } from '../src/domain/project.js';
import { rampFromPalette, darkerMap } from '../src/domain/colour.js';
import { selOut, autoShade, pixelPerfect } from '../src/domain/pixel-fx.js';
import { rampsForPalette, gradientStops, applyPixelEffect, applyGradient, addShadingRamp, colourCycle, strokePoints, toolLinePoints, tileSeams } from '../src/domain/effects.js';

const W = 16;
/** 16×16, frames f0..f(n-1), layer L; a 6×6 square of colour 9 at (5,5) — raster, or a placed part when `retained`. */
function scene(n = 2, { retained = false, locked = false } = {}) {
  const p = blankProject('fx', W, W), a = p.animations[0];
  a.id = 'A'; p.layers[0].id = 'L';
  const square = Array(W * W).fill(-1);
  for (let y = 5; y < 11; y++) for (let x = 5; x < 11; x++) square[y * W + x] = 9;
  a.frames = Array.from({ length: n }, (_, k) => ({ id: `f${k}`, duration: 100, cels: [{ layerId: 'L', pixels: [...square] }] }));
  if (retained) {
    p.version = 3;
    p.parts = [{ id: 'sq', width: 6, height: 6, ops: [{ type: 'rect', x: 0, y: 0, width: 6, height: 6, color: 9 }] }];
    for (const f of a.frames) f.cels[0].source = { ops: [{ type: 'use', id: 'o', partId: 'sq', x: 5, y: 5, transform: 'N', ...(locked ? { name: 'sq', visible: true, locked: true } : {}) }], overrides: [] };
  }
  return validateProject(p);
}
const T = { animationId: 'A', frameId: 'f0', layerId: 'L' };
const cel = (p, k = 0) => p.animations[0].frames[k].cels[0];
const at = (p, x, y, k = 0) => cel(p, k).pixels[y * W + x];

test('palette helpers feed exactly what selOut and autoShade expect', () => {
  const { palette } = scene(), ramps = rampsForPalette(palette);
  assert.ok(ramps instanceof Map && ramps.size === palette.length);
  assert.deepEqual(ramps.get(9), rampFromPalette(palette, 9));
  const px = cel(scene()).pixels;
  assert.deepEqual(selOut(px, W, W, { ramps }), selOut(px, W, W, { ramps: Object.fromEntries(ramps) }));
  assert.notDeepEqual(autoShade(px, W, W, { ramps, light: { x: -1, y: -1 } }), px);
  assert.equal(selOut(px, W, W, { darkenMap: darkerMap(palette) })[4 * W + 7], darkerMap(palette).get(9));
  assert.deepEqual(gradientStops(palette, 8, 10), [8, 9, 10]);
  assert.deepEqual(gradientStops(palette, 0, 12), [0, 12]);
});

test('applyPixelEffect writes raster pixels, or local edits that keep retained objects', () => {
  const r = applyPixelEffect(scene(), T, 'outline', { color: 0 });
  assert.deepEqual([r.frameIds, r.skipped, at(r.project, 4, 4), at(r.project, 5, 5), at(r.project, 4, 4, 1)], [['f0'], 0, 0, 9, -1]);
  const retained = applyPixelEffect(scene(2, { retained: true }), { ...T, scope: 'animation' }, 'selOut', { light: { x: -1, y: -1 } });
  assert.deepEqual(retained.frameIds, ['f0', 'f1']);
  const c = cel(retained.project, 1);
  assert.equal(c.source.ops[0].type, 'use');
  assert.ok(c.source.overrides.length > 0);
  assert.equal(at(retained.project, 7, 11, 1), darkerMap(retained.project.palette).get(9));
  assert.equal(at(retained.project, 7, 4, 1), -1, 'lit side omitted');
  // A selection limits the effect.
  const limited = applyPixelEffect(scene(), { ...T, rect: { x: 0, y: 0, width: 8, height: 16 } }, 'outline', { color: 0 });
  assert.deepEqual([at(limited.project, 4, 7), at(limited.project, 11, 7)], [0, -1]);
  for (const [effect, options] of [['innerGlow', { color: 3 }], ['rimLight', { color: 4, light: { x: 0, y: -1 } }], ['autoShade', { light: { x: -1, y: -1 } }], ['offsetWrap', {}], ['dither', { a: 1, b: 2, ratio: 0.5, region: 'opaque' }]])
    assert.deepEqual(applyPixelEffect(scene(), T, effect, options).frameIds, ['f0'], effect);
  assert.equal(at(applyPixelEffect(scene(), T, 'offsetWrap', {}).project, 13, 13), 9);
  assert.deepEqual(applyPixelEffect(scene(), T, 'cleanup', {}).frameIds, [], 'nothing to clean in a solid square');
});

test('applyPixelEffect respects locks', () => {
  const locked = scene(2, { retained: true, locked: true });
  assert.throws(() => applyPixelEffect(locked, T, 'outline', { color: 0 }), /Unlock/);
  assert.deepEqual(applyPixelEffect(locked, { ...T, scope: 'animation' }, 'outline', { color: 0 }).skipped, 2);
  const p = scene(); p.layers[0].locked = true;
  assert.throws(() => applyPixelEffect(p, T, 'outline', { color: 0 }), /unlocked/);
  assert.throws(() => applyPixelEffect(scene(), T, 'sparkle', {}), /Unknown effect/);
  assert.throws(() => applyPixelEffect(scene(), T, 'outline', {}), /Outline color/);
});

test('applyGradient fills a flood region or selection with palette stops', () => {
  const g = applyGradient(scene(), T, { region: 'flood', seed: { x: 6, y: 6 }, from: { x: 5, y: 0 }, to: { x: 10, y: 0 }, fromIndex: 8, toIndex: 10 });
  assert.deepEqual([at(g.project, 5, 7), at(g.project, 10, 7), at(g.project, 0, 0)], [8, 10, -1]);
  const dithered = applyGradient(scene(), { ...T, rect: { x: 0, y: 0, width: 16, height: 4 } }, { region: 'mask', from: { x: 0, y: 0 }, to: { x: 15, y: 0 }, colors: [1, 2], style: 'dither' });
  const row = Array.from({ length: 16 }, (_, x) => at(dithered.project, x, 1));
  assert.ok(row.includes(1) && row.includes(2) && at(dithered.project, 0, 8) === -1);
});

test('addShadingRamp adds hue-shifted colours and colourCycle animates them', () => {
  const { project, indices, colours } = addShadingRamp(scene(), 9, { steps: 5, hueShift: 30 });
  assert.equal(indices.length, 5);
  assert.equal(project.palette[indices[2]], scene().palette[9]);
  assert.equal(colours.length, 5);
  const ramp = [9, 10, 11];
  const cycled = colourCycle(scene(3), { animationId: 'A', rampIndices: ramp });
  assert.deepEqual([0, 1, 2].map(k => at(cycled.project, 6, 6, k)), [9, 10, 11]);
  assert.equal(cycled.loopLength, 3);
  const loop = colourCycle(scene(2, { retained: true }), { animationId: 'A', frameId: 'f0', rampIndices: ramp, frames: 'loop' });
  assert.deepEqual(loop.project.animations[0].frames.map(f => f.id).at(-1), 'f1');
  assert.deepEqual(loop.frameIds.length, 3);
  assert.deepEqual([0, 1, 2].map(k => at(loop.project, 6, 6, k)), [9, 10, 11]);
  assert.ok(cel(loop.project, 2).source.overrides.length);
  assert.throws(() => colourCycle(scene(), { animationId: 'A', rampIndices: [9] }), /two/);
});

test('tool helpers: pixel-perfect, wrap-around and clean-slope points', () => {
  const stroke = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }];
  assert.deepEqual(strokePoints(stroke, { pixelPerfect: true }), pixelPerfect(stroke));
  assert.deepEqual(strokePoints([{ x: -1, y: 17 }], { wrap: true, width: W, height: W }), [{ x: 15, y: 1 }]);
  const line = toolLinePoints(0, 0, 7, 3, { clean: true });
  assert.deepEqual(line.slice(0, 4), [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 1 }]);
  assert.equal(toolLinePoints(14, 0, 17, 0, { wrap: true, width: W, height: W }).at(-1).x, 1);
  assert.equal(tileSeams(cel(scene()).pixels, W, W), 0);
});
