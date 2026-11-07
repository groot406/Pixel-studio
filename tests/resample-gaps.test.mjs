import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOperations } from '../src/domain/artwork.js';
import { linePoints, rectanglePoints } from '../src/domain/geometry.js';
import { smear } from '../src/domain/pixel-fx.js';

const W = 64, H = 64;
/** A w×h part with `points` in colour 1 (or colour(p)). */
function part(w, h, points, colour = () => 1) {
  const pixels = Array(w * h).fill(-1);
  for (const p of points) pixels[p.y * w + p.x] = colour(p);
  return { id: 'p', width: w, height: h, pixels };
}
function render(img, pose) {
  const op = { type: 'use', id: 'o', partId: 'p', transform: 'N', x: Math.floor((W - img.width) / 2), y: Math.floor((H - img.height) / 2), ...pose };
  return renderOperations([op], W, H, new Map([['p', img]]));
}
/** Number of 8-connected components of pixels matching `keep`. */
function components(pixels, keep = v => v >= 0, w = W, diagonal = true) {
  const seen = new Uint8Array(pixels.length);
  let count = 0;
  for (let i = 0; i < pixels.length; i++) {
    if (seen[i] || !keep(pixels[i])) continue;
    count++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), x = j % w, y = Math.floor(j / w);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (!diagonal && dx && dy)) continue;
        const nx = x + dx, ny = y + dy, k = ny * w + nx;
        if (nx < 0 || ny < 0 || nx >= w || ny >= pixels.length / w || seen[k] || !keep(pixels[k])) continue;
        seen[k] = 1; stack.push(k);
      }
    }
  }
  return count;
}
/** A closed outline separates its (transparent) inside from the outside: the transparent pixels form ≥ 2 4-connected regions. */
const closed = pixels => components(pixels, v => v < 0, W, false) >= 2;
const show = pixels => Array.from({ length: H }, (_, y) => pixels.slice(y * W, y * W + W).map(v => (v < 0 ? '.' : v)).join('')).filter(r => r.includes('1') || r.includes('2')).join('\n');

const lines = {
  horizontal: part(20, 1, linePoints(0, 0, 19, 0)),
  vertical: part(1, 20, linePoints(0, 0, 0, 19)),
  diagonal: part(16, 16, linePoints(0, 0, 15, 15)),
  shallow: part(20, 7, linePoints(0, 0, 19, 6)),
  steep: part(7, 20, linePoints(0, 0, 6, 19)),
};
const box = part(16, 12, rectanglePoints(0, 0, 15, 11, false, 16, 12));
// Outline (2) around a fill (1): the outline must stay closed even where the fill competes for the same pixels.
const filledBox = part(16, 12, rectanglePoints(0, 0, 15, 11, true, 16, 12), p => (p.x % 15 && p.y % 11 ? 1 : 2));
const poses = {
  ...Object.fromEntries([10, 30, 45, 60, -20, 75].map(a => [`rotate ${a}°`, { angle: a }])),
  'skew x 30': { skew: { x: 30, y: 0 } }, 'skew y -45': { skew: { x: 0, y: -45 } }, 'skew both': { skew: { x: 20, y: 15 } },
  'tilt y 30': { tilt: { x: 0, y: 30 } }, 'tilt y 60': { tilt: { x: 0, y: 60 } }, 'tilt x 30': { tilt: { x: 30, y: 0 } }, 'tilt x 60': { tilt: { x: 60, y: 0, perspective: 80 } },
  'tilt + rotate': { tilt: { x: 20, y: 40 }, angle: 25 },
  wave: { deform: { kind: 'wave', axis: 'x', amplitude: 3, wavelength: 8, phase: 0 } },
  'wave y': { deform: { kind: 'wave', axis: 'y', amplitude: 2, wavelength: 6, phase: 45 } },
  bulge: { deform: { kind: 'bulge', strength: 80 } }, pinch: { deform: { kind: 'bulge', strength: -80 } }, twist: { deform: { kind: 'twist', angle: 120 } },
};
const scaled = img => ({ 'squash 0.7': { width: img.width, height: Math.max(1, Math.round(img.height * 0.7)) }, 'stretch 1.3': { width: Math.round(img.width * 1.3), height: img.height },
  'scale 0.7': { width: Math.max(1, Math.round(img.width * 0.7)), height: Math.max(1, Math.round(img.height * 0.7)) }, 'scale 0.55 + rotate 30°': { width: Math.max(1, Math.round(img.width * .55)), height: Math.max(1, Math.round(img.height * .55)), angle: 30 } });

for (const sampling of ['nearest', 'rotsprite', 'aa']) {
  test(`1px lines stay 8-connected under every resampling transform (${sampling})`, () => {
    for (const [name, img] of Object.entries(lines)) for (const [label, pose] of Object.entries({ ...poses, ...scaled(img) })) {
      const out = render(img, { ...pose, sampling });
      assert.equal(components(out), 1, `${name} line, ${label}, ${sampling}:\n${show(out)}`);
    }
  });
  test(`1px outlines stay closed under every resampling transform (${sampling})`, () => {
    for (const [label, pose] of Object.entries({ ...poses, ...scaled(box) })) {
      if (label === 'twist' || label.startsWith('pinch')) continue;
      const out = render(box, { ...pose, sampling });
      assert.ok(components(out) === 1 && closed(out), `outline, ${label}, ${sampling}:\n${show(out)}`);
    }
    for (const [label, pose] of Object.entries({ ...poses, ...scaled(filledBox) })) {
      const out = render(filledBox, { ...pose, sampling });
      assert.equal(components(out, v => v === 2), 1, `filled outline, ${label}, ${sampling}:\n${show(out)}`);
    }
  });
}

test('neutral poses and lossless turns render the part exactly', () => {
  const img = part(9, 7, [...linePoints(0, 0, 8, 6), ...rectanglePoints(2, 1, 6, 5, false, 9, 7)], p => 1 + (p.x + p.y) % 3);
  const base = render(img, {});
  for (const pose of [{ angle: 0 }, { skew: { x: 0, y: 0 } }, { sampling: 'rotsprite' }, { sampling: 'aa' }, { width: 9, height: 7, sampling: 'aa' }])
    assert.deepEqual(render(img, pose), base);
  for (const sampling of ['nearest', 'rotsprite', 'aa']) {
    const turned = render(img, { transform: 'R90', sampling }), quarter = render(img, { transform: 'R90', angle: 0, sampling });
    assert.deepEqual(turned, quarter);
    // Whole-number upscales just repeat pixels.
    const twice = render(img, { width: 18, height: 14, sampling: 'nearest' });
    assert.equal(twice.filter(v => v >= 0).length, base.filter(v => v >= 0).length * 4);
  }
});

test('smear trails stay connected even when given fewer steps than the distance', () => {
  const b = Array(10 * 3).fill(-1);
  b[1 * 10 + 8] = 1;
  const out = smear(null, b, 10, 3, { offset: { x: 7, y: 0 }, steps: 2 });
  assert.equal(out.slice(10, 20).filter(v => v >= 0).length, 8);
});
