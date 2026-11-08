/**
 * Palette-aware shading: colour ramps detected in any palette (hue-shifted chains or plain lightness families), the
 * one-step shade used by the Shade brush, and an automatic selective outline that picks the darkest colour of each
 * fill's ramp. Pure and deterministic; pixels are row-major palette indices, -1 transparent.
 */
import { hexToOklch, hexToRgb, rgbToOklab } from './colour.js';
import { shadeIndex } from './toolbox.js';

export const RAMP_MODES = ['hue-shift', 'lightness'];
const GREY = 0.03, MIN_STEP = 0.02;
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

function readPalette(palette) {
  if (!Array.isArray(palette) || !palette.length) throw new Error('The palette needs at least one colour.');
  return palette.map(hex => ({ lch: hexToOklch(hex), lab: rgbToOklab(hexToRgb(hex)) }));
}
function readIndex(index, palette) {
  if (!Number.isInteger(index) || index < 0 || index >= palette.length) throw new Error('Choose a palette colour.');
  return index;
}
const labGap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The ramp (palette indices, dark → light) that `index` belongs to. mode 'hue-shift' (default) chains step by step
 * to the perceptually nearest darker / lighter colour whose hue is within 50° of the previous step (and 100° of the
 * start), so ramps that drift from cool shadows to warm highlights are found; greys chain with greys. 'lightness'
 * takes every colour within 20° of the start's hue (greys with greys), ordered by lightness.
 */
export function paletteRamp(palette, index, { mode = 'hue-shift' } = {}) {
  const colours = readPalette(palette);
  readIndex(index, palette);
  if (!RAMP_MODES.includes(mode)) throw new Error('Ramp mode must be hue-shift or lightness.');
  const base = colours[index].lch, grey = c => c.lch[1] < GREY;
  if (mode === 'lightness') {
    const family = colours.map((c, i) => i).filter(i => i === index || (grey(colours[i]) === grey(colours[index]) && (grey(colours[i]) || hueGap(colours[i].lch[2], base[2]) <= 20)));
    const sorted = family.sort((a, b) => colours[a].lch[0] - colours[b].lch[0] || a - b);
    return sorted.filter((i, k) => i === index || k === 0 || colours[i].lch[0] - colours[sorted[k - 1]].lch[0] >= MIN_STEP / 2);
  }
  const ramp = [index], used = new Set(ramp);
  for (const direction of [-1, 1]) {
    for (let current = index; ;) {
      const from = colours[current];
      let best = -1, bestGap = Infinity;
      colours.forEach((c, j) => {
        if (used.has(j) || direction * (c.lch[0] - from.lch[0]) < MIN_STEP || grey(c) !== grey(from)) return;
        if (!grey(c) && (hueGap(c.lch[2], from.lch[2]) > 50 || hueGap(c.lch[2], base[2]) > 100)) return;
        const gap = labGap(c.lab, from.lab);
        if (gap < bestGap) { best = j; bestGap = gap; }
      });
      if (best < 0) break;
      used.add(best); direction < 0 ? ramp.unshift(best) : ramp.push(best); current = best;
    }
  }
  return ramp;
}

/**
 * One shading step along the colour's ramp: direction -1 darker, +1 lighter. At the end of a ramp the colour stays;
 * a colour with no ramp of its own falls back to the nearest noticeably darker / lighter palette colour.
 */
export function shadeStep(palette, index, direction, options = {}) {
  if (direction !== -1 && direction !== 1) throw new Error('Shade direction must be -1 (darker) or 1 (lighter).');
  if (index < 0) return index;
  const ramp = paletteRamp(palette, index, options);
  if (ramp.length < 2) return shadeIndex(palette, index, direction);
  return ramp[Math.max(0, Math.min(ramp.length - 1, ramp.indexOf(index) + direction))];
}

/** shadeStep for every palette colour, as an array index → stepped index (for fast brushing). */
export function shadeMap(palette, direction, options = {}) { return palette.map((_, i) => shadeStep(palette, i, direction, options)); }

/** Outline colour for a fill: the darkest of its ramp, or the nearest darker colour when the fill is already darkest. */
export function outlineColourFor(palette, fill, options = {}) {
  const darkest = paletteRamp(palette, fill, options)[0];
  return darkest !== fill ? darkest : shadeIndex(palette, fill, -1);
}

const ORTHO = [[0, -1], [-1, 0], [1, 0], [0, 1]], DIAG = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

/**
 * Automatic outline. mode 'outside' adds pixels around the art, 'inside' recolours its edge pixels; corners=true also
 * uses diagonal neighbours (a square outline). style 'selective' (sel-out) gives each outline pixel the darkest
 * colour in the ramp of the fill it touches (the most common neighbouring fill, edge-sharing first); 'single' uses
 * `color`. Optional `mask` (0/1 per pixel) limits the change. Returns new pixels.
 */
export function autoOutline(pixels, width, height, palette, { mode = 'outside', corners = true, style = 'selective', color, mask, rampMode = 'hue-shift' } = {}) {
  if (!Array.isArray(pixels) || pixels.length !== width * height) throw new Error(`Expected exactly ${width * height} pixels.`);
  if (!['outside', 'inside'].includes(mode)) throw new Error('Outline mode must be outside or inside.');
  if (!['selective', 'single'].includes(style)) throw new Error('Outline style must be selective or single.');
  if (style === 'single') readIndex(color, palette);
  const cache = new Map(), darkest = fill => {
    if (!cache.has(fill)) cache.set(fill, outlineColourFor(palette, fill, { mode: rampMode }));
    return cache.get(fill);
  };
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? -1 : pixels[y * width + x]);
  const result = pixels.slice();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, own = pixels[i];
    if (mask && !mask[i]) continue;
    if (mode === 'inside') {
      if (own < 0) continue;
      const edge = [...ORTHO, ...(corners ? DIAG : [])].some(([dx, dy]) => at(x + dx, y + dy) < 0);
      if (edge) result[i] = style === 'single' ? color : darkest(own);
      continue;
    }
    if (own >= 0) continue;
    let fill = -1;
    for (const ring of corners ? [ORTHO, DIAG] : [ORTHO]) {
      const counts = new Map();
      for (const [dx, dy] of ring) { const v = at(x + dx, y + dy); if (v >= 0) counts.set(v, (counts.get(v) || 0) + 1); }
      for (const [v, n] of counts) if (fill < 0 || n > counts.get(fill) || (n === counts.get(fill) && v < fill)) fill = v;
      if (fill >= 0) break;
    }
    if (fill >= 0) result[i] = style === 'single' ? color : darkest(fill);
  }
  return result;
}
