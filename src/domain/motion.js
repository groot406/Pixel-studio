/**
 * Pure, deterministic animation maths: easing, tweening, squash & stretch, paths, springs, IK, pivots and smears.
 * Screen coordinates (y down); angles are degrees, positive clockwise, matching instance `angle`.
 */

import { instancePivot, instanceSize } from './geometry.js';
import { MAX_SIZE } from './limits.js';

const DEG = 180 / Math.PI, RAD = Math.PI / 180, EPS = 1e-9;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** Round half away from zero, so mirrored motion rounds symmetrically; never returns -0. */
export function roundInt(v) { return (Math.sign(v) * Math.round(Math.abs(v))) || 0; }
/** Integer pixel point. */
export function roundPoint(p) { return { x: roundInt(p.x), y: roundInt(p.y) }; }
/** Normalise degrees into the instance range -179..180 (fractions kept). */
export function normalizeAngle(a) { const q = ((a % 360) + 360) % 360; return (q > 180 ? q - 360 : q) || 0; }
/** Signed shortest turn from angle `a` to angle `b`, in -180..180. */
export function angleDelta(a, b) { const d = normalizeAngle(b - a); return d === 180 && b < a ? -180 : d; }

// ---- Easing -------------------------------------------------------------------------------------------------

const BACK = 1.70158, BOUNCE_N = 7.5625, BOUNCE_D = 2.75;
function bounceOut(t) {
  if (t < 1 / BOUNCE_D) return BOUNCE_N * t * t;
  if (t < 2 / BOUNCE_D) return BOUNCE_N * (t -= 1.5 / BOUNCE_D) * t + 0.75;
  if (t < 2.5 / BOUNCE_D) return BOUNCE_N * (t -= 2.25 / BOUNCE_D) * t + 0.9375;
  return BOUNCE_N * (t -= 2.625 / BOUNCE_D) * t + 0.984375;
}

/**
 * CSS-style cubic Bézier easing through (0,0),(x1,y1),(x2,y2),(1,1). x1,x2 are clamped to [0,1] so x(s) is monotonic;
 * x(s)=t is solved by Newton's method, falling back to bisection when the slope is flat or Newton fails to converge.
 */
export function cubicBezier(x1, y1, x2, y2) {
  x1 = clamp(x1, 0, 1); x2 = clamp(x2, 0, 1);
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const xAt = s => ((ax * s + bx) * s + cx) * s, yAt = s => ((ay * s + by) * s + cy) * s;
  const dxAt = s => (3 * ax * s + 2 * bx) * s + cx;
  const solve = t => {
    let s = t;
    for (let i = 0; i < 8; i += 1) {
      const err = xAt(s) - t, d = dxAt(s);
      if (Math.abs(err) < 1e-7) return s;
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0, hi = 1; s = t;
    for (let i = 0; i < 60; i += 1) {
      const x = xAt(s);
      if (Math.abs(x - t) < 1e-7) break;
      if (x < t) lo = s; else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };
  return t => (t <= 0 ? 0 : t >= 1 ? 1 : yAt(solve(t)));
}

/** Named easings t∈[0,1] → progress (0 at 0, 1 at 1; back/elastic overshoot in between). */
export const EASINGS = Object.freeze({
  linear: t => t,
  easeIn: t => t * t,
  easeOut: t => t * (2 - t),
  easeInOut: t => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2),
  cubicIn: t => t ** 3,
  cubicOut: t => 1 - (1 - t) ** 3,
  cubicInOut: t => (t < 0.5 ? 4 * t ** 3 : 1 - 4 * (1 - t) ** 3),
  backIn: t => (BACK + 1) * t ** 3 - BACK * t * t,
  backOut: t => 1 + (BACK + 1) * (t - 1) ** 3 + BACK * (t - 1) ** 2,
  bounceOut,
  elasticOut: t => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1),
});

/** Resolve an easing name or function (default linear). */
export function easingFn(easing) {
  if (typeof easing === 'function') return easing;
  if (easing == null) return EASINGS.linear;
  const fn = EASINGS[easing];
  if (!fn) throw new Error(`Unknown easing: ${easing}`);
  return fn;
}
/** Apply an easing to t clamped into [0,1]. */
export function ease(easing, t) { return easingFn(easing)(clamp(Number.isFinite(t) ? t : 0, 0, 1)); }

// ---- Tweening -----------------------------------------------------------------------------------------------

/**
 * Flat, numeric pose fields; skewX/skewY map to the instance's `skew`, tiltX/tiltY to its 3D turn `tilt`,
 * phase/bulge/twist to its `deform`.
 */
export const POSE_FIELDS = Object.freeze(['x', 'y', 'width', 'height', 'angle', 'skewX', 'skewY', 'tiltX', 'tiltY', 'phase', 'bulge', 'twist']);
const CYCLIC = { angle: normalizeAngle, tiltX: normalizeAngle, tiltY: normalizeAngle, phase: v => ((v % 360) + 360) % 360 };
/** Cyclic fields that tween the way they are written (0 → 360 is a full 3D spin) rather than the shortest way round. */
const UNWRAPPED = new Set(['tiltX', 'tiltY']);

/**
 * Interpolate the numeric pose fields present in `from` or `to` (a field missing on one side holds the other's value).
 * Angles and wave phase take the shortest way round; 3D turns (tiltX/tiltY) go linearly from a to b, so tiltY 0 → 360
 * spins once, and are then wrapped to -179..180. Results are integers, width/height ≥ 1. Other fields are copied from `from`.
 */
export function tweenPose(from, to, t, easing = 'linear') {
  const e = ease(easing, t), out = { ...from };
  for (const key of POSE_FIELDS) {
    const a = from[key] ?? to[key], b = to[key] ?? from[key];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const wrap = CYCLIC[key];
    let v = roundInt(wrap && !UNWRAPPED.has(key) ? a + angleDelta(a, b) * e : lerp(a, b, e));
    if (wrap) v = wrap(v);
    if (key === 'width' || key === 'height') v = Math.max(1, v);
    out[key] = v;
  }
  return out;
}

/**
 * Canonical flat pose of a placed instance (`use` op): position, displayed size in part orientation (defaults from
 * `part`), angle, skewX/skewY, tiltX/tiltY (3D turn), and the wave phase / bulge strength / twist angle of its deform when it has one.
 */
export function poseOf(instance, part) {
  const { width, height } = instanceSize(instance, part), d = instance.deform;
  const pose = { x: instance.x, y: instance.y, width, height, angle: instance.angle || 0, skewX: instance.skew?.x || 0, skewY: instance.skew?.y || 0, tiltX: instance.tilt?.x || 0, tiltY: instance.tilt?.y || 0 };
  if (d?.kind === 'wave') pose.phase = d.phase || 0;
  if (d?.kind === 'bulge') pose.bulge = d.strength;
  if (d?.kind === 'twist') pose.twist = d.angle;
  return pose;
}

/**
 * Copy of `instance` with the flat `pose` written back in the stored form: part-sized width/height, zero angle and zero
 * skew are omitted; a zero 3D turn removes `tilt` (otherwise its perspective is kept); phase/bulge/twist only change a
 * deform of that kind (bulge/twist 0 removes it). Values are clamped or wrapped to the stored ranges (angle and tilt
 * -179..180, skew ±60, bulge ±100, twist ±360).
 */
export function applyPose(instance, pose, part) {
  const op = { ...instance }, int = (v, lo, hi) => clamp(roundInt(v), lo, hi);
  if (Number.isFinite(pose.x)) op.x = roundInt(pose.x);
  if (Number.isFinite(pose.y)) op.y = roundInt(pose.y);
  const size = instanceSize(instance, part), w = Number.isFinite(pose.width) ? int(pose.width, 1, MAX_SIZE) : size.width, h = Number.isFinite(pose.height) ? int(pose.height, 1, MAX_SIZE) : size.height;
  if (w === part.width && h === part.height) { delete op.width; delete op.height; } else Object.assign(op, { width: w, height: h });
  if (Number.isFinite(pose.angle)) { const a = roundInt(normalizeAngle(pose.angle)); if (a) op.angle = a === -180 ? 180 : a; else delete op.angle; }
  if (Number.isFinite(pose.skewX) || Number.isFinite(pose.skewY)) {
    const x = int(pose.skewX ?? op.skew?.x ?? 0, -60, 60), y = int(pose.skewY ?? op.skew?.y ?? 0, -60, 60);
    if (x || y) op.skew = { x, y }; else delete op.skew;
  }
  if (Number.isFinite(pose.tiltX) || Number.isFinite(pose.tiltY)) {
    const turn = v => { const a = roundInt(normalizeAngle(roundInt(v))); return a === -180 ? 180 : a; };
    const x = turn(pose.tiltX ?? op.tilt?.x ?? 0), y = turn(pose.tiltY ?? op.tilt?.y ?? 0);
    if (x || y) op.tilt = { ...op.tilt, x, y }; else delete op.tilt;
  }
  const d = op.deform;
  if (d?.kind === 'wave' && Number.isFinite(pose.phase)) op.deform = { ...d, phase: CYCLIC.phase(roundInt(pose.phase)) };
  if (d?.kind === 'bulge' && Number.isFinite(pose.bulge)) { const v = int(pose.bulge, -100, 100); if (v) op.deform = { ...d, strength: v }; else delete op.deform; }
  if (d?.kind === 'twist' && Number.isFinite(pose.twist)) { const v = int(pose.twist, -360, 360); if (v) op.deform = { ...d, angle: v }; else delete op.deform; }
  return op;
}

/** `count` poses from `from` to `to`; with includeEnds=false only the in-betweens (t = i/(count+1)). */
export function tweenFrames(from, to, count, { easing = 'linear', includeEnds = true } = {}) {
  const n = Math.max(0, Math.floor(count));
  return Array.from({ length: n }, (_, i) => tweenPose(from, to, includeEnds ? (n === 1 ? 0 : i / (n - 1)) : (i + 1) / (n + 1), easing));
}

// ---- Squash & stretch ---------------------------------------------------------------------------------------

/**
 * Area-preserving stretch along the motion direction.
 * speed = |v|, L = √(w·h) (the sprite's characteristic size), s = min(max, strength·speed/L), k = 1 + s.
 * The axis nearer the motion is scaled by k and the other by 1/k, so w'·h' = w·h (exact before rounding);
 * the returned angle (−45..45) tilts that axis onto the motion so the sprite stays mostly upright.
 */
export function squashStretch(velocity, base, { strength = 0.5, max = 0.6 } = {}) {
  const vx = velocity?.x || 0, vy = velocity?.y || 0, speed = Math.hypot(vx, vy), area = base.width * base.height;
  const k = 1 + Math.min(Math.max(0, max), Math.max(0, strength) * speed / Math.sqrt(area));
  if (speed < EPS || k === 1) return { width: base.width, height: base.height, angle: 0 };
  const vertical = Math.abs(vy) > Math.abs(vx);
  const angle = roundInt(normalizeAngle(vertical ? Math.atan2(-vx, Math.abs(vy)) * DEG * Math.sign(vy) : Math.atan2(vy, Math.abs(vx)) * DEG * Math.sign(vx)));
  return { ...areaFit(base, vertical ? 'height' : 'width', k), angle };
}

/** Scale `axis` by k and fit the other axis so the integer area stays as close as possible to the original. */
function areaFit(base, axis, k) {
  const area = base.width * base.height, other = axis === 'width' ? 'height' : 'width';
  const main = Math.max(1, roundInt(base[axis] * k));
  return { [axis]: main, [other]: Math.max(1, roundInt(area / main)) };
}

/**
 * Landing squash: wider by (1+amount), shorter to keep the area. dx/dy re-anchor the box so it stays centred
 * horizontally with the bottom edge on the ground (add them to x,y).
 */
export function impactSquash(base, amount = 0.3) {
  const { width, height } = areaFit(base, 'width', 1 + clamp(amount, 0, 4));
  return { width, height, dx: -roundInt((width - base.width) / 2), dy: base.height - height };
}

// ---- Paths & arcs -------------------------------------------------------------------------------------------

/** Cubic Bézier point at t. */
export function bezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** Linear path a→b. */
export function linePath(a, b) { return t => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }); }

/** Circular arc t→point from a (t=0) through b to c (t=1); a straight line a→c when the points are collinear. */
export function arcThrough(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  const scale = Math.max(1, Math.hypot(c.x - a.x, c.y - a.y) ** 2);
  if (Math.abs(d) < 1e-9 * scale) return linePath(a, c);
  const sq = p => p.x * p.x + p.y * p.y;
  const cx = (sq(a) * (b.y - c.y) + sq(b) * (c.y - a.y) + sq(c) * (a.y - b.y)) / d;
  const cy = (sq(a) * (c.x - b.x) + sq(b) * (a.x - c.x) + sq(c) * (b.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy), TAU = 2 * Math.PI, wrap = v => ((v % TAU) + TAU) % TAU;
  const ta = Math.atan2(a.y - cy, a.x - cx), tb = wrap(Math.atan2(b.y - cy, b.x - cx) - ta), tc = wrap(Math.atan2(c.y - cy, c.x - cx) - ta);
  const sweep = tb < tc ? tc : tc - TAU;
  return t => (t >= 1 ? { x: c.x, y: c.y } : t <= 0 ? { x: a.x, y: a.y } : { x: cx + r * Math.cos(ta + sweep * t), y: cy + r * Math.sin(ta + sweep * t) });
}

/** `count` points of path fn at evenly spaced eased times (both ends included). */
export function samplePath(fn, count, easing = 'linear') {
  const n = Math.max(0, Math.floor(count));
  return Array.from({ length: n }, (_, i) => fn(ease(easing, n === 1 ? 0 : i / (n - 1))));
}

/** Arc-length reparameterisation: u→point where u is the fraction of distance travelled (constant speed); `.totalLength` is the path length. */
export function pathLengthParam(fn, samples = 128) {
  const n = Math.max(2, Math.floor(samples)), ts = [], lens = [0];
  let prev = fn(0);
  for (let i = 0; i <= n; i += 1) {
    const t = i / n; ts.push(t);
    if (i) { const p = fn(t); lens.push(lens[i - 1] + Math.hypot(p.x - prev.x, p.y - prev.y)); prev = p; }
  }
  const total = lens[n];
  const reparam = u => {
    if (total < EPS) return fn(clamp(u, 0, 1));
    const target = clamp(u, 0, 1) * total;
    let lo = 0, hi = n;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (lens[mid] < target) lo = mid; else hi = mid; }
    const span = lens[hi] - lens[lo];
    return fn(lerp(ts[lo], ts[hi], span > EPS ? (target - lens[lo]) / span : 0));
  };
  reparam.totalLength = total;
  return reparam;
}

// ---- Springs & overlap --------------------------------------------------------------------------------------

/** Unwrap an angle series so consecutive values differ by the shortest turn. */
function unwrap(series) {
  const out = [];
  for (const v of series) out.push(out.length ? out[out.length - 1] + angleDelta(out[out.length - 1], v) : v);
  return out;
}

function springRun(targets, x, v, stiffness, damping) {
  const out = [];
  for (const target of targets) {
    v = v * (1 - damping) + (target - x) * stiffness; // semi-implicit Euler, one step per frame
    x += v;
    out.push(x);
  }
  return { out, x, v };
}

/**
 * Lagging follow-through: each frame v ← v·(1−damping) + (target−x)·stiffness, then x ← x+v.
 * `initial` defaults to the first target (start at rest); `angles: true` follows the shortest turns and returns -179..180.
 */
export function springFollow(targetSeries, { stiffness = 0.25, damping = 0.7, initial, velocity = 0, angles = false } = {}) {
  if (!targetSeries.length) return [];
  const targets = angles ? unwrap(targetSeries) : targetSeries;
  let start = initial ?? targets[0];
  if (angles && initial != null) start = targets[0] + angleDelta(targets[0], initial);
  const { out } = springRun(targets, start, velocity, stiffness, damping);
  return angles ? out.map(normalizeAngle) : out;
}

/**
 * Spring for a looping animation: runs the loop repeatedly, carrying spring state across the seam, until the state
 * at the loop boundary settles (or maxLoops), and returns the final pass — so the last frame flows into the first.
 */
export function loopSpring(series, { stiffness = 0.25, damping = 0.7, angles = false, maxLoops = 12, tolerance = 1e-4 } = {}) {
  if (!series.length) return [];
  const targets = angles ? unwrap(series) : series, last = targets[targets.length - 1];
  // A looping spin winds whole turns per pass; subtract them at the seam so the state stays comparable.
  const turns = angles ? last + angleDelta(last, targets[0]) - targets[0] : 0;
  let x = targets[0], v = 0, pass = null;
  for (let loop = 0; loop < Math.max(1, maxLoops); loop += 1) {
    pass = springRun(targets, x, v, stiffness, damping);
    const nx = pass.x - turns, settled = Math.abs(nx - x) < tolerance && Math.abs(pass.v - v) < tolerance;
    x = nx; v = pass.v;
    if (settled) break;
  }
  return angles ? pass.out.map(normalizeAngle) : pass.out;
}

/** Delay a series by `frames` (overlapping action); loops wrap around, otherwise the first value is held. */
export function overlapDelay(series, frames, { loop = true } = {}) {
  const n = series.length, f = Math.round(frames) || 0;
  return series.map((_, i) => (loop ? series[(((i - f) % n) + n) % n] : series[clamp(i - f, 0, n - 1)]));
}

// ---- Inverse kinematics -------------------------------------------------------------------------------------

/**
 * Two-bone IK by the law of cosines. angle1 is bone 1's absolute angle, angle2 bone 2's angle relative to bone 1
 * (degrees, clockwise). bendSign (±1) picks which side the joint bends to. Targets out of reach (too far or too close)
 * are clamped to the nearest reachable point along the root→target direction; `reached` reports whether no clamp was needed.
 */
export function solveTwoBone(root, target, len1, len2, bendSign = 1) {
  const dx = target.x - root.x, dy = target.y - root.y, dist = Math.hypot(dx, dy);
  const minD = Math.abs(len1 - len2), maxD = len1 + len2, tol = 1e-9 * Math.max(1, maxD);
  const reached = dist <= maxD + tol && dist >= minD - tol;
  const d = clamp(dist, minD, maxD), base = Math.atan2(dy, dx);
  const cosA = d < EPS ? 1 : clamp((len1 * len1 + d * d - len2 * len2) / (2 * len1 * d), -1, 1);
  const a1 = base - Math.sign(bendSign || 1) * Math.acos(len1 < EPS ? 1 : cosA);
  const joint = { x: root.x + len1 * Math.cos(a1), y: root.y + len1 * Math.sin(a1) };
  const goal = { x: root.x + d * Math.cos(base), y: root.y + d * Math.sin(base) };
  const a2 = len2 < EPS ? a1 : Math.atan2(goal.y - joint.y, goal.x - joint.x);
  const end = { x: joint.x + len2 * Math.cos(a2), y: joint.y + len2 * Math.sin(a2) };
  return { angle1: normalizeAngle(a1 * DEG), angle2: normalizeAngle((a2 - a1) * DEG), joint, end, reached };
}

/**
 * N-joint IK by cyclic coordinate descent. `points` are the joints J0…Jn−1 followed by the effector; J0 is pinned.
 * Each sweep turns joint i (last to first) so the effector points at `target`, rotating everything after it.
 * `limits[i]` ({min,max} or null) bounds joint i's total turn in degrees. Returns { deltas (degrees per joint,
 * clockwise), points, reached }; unreachable targets end with the chain stretched toward them.
 */
export function solveChain(points, target, { limits = [], iterations = 32, tolerance = 0.25 } = {}) {
  const pts = points.map(p => ({ x: p.x, y: p.y })), n = pts.length - 1, deltas = Array(Math.max(0, n)).fill(0);
  const gap = () => Math.hypot(pts[n].x - target.x, pts[n].y - target.y);
  for (let sweep = 0; sweep < iterations && n > 0 && gap() > tolerance; sweep++) {
    for (let i = n - 1; i >= 0; i--) {
      const c = pts[i], e = pts[n];
      if (Math.hypot(e.x - c.x, e.y - c.y) < EPS || Math.hypot(target.x - c.x, target.y - c.y) < EPS) continue;
      let turn = normalizeAngle((Math.atan2(target.y - c.y, target.x - c.x) - Math.atan2(e.y - c.y, e.x - c.x)) * DEG);
      const limit = limits[i];
      if (limit) turn = clamp(deltas[i] + turn, limit.min, limit.max) - deltas[i];
      if (!turn) continue;
      deltas[i] += turn;
      for (let k = i + 1; k <= n; k++) pts[k] = rotatePoint(pts[k], c, turn);
    }
  }
  return { deltas, points: pts, reached: gap() <= Math.max(tolerance, 1) };
}

// ---- Pivots -------------------------------------------------------------------------------------------------

/** Rotate point p clockwise by angleDeg about centre c. */
export function rotatePoint(p, c, angleDeg) {
  const r = angleDeg * RAD, cos = Math.cos(r), sin = Math.sin(r), dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/**
 * For a box {x,y,width,height} that is drawn rotated about its centre, the top-left that makes the rotation appear to
 * happen about `pivot` (continuous box-relative coords, default the centre; for an instance pivot pixel p use p + 0.5)
 * instead: the centre orbits the pivot.
 * Returns the exact centre, the rounded top-left {x,y} and the world pivot.
 */
export function rotateAboutPivot(box, pivot, angleDeg) {
  const p = pivot ?? { x: box.width / 2, y: box.height / 2 };
  const world = { x: box.x + p.x, y: box.y + p.y };
  const centre = rotatePoint({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, world, angleDeg);
  return { x: roundInt(centre.x - box.width / 2), y: roundInt(centre.y - box.height / 2), centre, pivot: world };
}

/**
 * Canvas position of an instance's pivot (the centre of its pivot pixel, else the exact box centre); rotation and skew
 * turn about this point, so it is fixed under them. Same as geometry.instancePivot.
 */
export function pivotWorld(instance, part) { return instancePivot(instance, part); }

// ---- Smears -------------------------------------------------------------------------------------------------

/** Displacement between two poses: dx, dy, length and direction angle (degrees, clockwise from +x). */
export function motionVector(a, b) {
  const dx = (b.x ?? 0) - (a.x ?? 0), dy = (b.y ?? 0) - (a.y ?? 0);
  return { dx, dy, length: Math.hypot(dx, dy), angle: Math.hypot(dx, dy) < EPS ? 0 : normalizeAngle(Math.atan2(dy, dx) * DEG) };
}

/** `count` integer positions evenly spaced strictly between pose a and pose b (for smear/ghost copies). */
export function smearSteps(a, b, count) {
  const n = Math.max(0, Math.floor(count));
  return Array.from({ length: n }, (_, i) => roundPoint({ x: lerp(a.x, b.x, (i + 1) / (n + 1)), y: lerp(a.y, b.y, (i + 1) / (n + 1)) }));
}
