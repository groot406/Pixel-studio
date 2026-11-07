import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hexToRgb, rgbToHex, hexToOklch, oklchToHex, deltaE, nearestColour, nearestIndexMap,
  shadingRamp, rampFromPalette, darkerMap, lighterMap, addRampToPalette,
  cycleRamp, colourCycleFrames, cycleLoopLength, paletteHarmony, mixColour,
} from '../src/domain/colour.js';

const HEX = /^#[0-9a-f]{6}$/;
const SAMPLES = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff',
  '#808080', '#232a36', '#e8c99c', '#d86850', '#638bac', '#010203', '#fefdfc', '#7f3f1f'];
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

test('hex ↔ rgb and hex → oklch → hex round trips exactly', () => {
  assert.deepEqual(hexToRgb('#FF8001'), [255, 128, 1]);
  assert.equal(rgbToHex([255, 128, 1]), '#ff8001');
  for (const hex of SAMPLES) assert.equal(oklchToHex(hexToOklch(hex)), hex);
  assert.throws(() => hexToRgb('#fff'), /six-digit hex/);
});

test('white and black lightness, greys have no chroma', () => {
  assert.ok(Math.abs(hexToOklch('#ffffff')[0] - 1) < 1e-4);
  assert.ok(Math.abs(hexToOklch('#000000')[0]) < 1e-9);
  assert.ok(hexToOklch('#808080')[1] < 1e-4);
});

test('gamut mapping always yields valid hex and keeps lightness', () => {
  for (let h = 0; h < 360; h += 15) {
    for (const L of [0.1, 0.5, 0.9]) {
      const hex = oklchToHex([L, 0.5, h]);
      assert.match(hex, HEX);
      assert.ok(Math.abs(hexToOklch(hex)[0] - L) < 0.01, `${hex} L`);
    }
  }
  assert.equal(oklchToHex([1.2, 0.3, 40]), '#ffffff');
  assert.equal(oklchToHex([-1, 0.3, 40]), '#000000');
});

test('deltaE, nearestColour and nearestIndexMap', () => {
  assert.equal(deltaE('#123456', '#123456'), 0);
  assert.ok(deltaE('#000000', '#ffffff') > 0.99);
  const pal = ['#000000', '#ff0000', '#ffffff'];
  assert.equal(nearestColour('#e01010', pal), 1);
  assert.deepEqual(nearestIndexMap(['#111111', '#eeeeee', '#cc0000'], pal), [0, 2, 1]);
});

test('shadingRamp is monotonic, includes base, shifts hue cool in shadows and warm in highlights', () => {
  const base = '#4d9a52';
  const ramp = shadingRamp(base, { steps: 5, hueShift: 30 });
  assert.equal(ramp.length, 5);
  assert.equal(ramp[2], base);
  ramp.forEach((c) => assert.match(c, HEX));
  const lch = ramp.map(hexToOklch);
  for (let i = 1; i < lch.length; i += 1) assert.ok(lch[i][0] > lch[i - 1][0], 'lightness increases');
  const h = lch[2][2];
  assert.ok(hueDist(lch[0][2], 260) < hueDist(h, 260), 'shadow moves toward blue');
  assert.ok(hueDist(lch[4][2], 90) < hueDist(h, 90), 'highlight moves toward yellow');
  assert.ok(lch[0][1] < lch[2][1] && lch[4][1] < lch[2][1], 'chroma lower at extremes');
  assert.deepEqual(shadingRamp(base, { steps: 5, hueShift: 30 }), ramp, 'deterministic');
  assert.equal(shadingRamp(base, { steps: 4, baseIndex: 0 })[0], base);
  assert.throws(() => shadingRamp(base, { steps: 1 }), /steps/);
});

test('rampFromPalette groups a hue family; darker/lighter maps stay in family', () => {
  const greens = shadingRamp('#4d9a52', { steps: 4 });
  const pal = ['#ffffff', greens[2], '#d86850', greens[0], '#000000', greens[3], greens[1], '#8a3020'];
  assert.deepEqual(rampFromPalette(pal, 1), [3, 6, 1, 5]);
  assert.deepEqual(rampFromPalette(pal, 0), [4, 0]);
  const dark = darkerMap(pal), light = lighterMap(pal);
  assert.equal(dark.get(1), 6);
  assert.equal(dark.get(6), 3);
  assert.equal(dark.get(2), 7, 'red shades to darker red, not a green');
  assert.equal(dark.get(4), 4, 'black has nothing darker');
  assert.equal(light.get(3), 6);
  assert.equal(light.get(0), 0);
});

test('addRampToPalette reuses near-duplicates and respects max', () => {
  const ramp = ['#000000', '#101820', '#ffffff', '#808080'];
  const { palette, indices } = addRampToPalette(['#000000', '#FFFFFF'], ramp);
  assert.deepEqual(palette, ['#000000', '#ffffff', '#101820', '#808080']);
  assert.deepEqual(indices, [0, 2, 1, 3]);
  assert.deepEqual(addRampToPalette(['#808080'], ['#818181']).indices, [0]);
  assert.throws(() => addRampToPalette(['#000000', '#ffffff'], ['#ff0000'], 2), /2-colour palette limit/);
});

test('cycleRamp wraps and leaves non-ramp pixels', () => {
  const px = [-1, 2, 3, 4, 9, 2];
  assert.deepEqual(cycleRamp(px, [2, 3, 4], 1), [-1, 3, 4, 2, 9, 3]);
  assert.deepEqual(cycleRamp(px, [2, 3, 4], -1), [-1, 4, 2, 3, 9, 4]);
  assert.deepEqual(cycleRamp(px, [2, 3, 4], 3), px);
  assert.deepEqual(px, [-1, 2, 3, 4, 9, 2], 'input untouched');
  assert.throws(() => cycleRamp(px, [2, 2], 1), /repeat/);
});

test('colourCycleFrames loops after cycleLoopLength frames', () => {
  const px = [0, 1, 2, 3, 4, 5, 7, -1];
  const ramp = [1, 2, 3, 4, 5, 7];
  for (const stepsPerFrame of [1, 2, 4]) {
    const loop = cycleLoopLength(ramp, stepsPerFrame);
    const frames = colourCycleFrames(px, ramp, loop + 1, { stepsPerFrame, direction: -1 });
    assert.deepEqual(frames[0], px);
    assert.deepEqual(frames[loop], frames[0]);
    for (let k = 1; k < loop; k += 1) assert.notDeepEqual(frames[k], px);
  }
  assert.equal(cycleLoopLength(ramp, 1), 6);
  assert.equal(cycleLoopLength(ramp, 4), 3);
  assert.equal(cycleLoopLength(ramp, 6), 1);
});

test('paletteHarmony and mixColour', () => {
  const base = '#d86850';
  const h = hexToOklch(base)[2];
  const comp = paletteHarmony(base, 'complementary');
  assert.equal(comp[0], base);
  assert.ok(hueDist(hexToOklch(comp[1])[2], h + 180) < 5);
  const tri = paletteHarmony(base, 'triadic', 6);
  assert.equal(tri.length, 6);
  tri.forEach((c) => assert.match(c, HEX));
  assert.equal(paletteHarmony(base, 'analogous', 5).length, 5);
  assert.throws(() => paletteHarmony(base, 'tetradic'), /analogous/);
  assert.equal(mixColour('#000000', '#ffffff', 0), '#000000');
  assert.equal(mixColour('#000000', '#FFFFFF', 1), '#ffffff');
  const mid = hexToOklch(mixColour('#000000', '#ffffff', 0.5));
  assert.ok(Math.abs(mid[0] - 0.5) < 0.01);
});
