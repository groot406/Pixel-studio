import test from 'node:test';
import assert from 'node:assert/strict';
import { hexToOklch, deltaE } from '../src/domain/colour.js';
import { compositeFrame, blankProject } from '../src/domain/project.js';
import { decodeAIProject } from '../src/formats/pxa.js';
import { sparklePxa } from './fixtures/pxa-v2.mjs';
import { HARMONIES, harmonyHues, harmonyColours, harmonyPalette, complementColour, neutralColour, tintsShadesTones, sortPaletteIndices,
  similarColours, lightnessGaps, mergeColours, usedPaletteIndices, replacePalette, removePaletteColour, removeUnusedColours, reorderPalette } from '../src/domain/palette-theory.js';
import { PALETTE_PRESETS } from '../src/domain/palette-presets.js';

const HEX = /^#[0-9a-f]{6}$/;
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const composites = p => p.animations.flatMap(a => a.frames.map(f => compositeFrame(p, f).map(i => (i < 0 ? null : p.palette[i]))));

test('harmony hue angles follow colour theory', () => {
  assert.deepEqual(harmonyHues(10, 'complementary'), [10, 190]);
  assert.deepEqual(harmonyHues(10, 'split'), [10, 160, 220]);
  assert.deepEqual(harmonyHues(10, 'analogous'), [10, 340, 40]);
  assert.deepEqual(harmonyHues(300, 'triadic'), [300, 60, 180]);
  assert.deepEqual(harmonyHues(0, 'tetradic'), [0, 60, 180, 240]);
  assert.deepEqual(harmonyHues(45, 'square'), [45, 135, 225, 315]);
  assert.deepEqual(harmonyHues(20, 'analogous', 15), [20, 5, 35]);
  assert.throws(() => harmonyHues(0, 'nope'), /Harmony must be/);
  assert.equal(Object.keys(HARMONIES).length, 7);
});

test('harmony colours keep the base exactly and land on the harmony hues', () => {
  const base = '#3b7dd8', [, , h] = hexToOklch(base);
  for (const kind of ['complementary', 'split', 'triadic', 'square']) {
    const colours = harmonyColours(base, kind), hues = harmonyHues(h, kind);
    assert.equal(colours[0], base);
    colours.forEach((c, i) => { assert.match(c, HEX); assert.ok(hueDist(hexToOklch(c)[2], hues[i]) < 3, `${kind} ${i}`); });
  }
  const mono = harmonyColours(base, 'monochromatic');
  assert.equal(mono.length, 5);
  mono.slice(1).forEach(c => assert.ok(hueDist(hexToOklch(c)[2], h) < 4));
  assert.ok(deltaE(complementColour(base), base) > 0.2);
  assert.equal(complementColour('#808080'), '#808080');
});

test('harmony ramps are gamut-valid with monotonic lightness, base included', () => {
  for (const base of ['#ff0000', '#00ff88', '#2b2bff', '#ffe066', '#202020']) for (const kind of Object.keys(HARMONIES)) {
    const rows = harmonyPalette(base, kind, { steps: 6, hueShift: 30 });
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      assert.equal(row.length, 6);
      row.forEach(c => assert.match(c, HEX));
      const L = row.map(c => hexToOklch(c)[0]);
      for (let i = 1; i < L.length; i++) assert.ok(L[i] >= L[i - 1] - 1e-9, `${base} ${kind} ramp is dark → light`);
    }
    if (kind !== 'monochromatic') assert.ok(rows[0].includes(base));
  }
  assert.deepEqual(harmonyPalette('#ff0000', 'triadic', { steps: 1 }), harmonyColours('#ff0000', 'triadic').map(c => [c]));
});

test('tints, shades, tones and neutrals move the right way', () => {
  const base = '#c0503a', [L, C] = hexToOklch(base), { tints, shades, tones } = tintsShadesTones(base, 3);
  tints.forEach((c, i) => assert.ok(hexToOklch(c)[0] > (i ? hexToOklch(tints[i - 1])[0] : L)));
  shades.forEach((c, i) => assert.ok(hexToOklch(c)[0] < (i ? hexToOklch(shades[i - 1])[0] : L)));
  tones.forEach(c => { assert.ok(Math.abs(hexToOklch(c)[0] - L) < 0.01); assert.ok(hexToOklch(c)[1] < C); });
  assert.ok(hexToOklch(neutralColour(base, 1))[1] < 0.03);
  assert.equal(neutralColour(base, 0), base);
});

test('analysis: sorting, similar pairs and lightness gaps', () => {
  const palette = ['#ffffff', '#000000', '#808080', '#ff0000', '#fe0101'];
  assert.deepEqual(sortPaletteIndices(palette).slice(0, 2), [1, 2]);
  assert.deepEqual(sortPaletteIndices(palette, 'hue').slice(0, 3), [1, 2, 0]);
  const pairs = similarColours(palette);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].a, pairs[0].b], [3, 4]);
  const gaps = lightnessGaps(['#000000', '#ffffff']);
  assert.ok(gaps.some(g => g.reason === 'Value gap' && g.L > 0.3 && g.L < 0.7));
  const ends = lightnessGaps(['#808080']);
  assert.deepEqual(ends.map(g => g.reason), ['Deep shadow', 'Highlight']);
  ends.forEach(g => assert.match(g.hex, HEX));
});

test('merging dedupes near colours and respects the limit', () => {
  const r = mergeColours(['#000000', '#ffffff'], ['#000000', '#fefefe', '#ff0000', '#00ff00'], { max: 3 });
  assert.deepEqual(r.palette, ['#000000', '#ffffff', '#ff0000']);
  assert.deepEqual(r.duplicates, ['#000000', '#fefefe']);
  assert.deepEqual(r.overflow, ['#00ff00']);
});

test('replacePalette remaps raster pixels to the nearest new colour', () => {
  const p = blankProject('t', 4, 1);
  p.palette = ['#000000', '#fa0505', '#0000ff', '#ffffff'];
  p.animations[0].frames[0].cels[0].pixels = [0, 1, -1, 3];
  const { project, map, changed } = replacePalette(p, ['#ffffff', '#ff0000', '#111111']);
  assert.deepEqual(map, [2, 1, 2, 0]);
  assert.deepEqual(project.palette, ['#ffffff', '#ff0000', '#111111']);
  assert.deepEqual(project.animations[0].frames[0].cels[0].pixels, [2, 1, -1, 0]);
  assert.equal(changed, 2);
  assert.throws(() => replacePalette(p, ['#000000'], [0, 0]), /colour map/);
});

test('replace, reorder and remove keep retained shapes and shared parts consistent', () => {
  const p = decodeAIProject(sparklePxa), before = composites(p), used = usedPaletteIndices(p);
  assert.ok(used.size > 1);
  const order = p.palette.map((_, i) => i).reverse(), reordered = reorderPalette(p, order).project;
  assert.deepEqual(reordered.palette, [...p.palette].reverse());
  assert.deepEqual(composites(reordered), before);
  assert.deepEqual(reordered.parts.map(x => x.id), p.parts.map(x => x.id));
  const same = replacePalette(p, [...p.palette, '#123456']);
  assert.deepEqual(composites(same.project), before);
  assert.equal(same.changed, 0);
  const victim = [...used][0], removed = removePaletteColour(p, victim).project;
  assert.equal(removed.palette.length, p.palette.length - 1);
  const after = composites(removed);
  before.forEach((frame, f) => frame.forEach((c, i) => {
    if (c !== p.palette[victim]) assert.equal(after[f][i], c);
    else assert.notEqual(after[f][i], null);
  }));
  assert.throws(() => removePaletteColour({ ...p, palette: ['#000000'] }, 0), /at least one/);
});

test('presets are valid, uniquely named and free of duplicate colours', () => {
  const ids = new Set(), names = new Set();
  assert.ok(PALETTE_PRESETS.length >= 20);
  for (const preset of PALETTE_PRESETS) {
    assert.ok(!ids.has(preset.id) && !names.has(preset.name), preset.name);
    ids.add(preset.id); names.add(preset.name);
    assert.ok(preset.colours.length >= 2 && preset.colours.length <= 64, preset.name);
    preset.colours.forEach(c => assert.match(c, HEX, preset.name));
    assert.equal(new Set(preset.colours).size, preset.colours.length, `${preset.name} has duplicates`);
  }
  const pico = PALETTE_PRESETS.find(x => x.id === 'pico-8');
  assert.equal(pico.colours.length, 16);
  assert.equal(pico.colours[8], '#ff004d');
  assert.equal(PALETTE_PRESETS.find(x => x.id === 'endesga-32').colours.length, 32);
  assert.equal(PALETTE_PRESETS.find(x => x.id === 'dawnbringer-32').colours.length, 32);
});

test('merging two colours and removing unused colours keep the artwork', () => {
  const p = blankProject('t', 3, 1);
  p.palette = ['#000000', '#ff0000', '#00ff00', '#fe0000'];
  p.animations[0].frames[0].cels[0].pixels = [3, 1, -1];
  const merged = removePaletteColour(p, 3, 1).project;
  assert.deepEqual(merged.palette, ['#000000', '#ff0000', '#00ff00']);
  assert.deepEqual(merged.animations[0].frames[0].cels[0].pixels, [1, 1, -1]);
  const { project, removed } = removeUnusedColours(p);
  assert.deepEqual(removed, [0, 2]);
  assert.deepEqual(project.palette, ['#ff0000', '#fe0000']);
  assert.deepEqual(project.animations[0].frames[0].cels[0].pixels, [1, 0, -1]);
  assert.deepEqual(removeUnusedColours(blankProject('e', 2, 2)).project.palette.length, 1);
});
