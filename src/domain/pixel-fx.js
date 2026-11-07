/** Pure, deterministic pixel-art effects on indexed pixels (row-major, -1 = transparent). */
import { MAX_COLORS, pixelCount } from './limits.js';
import { pixelPerfectStep } from './toolbox.js';

const ORTHO = [[0, -1], [-1, 0], [1, 0], [0, 1]];
const DIAG = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
const METRICS = ['chebyshev', 'manhattan', 'euclidean'];
const EDGES = ['transparent', 'clamp', 'wrap'];

function colorIndex(value, label, allowTransparent = true) {
  if (!Number.isInteger(value) || value < (allowTransparent ? -1 : 0) || value >= MAX_COLORS) {
    throw new Error(`${label} must be a palette index from ${allowTransparent ? -1 : 0} to ${MAX_COLORS - 1}.`);
  }
  return value;
}

function readPixels(pixels, width, height, label = 'pixels') {
  const count = pixelCount(width, height);
  if (!Array.isArray(pixels) || pixels.length !== count) throw new Error(`Expected exactly ${count} indexed ${label}.`);
  for (let i = 0; i < count; i += 1) colorIndex(pixels[i], 'Each pixel');
  return count;
}

function readMask(mask, count) {
  if (mask == null) return null;
  if (!(Array.isArray(mask) || ArrayBuffer.isView(mask)) || mask.length !== count) throw new Error(`A mask must contain exactly ${count} entries.`);
  return mask;
}

function readPoint(value, label) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Error(`${label} must be a point with finite x and y.`);
  return { x: value.x, y: value.y };
}

function positiveInt(value, label, max = 1024) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${label} must be a whole number from 1 to ${max}.`);
  return value;
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of: ${allowed.join(', ')}.`);
  return value;
}

/** Look up a colour in a Map, array, or plain object; undefined when absent. */
function lookup(map, key) {
  if (map == null) return undefined;
  const value = map instanceof Map ? map.get(key) : map[key];
  return value === undefined ? undefined : colorIndex(value, 'A mapped colour');
}

/** Keep effect pixels only where the optional mask is set. */
function limit(base, effect, mask) { return mask ? applyMask(base, effect, mask) : effect; }

// ---------------------------------------------------------------------------------------------
// Distance field

function chamfer(dist, W, H, diagonal) {
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? Infinity : dist[y * W + x]);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let d = dist[y * W + x];
      d = Math.min(d, at(x - 1, y) + 1, at(x, y - 1) + 1);
      if (diagonal) d = Math.min(d, at(x - 1, y - 1) + 1, at(x + 1, y - 1) + 1);
      dist[y * W + x] = d;
    }
  }
  for (let y = H - 1; y >= 0; y -= 1) {
    for (let x = W - 1; x >= 0; x -= 1) {
      let d = dist[y * W + x];
      d = Math.min(d, at(x + 1, y) + 1, at(x, y + 1) + 1);
      if (diagonal) d = Math.min(d, at(x + 1, y + 1) + 1, at(x - 1, y + 1) + 1);
      dist[y * W + x] = d;
    }
  }
}

const BIG = 1e20;

/** Felzenszwalb–Huttenlocher exact 1D squared distance transform. */
function edt1d(f, n) {
  const d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  let k = 0;
  z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q += 1) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k -= 1; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k += 1; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1] < q) k += 1;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
  return d;
}

function euclidean(dist, W, H) {
  for (let i = 0; i < dist.length; i += 1) if (dist[i] !== 0) dist[i] = BIG;
  const column = new Float64Array(H);
  for (let x = 0; x < W; x += 1) {
    for (let y = 0; y < H; y += 1) column[y] = dist[y * W + x];
    const out = edt1d(column, H);
    for (let y = 0; y < H; y += 1) dist[y * W + x] = out[y];
  }
  for (let y = 0; y < H; y += 1) {
    const out = edt1d(dist.subarray(y * W, y * W + W), W);
    for (let x = 0; x < W; x += 1) dist[y * W + x] = out[x] >= BIG / 2 ? Infinity : Math.sqrt(out[x]);
  }
}

/**
 * Exact distance transform. inside=true: each opaque pixel's distance to the nearest transparent
 * pixel; inside=false: each transparent pixel's distance to the nearest opaque one. Non-target
 * pixels are 0; Infinity when no source exists. `edge` says what lies beyond the canvas.
 */
export function distanceField(pixels, width, height, { metric = 'chebyshev', inside = true, edge = 'transparent' } = {}) {
  const count = readPixels(pixels, width, height);
  oneOf(metric, METRICS, 'Distance metric');
  oneOf(edge, EDGES, 'Edge mode');
  const pad = edge === 'transparent' ? 1 : 0;
  const tiles = edge === 'wrap' ? 3 : 1;
  const W = width * tiles + pad * 2, H = height * tiles + pad * 2;
  const dist = new Float64Array(W * H);
  for (let Y = 0; Y < H; Y += 1) {
    for (let X = 0; X < W; X += 1) {
      const x = X - pad, y = Y - pad;
      const opaque = x >= 0 && y >= 0 && x < width * tiles && y < height * tiles && pixels[(y % height) * width + (x % width)] !== -1;
      dist[Y * W + X] = opaque !== inside ? 0 : Infinity;
    }
  }
  if (metric === 'euclidean') euclidean(dist, W, H); else chamfer(dist, W, H, metric === 'chebyshev');
  const off = edge === 'wrap' ? { x: width, y: height } : { x: pad, y: pad };
  const result = new Float64Array(count);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) result[y * width + x] = dist[(y + off.y) * W + x + off.x];
  return result;
}

// ---------------------------------------------------------------------------------------------
// Outlines, glow, rim light, shading

/**
 * Outline as a composite. outside: transparent pixels within `thickness` of the art get `color`;
 * inside: opaque pixels within `thickness` of transparency (canvas edge counts) are recoloured.
 * corners=true uses Chebyshev (square) growth, false uses Manhattan (rounded corners).
 */
export function outline(pixels, width, height, { color, thickness = 1, corners = true, mode = 'outside', mask } = {}) {
  colorIndex(color, 'Outline color', false);
  positiveInt(thickness, 'Outline thickness', 64);
  oneOf(mode, ['outside', 'inside'], 'Outline mode');
  const inside = mode === 'inside';
  const dist = distanceField(pixels, width, height, { metric: corners ? 'chebyshev' : 'manhattan', inside });
  const m = readMask(mask, pixels.length);
  const result = pixels.map((v, i) => (dist[i] >= 1 && dist[i] <= thickness ? color : v));
  return limit(pixels, result, m);
}

function rampStep(ramps, fill, delta) {
  const ramp = ramps instanceof Map ? ramps.get(fill) : ramps?.[fill];
  if (!Array.isArray(ramp)) return undefined;
  const at = ramp.indexOf(fill);
  if (at < 0) return undefined;
  return colorIndex(ramp[Math.max(0, Math.min(ramp.length - 1, at + delta))], 'A ramp colour');
}

/**
 * Selective outline: each outline pixel takes a darker variant of its adjacent fill colour
 * (`darkenMap` index→darker, or `ramps` index→[darkest..lightest]). With `light` (a direction
 * toward the light, e.g. {x:-1,y:-1} = top-left) the lit side is omitted (lit:'omit'), lightened
 * (lit:'lighter' via `lightenMap`/ramps) or kept as the fill colour (lit:'fill').
 * mode:'outside' adds pixels around the art; 'inside' recolours the art's own edge pixels.
 */
export function selOut(pixels, width, height, { darkenMap, lightenMap, ramps, light, lit = 'omit', mode = 'outside', corners = false, mask } = {}) {
  const count = readPixels(pixels, width, height);
  if (darkenMap == null && ramps == null) throw new Error('Selective outline needs a darkenMap or ramps.');
  oneOf(lit, ['omit', 'lighter', 'fill'], 'Lit side');
  oneOf(mode, ['outside', 'inside'], 'Outline mode');
  const L = light == null ? null : readPoint(light, 'Light direction');
  const m = readMask(mask, count);
  const darker = (fill) => lookup(darkenMap, fill) ?? rampStep(ramps, fill, -1) ?? fill;
  const lighter = (fill) => lookup(lightenMap, fill) ?? rampStep(ramps, fill, 1) ?? fill;
  const dirs = corners ? [...ORTHO, ...DIAG] : ORTHO;
  const opaqueAt = (x, y) => x >= 0 && y >= 0 && x < width && y < height && pixels[y * width + x] !== -1;
  const result = pixels.slice();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x, own = pixels[i];
      if ((mode === 'outside') === (own !== -1)) continue;
      // Outward vector `d` points from the fill pixel to the transparent side.
      let fill, d;
      for (const [dx, dy] of dirs) {
        const n = opaqueAt(x + dx, y + dy);
        if (mode === 'outside' && n) { fill = pixels[(y + dy) * width + x + dx]; d = [-dx, -dy]; break; }
        if (mode === 'inside' && !n) { fill = own; d = [dx, dy]; break; }
      }
      if (fill === undefined) continue;
      const isLit = L && d[0] * L.x + d[1] * L.y > 0;
      if (!isLit) result[i] = darker(fill);
      else if (lit === 'lighter') result[i] = lighter(fill);
      else if (lit === 'fill') result[i] = fill;
    }
  }
  return limit(pixels, result, m);
}

/** Recolour opaque pixels within `size` of the edge; `color` may be an array ordered edge→inward. */
export function innerGlow(pixels, width, height, { color, size = 1, metric = 'chebyshev', edge = 'transparent', mask } = {}) {
  const colors = Array.isArray(color) ? color : [color];
  if (!colors.length) throw new Error('Inner glow needs at least one colour.');
  colors.forEach((c) => colorIndex(c, 'Glow color', false));
  positiveInt(size, 'Glow size', 64);
  const dist = distanceField(pixels, width, height, { metric, inside: true, edge });
  const m = readMask(mask, pixels.length);
  const result = pixels.map((v, i) => (v !== -1 && dist[i] <= size ? colors[Math.min(colors.length - 1, Math.ceil(dist[i]) - 1)] : v));
  return limit(pixels, result, m);
}

/** Opaque pixels with transparency (or the canvas edge) within `size` steps toward `light` get `color`. */
export function rimLight(pixels, width, height, { color, light, size = 1, mask } = {}) {
  const count = readPixels(pixels, width, height);
  colorIndex(color, 'Rim light color', false);
  const L = readPoint(light, 'Light direction');
  positiveInt(size, 'Rim size', 64);
  const sx = Math.sign(L.x), sy = Math.sign(L.y);
  if (!sx && !sy) throw new Error('Light direction must not be zero.');
  const m = readMask(mask, count);
  const result = pixels.slice();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[y * width + x] === -1) continue;
      for (let k = 1; k <= size; k += 1) {
        const nx = x + sx * k, ny = y + sy * k;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || pixels[ny * width + nx] === -1) { result[y * width + x] = color; break; }
      }
    }
  }
  return limit(pixels, result, m);
}

/**
 * Bevel + directional shading. For pixels whose colour has a ramp ([darkest..lightest]) the ramp
 * step combines distance-to-edge (edges darker, interior lighter, saturating at `depth`) and the
 * edge normal (from the distance-field gradient) against the `light` direction.
 */
export function autoShade(pixels, width, height, { ramps, light, depth = 3, mask } = {}) {
  const count = readPixels(pixels, width, height);
  if (!(ramps instanceof Map)) throw new Error('autoShade needs ramps as a Map of colour index → ramp array.');
  positiveInt(depth, 'Shade depth', 64);
  const L = light == null ? null : readPoint(light, 'Light direction');
  const len = L ? Math.hypot(L.x, L.y) : 0;
  const m = readMask(mask, count);
  const dist = distanceField(pixels, width, height, { metric: 'chebyshev', inside: true });
  const D = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : dist[y * width + x]);
  const result = pixels.slice();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x, ramp = ramps.get(pixels[i]);
      if (pixels[i] === -1 || !Array.isArray(ramp) || !ramp.length) continue;
      const e = (Math.min(dist[i], depth) - 1) / depth;
      let lambert = 0;
      if (len) {
        const gx = D(x + 1, y) - D(x - 1, y), gy = D(x, y + 1) - D(x, y - 1), g = Math.hypot(gx, gy);
        if (g) lambert = (-gx * L.x - gy * L.y) / (g * len);
      }
      const shade = Math.max(0, Math.min(1, 0.35 + 0.65 * e + 0.5 * lambert * (1 - e)));
      result[i] = colorIndex(ramp[Math.round(shade * (ramp.length - 1))], 'A ramp colour');
    }
  }
  return limit(pixels, result, m);
}

// ---------------------------------------------------------------------------------------------
// Ordered dithering and gradients

function bayer(n) {
  if (n === 1) return [[0]];
  const h = bayer(n / 2);
  return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => 4 * h[y % (n / 2)][x % (n / 2)] + [[0, 2], [3, 1]][Math.floor(y / (n / 2))][Math.floor(x / (n / 2))]));
}

/** Bayer threshold matrices (values 0..n²-1). */
export const BAYER = Object.freeze({ 2: bayer(2), 4: bayer(4), 8: bayer(8) });

function matrixSize(matrix) {
  if (!BAYER[matrix]) throw new Error('Dither matrix must be 2, 4, or 8.');
  return matrix;
}

/** Bayer threshold in (0,1) for pixel (x, y). */
function threshold(x, y, n) {
  const mod = (v) => ((v % n) + n) % n;
  return (BAYER[n][mod(y)][mod(x)] + 0.5) / (n * n);
}

/** Ordered-dither one pixel: colorB when `ratio` exceeds the Bayer threshold at (x, y), else colorA. */
export function ditherMix(colorA, colorB, ratio, x, y, matrix = 4) {
  colorIndex(colorA, 'Dither colour A'); colorIndex(colorB, 'Dither colour B');
  if (!Number.isFinite(ratio)) throw new Error('Dither ratio must be a finite number.');
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('Dither position must be whole pixel coordinates.');
  return ratio > threshold(x, y, matrixSize(matrix)) ? colorB : colorA;
}

const SHAPES = ['linear', 'radial', 'diamond', 'angle'];

/** Raw gradient parameter at (x, y): 0 at `from`, 1 at `to` (may exceed [0,1] before repeat). */
function gradientT(x, y, from, to, shape) {
  const ax = to.x - from.x, ay = to.y - from.y, len2 = ax * ax + ay * ay;
  const px = x - from.x, py = y - from.y;
  if (shape === 'angle') {
    const turn = (Math.atan2(py, px) - Math.atan2(ay, ax)) / (2 * Math.PI);
    return turn - Math.floor(turn);
  }
  if (!len2) return 0;
  if (shape === 'linear') return (px * ax + py * ay) / len2;
  if (shape === 'radial') return Math.hypot(px, py) / Math.sqrt(len2);
  const u = (px * ax + py * ay) / len2, v = (px * -ay + py * ax) / len2;
  return Math.abs(u) + Math.abs(v);
}

function repeatT(t, repeat) {
  if (repeat === 'repeat') return t - Math.floor(t);
  if (repeat === 'mirror') { const r = t - 2 * Math.floor(t / 2); return r > 1 ? 2 - r : r; }
  return Math.max(0, Math.min(1, t));
}

/** Colour for parameter t∈[0,1]: equal-width bands or Bayer-dithered transitions between stops. */
function gradientColor(t, colors, style, x, y, matrix) {
  const n = colors.length;
  if (n === 1) return colors[0];
  if (style === 'bands') return colors[Math.min(n - 1, Math.floor(t * n))];
  const pos = t * (n - 1), i = Math.min(n - 2, Math.floor(pos));
  return ditherMix(colors[i], colors[i + 1], pos - i, x, y, matrix);
}

function readColors(colors) {
  if (!Array.isArray(colors) || colors.length < 1) throw new Error('A gradient needs at least one colour stop.');
  colors.forEach((c) => colorIndex(c, 'Gradient colour'));
  return colors;
}

/**
 * Bayer-dithered gradient image (transparent outside `mask`). Linear projects onto from→to;
 * radial/diamond/angle measure from `from`. Ends are pure colours.
 */
export function ditherGradient(width, height, { from, to, colors, matrix = 4, shape = 'linear', mask, repeat = 'clamp' } = {}) {
  const count = pixelCount(width, height);
  return gradientFill(Array(count).fill(-1), width, height, { region: mask ? 'mask' : 'all', mask, from, to, colors, matrix, shape, repeat, style: 'dither' });
}

/** 4-connected same-colour region from `seed` (paint-bucket); contiguous=false selects every pixel of that colour. */
export function floodRegion(pixels, width, height, seed, { contiguous = true } = {}) {
  const count = readPixels(pixels, width, height);
  const { x, y } = readPoint(seed, 'Flood seed');
  const mask = new Uint8Array(count);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) return mask;
  const target = pixels[y * width + x];
  if (!contiguous) { for (let i = 0; i < count; i += 1) if (pixels[i] === target) mask[i] = 1; return mask; }
  // toolbox connectedRegion rejects transparent seeds, so a bucket-style flood is done here.
  const stack = [y * width + x];
  mask[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop(), px = i % width, py = (i - px) / width;
    for (const [dx, dy] of ORTHO) {
      const nx = px + dx, ny = py + dy, n = ny * width + nx;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || mask[n] || pixels[n] !== target) continue;
      mask[n] = 1; stack.push(n);
    }
  }
  return mask;
}

/**
 * Gradient fill using only the given palette `colors` (-1 allowed to fade out). region: 'flood'
 * (from `seed`, 4-connected same colour), 'mask', or 'all'; an extra `mask` also limits flood/all.
 * style 'bands' = equal-width hard steps; 'dither' = Bayer transitions between adjacent stops.
 */
export function gradientFill(pixels, width, height, { region = 'all', seed, mask, from, to, shape = 'linear', colors, style = 'bands', matrix = 4, repeat = 'clamp' } = {}) {
  const count = readPixels(pixels, width, height);
  oneOf(region, ['flood', 'mask', 'all'], 'Gradient region');
  oneOf(shape, SHAPES, 'Gradient shape');
  oneOf(style, ['bands', 'dither'], 'Gradient style');
  oneOf(repeat, ['clamp', 'repeat', 'mirror'], 'Gradient repeat');
  matrixSize(matrix);
  readColors(colors);
  const a = readPoint(from, 'Gradient start'), b = readPoint(to, 'Gradient end');
  const m = readMask(mask, count);
  if (region === 'mask' && !m) throw new Error('Gradient region "mask" needs a mask.');
  const flood = region === 'flood' ? floodRegion(pixels, width, height, seed) : null;
  const result = pixels.slice();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if ((flood && !flood[i]) || (m && !m[i])) continue;
      result[i] = gradientColor(repeatT(gradientT(x, y, a, b, shape), repeat), colors, style, x, y, matrix);
    }
  }
  return result;
}

/** Gradient stops from `fromIndex` to `toIndex` along an ordered ramp (inclusive, either direction). */
export function gradientStopsBetween(rampIndices, fromIndex, toIndex) {
  readColors(rampIndices);
  const i = rampIndices.indexOf(fromIndex), j = rampIndices.indexOf(toIndex);
  if (i < 0 || j < 0) throw new Error('Both gradient colours must be in the ramp.');
  return i <= j ? rampIndices.slice(i, j + 1) : rampIndices.slice(j, i + 1).reverse();
}

// ---------------------------------------------------------------------------------------------
// Pixel-perfect cleanup and clean slopes

/** Remove L-shaped corner pixels (and consecutive duplicates) from a 1px freehand stroke. */
export function pixelPerfect(points) {
  if (!Array.isArray(points)) throw new Error('Stroke points must be an array.');
  const path = [];
  for (const p of points) {
    if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y)) throw new Error('Each stroke point needs whole x and y.');
    pixelPerfectStep(path, p);
  }
  return path;
}

/**
 * Remove redundant L-corner pixels from 1px lines in an image: a pixel is removed only when it has
 * exactly two orthogonal line neighbours forming an L, the inner diagonal is empty, both arms do
 * not continue straight (keeps deliberate right angles), and its line neighbours stay 8-connected.
 */
export function cleanupDoubles(pixels, width, height, color) {
  readPixels(pixels, width, height);
  if (color !== undefined) colorIndex(color, 'Cleanup colour', false);
  const result = pixels.slice();
  const on = (x, y) => x >= 0 && y >= 0 && x < width && y < height && (color === undefined ? result[y * width + x] !== -1 : result[y * width + x] === color);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!on(x, y)) continue;
      const arms = ORTHO.filter(([dx, dy]) => on(x + dx, y + dy));
      if (arms.length !== 2) continue;
      const [[ax, ay], [bx, by]] = arms;
      if (ax + bx === 0 && ay + by === 0) continue;
      if (on(x + ax + bx, y + ay + by)) continue;
      if (on(x + 2 * ax, y + 2 * ay) && on(x + 2 * bx, y + 2 * by)) continue;
      const ring = [...ORTHO, ...DIAG].filter(([dx, dy]) => on(x + dx, y + dy));
      const seen = new Set([0]), queue = [0];
      while (queue.length) {
        const [px, py] = ring[queue.pop()];
        ring.forEach(([qx, qy], k) => { if (!seen.has(k) && Math.abs(px - qx) <= 1 && Math.abs(py - qy) <= 1) { seen.add(k); queue.push(k); } });
      }
      if (seen.size === ring.length) result[y * width + x] = -1;
    }
  }
  return result;
}

const SLOPES = [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2], [3, 1], [1, 3], [4, 1], [1, 4]];

/** Snap a direction to the nearest clean pixel slope (by angle); returns signed {x, y} step ratio. */
export function snapSlope(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('Slope components must be finite numbers.');
  if (!dx && !dy) return { x: 0, y: 0 };
  const angle = Math.atan2(Math.abs(dy), Math.abs(dx));
  let best = SLOPES[0];
  for (const s of SLOPES) if (Math.abs(Math.atan2(s[1], s[0]) - angle) < Math.abs(Math.atan2(best[1], best[0]) - angle) - 1e-12) best = s;
  return { x: best[0] * (dx < 0 ? -1 : 1), y: best[1] * (dy < 0 ? -1 : 1) };
}

/** Clean line with uniform runs (e.g. 2:1 → every run exactly 2 px), ending at the snapped end. */
export function cleanLinePoints(x0, y0, x1, y1) {
  if (![x0, y0, x1, y1].every(Number.isInteger)) throw new Error('Line endpoints must be whole pixel coordinates.');
  const s = snapSlope(x1 - x0, y1 - y0);
  if (!s.x && !s.y) return [{ x: x0, y: y0 }];
  const ax = Math.abs(s.x), ay = Math.abs(s.y), sx = Math.sign(s.x), sy = Math.sign(s.y);
  const major = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1;
  if (major > 4096) throw new Error('Clean lines are limited to 4096 pixels.');
  if (!ax || !ay) return Array.from({ length: major }, (_, k) => ({ x: x0 + sx * k, y: y0 + sy * k }));
  const run = Math.max(ax, ay), runs = Math.max(1, Math.round(major / run)), points = [];
  for (let r = 0; r < runs; r += 1) {
    for (let j = 0; j < run; j += 1) {
      points.push(ax >= ay ? { x: x0 + sx * (r * run + j), y: y0 + sy * r } : { x: x0 + sx * r, y: y0 + sy * (r * run + j) });
    }
  }
  return points;
}

// ---------------------------------------------------------------------------------------------
// Smear frames

/**
 * Smear frame: union of copies of B swept back along -offset (B moved by `offset` since A), with
 * nearest-in-time priority (B itself on top). color:'source' keeps B's colours on the trail, an
 * index paints the trail solid. Optional `a` (pixels of the previous frame, or null) sits underneath.
 */
export function smear(a, b, width, height, { offset, steps, color = 'source' } = {}) {
  const count = readPixels(b, width, height, 'pixels for frame B');
  if (a != null) readPixels(a, width, height, 'pixels for frame A');
  const o = readPoint(offset, 'Smear offset');
  if (color !== 'source') colorIndex(color, 'Smear colour', false);
  const n = steps ?? Math.max(1, Math.ceil(Math.max(Math.abs(o.x), Math.abs(o.y))));
  positiveInt(n, 'Smear steps', 1024);
  const result = a ? a.slice() : Array(count).fill(-1);
  for (let s = n; s >= 0; s -= 1) {
    const shx = Math.round((-o.x * s) / n), shy = Math.round((-o.y * s) / n);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const v = b[y * width + x], px = x + shx, py = y + shy;
        if (v === -1 || px < 0 || py < 0 || px >= width || py >= height) continue;
        result[py * width + px] = s === 0 || color === 'source' ? v : color;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Seamless tiles

/** Wrap a point into the canvas (modular, negative-safe). */
export function wrapPoint(x, y, width, height) {
  pixelCount(width, height);
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('Wrap coordinates must be whole numbers.');
  return { x: ((x % width) + width) % width, y: ((y % height) + height) % height };
}

/** Wrap every point into the canvas, dropping duplicates while keeping order. */
export function wrapPoints(points, width, height) {
  if (!Array.isArray(points)) throw new Error('Points must be an array.');
  const seen = new Set(), out = [];
  for (const p of points) {
    const w = wrapPoint(p?.x, p?.y, width, height), key = w.y * width + w.x;
    if (!seen.has(key)) { seen.add(key); out.push(w); }
  }
  return out;
}

/** Circularly shift the image by (dx, dy), e.g. by half a tile to inspect seams. */
export function offsetWrap(pixels, width, height, dx, dy) {
  readPixels(pixels, width, height);
  const result = Array(pixels.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = wrapPoint(x + dx, y + dy, width, height);
      result[t.y * width + t.x] = pixels[y * width + x];
    }
  }
  return result;
}

/** Number of colour mismatches across the wrapped left/right and top/bottom edges. */
export function seamScore(pixels, width, height) {
  readPixels(pixels, width, height);
  let score = 0;
  for (let y = 0; y < height; y += 1) if (pixels[y * width] !== pixels[y * width + width - 1]) score += 1;
  for (let x = 0; x < width; x += 1) if (pixels[x] !== pixels[(height - 1) * width + x]) score += 1;
  return score;
}

// ---------------------------------------------------------------------------------------------
// Selection masks

/** Take `effect` where `mask` is set and `base` elsewhere. */
export function applyMask(base, effect, mask) {
  if (!Array.isArray(base) || !Array.isArray(effect) || base.length !== effect.length) throw new Error('Base and effect must be pixel arrays of equal length.');
  readMask(mask, base.length);
  return base.map((v, i) => (mask[i] ? effect[i] : v));
}

/** Mask (Uint8Array of 0/1) covering a rectangle inside the canvas; null covers everything. */
export function selectionMask(rect, width, height) {
  const count = pixelCount(width, height);
  const mask = new Uint8Array(count);
  if (rect == null) return mask.fill(1);
  if (!['x', 'y', 'width', 'height'].every((k) => Number.isInteger(rect[k])) || rect.width < 1 || rect.height < 1 || rect.x < 0 || rect.y < 0 || rect.x + rect.width > width || rect.y + rect.height > height) {
    throw new Error('The selection must be a nonempty rectangle inside the canvas.');
  }
  for (let y = rect.y; y < rect.y + rect.height; y += 1) mask.fill(1, y * width + rect.x, y * width + rect.x + rect.width);
  return mask;
}
