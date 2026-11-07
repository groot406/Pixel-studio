import test from 'node:test';
import assert from 'node:assert/strict';
import { paletteBlend, antialiasStroke, smoothJaggies } from '../src/domain/antialias.js';
import { linePoints } from '../src/domain/geometry.js';
import { renderOperations } from '../src/domain/artwork.js';

// 0 black, 1 dark grey, 2 mid grey, 3 light grey, 4 white, 5 red
const palette = ['#000000', '#404040', '#808080', '#c0c0c0', '#ffffff', '#ff0000'];
const W = 16, H = 10;
const fill = color => Array(W * H).fill(color);
const draw = (pixels, points, color) => { const out = [...pixels]; for (const p of points) out[p.y * W + p.x] = color; return out; };

test('paletteBlend picks an in-between palette colour, or -1 when none lies between', () => {
  assert.equal(paletteBlend(palette, 0, 4, 0.5), 2);
  assert.equal(paletteBlend(palette, 0, 4, 0.25), 1);
  assert.equal(paletteBlend(palette, 0, 1, 0.5), -1);
  assert.equal(paletteBlend(['#000000', '#ffffff', '#ff0000'], 0, 1, 0.5), -1, 'red is not between black and white');
  assert.equal(paletteBlend(palette, -1, 0, 0.5), -1);
});

test('antialiasStroke softens the run ends of a shallow line and leaves the stroke itself unchanged', () => {
  const points = linePoints(1, 2, 13, 5), base = fill(4), stroke = draw(base, points, 0);
  const out = antialiasStroke(stroke, W, H, points, 0, palette);
  const changed = out.flatMap((v, i) => v !== stroke[i] ? [i] : []);
  assert.ok(changed.length >= 2, 'AA pixels at the steps');
  for (const p of points) assert.equal(out[p.y * W + p.x], 0);
  for (const i of changed) assert.ok([1, 2, 3].includes(out[i]), 'only in-between greys');
  assert.notEqual(out, stroke, 'returns a new array');
});

test('antialiasStroke adds nothing to a clean 45° line, over transparency, or without an in-between colour', () => {
  const diagonal = linePoints(1, 1, 8, 8);
  const d = draw(fill(4), diagonal, 0);
  assert.deepEqual(antialiasStroke(d, W, H, diagonal, 0, palette), d);
  const shallow = linePoints(1, 2, 13, 5), clear = draw(fill(-1), shallow, 0);
  assert.deepEqual(antialiasStroke(clear, W, H, shallow, 0, palette), clear);
  assert.notDeepEqual(antialiasStroke(clear, W, H, shallow, 0, palette, { background: 4 }), clear, 'a background colour enables AA');
  const two = ['#000000', '#ffffff'], plain = draw(fill(1), shallow, 0);
  assert.deepEqual(antialiasStroke(plain, W, H, shallow, 0, two), plain);
});

test('smoothJaggies smooths one side of each edge, respects the mask and keeps transparency crisp', () => {
  // A black wedge on white: its stair-stepped edge gets grey AA pixels.
  const wedge = Array.from({ length: W * H }, (_, i) => (i % W) * 3 < Math.floor(i / W) * 10 ? 0 : 4);
  const out = smoothJaggies(wedge, W, H, palette);
  const changed = out.flatMap((v, i) => v !== wedge[i] ? [i] : []);
  assert.ok(changed.length > 0);
  for (const i of changed) {
    assert.ok([1, 2, 3].includes(out[i]));
    const x = i % W, y = Math.floor(i / W);
    const across = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]].filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H).map(([a, b]) => b * W + a);
    assert.ok(!across.some(j => changed.includes(j) && wedge[j] !== wedge[i]), 'never both sides of the same step');
  }
  assert.deepEqual(smoothJaggies(wedge, W, H, palette, { mask: Array(W * H).fill(0) }), wedge);
  const onClear = wedge.map(v => v === 4 ? -1 : v);
  assert.deepEqual(smoothJaggies(onClear, W, H, palette), onClear);
});

test('Smooth AA sampling blends part colours with palette colours; nearest never invents colours', () => {
  const size = 12, pixels = Array.from({ length: size * size }, (_, i) => (i % size) < 6 ? 0 : 4);
  const part = { id: 'p', width: size, height: size, pixels, palette };
  const use = sampling => renderOperations([{ type: 'use', id: 'i', partId: 'p', x: 4, y: 4, width: size, height: size, transform: 'N', angle: 30, ...(sampling ? { sampling } : {}) }], 20, 20, new Map([['p', part]]));
  const colours = image => new Set(image.filter(v => v >= 0));
  assert.deepEqual([...colours(use())].sort(), [0, 4]);
  assert.ok([...colours(use('aa'))].some(v => [1, 2, 3].includes(v)), 'AA adds in-between greys');
  // Silhouette edges blend with the artwork beneath in the same cel (white here), and stay crisp over transparency.
  const solid = { id: 's', width: 8, height: 8, pixels: Array(64).fill(0), palette };
  const over = ground => renderOperations([...ground, { type: 'use', id: 'j', partId: 's', x: 6, y: 6, width: 8, height: 8, transform: 'N', angle: 30, sampling: 'aa' }], 20, 20, new Map([['s', solid]]));
  const white = Array.from({ length: 20 }, (_, y) => ({ type: 'span', x: 0, y, values: Array(20).fill(4) }));
  assert.ok([...colours(over(white))].some(v => [1, 2, 3].includes(v)));
  assert.deepEqual([...colours(over([]))], [0]);
});
