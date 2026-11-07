/**
 * Palette-aware pixel-art anti-aliasing on indexed pixels (row-major, -1 transparent). Colours never leave the palette:
 * an AA pixel is the palette colour nearest (OKLab) to the blend of the stroke/shape colour and the colour beneath, and
 * is only placed when that colour lies meaningfully between the two. Where there is nothing beneath (transparent and no
 * `under`/`background` given) no AA pixel is added, so silhouettes on empty layers stay crisp. Pure and deterministic.
 *
 * The classic hand technique: at each stair step of a jaggy (two pixels of one colour touching only diagonally), the
 * notch pixel(s) beside the step get an intermediate colour weighted by how much of the ideal line or edge covers them.
 * The ideal line runs through the midpoints of the two runs that meet at the step, so long shallow runs get AA pixels at
 * their ends and clean 45° lines get none (their notches are covered < 25%).
 */
import { hexToRgb, rgbToOklab } from './colour.js';

/** Minimum and maximum coverage for an AA pixel: below it the pixel stays, above it is part of the shape. */
export const AA_MIN_COVERAGE = 0.2, AA_MAX_COVERAGE = 0.8;
const labCache = new WeakMap();

/** OKLab of every palette colour (cached per palette array). */
export function paletteLabs(palette) {
  let labs = labCache.get(palette);
  if (!labs) { labs = palette.map(hex => rgbToOklab(hexToRgb(hex))); labCache.set(palette, labs); }
  return labs;
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Palette index for `t` of the way from colour `from` to colour `to` (OKLab blend), or -1 when no palette colour is
 * meaningfully between them: the match must differ from both ends, be closer to the blend than either end, and lie
 * near the segment between them (detour ≤ 10%).
 */
export function paletteBlend(palette, from, to, t) {
  if (from < 0 || to < 0 || from === to || !palette?.[from] || !palette?.[to]) return -1;
  const labs = paletteLabs(palette), a = labs[from], b = labs[to], target = a.map((v, i) => v + (b[i] - v) * t);
  let best = -1, bestD = Infinity;
  labs.forEach((lab, i) => { const d = dist(lab, target); if (d < bestD) { bestD = d; best = i; } });
  if (best === from || best === to || labs[best] === undefined) return -1;
  const span = dist(a, b), m = labs[best];
  if (bestD >= dist(a, target) || bestD >= dist(b, target) || dist(a, m) + dist(m, b) > 1.1 * span) return -1;
  return best;
}

/** Length of the run of pixels from (x,y) stepping (dx,dy) while `ok` holds (excluding the start). */
function runLength(ok, x, y, dx, dy) { let n = 0; while (n < 256 && ok(x + dx * (n + 1), y + dy * (n + 1))) n++; return n; }

/**
 * Coverage of AA notch pixels around stair steps of the pixel set `inside(x,y)`. `thin` treats the set as a 1px line
 * (both notches are outside; coverage is the overlap of a 1px band along the ideal line through the two run midpoints);
 * otherwise as a filled edge (one notch is inside; the outside notch's coverage is the area behind the ideal edge
 * through the runs' outer pixel edges). Returns Map index → coverage.
 */
function notchCoverage(inside, points, width, height, thin) {
  const cover = new Map();
  const add = (x, y, c) => { if (x < 0 || y < 0 || x >= width || y >= height || inside(x, y)) return; const i = y * width + x; if (c > (cover.get(i) ?? 0)) cover.set(i, c); };
  for (const p of points) for (const sy of [-1, 1]) {
    const q = { x: p.x + 1, y: p.y + sy };
    if (!inside(q.x, q.y)) continue;
    const n1 = { x: q.x, y: p.y }, n2 = { x: p.x, y: q.y }, in1 = inside(n1.x, n1.y), in2 = inside(n2.x, n2.y);
    if (in1 && in2 || thin !== (!in1 && !in2)) continue;
    let a, b, facing = null;
    if (thin) {
      const mid = (r, dx, dy) => { const h = runLength(inside, r.x, r.y, dx, 0), v = runLength(inside, r.x, r.y, 0, dy); return h >= v ? { x: r.x + dx * h / 2, y: r.y } : { x: r.x, y: r.y + dy * v / 2 }; };
      a = mid(p, -1, -sy); b = mid(q, 1, sy);
      if (a.x === p.x && a.y === p.y && b.x === q.x && b.y === q.y) continue; // clean 45° steps stay crisp
    } else {
      // Outside notch beside p vertically (n2) or horizontally (n1); each step reads as two horizontal or two vertical runs.
      const [hf, vf] = in1 ? [[0, sy], [-1, 0]] : [[0, -sy], [1, 0]];
      const edge = f => (x, y) => inside(x, y) && !inside(x + f[0], y + f[1]);
      const hp = runLength(edge(hf), p.x, p.y, -1, 0), hq = runLength(edge(hf), q.x, q.y, 1, 0);
      const vp = runLength(edge(vf), p.x, p.y, 0, -sy), vq = runLength(edge(vf), q.x, q.y, 0, sy);
      facing = hp + hq >= vp + vq ? hf : vf;
      const horizontal = facing === hf;
      a = horizontal ? { x: p.x - hp / 2, y: p.y } : { x: p.x, y: p.y - sy * vp / 2 };
      b = horizontal ? { x: q.x + hq / 2, y: q.y } : { x: q.x, y: q.y + sy * vq / 2 };
      for (const r of [a, b]) { r.x += facing[0] / 2; r.y += facing[1] / 2; }
    }
    let dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!len) continue;
    dx /= len; dy /= len;
    let nx = -dy, ny = dx;
    const m = Math.max(Math.abs(nx), Math.abs(ny));
    if (thin) {
      for (const n of [n1, n2]) {
        const d = Math.abs((n.x - a.x) * nx + (n.y - a.y) * ny) / m, h = 0.5 / m;
        add(n.x, n.y, Math.max(0, Math.min(0.5, d + h) - Math.max(-0.5, d - h)));
      }
    } else {
      if (nx * facing[0] + ny * facing[1] < 0) { nx = -nx; ny = -ny; }
      const out = in1 ? n2 : n1, s = (out.x - a.x) * nx + (out.y - a.y) * ny;
      add(out.x, out.y, Math.max(0, Math.min(1, 0.5 - s / m)));
    }
  }
  return cover;
}

function readOptions(pixels, width, height, palette) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('Width and height must be positive whole numbers.');
  if (!Array.isArray(pixels) || pixels.length !== width * height) throw new Error(`Expected exactly ${width * height} indexed pixels.`);
  if (!Array.isArray(palette) || !palette.length) throw new Error('Anti-aliasing needs the palette.');
}

/** Colour beneath pixel i: the pixel itself, else `under[i]`, else `background`; -1 when nothing is there. */
const beneath = (pixels, i, color, under, background) => {
  const v = pixels[i];
  if (v >= 0 && v !== color) return v;
  if (v < 0 && under && under[i] >= 0) return under[i];
  return v < 0 && background >= 0 ? background : -1;
};

/**
 * Anti-alias a 1px stroke: `strokePoints` ({x,y}, any order) drawn in palette index `color`. Returns a copy of `pixels`
 * (the cel, with or without the stroke) where notch pixels at stair steps get an intermediate palette colour between
 * `color` and the colour beneath. Options: strength (0–1, default 1, scales the coverage), under (pixels to blend with
 * where the cel is transparent, e.g. the composite of the layers below), background (index used where both are empty).
 * Stroke pixels themselves never change.
 */
export function antialiasStroke(pixels, width, height, strokePoints, color, palette, { strength = 1, under = null, background = -1 } = {}) {
  readOptions(pixels, width, height, palette);
  const out = [...pixels], set = new Set();
  for (const p of strokePoints || []) if (p.x >= 0 && p.y >= 0 && p.x < width && p.y < height) set.add(p.y * width + p.x);
  const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height && set.has(y * width + x);
  const points = [...set].map(i => ({ x: i % width, y: Math.floor(i / width) }));
  for (const [i, c] of notchCoverage(inside, points, width, height, true)) {
    if (c < AA_MIN_COVERAGE || c > AA_MAX_COVERAGE) continue;
    const below = beneath(pixels, i, color, under, background), aa = paletteBlend(palette, below, color, Math.min(1, c * strength));
    if (aa >= 0) out[i] = aa;
  }
  return out;
}

/**
 * "Smooth jaggies": anti-alias the stair-stepped edges of every colour region (filled edges and 1px lines) with
 * palette colours between each region's colour and its neighbour. Options as antialiasStroke plus `mask` (0/1 per
 * pixel: only masked pixels change) and `colors` (only these region colours are smoothed). Transparent neighbours are
 * left alone unless `under`/`background` give a colour.
 */
export function smoothJaggies(pixels, width, height, palette, { strength = 1, under = null, background = -1, mask = null, colors = null } = {}) {
  readOptions(pixels, width, height, palette);
  const out = [...pixels], found = [], regions = new Map();
  pixels.forEach((v, i) => { if (v >= 0 && (!colors || colors.includes(v))) (regions.get(v) || regions.set(v, []).get(v)).push({ x: i % width, y: Math.floor(i / width) }); });
  for (const [color, points] of regions) {
    const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height && pixels[y * width + x] === color;
    for (const thin of [true, false]) for (const [i, c] of notchCoverage(inside, points, width, height, thin)) {
      if (c < AA_MIN_COVERAGE || c > AA_MAX_COVERAGE || (mask && !mask[i])) continue;
      const below = beneath(pixels, i, color, under, background), aa = paletteBlend(palette, below, color, Math.min(1, c * strength));
      if (aa >= 0) found.push({ i, c, aa, color, below });
    }
  }
  // Strongest first, then replacing pixels of the larger region (the background); the two regions of one boundary
  // would each smooth their side, so only one side is kept.
  const done = new Map(), size = c => regions.get(c)?.length ?? 0;
  for (const f of found.sort((a, b) => b.c - a.c || size(b.below) - size(a.below) || a.i - b.i)) {
    if (done.has(f.i)) continue;
    const x = f.i % width, y = Math.floor(f.i / width);
    let clash = false;
    for (let dy = -1; dy <= 1 && !clash; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = (y + dy) * width + x + dx, o = x + dx >= 0 && x + dx < width ? done.get(k) : null;
      if (o && o.color === f.below && o.below === f.color) { clash = true; break; }
    }
    if (!clash) { done.set(f.i, f); out[f.i] = f.aa; }
  }
  return out;
}
