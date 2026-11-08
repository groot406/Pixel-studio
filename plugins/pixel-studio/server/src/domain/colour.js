// Colour maths for pixel art: OKLab/OKLCH conversions, distances, hue-shifted ramps,
// palette families, palette cycling and harmonies. Pure and deterministic.
import { MAX_COLORS } from './limits.js';

const HEX = /^#[0-9a-f]{6}$/i;
const GAMUT_EPS = 1e-7;
const ACHROMATIC = 0.03;
const SHADOW_HUE = 260;
const HIGHLIGHT_HUE = 90;

/** Throw unless `hex` is a six-digit '#rrggbb' string; return it lower-cased. */
function readHex(hex, label = 'Colour') {
  if (typeof hex !== 'string' || !HEX.test(hex)) throw new Error(`${label} must be a six-digit hex colour, such as #ffcc66.`);
  return hex.toLowerCase();
}

/** Validate a palette array of hex strings; return a lower-cased copy. */
function readPalette(palette, label = 'Palette') {
  if (!Array.isArray(palette) || !palette.length) throw new Error(`${label} must be a non-empty array of hex colours.`);
  return palette.map((c, i) => readHex(c, `${label} colour ${i}`));
}

function readNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapHue = (h) => ((h % 360) + 360) % 360;
/** Signed shortest angular difference b - a in degrees, in (-180, 180]. */
const hueDelta = (a, b) => { const d = wrapHue(b - a); return d > 180 ? d - 360 : d; };

/** '#rrggbb' → [r, g, b] bytes. */
export function hexToRgb(hex) {
  const v = Number.parseInt(readHex(hex).slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** [r, g, b] (0–255, rounded and clamped) → '#rrggbb'. */
export function rgbToHex(rgb) {
  if (!Array.isArray(rgb) || rgb.length !== 3) throw new Error('RGB must be an array of three channel values.');
  return '#' + rgb.map((c, i) => clamp(Math.round(readNumber(c, `RGB channel ${i}`)), 0, 255).toString(16).padStart(2, '0')).join('');
}

/** sRGB channel 0–1 → linear-light 0–1. */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Linear-light channel 0–1 → sRGB 0–1 (sign-preserving for out-of-gamut values). */
export function linearToSrgb(c) {
  const a = Math.abs(c);
  const v = a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055;
  return c < 0 ? -v : v;
}

function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

/** [r, g, b] bytes → OKLab [L, a, b] (Björn Ottosson). */
export function rgbToOklab(rgb) {
  if (!Array.isArray(rgb) || rgb.length !== 3) throw new Error('RGB must be an array of three channel values.');
  return linearToOklab(rgb.map((c, i) => srgbToLinear(readNumber(c, `RGB channel ${i}`) / 255)));
}

/** OKLab [L, a, b] → unrounded, unclamped sRGB [r, g, b] in 0–255 scale. */
export function oklabToRgb(lab) {
  if (!Array.isArray(lab) || lab.length !== 3) throw new Error('OKLab must be an array [L, a, b].');
  lab.forEach((v, i) => readNumber(v, `OKLab component ${i}`));
  return oklabToLinear(lab).map((c) => linearToSrgb(c) * 255);
}

/** OKLab [L, a, b] → OKLCH [L, C, h°]. */
export function oklabToOklch([L, a, b]) {
  const C = Math.hypot(a, b);
  return [L, C, C < 1e-9 ? 0 : wrapHue((Math.atan2(b, a) * 180) / Math.PI)];
}

/** OKLCH [L, C, h°] → OKLab [L, a, b]. */
export function oklchToOklab([L, C, h]) {
  const r = (h * Math.PI) / 180;
  return [L, C * Math.cos(r), C * Math.sin(r)];
}

/** '#rrggbb' → OKLCH [L, C, h°]. */
export function hexToOklch(hex) {
  return oklabToOklch(rgbToOklab(hexToRgb(hex)));
}

const inGamut = (lin) => lin.every((c) => c >= -GAMUT_EPS && c <= 1 + GAMUT_EPS);

/** OKLCH → '#rrggbb'; out-of-gamut colours keep L and h while chroma is reduced by bisection. */
export function oklchToHex(lch) {
  if (!Array.isArray(lch) || lch.length !== 3) throw new Error('OKLCH must be an array [L, C, h].');
  const [L0, C0, h] = lch.map((v, i) => readNumber(v, `OKLCH component ${i}`));
  const L = clamp(L0, 0, 1), C = Math.max(0, C0);
  if (L >= 1) return '#ffffff';
  if (L <= 0) return '#000000';
  const lin = (c) => oklabToLinear(oklchToOklab([L, c, h]));
  let best = lin(C);
  if (!inGamut(best)) {
    let lo = 0, hi = C;
    best = lin(0);
    for (let i = 0; i < 30; i += 1) {
      const mid = (lo + hi) / 2, v = lin(mid);
      if (inGamut(v)) { lo = mid; best = v; } else hi = mid;
    }
  }
  return rgbToHex(best.map((c) => clamp(linearToSrgb(c), 0, 1) * 255));
}

/** OKLab → '#rrggbb' with gamut mapping. */
function oklabToHex(lab) {
  return oklchToHex(oklabToOklch(lab));
}

/** Perceptual distance: Euclidean distance in OKLab (≈0.02 is barely noticeable). */
export function deltaE(hexA, hexB) {
  const a = rgbToOklab(hexToRgb(hexA)), b = rgbToOklab(hexToRgb(hexB));
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function nearestLab(lab, labs) {
  let best = 0, bestD = Infinity;
  labs.forEach((p, i) => {
    const d = (lab[0] - p[0]) ** 2 + (lab[1] - p[1]) ** 2 + (lab[2] - p[2]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

/** Index of the palette colour perceptually closest to `hex` (first wins ties). */
export function nearestColour(hex, palette) {
  const labs = readPalette(palette).map((c) => rgbToOklab(hexToRgb(c)));
  return nearestLab(rgbToOklab(hexToRgb(hex)), labs);
}

/** Array mapping each `fromPalette` index to its nearest `toPalette` index (for remapping pixels). */
export function nearestIndexMap(fromPalette, toPalette) {
  const to = readPalette(toPalette, 'Target palette').map((c) => rgbToOklab(hexToRgb(c)));
  return readPalette(fromPalette, 'Source palette').map((c) => nearestLab(rgbToOklab(hexToRgb(c)), to));
}

/** Move hue `h` toward `target` by up to `amount` degrees along the shortest arc, never overshooting. */
function shiftHueToward(h, target, amount) {
  const d = hueDelta(h, target);
  return wrapHue(h + Math.sign(d) * Math.min(Math.abs(d), amount));
}

/**
 * Hue-shifted shading ramp, darkest → lightest. Shadows rotate toward cool blue (h≈260), highlights toward
 * warm yellow (h≈90); chroma falls off toward both extremes. The base colour is included exactly at `baseIndex`.
 * Options: steps (2–16, default 5), hueShift (total degrees, default 20), lightnessSpan (total L, default 0.6),
 * chromaDrop (0–1 fraction of chroma lost at extremes, default 0.35), baseIndex (default middle).
 */
export function shadingRamp(baseHex, options = {}) {
  const base = readHex(baseHex, 'Base colour');
  const { steps = 5, hueShift = 20, lightnessSpan = 0.6, chromaDrop = 0.35 } = options;
  if (!Number.isInteger(steps) || steps < 2 || steps > 16) throw new Error('Ramp steps must be a whole number from 2 to 16.');
  readNumber(hueShift, 'Hue shift');
  if (readNumber(lightnessSpan, 'Lightness span') <= 0 || lightnessSpan > 1) throw new Error('Lightness span must be between 0 and 1.');
  if (readNumber(chromaDrop, 'Chroma drop') < 0 || chromaDrop > 1) throw new Error('Chroma drop must be between 0 and 1.');
  const b = options.baseIndex ?? Math.floor((steps - 1) / 2);
  if (!Number.isInteger(b) || b < 0 || b >= steps) throw new Error(`Base index must be a whole number from 0 to ${steps - 1}.`);
  const [L, C, h] = hexToOklch(base);
  const half = lightnessSpan / 2;
  const down = Math.min(half * (b / Math.max(1, (steps - 1) / 2)), Math.max(0, L - 0.05));
  const up = Math.min(half * ((steps - 1 - b) / Math.max(1, (steps - 1) / 2)), Math.max(0, 0.98 - L));
  return Array.from({ length: steps }, (_, i) => {
    if (i === b) return base;
    const t = i < b ? -(b - i) / b : (i - b) / (steps - 1 - b);
    const Li = t < 0 ? L + t * down : L + t * up;
    const Ci = C * (1 - chromaDrop * t * t);
    const hi = shiftHueToward(h, t < 0 ? SHADOW_HUE : HIGHLIGHT_HUE, (Math.abs(t) * hueShift) / 2);
    return oklchToHex([Li, Ci, hi]);
  });
}

/** True when two OKLCH colours belong to the same hue family. */
function sameFamily(a, b, hueTolerance) {
  const greyA = a[1] < ACHROMATIC, greyB = b[1] < ACHROMATIC;
  if (greyA || greyB) return greyA && greyB;
  return Math.abs(hueDelta(a[2], b[2])) <= hueTolerance;
}

/** Indices of palette colours in the same hue family as `baseIndex` (greys group together), sorted dark → light. */
export function rampFromPalette(palette, baseIndex, { hueTolerance = 35 } = {}) {
  const lch = readPalette(palette).map(hexToOklch);
  if (!Number.isInteger(baseIndex) || baseIndex < 0 || baseIndex >= lch.length) throw new Error('Choose a valid base palette index.');
  readNumber(hueTolerance, 'Hue tolerance');
  return lch
    .map((c, i) => i)
    .filter((i) => i === baseIndex || sameFamily(lch[baseIndex], lch[i], hueTolerance))
    .sort((i, j) => lch[i][0] - lch[j][0] || i - j);
}

function neighbourMap(palette, direction, hueTolerance) {
  const p = readPalette(palette);
  const lch = p.map(hexToOklch), labs = p.map((c) => rgbToOklab(hexToRgb(c)));
  const map = new Map();
  const minStep = 0.01;
  p.forEach((_, i) => {
    const beyond = (j) => direction * (lch[j][0] - lch[i][0]) > minStep;
    const family = rampFromPalette(p, i, { hueTolerance }).filter(beyond);
    if (family.length) {
      // Nearest in lightness within the family; ties broken by index.
      family.sort((a, b) => Math.abs(lch[a][0] - lch[i][0]) - Math.abs(lch[b][0] - lch[i][0]) || a - b);
      map.set(i, family[0]);
      return;
    }
    const others = p.map((c, j) => j).filter(beyond);
    if (!others.length) { map.set(i, i); return; }
    map.set(i, others[nearestLab(labs[i], others.map((j) => labs[j]))]);
  });
  return map;
}

/** Map index → nearest darker colour in the same hue family; falls back to the closest darker colour, else itself. */
export function darkerMap(palette, { hueTolerance = 35 } = {}) {
  return neighbourMap(palette, -1, hueTolerance);
}

/** Map index → nearest lighter colour in the same hue family; falls back to the closest lighter colour, else itself. */
export function lighterMap(palette, { hueTolerance = 35 } = {}) {
  return neighbourMap(palette, 1, hueTolerance);
}

/**
 * Merge `ramp` colours into `palette`, reusing any colour within deltaE < `tolerance` (default 0.02).
 * Returns { palette, indices } where indices[i] is the palette slot for ramp[i]. Throws if `max` would be exceeded.
 */
export function addRampToPalette(palette, ramp, max = MAX_COLORS, { tolerance = 0.02 } = {}) {
  const next = Array.isArray(palette) && palette.length === 0 ? [] : readPalette(palette);
  const colours = readPalette(ramp, 'Ramp');
  if (!Number.isInteger(max) || max < 1 || max > MAX_COLORS) throw new Error(`Palette limit must be a whole number from 1 to ${MAX_COLORS}.`);
  const indices = colours.map((c) => {
    if (next.length) {
      const i = nearestColour(c, next);
      if (deltaE(c, next[i]) < tolerance) return i;
    }
    if (next.length >= max) throw new Error(`Adding this ramp would exceed the ${max}-colour palette limit.`);
    next.push(c);
    return next.length - 1;
  });
  return { palette: next, indices };
}

function readRamp(ramp) {
  if (!Array.isArray(ramp) || !ramp.length) throw new Error('Cycle ramp must be a non-empty array of palette indices.');
  if (ramp.some((i) => !Number.isInteger(i) || i < 0)) throw new Error('Cycle ramp entries must be palette indices (whole numbers ≥ 0).');
  if (new Set(ramp).size !== ramp.length) throw new Error('Cycle ramp must not repeat a palette index.');
  return ramp;
}

function readPixels(pixels) {
  if (!Array.isArray(pixels) && !ArrayBuffer.isView(pixels)) throw new Error('Pixels must be an array of palette indices.');
  return pixels;
}

/** Palette cycling: shift every pixel whose index is in `rampIndices` by `step` ramp positions (wrapping). */
export function cycleRamp(pixels, rampIndices, step) {
  readPixels(pixels);
  const ramp = readRamp(rampIndices), n = ramp.length;
  if (!Number.isInteger(step)) throw new Error('Cycle step must be a whole number.');
  const pos = new Map(ramp.map((c, i) => [c, i]));
  const out = pixels.slice();
  for (let i = 0; i < out.length; i += 1) {
    const p = pos.get(out[i]);
    if (p !== undefined) out[i] = ramp[(((p + step) % n) + n) % n];
  }
  return out;
}

/** Frames for colour cycling: frame k is cycled by k × stepsPerFrame × direction (frame 0 is an unchanged copy). */
export function colourCycleFrames(pixels, ramp, frameCount, { direction = 1, stepsPerFrame = 1 } = {}) {
  if (!Number.isInteger(frameCount) || frameCount < 1) throw new Error('Frame count must be a whole number ≥ 1.');
  if (direction !== 1 && direction !== -1) throw new Error('Cycle direction must be 1 or -1.');
  if (!Number.isInteger(stepsPerFrame)) throw new Error('Steps per frame must be a whole number.');
  readPixels(pixels); readRamp(ramp);
  return Array.from({ length: frameCount }, (_, k) => cycleRamp(pixels, ramp, k * stepsPerFrame * direction));
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** Frames until a cycle returns to its start: ramp length / gcd(ramp length, |stepsPerFrame|). */
export function cycleLoopLength(ramp, stepsPerFrame = 1) {
  const n = readRamp(ramp).length;
  if (!Number.isInteger(stepsPerFrame)) throw new Error('Steps per frame must be a whole number.');
  const s = Math.abs(stepsPerFrame) % n;
  return s === 0 ? 1 : n / gcd(n, s);
}

const HARMONY = {
  analogous: { count: 3, hues: (i) => (i === 0 ? 0 : (i % 2 ? 1 : -1) * 30 * Math.ceil(i / 2)), rings: false },
  complementary: { count: 2, hues: [0, 180], rings: true },
  triadic: { count: 3, hues: [0, 120, 240], rings: true },
};

/**
 * Harmony colours in OKLCH, base first. Analogous fans out ±30° steps; complementary/triadic repeat their hue
 * set with alternating lighter/darker variants when `count` exceeds the set size.
 */
export function paletteHarmony(baseHex, kind, count) {
  const base = readHex(baseHex, 'Base colour');
  const spec = HARMONY[kind];
  if (!spec) throw new Error('Harmony kind must be analogous, complementary or triadic.');
  const n = count ?? spec.count;
  if (!Number.isInteger(n) || n < 1 || n > MAX_COLORS) throw new Error(`Harmony count must be a whole number from 1 to ${MAX_COLORS}.`);
  const [L, C, h] = hexToOklch(base);
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return base;
    if (!spec.rings) return oklchToHex([L, C, wrapHue(h + spec.hues(i))]);
    const k = spec.hues.length, ring = Math.floor(i / k);
    const dL = ring === 0 ? 0 : (ring % 2 ? 1 : -1) * 0.12 * Math.ceil(ring / 2);
    return oklchToHex([clamp(L + dL, 0.05, 0.98), C, wrapHue(h + spec.hues[i % k])]);
  });
}

/** Perceptual mix of two colours in OKLab; t=0 → a, t=1 → b. */
export function mixColour(a, b, t) {
  const A = rgbToOklab(hexToRgb(a)), B = rgbToOklab(hexToRgb(b));
  if (readNumber(t, 'Mix amount') < 0 || t > 1) throw new Error('Mix amount must be between 0 and 1.');
  if (t === 0) return a.toLowerCase();
  if (t === 1) return b.toLowerCase();
  return oklabToHex(A.map((v, i) => v + (B[i] - v) * t));
}
