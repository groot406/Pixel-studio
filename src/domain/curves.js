/**
 * Curves for the Curve tool: cubic Bézier curves and smooth (centripetal Catmull-Rom) paths, sampled densely and
 * rasterised into clean 1px pixel-art strokes — 8-connected, without doubled L-corners or repeated pixels, endpoints
 * kept. Points are pixel coordinates (pixel x,y has its centre at x,y); results are integer {x, y} lists, unclipped.
 */
import { linePoints } from './geometry.js';
import { pixelPerfect } from './pixel-fx.js';

const MAX_SAMPLES = 20000;

function point(p, label = 'Point') {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error(`${label} needs finite x and y.`);
  return { x: p.x, y: p.y };
}
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/** Point at t (0..1) of the cubic Bézier p0 → p3 with handles c1, c2. */
export function cubicPoint(p0, c1, c2, p3, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p3.x, y: a * p0.y + b * c1.y + c * c2.y + d * p3.y };
}

/** Dense samples of a cubic Bézier (spacing well under a pixel), first and last exactly p0 and p3. */
export function sampleCubic(p0, c1, c2, p3) {
  [p0, c1, c2, p3] = [point(p0, 'Start'), point(c1, 'Handle'), point(c2, 'Handle'), point(p3, 'End')];
  const steps = Math.min(MAX_SAMPLES, Math.max(1, Math.ceil((dist(p0, c1) + dist(c1, c2) + dist(c2, p3)) * 4)));
  return Array.from({ length: steps + 1 }, (_, i) => (i === 0 ? p0 : i === steps ? p3 : cubicPoint(p0, c1, c2, p3, i / steps)));
}

/** Handles that make the cubic a straight line (thirds of the way). */
export function straightHandles(p0, p3) { return [lerp(p0, p3, 1 / 3), lerp(p0, p3, 2 / 3)]; }

/** One handle for both ends so the curve passes through `through` halfway (a quadratic-like bend). */
export function bendThrough(p0, p3, through) {
  return { x: (8 * through.x - p0.x - p3.x) / 6, y: (8 * through.y - p0.y - p3.y) / 6 };
}

/** Mirror handle `c` across the perpendicular bisector of p0–p3, for a symmetric arc. */
export function mirrorHandle(p0, p3, c) {
  const dx = p3.x - p0.x, dy = p3.y - p0.y, len2 = dx * dx + dy * dy;
  if (!len2) return { ...c };
  const mx = (p0.x + p3.x) / 2, my = (p0.y + p3.y) / 2, along = ((c.x - mx) * dx + (c.y - my) * dy) / len2;
  return { x: c.x - 2 * along * dx, y: c.y - 2 * along * dy };
}

/**
 * Dense samples of a smooth path through `points` (centripetal Catmull-Rom, no cusps or overshoot loops); `closed`
 * joins the last point back to the first. Fewer than 3 points give straight segments.
 */
export function samplePath(points, { closed = false } = {}) {
  const pts = points.map(p => point(p)).filter((p, i, all) => i === 0 || dist(p, all[i - 1]) > 0);
  if (closed && pts.length > 1 && !dist(pts[0], pts.at(-1))) pts.pop();
  if (pts.length < 2) return pts;
  const n = pts.length, segments = closed ? n : n - 1, at = i => closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
  const out = [pts[0]];
  for (let s = 0; s < segments; s++) {
    let p0 = at(s - 1), p1 = at(s), p2 = at(s + 1), p3 = at(s + 2);
    if (!closed && s === 0) p0 = { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
    if (!closed && s === segments - 1) p3 = { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };
    const knot = (a, b) => Math.max(1e-6, Math.sqrt(dist(a, b)));
    const t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    const steps = Math.min(MAX_SAMPLES, Math.max(1, Math.ceil(dist(p1, p2) * 6)));
    for (let k = 1; k <= steps; k++) {
      if (k === steps) { out.push(p2); continue; }
      const t = t1 + (t2 - t1) * (k / steps);
      const a1 = lerp(p0, p1, t / t1), a2 = lerp(p1, p2, (t - t1) / (t2 - t1)), a3 = lerp(p2, p3, (t - t2) / (t3 - t2));
      const b1 = lerp(a1, a2, t / t2), b2 = lerp(a2, a3, (t - t1) / (t3 - t1));
      out.push(lerp(b1, b2, (t - t1) / (t2 - t1)));
    }
  }
  return out;
}

const isCorner = (a, b, c) => Math.abs(a.x - c.x) === 1 && Math.abs(a.y - c.y) === 1 && (b.x === a.x || b.y === a.y) && (b.x === c.x || b.y === c.y);

/**
 * Clean 1px stroke through float samples: rounded to pixels, gaps bridged, doubled L-corners removed (pixel-perfect)
 * and repeated pixels dropped. `closed` also cleans the corner where the loop meets itself. Endpoints are kept.
 */
export function rasterizeSamples(samples, { closed = false } = {}) {
  const raw = [];
  for (const s of samples) {
    const p = { x: Math.round(s.x), y: Math.round(s.y) }, last = raw.at(-1);
    if (last && (Math.abs(p.x - last.x) > 1 || Math.abs(p.y - last.y) > 1)) raw.push(...linePoints(last.x, last.y, p.x, p.y).slice(1, -1));
    raw.push(p);
  }
  let path = pixelPerfect(raw);
  if (closed && path.length > 3) {
    if (path.at(-1).x === path[0].x && path.at(-1).y === path[0].y) path.pop();
    for (let changed = true; changed && path.length > 3;) {
      changed = false;
      if (isCorner(path.at(-2), path.at(-1), path[0])) { path.pop(); changed = true; }
      else if (isCorner(path.at(-1), path[0], path[1])) { path.shift(); changed = true; }
    }
  }
  const seen = new Set();
  path = path.filter(p => { const key = `${p.x},${p.y}`; if (seen.has(key)) return false; seen.add(key); return true; });
  return path;
}

/** Pixels of a cubic curve stroke p0 → p3 with handles c1, c2. */
export function curvePixels(p0, c1, c2, p3) { return rasterizeSamples(sampleCubic(p0, c1, c2, p3)); }

/** Pixels of a smooth path stroke through `points`; `closed` loops back to the start. */
export function pathPixels(points, { closed = false } = {}) { return rasterizeSamples(samplePath(points, { closed }), { closed }); }

/** Pixels inside a closed polygon of float samples (even-odd rule at pixel centres), clipped to width × height. */
export function polygonFill(samples, width, height) {
  const out = [], n = samples.length;
  if (n < 3) return out;
  const ys = samples.map(p => p.y), top = Math.max(0, Math.ceil(Math.min(...ys))), bottom = Math.min(height - 1, Math.floor(Math.max(...ys)));
  for (let y = top; y <= bottom; y++) {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const a = samples[i], b = samples[(i + 1) % n];
      if ((a.y <= y) !== (b.y <= y)) xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(width - 1, Math.floor(xs[k + 1])); x++) out.push({ x, y });
  }
  return out;
}

/** Shortest distance from `p` to a sampled polyline. */
export function distanceToSamples(samples, p) {
  let best = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i], b = samples[i + 1] || a, dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}
