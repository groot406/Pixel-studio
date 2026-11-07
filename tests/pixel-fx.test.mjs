import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceField, outline, selOut, innerGlow, rimLight, autoShade, BAYER, ditherMix, ditherGradient,
  pixelPerfect, cleanupDoubles, snapSlope, cleanLinePoints, smear, wrapPoint, wrapPoints, offsetWrap,
  seamScore, applyMask, selectionMask, gradientFill, gradientStopsBetween, floodRegion,
} from '../src/domain/pixel-fx.js';

/** Rows of '.' (transparent) and digits (palette indices). */
const grid = (...rows) => rows.join('').split('').map((c) => (c === '.' ? -1 : Number(c)));
const show = (pixels, w) => Array.from({ length: pixels.length / w }, (_, y) => pixels.slice(y * w, y * w + w).map((v) => (v === -1 ? '.' : v)).join(''));

test('distance field is exact for every metric, inside and outside, with edge modes', () => {
  const dot = grid('.....', '.....', '..1..', '.....', '.....');
  const outside = (metric) => show(Array.from(distanceField(dot, 5, 5, { metric, inside: false })), 5);
  assert.deepEqual(outside('chebyshev'), ['22222', '21112', '21012', '21112', '22222']);
  assert.deepEqual(outside('manhattan'), ['43234', '32123', '21012', '32123', '43234']);
  const e = distanceField(dot, 5, 5, { metric: 'euclidean', inside: false });
  assert.equal(e[0], Math.hypot(2, 2));
  assert.equal(e[1 * 5 + 2], 1);
  const block = Array(25).fill(1);
  assert.deepEqual(show(Array.from(distanceField(block, 5, 5)), 5), ['11111', '12221', '12321', '12221', '11111']);
  assert.ok(distanceField(block, 5, 5, { edge: 'clamp' }).every((d) => d === Infinity));
  const hole = block.slice(); hole[0] = -1;
  assert.equal(distanceField(hole, 5, 5, { edge: 'wrap', metric: 'manhattan' })[4 * 5 + 4], 2);
  assert.equal(distanceField(hole, 5, 5, { edge: 'clamp', metric: 'manhattan' })[4 * 5 + 4], 8);
  assert.throws(() => distanceField(dot, 5, 5, { metric: 'cosine' }), /metric/);
});

test('outline supports thickness, corners, and inside mode', () => {
  const dot = grid('.....', '.....', '..1..', '.....', '.....');
  assert.deepEqual(show(outline(dot, 5, 5, { color: 7 }), 5), ['.....', '.777.', '.717.', '.777.', '.....']);
  assert.deepEqual(show(outline(dot, 5, 5, { color: 7, corners: false }), 5), ['.....', '..7..', '.717.', '..7..', '.....']);
  assert.deepEqual(show(outline(dot, 5, 5, { color: 7, thickness: 2 }), 5), ['77777', '77777', '77177', '77777', '77777']);
  const block = Array(25).fill(1);
  assert.deepEqual(show(outline(block, 5, 5, { color: 7, mode: 'inside' }), 5), ['77777', '71117', '71117', '71117', '77777']);
  assert.throws(() => outline(dot, 5, 5, { color: -1 }), /Outline color/);
});

test('selective outline uses the darker map and omits or lightens the lit side', () => {
  const art = grid('.....', '.12..', '.12..', '.....');
  const darkenMap = new Map([[1, 3], [2, 4]]);
  const dark = selOut(art, 5, 4, { darkenMap });
  assert.deepEqual(show(dark, 5), ['.34..', '3124.', '3124.', '.34..']);
  const lit = selOut(art, 5, 4, { darkenMap, light: { x: -1, y: -1 } });
  assert.deepEqual(show(lit, 5), ['.....', '.124.', '.124.', '.34..']);
  const ramps = new Map([[1, [0, 1, 5]], [2, [0, 2, 6]]]);
  assert.deepEqual(show(selOut(art, 5, 4, { ramps, light: { x: 0, y: -1 }, lit: 'lighter' }), 5), ['.56..', '0120.', '0120.', '.00..']);
  assert.throws(() => selOut(art, 5, 4, {}), /darkenMap/);
});

test('rim light only lights pixels facing the light; inner glow follows the edge', () => {
  const block = grid('.....', '.111.', '.111.', '.111.', '.....');
  assert.deepEqual(show(rimLight(block, 5, 5, { color: 9, light: { x: -1, y: 0 } }), 5), ['.....', '.911.', '.911.', '.911.', '.....']);
  assert.deepEqual(show(rimLight(block, 5, 5, { color: 9, light: { x: 1, y: -1 }, size: 2 }), 5), ['.....', '.999.', '.999.', '.199.', '.....']);
  assert.deepEqual(show(innerGlow(block, 5, 5, { color: 8 }), 5), ['.....', '.888.', '.818.', '.888.', '.....']);
});

test('autoShade lights the lit edge, darkens the far edge, leaves transparency', () => {
  const w = 7, art = grid('.......', '.11111.', '.11111.', '.11111.', '.11111.', '.11111.', '.......');
  const ramp = [10, 11, 12, 13, 14];
  const out = autoShade(art, w, w, { ramps: new Map([[1, ramp]]), light: { x: -1, y: -1 } });
  const step = (x, y) => ramp.indexOf(out[y * w + x]);
  assert.ok(step(1, 1) > step(5, 5));
  assert.ok(step(1, 3) > step(5, 3));
  assert.ok(out.every((v, i) => (art[i] === -1 ? v === -1 : ramp.includes(v))));
  assert.deepEqual(out, autoShade(art, w, w, { ramps: new Map([[1, ramp]]), light: { x: -1, y: -1 } }));
});

test('Bayer dithering gives a checkerboard at 50% and pure gradient ends', () => {
  assert.deepEqual(BAYER[2], [[0, 2], [3, 1]]);
  assert.equal(new Set(BAYER[8].flat()).size, 64);
  const cells = [0, 1, 2, 3].map((y) => [0, 1, 2, 3].map((x) => ditherMix(1, 2, 0.5, x, y, 2)).join(''));
  assert.deepEqual(cells, ['2121', '1212', '2121', '1212']);
  const g = ditherGradient(9, 2, { from: { x: 0, y: 0 }, to: { x: 8, y: 0 }, colors: [3, 4, 5] });
  assert.deepEqual([g[0], g[9], g[8], g[17]], [3, 3, 5, 5]);
  const r = ditherGradient(9, 9, { from: { x: 4, y: 4 }, to: { x: 8, y: 4 }, colors: [1, 2], shape: 'radial', mask: selectionMask({ x: 0, y: 0, width: 9, height: 5 }, 9, 9) });
  assert.equal(r[4 * 9 + 4], 1);
  assert.equal(r[8 * 9 + 4], -1);
});

test('gradientFill: bands, dither, shapes, repeat, flood regions, palette-only output', () => {
  const blank = Array(8).fill(-1);
  const bands = gradientFill(blank, 8, 1, { from: { x: 0, y: 0 }, to: { x: 7, y: 0 }, colors: [1, 2] });
  assert.deepEqual(bands, [1, 1, 1, 1, 2, 2, 2, 2]);
  const dith = gradientFill(blank, 8, 1, { from: { x: 0, y: 0 }, to: { x: 7, y: 0 }, colors: [1, 2], style: 'dither' });
  assert.equal(dith[0], 1); assert.equal(dith[7], 2);
  const fade = gradientFill(blank, 8, 1, { from: { x: 0, y: 0 }, to: { x: 7, y: 0 }, colors: [5, -1], style: 'dither' });
  assert.equal(fade[7], -1);
  const radial = gradientFill(Array(81).fill(0), 9, 9, { from: { x: 4, y: 4 }, to: { x: 8, y: 4 }, colors: [1, 2, 3], shape: 'radial' });
  assert.equal(radial[40], 1); assert.equal(radial[0], 3);
  const diamond = gradientFill(Array(81).fill(0), 9, 9, { from: { x: 4, y: 4 }, to: { x: 8, y: 4 }, colors: [1, 2], shape: 'diamond' });
  assert.equal(diamond[4 * 9 + 6], 2); assert.equal(diamond[3 * 9 + 4], 1);
  const angle = gradientFill(Array(81).fill(0), 9, 9, { from: { x: 4, y: 4 }, to: { x: 8, y: 4 }, colors: [1, 2], shape: 'angle' });
  assert.equal(angle[4 * 9 + 8], 1); assert.equal(angle[4 * 9 + 0], 2);
  const long = Array(12).fill(-1), opts = { from: { x: 0, y: 0 }, to: { x: 3, y: 0 }, colors: [1, 2, 3, 4] };
  assert.deepEqual(gradientFill(long, 12, 1, opts), [1, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
  assert.deepEqual(gradientFill(long, 12, 1, { ...opts, repeat: 'repeat' }).slice(0, 8), [1, 2, 3, 1, 2, 3, 1, 2]);
  assert.deepEqual(gradientFill(long, 12, 1, { ...opts, repeat: 'mirror' }).slice(0, 8), [1, 2, 3, 4, 3, 2, 1, 2]);
  const art = grid('00900', '00900', '00900');
  const filled = gradientFill(art, 5, 3, { region: 'flood', seed: { x: 0, y: 0 }, from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, colors: [6, 7] });
  assert.deepEqual(show(filled, 5), ['67900', '67900', '67900']);
  const all = gradientFill(art, 5, 3, { from: { x: 0, y: 0 }, to: { x: 4, y: 2 }, colors: [6, 7, 8], style: 'dither', matrix: 8 });
  assert.ok(all.every((v) => [6, 7, 8].includes(v)));
  assert.throws(() => gradientFill(art, 5, 3, { region: 'mask', from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, colors: [1] }), /needs a mask/);
  assert.deepEqual(gradientStopsBetween([0, 3, 5, 7, 9], 7, 3), [7, 5, 3]);
  assert.throws(() => gradientStopsBetween([0, 3], 0, 4), /ramp/);
});

test('floodRegion is a 4-connected bucket region, or global by colour', () => {
  const art = grid('1.1', '.1.', '1.1');
  assert.deepEqual(Array.from(floodRegion(art, 3, 3, { x: 1, y: 1 })), [0, 0, 0, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(floodRegion(art, 3, 3, { x: 1, y: 0 })), [0, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(floodRegion(art, 3, 3, { x: 1, y: 1 }, { contiguous: false })), [1, 0, 1, 0, 1, 0, 1, 0, 1]);
});

test('pixelPerfect drops L corners but keeps straight and diagonal lines', () => {
  const pts = (...a) => a.map(([x, y]) => ({ x, y }));
  assert.deepEqual(pixelPerfect(pts([0, 0], [1, 0], [1, 1], [2, 1], [2, 2])), pts([0, 0], [1, 1], [2, 2]));
  const straight = pts([0, 0], [1, 0], [2, 0], [3, 0]);
  assert.deepEqual(pixelPerfect(straight), straight);
  const diagonal = pts([0, 0], [1, 1], [2, 2]);
  assert.deepEqual(pixelPerfect([...diagonal, { x: 2, y: 2 }]), diagonal);
});

test('cleanupDoubles removes staircase doubles only', () => {
  const stairs = grid('11...', '.11..', '..11.', '...1.');
  assert.deepEqual(show(cleanupDoubles(stairs, 5, 4), 5), ['1....', '.1...', '..1..', '...1.']);
  const box = grid('1111', '1..1', '1..1', '1111');
  assert.deepEqual(cleanupDoubles(box, 4, 4), box);
  const solid = grid('11', '11');
  assert.deepEqual(cleanupDoubles(solid, 2, 2), solid);
  assert.deepEqual(cleanupDoubles(stairs, 5, 4, 2), stairs);
});

test('snapSlope and cleanLinePoints produce uniform runs', () => {
  assert.deepEqual(snapSlope(10, 0), { x: 1, y: 0 });
  assert.deepEqual(snapSlope(0, -5), { x: 0, y: -1 });
  assert.deepEqual(snapSlope(5, 6), { x: 1, y: 1 });
  assert.deepEqual(snapSlope(-10, 5), { x: -2, y: 1 });
  assert.deepEqual(snapSlope(3, -10), { x: 1, y: -3 });
  assert.deepEqual(snapSlope(40, 9), { x: 4, y: 1 });
  const line = cleanLinePoints(0, 0, 7, 3);
  assert.deepEqual(line.map((p) => p.y), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.deepEqual(line.map((p) => p.x), [0, 1, 2, 3, 4, 5, 6, 7]);
  const steep = cleanLinePoints(0, 0, -2, -8);
  assert.equal(steep.length, 8);
  assert.deepEqual(steep.at(-1), { x: -1, y: -7 });
  assert.ok(steep.every((p, i) => p.x === -Math.floor(i / 4) && p.y === -i));
});

test('smear sweeps B back along the motion with B on top', () => {
  const b = grid('.....', '...12', '.....');
  const out = smear(null, b, 5, 3, { offset: { x: 3, y: 0 } });
  assert.deepEqual(show(out, 5), ['.....', '11112', '.....']);
  const solid = smear(null, b, 5, 3, { offset: { x: 3, y: 0 }, color: 7 });
  assert.deepEqual(show(solid, 5), ['.....', '77712', '.....']);
  const a = grid('9....', '.....', '.....');
  assert.equal(smear(a, b, 5, 3, { offset: { x: 3, y: 0 } })[0], 9);
});

test('seamless tile helpers wrap and round-trip', () => {
  assert.deepEqual(wrapPoint(-1, 5, 4, 4), { x: 3, y: 1 });
  assert.deepEqual(wrapPoints([{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 5, y: 0 }], 4, 4), [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  const art = grid('1234', '5678', '9012', '3456');
  const shifted = offsetWrap(art, 4, 4, 2, -1);
  assert.notDeepEqual(shifted, art);
  assert.deepEqual(offsetWrap(shifted, 4, 4, -2, 1), art);
  assert.equal(seamScore(grid('121', '331', '121'), 3, 3), 1);
});

test('masks limit effects to a selection', () => {
  const block = Array(9).fill(1);
  const mask = selectionMask({ x: 0, y: 0, width: 2, height: 1 }, 3, 3);
  assert.deepEqual(Array.from(mask), [1, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(applyMask([0, 0, 0], [5, 5, 5], [1, 0, 1]), [5, 0, 5]);
  assert.deepEqual(show(outline(block, 3, 3, { color: 4, mode: 'inside', mask }), 3), ['441', '111', '111']);
  assert.throws(() => selectionMask({ x: 2, y: 0, width: 2, height: 1 }, 3, 3), /inside the canvas/);
});
