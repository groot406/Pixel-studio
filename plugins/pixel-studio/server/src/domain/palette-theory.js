// Colour theory for palette building: harmonies on the OKLCH hue wheel, harmony ramps, tints/shades/tones,
// palette analysis (similar colours, lightness gaps) and remapping a project's pixels onto a new palette. Pure.
import { MAX_COLORS } from './limits.js';
import { hexToOklch, oklchToHex, deltaE, nearestIndexMap, shadingRamp, mixColour } from './colour.js';
import { validateProject } from './project.js';

const HEX = /^#[0-9a-f]{6}$/i;
const ACHROMATIC = 0.03;
const wrapHue = h => ((h % 360) + 360) % 360;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const readHex = (hex, label = 'Colour') => {
  if (typeof hex !== 'string' || !HEX.test(hex)) throw new Error(`${label} must be a six-digit hex colour, such as #ffcc66.`);
  return hex.toLowerCase();
};

/** Harmony kinds: label, default spread (degrees) and hue offsets from the base for a spread `s`. */
export const HARMONIES = Object.freeze({
  complementary: { label: 'Complementary', spread: 0, offsets: () => [0, 180] },
  split: { label: 'Split-complementary', spread: 30, offsets: s => [0, 180 - s, 180 + s] },
  analogous: { label: 'Analogous', spread: 30, offsets: s => [0, -s, s] },
  triadic: { label: 'Triadic', spread: 0, offsets: () => [0, 120, 240] },
  tetradic: { label: 'Tetradic (rectangle)', spread: 60, offsets: s => [0, s, 180, 180 + s] },
  square: { label: 'Square', spread: 0, offsets: () => [0, 90, 180, 270] },
  monochromatic: { label: 'Monochromatic', spread: 0, offsets: () => [0] },
});

function readKind(kind) {
  if (!Object.hasOwn(HARMONIES, kind)) throw new Error(`Harmony must be one of ${Object.keys(HARMONIES).join(', ')}.`);
  return HARMONIES[kind];
}

/** Hue angles (0–360, base first) of a harmony around `baseHue`; `spread` overrides the kind's default angle. */
export function harmonyHues(baseHue, kind, spread) {
  const spec = readKind(kind), s = spread ?? spec.spread;
  if (!Number.isFinite(baseHue) || !Number.isFinite(s)) throw new Error('Hue and spread must be finite numbers.');
  return spec.offsets(s).map(o => wrapHue(baseHue + o));
}

/** Harmony colours (base first, exact) keeping the base lightness and chroma; gamut-clamped. Monochromatic gives 5 lightness steps. */
export function harmonyColours(baseHex, kind, { spread } = {}) {
  const base = readHex(baseHex, 'Base colour'), [L, C, h] = hexToOklch(base);
  if (kind === 'monochromatic') {
    readKind(kind);
    return [base, ...[-0.3, -0.15, 0.15, 0.3].map(d => oklchToHex([clamp(L + d, 0.08, 0.97), C, h]))];
  }
  return harmonyHues(h, kind, spread).map((hue, i) => (i ? oklchToHex([L, C, hue]) : base));
}

/**
 * Rows of hue-shifted shading ramps (dark → light), one per harmony colour; options: spread, steps (1–16), hueShift,
 * lightnessSpan, chromaDrop. Monochromatic gives the base ramp plus a muted (neutralised) ramp.
 */
export function harmonyPalette(baseHex, kind, { spread, steps = 5, hueShift = 20, lightnessSpan = 0.6, chromaDrop = 0.35 } = {}) {
  const base = readHex(baseHex, 'Base colour');
  if (!Number.isInteger(steps) || steps < 1 || steps > 16) throw new Error('Ramp steps must be a whole number from 1 to 16.');
  const seeds = kind === 'monochromatic' ? (readKind(kind), [base, neutralColour(base, 0.6)]) : harmonyColours(base, kind, { spread });
  return seeds.map(c => (steps === 1 ? [c] : shadingRamp(c, { steps, hueShift, lightnessSpan, chromaDrop })));
}

/** Complementary colour: opposite hue on the OKLCH wheel at the same lightness and chroma (gamut-clamped). */
export function complementColour(hex) {
  const [L, C, h] = hexToOklch(readHex(hex));
  return C < 1e-6 ? hex.toLowerCase() : oklchToHex([L, C, h + 180]);
}

/** Neutralised colour: mixed toward its complement, the painter's way to desaturate; amount 0 → itself, 1 → grey. */
export function neutralColour(hex, amount = 0.6) {
  if (!Number.isFinite(amount) || amount < 0 || amount > 1) throw new Error('Neutral amount must be between 0 and 1.');
  return mixColour(readHex(hex), complementColour(hex), amount / 2);
}

/** Tints (toward white), shades (toward black) and tones (toward grey of equal lightness), `steps` each, nearest first. */
export function tintsShadesTones(hex, steps = 4) {
  const base = readHex(hex), [L, C, h] = hexToOklch(base);
  if (!Number.isInteger(steps) || steps < 1 || steps > 12) throw new Error('Steps must be a whole number from 1 to 12.');
  const ts = Array.from({ length: steps }, (_, i) => (i + 1) / (steps + 1));
  return {
    tints: ts.map(t => mixColour(base, '#ffffff', t)),
    shades: ts.map(t => mixColour(base, '#000000', t)),
    tones: ts.map(t => oklchToHex([L, C * (1 - t), h])),
  };
}

const readPalette = (palette, label = 'Palette') => {
  if (!Array.isArray(palette) || !palette.length) throw new Error(`${label} must be a non-empty array of hex colours.`);
  return palette.map((c, i) => readHex(c, `${label} colour ${i + 1}`));
};
const isGrey = lch => lch[1] < ACHROMATIC;

/** Palette indices sorted by 'lightness' (dark → light) or 'hue' (greys first, then hue bands of 30°, each dark → light). */
export function sortPaletteIndices(palette, by = 'lightness') {
  const lch = readPalette(palette).map(hexToOklch);
  const key = i => (by === 'hue' ? [isGrey(lch[i]) ? -1 : Math.floor(lch[i][2] / 30), lch[i][0]] : [lch[i][0], 0]);
  if (!['lightness', 'hue'].includes(by)) throw new Error('Sort by lightness or hue.');
  return lch.map((_, i) => i).sort((a, b) => { const ka = key(a), kb = key(b); return ka[0] - kb[0] || ka[1] - kb[1] || a - b; });
}

/** Pairs of palette colours closer than `threshold` (OKLab ΔE), most similar first: [{ a, b, distance }]. */
export function similarColours(palette, threshold = 0.04) {
  const p = readPalette(palette), pairs = [];
  for (let a = 0; a < p.length; a++) for (let b = a + 1; b < p.length; b++) {
    const distance = deltaE(p[a], p[b]);
    if (distance < threshold) pairs.push({ a, b, distance });
  }
  return pairs.sort((x, y) => x.distance - y.distance || x.a - y.a || x.b - y.b);
}

/**
 * Missing values: wherever sorted palette lightness jumps by more than `minGap`, suggest the OKLab midpoint of the two
 * neighbours; also a deep shadow / bright highlight when the darkest / lightest colour is far from black / white.
 * Returns [{ hex, L, between: [i, j] | null, reason }].
 */
export function lightnessGaps(palette, { minGap = 0.15 } = {}) {
  const p = readPalette(palette), order = sortPaletteIndices(p), lch = p.map(hexToOklch), out = [];
  const first = lch[order[0]], last = lch[order.at(-1)];
  if (first[0] > 0.3) out.push({ hex: oklchToHex([0.2, first[1] * 0.6, wrapHue(first[2] + (isGrey(first) ? 0 : 20))]), L: 0.2, between: null, reason: 'Deep shadow' });
  for (let k = 1; k < order.length; k++) {
    const i = order[k - 1], j = order[k], gap = lch[j][0] - lch[i][0];
    if (gap > minGap) { const hex = mixColour(p[i], p[j], 0.5); out.push({ hex, L: hexToOklch(hex)[0], between: [i, j], reason: 'Value gap' }); }
  }
  if (last[0] < 0.85) out.push({ hex: oklchToHex([0.93, last[1] * 0.5, last[2]]), L: 0.93, between: null, reason: 'Highlight' });
  return out;
}

/**
 * Append `colours` to `palette`, skipping colours within ΔE `tolerance` of one already there and any beyond `max`.
 * Returns { palette, added, duplicates, overflow } (hex lists).
 */
export function mergeColours(palette, colours, { max = MAX_COLORS, tolerance = 0.01 } = {}) {
  const next = palette.length ? readPalette(palette) : [], added = [], duplicates = [], overflow = [];
  for (const c of readPalette(colours, 'Colours')) {
    if (next.some(p => deltaE(p, c) < tolerance)) duplicates.push(c);
    else if (next.length >= max) overflow.push(c);
    else { next.push(c); added.push(c); }
  }
  return { palette: next, added, duplicates, overflow };
}

/** Every palette index drawn anywhere in the project (pixels, retained sources and part definitions). */
export function usedPaletteIndices(project) {
  const used = new Set(), add = v => { if (v >= 0) used.add(v); };
  const ops = list => (list || []).forEach(op => (op.type === 'span' ? op.values.forEach(add) : op.type !== 'use' && add(op.color)));
  for (const a of project.animations) for (const f of a.frames) for (const cel of f.cels) { cel.pixels.forEach(add); if (cel.source) { ops(cel.source.ops); ops(cel.source.overrides); } }
  for (const part of project.parts || []) ops(part.ops);
  return used;
}

/**
 * Replace the project palette with `palette`, remapping every pixel, retained shape and part colour through `map`
 * (old index → new index; default: the perceptually nearest new colour in OKLab). Transparency (-1) is kept.
 * Returns { project, map, changed } where changed counts used colours whose appearance changes.
 */
export function replacePalette(project, palette, map) {
  const p = validateProject(project), next = readPalette(palette, 'New palette');
  if (next.length > MAX_COLORS) throw new Error(`A palette holds at most ${MAX_COLORS} colours.`);
  const m = map ?? nearestIndexMap(p.palette, next);
  if (!Array.isArray(m) || m.length !== p.palette.length || m.some(i => !Number.isInteger(i) || i < 0 || i >= next.length)) throw new Error('The colour map needs a new palette index for every old colour.');
  const used = usedPaletteIndices(p), to = v => (v < 0 ? v : m[v]);
  const remap = list => list.map(op => (op.type === 'span' ? { ...op, values: op.values.map(to) } : op.type === 'use' ? op : { ...op, color: to(op.color) }));
  for (const a of p.animations) for (const f of a.frames) for (const cel of f.cels) {
    cel.pixels = cel.pixels.map(to);
    if (cel.source) cel.source = { ops: remap(cel.source.ops), overrides: remap(cel.source.overrides) };
  }
  for (const part of p.parts || []) part.ops = remap(part.ops);
  const changed = [...used].filter(i => next[m[i]] !== p.palette[i]).length;
  p.palette = next;
  return { project: validateProject(p), map: m, changed };
}

/** Remove palette colour `index`; its pixels take colour `into` (default: the nearest remaining), later indices shift down. */
export function removePaletteColour(project, index, into) {
  const old = project.palette;
  if (!Number.isInteger(index) || index < 0 || index >= old.length) throw new Error('Choose a palette colour to remove.');
  if (old.length < 2) throw new Error('A palette needs at least one colour.');
  if (into !== undefined && (!Number.isInteger(into) || into < 0 || into >= old.length || into === index)) throw new Error('Choose another palette colour to merge into.');
  const next = old.filter((_, i) => i !== index), shift = i => i - (i > index);
  const target = into === undefined ? nearestIndexMap([old[index]], next)[0] : shift(into);
  return replacePalette(project, next, old.map((_, i) => (i === index ? target : shift(i))));
}

/** Drop palette colours no artwork uses (keeping at least one); returns { project, removed: old indices }. */
export function removeUnusedColours(project) {
  const used = usedPaletteIndices(project), keep = project.palette.map((_, i) => i).filter(i => used.has(i));
  if (!keep.length) keep.push(0);
  const index = new Map(keep.map((old, i) => [old, i])), next = keep.map(i => project.palette[i]);
  const nearest = nearestIndexMap(project.palette, next);
  const removed = project.palette.map((_, i) => i).filter(i => !index.has(i));
  return { ...replacePalette(project, next, project.palette.map((_, i) => index.get(i) ?? nearest[i])), removed };
}

/** Reorder the palette by `order` (a permutation of indices) without changing how anything looks. */
export function reorderPalette(project, order) {
  const n = project.palette.length;
  if (!Array.isArray(order) || order.length !== n || new Set(order).size !== n || order.some(i => !Number.isInteger(i) || i < 0 || i >= n)) throw new Error('The new order must list every palette index once.');
  const map = Array(n);
  order.forEach((oldIndex, newIndex) => { map[oldIndex] = newIndex; });
  return replacePalette(project, order.map(i => project.palette[i]), map);
}
