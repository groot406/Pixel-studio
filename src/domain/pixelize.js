// Turn "looks like pixel art" images (AI output, upscaled or JPEG-compressed sprites) into real pixel data:
// detect the hidden pixel grid, take one colour per cell, remove the background and trim.
// Pure functions on RGBA arrays so they run in the browser, in workers and in tests.

const MIN_PERIOD = 2;
const MAX_PERIOD = 64;

/** Colour change between neighbouring pixels, premultiplied by alpha so transparent noise is ignored. */
function difference(rgba, a, b) {
  const aa = rgba[a + 3] / 255, ab = rgba[b + 3] / 255;
  return Math.abs(rgba[a] * aa - rgba[b] * ab) + Math.abs(rgba[a + 1] * aa - rgba[b + 1] * ab)
    + Math.abs(rgba[a + 2] * aa - rgba[b + 2] * ab) + Math.abs(rgba[a + 3] - rgba[b + 3]);
}

/** Edge energy per column boundary (x between x-1 and x) and per row boundary. */
export function edgeProfiles(rgba, width, height) {
  const columns = new Float64Array(width), rows = new Float64Array(height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (x > 0) columns[x] += difference(rgba, i, i - 4);
      if (y > 0) rows[y] += difference(rgba, i, i - width * 4);
    }
  }
  return { columns, rows };
}

/** How strongly edges line up on a grid with this period: the normalised Fourier magnitude at 1/period. */
function periodicity(profile, period) {
  let re = 0, im = 0, total = 0;
  const w = (2 * Math.PI) / period;
  for (let x = 1; x < profile.length; x += 1) {
    const e = profile[x];
    if (!e) continue;
    re += e * Math.cos(w * x); im += e * Math.sin(w * x); total += e;
  }
  if (!total) return { score: 0, phase: 0 };
  let phase = (Math.atan2(im, re) / w) % period;
  if (phase < 0) phase += period;
  return { score: Math.hypot(re, im) / total, phase };
}

/**
 * Find the logical pixel size of an image. Returns { scale, offsetX, offsetY, width, height, confidence }.
 * A scale of 1 means the image already is real pixel art (or no grid was found).
 * Divisors of the true period score just as high, so the largest strong period wins.
 */
export function detectGrid(rgba, width, height, options = {}) {
  const { columns, rows } = options.profiles || edgeProfiles(rgba, width, height);
  if (options.scale) return gridAt(columns, rows, width, height, options.scale);
  const maxPeriod = Math.min(options.maxPeriod ?? MAX_PERIOD, Math.floor(Math.min(width, height) / 4));
  const candidates = [];
  for (let period = MIN_PERIOD; period <= maxPeriod; period += period < 8 ? 0.05 : 0.1) {
    const x = periodicity(columns, period), y = periodicity(rows, period);
    candidates.push({ period, score: (x.score + y.score) / 2, x, y });
  }
  const none = { scale: 1, offsetX: 0, offsetY: 0, width, height, confidence: 0 };
  if (!candidates.length) return none;
  const best = Math.max(...candidates.map(c => c.score));
  if (best < 0.3) return { ...none, confidence: best };
  // Prefer the largest period that is nearly as strong: smaller divisors of the grid score equally well.
  let pick = null;
  for (const c of candidates) if (c.score >= best * 0.85 && (!pick || c.period > pick.period + 0.5 || (Math.abs(c.period - pick.period) <= 0.5 && c.score > pick.score))) pick = c;
  for (let period = pick.period - 0.1; period <= pick.period + 0.1; period += 0.01) {
    if (period < MIN_PERIOD) continue;
    const x = periodicity(columns, period), y = periodicity(rows, period), score = (x.score + y.score) / 2;
    if (score > pick.score) pick = { period, score, x, y };
  }
  // Snap to a whole number when the drift across the whole image stays small: most upscales are integer.
  const rounded = Math.round(pick.period);
  let scale = pick.period;
  const drift = Math.abs(rounded - pick.period) * Math.max(width, height) / pick.period;
  if (drift < pick.period * 0.15) {
    const exact = { x: periodicity(columns, rounded), y: periodicity(rows, rounded) };
    if ((exact.x.score + exact.y.score) / 2 >= pick.score * 0.9) { scale = rounded; pick = { ...pick, x: exact.x, y: exact.y }; }
  }
  return { ...gridAt(columns, rows, width, height, scale, pick), confidence: pick.score };
}

/** The grid for a known pixel size: the phase of the edges gives the offset. */
function gridAt(columns, rows, width, height, scale, known) {
  const x = known?.x || periodicity(columns, scale), y = known?.y || periodicity(rows, scale);
  const offsetX = x.phase % scale, offsetY = y.phase % scale;
  // Cells start on the first grid line, or one cell earlier when a partial cell sits at the edge.
  const startX = offsetX > scale * 0.5 ? offsetX - scale : offsetX;
  const startY = offsetY > scale * 0.5 ? offsetY - scale : offsetY;
  return {
    scale, offsetX, offsetY,
    width: Math.max(1, Math.round((width - startX) / scale)),
    height: Math.max(1, Math.round((height - startY) / scale)),
    confidence: (x.score + y.score) / 2,
  };
}

function median(values) {
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

/**
 * One colour per grid cell. Samples the middle of each cell (edges are blurred in AI output),
 * keeps the cell transparent when most of it is, and uses a per-channel median so JPEG noise vanishes.
 */
export function sampleGrid(rgba, width, height, grid) {
  const { scale, offsetX, offsetY } = grid;
  const startX = offsetX > scale * 0.5 ? offsetX - scale : offsetX;
  const startY = offsetY > scale * 0.5 ? offsetY - scale : offsetY;
  const outWidth = grid.width, outHeight = grid.height;
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  const inset = scale >= 3 ? 0.25 : 0;
  const r = [], g = [], b = [];
  for (let cy = 0; cy < outHeight; cy += 1) {
    for (let cx = 0; cx < outWidth; cx += 1) {
      const x0 = Math.max(0, Math.floor(startX + (cx + inset) * scale)), x1 = Math.min(width, Math.ceil(startX + (cx + 1 - inset) * scale));
      const y0 = Math.max(0, Math.floor(startY + (cy + inset) * scale)), y1 = Math.min(height, Math.ceil(startY + (cy + 1 - inset) * scale));
      r.length = g.length = b.length = 0;
      let samples = 0;
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
        const i = (y * width + x) * 4; samples += 1;
        if (rgba[i + 3] < 128) continue;
        r.push(rgba[i]); g.push(rgba[i + 1]); b.push(rgba[i + 2]);
      }
      if (!samples || r.length * 2 < samples) continue;
      const o = (cy * outWidth + cx) * 4;
      out[o] = median(r); out[o + 1] = median(g); out[o + 2] = median(b); out[o + 3] = 255;
    }
  }
  return { rgba: out, width: outWidth, height: outHeight };
}

/** Area-average downscale for photos and paintings that have no pixel grid. */
export function averageDownscale(rgba, width, height, outWidth, outHeight) {
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  const sx = width / outWidth, sy = height / outHeight;
  for (let cy = 0; cy < outHeight; cy += 1) {
    for (let cx = 0; cx < outWidth; cx += 1) {
      const x0 = Math.floor(cx * sx), x1 = Math.max(x0 + 1, Math.floor((cx + 1) * sx));
      const y0 = Math.floor(cy * sy), y1 = Math.max(y0 + 1, Math.floor((cy + 1) * sy));
      let tr = 0, tg = 0, tb = 0, ta = 0, n = 0;
      for (let y = y0; y < Math.min(y1, height); y += 1) for (let x = x0; x < Math.min(x1, width); x += 1) {
        const i = (y * width + x) * 4, a = rgba[i + 3];
        tr += rgba[i] * a; tg += rgba[i + 1] * a; tb += rgba[i + 2] * a; ta += a; n += 1;
      }
      const o = (cy * outWidth + cx) * 4;
      if (!n || ta / n < 128) continue;
      out[o] = tr / ta; out[o + 1] = tg / ta; out[o + 2] = tb / ta; out[o + 3] = 255;
    }
  }
  return { rgba: out, width: outWidth, height: outHeight };
}

const distance = (rgba, i, c) => Math.abs(rgba[i] - c[0]) + Math.abs(rgba[i + 1] - c[1]) + Math.abs(rgba[i + 2] - c[2]);

/** The most common opaque colour along the image border, or null when the border is already transparent. */
export function borderColor(rgba, width, height) {
  const counts = new Map();
  let opaque = 0, total = 0;
  const visit = (x, y) => {
    const i = (y * width + x) * 4; total += 1;
    if (rgba[i + 3] < 128) return;
    opaque += 1;
    const key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    const entry = counts.get(key) || { n: 0, c: [rgba[i], rgba[i + 1], rgba[i + 2]] };
    entry.n += 1; counts.set(key, entry);
  };
  for (let x = 0; x < width; x += 1) { visit(x, 0); if (height > 1) visit(x, height - 1); }
  for (let y = 1; y < height - 1; y += 1) { visit(0, y); if (width > 1) visit(width - 1, y); }
  if (opaque * 2 < total) return null;
  const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return top && top.n * 4 >= total ? top.c : null;
}

/** Flood-fill the background from the borders and make it transparent. Inner holes of the same colour stay. */
export function removeBackground(rgba, width, height, tolerance = 80) {
  const out = new Uint8ClampedArray(rgba);
  const bg = borderColor(out, width, height);
  if (!bg) return { rgba: out, removed: 0 };
  const seen = new Uint8Array(width * height), stack = [];
  const push = (x, y) => { const p = y * width + x; if (!seen[p]) { seen[p] = 1; stack.push(p); } };
  for (let x = 0; x < width; x += 1) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y += 1) { push(0, y); push(width - 1, y); }
  let removed = 0;
  while (stack.length) {
    const p = stack.pop(), i = p * 4;
    if (out[i + 3] >= 128 && distance(out, i, bg) > tolerance) continue;
    if (out[i + 3]) removed += 1;
    out[i + 3] = 0;
    const x = p % width, y = (p - x) / width;
    if (x > 0) push(x - 1, y); if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1); if (y < height - 1) push(x, y + 1);
  }
  return { rgba: out, removed };
}

/**
 * Merge near-identical colours (JPEG and AI noise) into the most common colour of each cluster,
 * so the palette holds the colours the artist meant rather than dozens of shades of them.
 */
export function mergeSimilarColors(rgba, threshold = 28) {
  const counts = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const reps = [], map = new Map();
  for (const [key] of [...counts].sort((a, b) => b[1] - a[1])) {
    const c = [key >> 16, (key >> 8) & 255, key & 255];
    let best = null, bestDistance = threshold + 1;
    for (const r of reps) {
      const d = Math.abs(r[0] - c[0]) + Math.abs(r[1] - c[1]) + Math.abs(r[2] - c[2]);
      if (d < bestDistance) { best = r; bestDistance = d; }
    }
    if (best) map.set(key, best); else { reps.push(c); map.set(key, c); }
  }
  const out = new Uint8ClampedArray(rgba);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] < 128) continue;
    const c = map.get((out[i] << 16) | (out[i + 1] << 8) | out[i + 2]);
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2];
  }
  return { rgba: out, colors: reps.length };
}

/** Crop to the opaque bounding box; null when nothing is opaque. */
export function trimRgba(rgba, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (rgba[(y * width + x) * 4 + 3] < 128) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1, h = maxY - minY + 1, out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) out.set(rgba.subarray(((minY + y) * width + minX) * 4, ((minY + y) * width + minX + w) * 4), y * w * 4);
  return { rgba: out, width: w, height: h, x: minX, y: minY };
}

/**
 * Full clean-up: mode 'detect' (grid), 'average' (downscale to maxSize) or 'none'.
 * Returns { rgba, width, height, grid, removed }.
 */
export function pixelize(rgba, width, height, options = {}) {
  const { mode = 'detect', background = true, trim = true, maxSize = 256, tolerance = 80, merge = 28 } = options;
  let out = { rgba, width, height }, grid = null;
  if (mode === 'detect') {
    grid = options.grid || detectGrid(rgba, width, height);
    if (grid.scale > 1) out = sampleGrid(rgba, width, height, grid);
  }
  if (mode === 'average' || (mode === 'detect' && Math.max(out.width, out.height) > maxSize)) {
    const ratio = Math.min(1, maxSize / Math.max(out.width, out.height));
    if (ratio < 1) out = averageDownscale(out.rgba, out.width, out.height, Math.max(1, Math.round(out.width * ratio)), Math.max(1, Math.round(out.height * ratio)));
  }
  if (merge > 0) out = { ...out, rgba: mergeSimilarColors(out.rgba, merge).rgba };
  let removed = 0;
  if (background) { const r = removeBackground(out.rgba, out.width, out.height, tolerance); out = { ...out, rgba: r.rgba }; removed = r.removed; }
  if (trim) { const t = trimRgba(out.rgba, out.width, out.height); if (t) out = t; }
  return { rgba: out.rgba, width: out.width, height: out.height, grid, removed };
}
