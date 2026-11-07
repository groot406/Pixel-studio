import test from 'node:test';
import assert from 'node:assert/strict';
import { paletteRamp, shadeStep, shadeMap, outlineColourFor, autoOutline } from '../src/domain/shading.js';
import { findStrays, findCorners, findJaggies, findBanding, findIssues, safeFixes, applyFixes } from '../src/domain/cleanup.js';
import { shadingRamp } from '../src/domain/colour.js';

const grid = (...rows) => rows.join('').split('').map(c => (c === '.' ? -1 : Number(c)));
const show = (pixels, w) => Array.from({ length: pixels.length / w }, (_, y) => pixels.slice(y * w, y * w + w).map(v => (v === -1 ? '.' : v)).join(''));

// 0–4: a hue-shifted red ramp (purple shadows → orange highlights), 5–7: greys, 8: a lone green.
const hueShifted = shadingRamp('#c83c3c', { steps: 5, hueShift: 60 });
const palette = [...hueShifted, '#202020', '#808080', '#e0e0e0', '#30a040'];

test('ramps are detected along hue-shifted chains, or by lightness only', () => {
  assert.deepEqual(paletteRamp(palette, 2), [0, 1, 2, 3, 4]);
  assert.deepEqual(paletteRamp(palette, 6), [5, 6, 7]);
  assert.deepEqual(paletteRamp(palette, 8), [8]);
  const strict = paletteRamp(palette, 2, { mode: 'lightness' });
  assert.ok(strict.includes(2) && strict.length < 5, 'lightness-only keeps to the base hue');
  assert.throws(() => paletteRamp(palette, 9), /palette colour/);
});

test('shade steps one ramp colour, stops at the ends and falls back without a ramp', () => {
  assert.equal(shadeStep(palette, 2, -1), 1);
  assert.equal(shadeStep(palette, 2, 1), 3);
  assert.equal(shadeStep(palette, 0, -1), 0);
  assert.equal(shadeStep(palette, 4, 1), 4);
  assert.notEqual(shadeStep(palette, 8, -1), 8, 'a lone colour still darkens');
  assert.equal(shadeStep(palette, -1, 1), -1);
  assert.deepEqual(shadeMap(palette, -1).slice(0, 5), [0, 0, 1, 2, 3]);
});

test('auto outline picks the darkest colour of each fill ramp, outside or inside, or one colour', () => {
  assert.equal(outlineColourFor(palette, 3), 0);
  assert.equal(outlineColourFor(palette, 6), 5);
  const art = grid('.....', '.33..', '.377.', '..77.', '.....');
  assert.deepEqual(show(autoOutline(art, 5, 5, palette, { corners: false }), 5), ['.00..', '0330.', '03775', '.0775', '..55.']);
  assert.deepEqual(show(autoOutline(art, 5, 5, palette, { style: 'single', color: 8, corners: false }), 5), ['.88..', '8338.', '83778', '.8778', '..88.']);
  assert.deepEqual(show(autoOutline(art, 5, 5, palette, { mode: 'inside' }), 5), ['.....', '.00..', '.055.', '..55.', '.....']);
  const full = show(autoOutline(art, 5, 5, palette), 5);
  assert.equal(full[0], '0000.');
  const mask = new Uint8Array(25); mask[1] = 1;
  assert.deepEqual(show(autoOutline(art, 5, 5, palette, { mask, corners: false }), 5)[0], '.0...');
});

test('stray pixels are found and fixed with the colour around them', () => {
  const art = grid('11111', '11211', '11111', '.....', '...3.');
  const strays = findStrays(art, 5, 5);
  assert.deepEqual(strays.map(s => [s.x, s.y]), [[2, 1], [3, 4]]);
  assert.deepEqual(strays[0].fix, [{ index: 7, value: 1 }]);
  assert.deepEqual(strays[1].fix, [{ index: 23, value: -1 }]);
  assert.deepEqual(findStrays(grid('111', '1.1', '111'), 3, 3).map(s => s.fix[0].value), [1]);
});

test('doubled corners on 1px lines are found per colour and fixed with the colour behind', () => {
  const art = grid('22222', '21222', '21122', '22212', '22221');
  const corners = findCorners(art, 5, 5);
  assert.deepEqual(corners.map(c => [c.x, c.y]), [[1, 2]]);
  assert.deepEqual(corners[0].fix, [{ index: 11, value: 2 }]);
  assert.deepEqual(findCorners(grid('111', '1.1', '111'), 3, 3), [], 'right angles of a box are kept');
});

test('jaggies flag runs that break the rhythm of a line, not regular patterns or curves', () => {
  const line = (runs, w = 16, h = 8) => {
    const px = Array(w * h).fill(-1);
    let x = 0;
    runs.forEach((len, y) => { for (let k = 0; k < len; k++) px[y * w + x++] = 4; });
    return px;
  };
  const bad = findJaggies(line([2, 1, 2, 3]), 16, 8);
  assert.equal(bad.length, 1);
  assert.deepEqual([bad[0].x, bad[0].y, bad[0].indices.length], [2, 1, 1]);
  assert.equal(findJaggies(line([3, 3, 1, 3, 3]), 16, 8).length, 1);
  assert.deepEqual(findJaggies(line([2, 1, 2, 1, 2]), 16, 8), [], 'alternating 2:1 is a clean slope');
  assert.deepEqual(findJaggies(line([1, 1, 2, 3, 4]), 16, 8), [], 'growing runs are a curve');
  assert.deepEqual(findJaggies(line([3, 3, 3, 3]), 16, 8), []);
});

test('banding finds a colour band stepping in parallel with its neighbours', () => {
  const art = grid('11233...', '.11233..', '..11233.', '...11233');
  const bands = findBanding(art, 8, 4);
  assert.equal(bands.length, 1);
  assert.deepEqual(bands[0].indices.length, 4);
  assert.deepEqual(findBanding(grid('1233', '1233', '1233'), 4, 3), [], 'straight vertical bands are not stepped');
});

test('findIssues counts every type; safe fixes repair strays and corners', () => {
  const art = grid('22222', '21222', '21122', '22212', '22521');
  const { issues, counts } = findIssues(art, 5, 5);
  assert.equal(counts.stray, 1);
  assert.equal(counts.corner, 1);
  assert.equal(issues.length, counts.stray + counts.corner + counts.jaggy + counts.banding);
  const fixed = applyFixes(art, safeFixes(issues));
  assert.equal(findIssues(fixed, 5, 5).counts.stray + findIssues(fixed, 5, 5).counts.corner, 0);
  assert.throws(() => applyFixes(art, [{ index: 99, value: 1 }]), /fix/);
});
