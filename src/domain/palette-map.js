// Map RGBA images onto a fixed palette using perceptual (OKLab) distance, optionally with
// Floyd–Steinberg error diffusion in OKLab. Pure; used by image import and AI image generation.
import { hexToRgb, rgbToOklab } from './colour.js';

const toLab = rgb => rgbToOklab(rgb);

function nearest(lab, labs) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < labs.length; i += 1) {
    const p = labs[i], d = (lab[0] - p[0]) ** 2 + (lab[1] - p[1]) ** 2 + (lab[2] - p[2]) ** 2;
    if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
  }
  return best;
}

/**
 * Palette index per pixel (-1 where alpha < 128) for `rgba` of `width` × `height`.
 * `dither` diffuses the OKLab error to opaque neighbours only, so outlines and transparency stay crisp.
 */
export function mapRgbaPerceptual(rgba, palette, width, height, { dither = false } = {}) {
  if (!Array.isArray(palette) || !palette.length) throw new Error('The palette needs at least one colour.');
  const count = width * height;
  if (!rgba || rgba.length !== count * 4) throw new Error(`Pixels must be sized to ${width} × ${height}.`);
  const labs = palette.map(hex => toLab(hexToRgb(hex)));
  const pixels = Array(count).fill(-1);
  if (!dither) {
    const cache = new Map();
    for (let i = 0; i < count; i += 1) {
      const o = i * 4;
      if (rgba[o + 3] < 128) continue;
      const key = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
      let index = cache.get(key);
      if (index === undefined) { index = nearest(toLab([rgba[o], rgba[o + 1], rgba[o + 2]]), labs); cache.set(key, index); }
      pixels[i] = index;
    }
    return pixels;
  }
  const work = new Float64Array(count * 3), opaque = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    if (rgba[o + 3] < 128) continue;
    opaque[i] = 1;
    work.set(toLab([rgba[o], rgba[o + 1], rgba[o + 2]]), i * 3);
  }
  const spread = (x, y, e, weight) => {
    if (x < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (!opaque[p]) return;
    for (let c = 0; c < 3; c += 1) work[p * 3 + c] += e[c] * weight;
  };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const p = y * width + x;
    if (!opaque[p]) continue;
    const lab = [work[p * 3], work[p * 3 + 1], work[p * 3 + 2]], index = nearest(lab, labs), chosen = labs[index];
    pixels[p] = index;
    // Damped error keeps flat areas flat: pixel art wants a light, ordered-looking texture, not noise.
    const e = [0, 1, 2].map(c => (lab[c] - chosen[c]) * 0.75);
    spread(x + 1, y, e, 7 / 16); spread(x - 1, y + 1, e, 3 / 16); spread(x, y + 1, e, 5 / 16); spread(x + 1, y + 1, e, 1 / 16);
  }
  return pixels;
}

/** Palette indices back to RGBA (for previews). */
export function indicesToRgba(pixels, palette) {
  const colors = palette.map(hexToRgb), out = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach((index, i) => { if (index >= 0) { out.set(colors[index], i * 4); out[i * 4 + 3] = 255; } });
  return out;
}
