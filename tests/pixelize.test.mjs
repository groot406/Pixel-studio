import test from 'node:test';
import assert from 'node:assert/strict';
import { detectGrid, pixelize, removeBackground, mergeSimilarColors } from '../src/domain/pixelize.js';

/** A small random sprite on a flat background, upscaled with soft edges, JPEG-like noise and an offset. */
function fakeAiImage({ cells = 24, scale = 12, offset = 5, seed = 7, blur = true }) {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const colors = [[40, 40, 60], [200, 80, 60], [240, 200, 120], [60, 140, 90]];
  const art = Array.from({ length: cells * cells }, (_, i) => {
    const x = i % cells, y = (i / cells) | 0;
    return x < 3 || y < 3 || x >= cells - 3 || y >= cells - 3 ? -1 : (rnd() * colors.length) | 0;
  });
  const bg = [250, 250, 250];
  const size = cells * scale + offset;
  const rgba = new Uint8ClampedArray(size * size * 4);
  const at = (cx, cy) => { const v = art[Math.min(cells - 1, Math.max(0, cy)) * cells + Math.min(cells - 1, Math.max(0, cx))]; return v < 0 ? bg : colors[v]; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = (x - offset) / scale, fy = (y - offset) / scale;
    const cx = Math.floor(fx), cy = Math.floor(fy);
    let c = at(cx, cy);
    if (blur && (fx - cx < 0.1 || fy - cy < 0.1)) { const n = at(cx - 1, cy - 1); c = c.map((v, k) => (v + n[k]) / 2); }
    const i = (y * size + x) * 4;
    for (let k = 0; k < 3; k++) rgba[i + k] = c[k] + (rnd() - 0.5) * 16;
    rgba[i + 3] = 255;
  }
  return { rgba, size, art, colors };
}

test('detectGrid finds the scale and offset of upscaled, noisy pixel art', () => {
  for (const scale of [8, 12, 16]) {
    const { rgba, size } = fakeAiImage({ scale, offset: 5 });
    const grid = detectGrid(rgba, size, size);
    assert.equal(grid.scale, scale, `scale ${scale}`);
    assert.ok(Math.abs(grid.offsetX - 5) < 1, `offset ${grid.offsetX}`);
    assert.ok(grid.confidence > 0.3);
  }
});

test('pixelize recovers every logical pixel and removes the background', () => {
  const { rgba, size, art, colors } = fakeAiImage({ cells: 20, scale: 10, offset: 3 });
  const out = pixelize(rgba, size, size, { trim: true });
  assert.equal(out.width, 14); assert.equal(out.height, 14);
  let wrong = 0;
  for (let y = 0; y < 14; y++) for (let x = 0; x < 14; x++) {
    const v = art[(y + 3) * 20 + x + 3], i = (y * 14 + x) * 4;
    const near = colors[v].every((c, k) => Math.abs(out.rgba[i + k] - c) < 12);
    if (!near || out.rgba[i + 3] !== 255) wrong++;
  }
  assert.equal(wrong, 0);
});

test('real pixel art is left at scale 1', () => {
  const { rgba, size } = fakeAiImage({ cells: 32, scale: 1, offset: 0, blur: false });
  assert.equal(detectGrid(rgba, size, size).scale, 1);
});

test('removeBackground keeps enclosed holes of the background colour', () => {
  const w = 5, rgba = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) if (x !== 2 || y !== 2) rgba.set([0, 0, 0, 255], (y * w + x) * 4);
  const { rgba: out } = removeBackground(rgba, w, w);
  assert.equal(out[3], 0);
  assert.equal(out[(2 * w + 2) * 4 + 3], 255);
});

test('mergeSimilarColors folds noisy shades into the dominant colour', () => {
  const rgba = new Uint8ClampedArray([200, 80, 60, 255, 200, 80, 60, 255, 206, 77, 64, 255, 40, 40, 60, 255]);
  const { rgba: out, colors } = mergeSimilarColors(rgba);
  assert.equal(colors, 2);
  assert.deepEqual([...out.slice(8, 12)], [200, 80, 60, 255]);
});
