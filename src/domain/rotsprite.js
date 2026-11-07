/**
 * RotSprite-style smoothing for indexed pixel art: Scale2x (EPX) three times gives an 8× image whose corner rounding
 * follows the artwork's own edges; free angles, skew and deforms then pick the 8× sub-pixel under each destination
 * pixel centre. Colours stay palette indices (-1 transparent) and equal indices are the only comparison, so it is exact.
 */
export const ROTSPRITE_SCALE = 8;
const byPixels = new WeakMap(), byContent = new Map(), CONTENT_CACHE = 16;

/** One Scale2x (EPX) pass with clamped edges: each pixel becomes 2×2, rounding a corner only where two neighbours agree. */
export function scale2x(pixels, width, height) {
  const out = new Int16Array(width * height * 4), w2 = width * 2;
  const at = (x, y) => pixels[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const e = at(x, y), b = at(x, y - 1), d = at(x - 1, y), f = at(x + 1, y), h = at(x, y + 1), i = 2 * y * w2 + 2 * x;
    const edge = b !== h && d !== f;
    out[i] = edge && d === b ? d : e;
    out[i + 1] = edge && b === f ? f : e;
    out[i + w2] = edge && d === h ? d : e;
    out[i + w2 + 1] = edge && h === f ? f : e;
  }
  return out;
}

/** The cached 8× Scale2x³ image of a rendered part `{width,height,pixels}`. */
export function rotspriteImage(part) {
  const cached = byPixels.get(part.pixels);
  if (cached) return cached;
  const key = `${part.width}x${part.height}:${part.pixels.join(',')}`;
  let image = byContent.get(key);
  if (!image) {
    let pixels = part.pixels, width = part.width, height = part.height;
    for (let pass = 0; pass < 3; pass++) { pixels = scale2x(pixels, width, height); width *= 2; height *= 2; }
    image = { width, height, pixels };
    if (byContent.size >= CONTENT_CACHE) byContent.delete(byContent.keys().next().value);
  } else byContent.delete(key);
  byContent.set(key, image);
  byPixels.set(part.pixels, image);
  return image;
}
