// Shared image clean-up for "Import image" and "Generate image": grid detection or downscaling,
// background removal, palette mapping, sprite-sheet slicing and placing on a canvas. Pure functions.
import { detectGrid, edgeProfiles, pixelize, averageDownscale, trimRgba } from './pixelize.js';
import { paletteFromRgba, mapRgbaToPalette } from './project.js';
import { MAX_COLORS, MAX_SIZE } from './limits.js';
import { mapRgbaPerceptual } from './palette-map.js';

/** Place an RGBA image centred on a canvas; shrink with sharp nearest-neighbour when it does not fit. */
export function placeRgba(source, sourceWidth, sourceHeight, canvasWidth, canvasHeight, fit) {
  const ratio = fit ? Math.min(1, canvasWidth / sourceWidth, canvasHeight / sourceHeight) : 1;
  const width = Math.max(1, Math.round(sourceWidth * ratio)), height = Math.max(1, Math.round(sourceHeight * ratio));
  const left = Math.floor((canvasWidth - width) / 2), top = Math.floor((canvasHeight - height) / 2);
  const out = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const tx = left + x, ty = top + y;
    if (tx < 0 || ty < 0 || tx >= canvasWidth || ty >= canvasHeight) continue;
    const sx = Math.min(sourceWidth - 1, Math.floor(x / ratio)), sy = Math.min(sourceHeight - 1, Math.floor(y / ratio));
    out.set(source.subarray((sy * sourceWidth + sx) * 4, (sy * sourceWidth + sx) * 4 + 4), (ty * canvasWidth + tx) * 4);
  }
  return out;
}

/** Make every pixel close to `key` ([r,g,b]) transparent, including enclosed holes (chroma-key backgrounds). */
export function removeKeyColor(rgba, key, tolerance = 90) {
  const out = new Uint8ClampedArray(rgba);
  let removed = 0;
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] < 128) continue;
    if (Math.abs(out[i] - key[0]) + Math.abs(out[i + 1] - key[1]) + Math.abs(out[i + 2] - key[2]) <= tolerance) { out[i + 3] = 0; removed += 1; }
  }
  return { rgba: out, removed };
}

/**
 * Clean an image into real pixels. mode: 'detect' (pixel grid, optional forced `scale`), 'average' (downscale so the
 * longest side is `target`) or 'auto' (detect, falling back to average when no grid is found).
 * `detected`/`profiles` may be passed to reuse earlier work. Returns { rgba, width, height, grid, mode }.
 */
export function cleanImage(source, width, height, options = {}) {
  const { background = true, trim = true, maxSize = MAX_SIZE, keyColor = null, target = 64 } = options;
  let mode = options.mode || 'auto';
  const profiles = options.profiles || (mode !== 'average' ? edgeProfiles(source, width, height) : null);
  const detected = options.detected || (mode !== 'average' ? detectGrid(source, width, height, { profiles }) : null);
  if (mode === 'auto') mode = detected.scale > 1 ? 'detect' : 'average';
  let result;
  if (mode === 'average') {
    const averageTarget = Math.max(4, Math.min(maxSize, Math.round(target) || 64));
    const ratio = averageTarget / Math.max(width, height);
    const pre = averageDownscale(source, width, height, Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio)));
    result = pixelize(pre.rgba, pre.width, pre.height, { mode: 'none', background, trim: trim && !keyColor });
  } else {
    const scale = options.scale;
    const grid = !scale || Math.abs(scale - detected.scale) < 0.005 ? detected : detectGrid(source, width, height, { profiles, scale: Math.max(1, scale) });
    result = pixelize(source, width, height, { mode: 'detect', grid, background, trim: trim && !keyColor, maxSize });
  }
  if (keyColor) {
    result = { ...result, rgba: removeKeyColor(result.rgba, keyColor).rgba };
    if (trim) { const t = trimRgba(result.rgba, result.width, result.height); if (t) result = { ...result, rgba: t.rgba, width: t.width, height: t.height }; }
  }
  return { rgba: result.rgba, width: result.width, height: result.height, grid: result.grid, mode, detected };
}

/**
 * Palette indices for an image. colors: a number (build a palette of at most that many colours) or 'palette'
 * (map perceptually onto `palette`). Returns { palette, pixels }.
 */
export function quantizeImage(rgba, width, height, { colors = 16, palette, dither = false } = {}) {
  if (colors === 'palette') return { palette, pixels: mapRgbaPerceptual(rgba, palette, width, height, { dither }) };
  const built = paletteFromRgba(rgba, Math.min(MAX_COLORS, Number(colors) || MAX_COLORS));
  return { palette: built, pixels: dither ? mapRgbaPerceptual(rgba, built, width, height, { dither }) : mapRgbaToPalette(rgba, built, width, height) };
}

/**
 * Slice a cleaned, untrimmed sprite sheet of `count` equal cells in one row into frames that share one size:
 * every frame is cropped to the union of their opaque boxes, so the character stays aligned between frames.
 */
export function sliceSheet(rgba, width, height, count) {
  const n = Math.max(1, Math.min(64, Math.round(count)));
  const cell = width / n, cellWidth = Math.max(1, Math.floor(cell));
  const cells = [];
  for (let k = 0; k < n; k += 1) {
    const x0 = Math.min(width - cellWidth, Math.round(k * cell)), out = new Uint8ClampedArray(cellWidth * height * 4);
    for (let y = 0; y < height; y += 1) out.set(rgba.subarray((y * width + x0) * 4, (y * width + x0 + cellWidth) * 4), y * cellWidth * 4);
    cells.push(out);
  }
  let minX = cellWidth, minY = height, maxX = -1, maxY = -1;
  for (const out of cells) {
    const box = trimRgba(out, cellWidth, height);
    if (!box) continue;
    minX = Math.min(minX, box.x); minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width - 1); maxY = Math.max(maxY, box.y + box.height - 1);
  }
  if (maxX < 0) return { frames: cells, width: cellWidth, height };
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const frames = cells.map(out => {
    const crop = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) crop.set(out.subarray(((minY + y) * cellWidth + minX) * 4, ((minY + y) * cellWidth + minX + w) * 4), y * w * 4);
    return crop;
  });
  return { frames, width: w, height: h };
}
