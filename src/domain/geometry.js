/** Deterministic integer-grid geometry shared by tools and retained artwork. */
import { SIZE, MAX_TOTAL_PIXELS, PIVOT_MIN, PIVOT_MAX, pixelCount } from './limits.js';
import { rotspriteImage, ROTSPRITE_SCALE } from './rotsprite.js';
import { paletteBlend } from './antialias.js';

function coordinates(...values) {
  if (!values.every(Number.isFinite)) return null;
  const rounded = values.map(Math.round);
  return rounded.every(Number.isSafeInteger) ? rounded : null;
}

/** Return the full integer line; callers apply their own canvas bounds. */
export function linePoints(x0, y0, x1, y1) {
  const rounded = coordinates(x0, y0, x1, y1);
  if (!rounded) return [];
  [x0, y0, x1, y1] = rounded;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  if (Math.max(dx, -dy) >= MAX_TOTAL_PIXELS) return [];
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  const points = [];
  while (true) {
    points.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const twiceError = 2 * error;
    if (twiceError >= dy) { error += dy; x0 += sx; }
    if (twiceError <= dx) { error += dx; y0 += sy; }
  }
  return points;
}

export function rectanglePoints(x0, y0, x1, y1, filled = false, width = SIZE, height = SIZE) {
  pixelCount(width, height);
  const rounded = coordinates(x0, y0, x1, y1);
  if (!rounded) return [];
  [x0, y0, x1, y1] = rounded;
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const points = [];
  for (let y = Math.max(0, top); y <= Math.min(height - 1, bottom); y += 1) {
    for (let x = Math.max(0, left); x <= Math.min(width - 1, right); x += 1) {
      if (filled || x === left || x === right || y === top || y === bottom) points.push({ x, y });
    }
  }
  return points;
}

/** Symmetric integer-cell ellipse, with a one-pixel boundary and no antialiasing. */
export function ellipsePoints(x0, y0, x1, y1, filled = false, width = SIZE, height = SIZE) {
  pixelCount(width, height);
  const rounded = coordinates(x0, y0, x1, y1);
  if (!rounded) return [];
  [x0, y0, x1, y1] = rounded;
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  if (right - left < 2 || bottom - top < 2) return rectanglePoints(left, top, right, bottom, filled, width, height);
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  // The quarter-cell allowance gives small ellipses useful, connected pixel clusters.
  const rx = (right - left) / 2 + 0.25;
  const ry = (bottom - top) / 2 + 0.25;
  const contains = (x, y) => {
    if (x < left || x > right || y < top || y > bottom) return false;
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    return nx * nx + ny * ny <= 1;
  };
  const points = [];
  for (let y = Math.max(0, top); y <= Math.min(height - 1, bottom); y += 1) {
    for (let x = Math.max(0, left); x <= Math.min(width - 1, right); x += 1) {
      if (!contains(x, y)) continue;
      if (filled || !contains(x - 1, y) || !contains(x + 1, y) || !contains(x, y - 1) || !contains(x, y + 1)) points.push({ x, y });
    }
  }
  return points;
}

/** Displayed size of an instance in part orientation (before its transform). Instances may be resized without changing the part. */
export function instanceSize(instance, part) {
  return {width:instance.width ?? part.width, height:instance.height ?? part.height};
}

/**
 * Nearest-neighbour sample: which of `source` part pixels shows at displayed pixel `i` of `target`.
 * Sampling at pixel centres, floor((2i+1)·source / (2·target)), is exact integer math and symmetric, so squashing
 * 8 rows to 4 keeps rows 1,3,5,7 and stretching 4 columns to 8 doubles every column. With a `seam` (see resizeSeam) the
 * rows/columns are added or dropped there instead. Out-of-range input stays out of range.
 */
export function sampleIndex(i, target, source, seam = null) {
  if (target === source) return i;
  if (seam === null) return Math.floor(((2*i+1)*source)/(2*target));
  const k = target - source, a = seamStart(seam, target, source);
  return i < a ? i : k > 0 && i < a + k ? a : i - k;
}

/**
 * With `stretch: 'pivot'`, a resize stretches or squashes at the pivot instead of evenly: displayed rows/columns before the
 * pivot show the part unchanged, the pivot row/column repeats to grow, and rows/columns from the pivot on are dropped
 * to shrink, so dragging the pivot down keeps the top of the artwork pixel-exact. Returns the seam (in the part's own
 * orientation, displayed size) per axis, null for even scaling, or 'centre' without a set pivot (the middle of the art).
 */
export function resizeSeam(instance, part) {
  if (instance.stretch !== 'pivot') return { x: null, y: null };
  const size = instanceSize(instance, part), even = { x: size.width === part.width, y: size.height === part.height };
  if (!instance.pivot) return { x: even.x ? null : 'centre', y: even.y ? null : 'centre' };
  const local = untransformPoint(instance.transform, size.width, size.height, instance.pivot.x, instance.pivot.y);
  return { x: even.x ? null : local.x, y: even.y ? null : local.y };
}
function seamStart(seam, target, source) {
  return seam === 'centre' ? Math.floor(Math.min(source, target) / 2) : Math.max(0, Math.min(seam, target > source ? source - 1 : target));
}
/** Continuous displayed coordinate `u` (0..target) → part coordinate (0..source), evenly or at the seam. */
export function axisToPart(u, target, source, seam = null) {
  if (target === source) return u;
  if (seam === null) return u * source / target;
  const k = target - source, a = seamStart(seam, target, source);
  return u < a ? u : k > 0 ? (u < a + k ? a + (u - a) / k : u - k) : u - k;
}
/** Inverse of axisToPart: continuous part coordinate → displayed coordinate (a squashed-away band collapses onto the seam). */
export function axisFromPart(s, target, source, seam = null) {
  if (target === source) return s;
  if (seam === null) return s * target / source;
  const k = target - source, a = seamStart(seam, target, source);
  if (s < a) return s;
  if (k > 0) return s < a + 1 ? a + (s - a) * k : s + k;
  return s < a - k ? a : s + k;
}

/**
 * The 8 lossless orientations of a pixel grid (the dihedral group): flips and quarter turns only move pixels, never
 * resample them. Each is a 2×2 integer matrix [a,b,c,d] acting on (x,y) with y pointing down; R90 turns clockwise.
 * R90FX (a transpose) and R270FX complete the group so every turn/flip combination has a name.
 */
export const TRANSFORM_MATRICES = { N: [1,0,0,1], FX: [-1,0,0,1], FY: [1,0,0,-1], R90: [0,-1,1,0], R180: [-1,0,0,-1], R270: [0,1,-1,0], R90FX: [0,1,1,0], R270FX: [0,-1,-1,0] };
export const TRANSFORM_NAMES = Object.keys(TRANSFORM_MATRICES);
function matrix(transform) {
  const m = TRANSFORM_MATRICES[transform];
  if (!m) throw new Error('Unknown instance transform.');
  return m;
}
const named = m => TRANSFORM_NAMES.find(name => TRANSFORM_MATRICES[name].every((v, i) => v === m[i]));
/** Whether a transform swaps the displayed width and height. */
export function swapsAxes(transform) { return matrix(transform)[0] === 0; }
/** The transform that applies `first`, then `then` (for example the current transform, then a 90° turn). */
export function composeTransform(first, then) {
  const [a, b, c, d] = matrix(first), [e, f, g, h] = matrix(then);
  return named([e*a + f*c, e*b + f*d, g*a + h*c, g*b + h*d]);
}
/** Map pixel (x,y) of a w×h grid to its pixel in the transformed grid (h×w when the axes swap). */
export function transformPoint(transform, w, h, x, y) {
  const [a, b, c, d] = matrix(transform);
  return { x: a*x + b*y + (a < 0 ? w - 1 : 0) + (b < 0 ? h - 1 : 0), y: c*x + d*y + (c < 0 ? w - 1 : 0) + (d < 0 ? h - 1 : 0) };
}
/** Inverse of transformPoint: the matrices are orthogonal, so the inverse is the transpose. */
function untransformPoint(transform, w, h, x, y) {
  const [a, b, c, d] = matrix(transform), swap = b !== 0;
  return transformPoint(named([a, c, b, d]), swap ? h : w, swap ? w : h, x, y);
}

/** Free rotation in whole degrees, after size, transform, deform, skew and 3D turn, about the pivot (default: box centre). */
export function instanceAngle(instance) { return instance.angle || 0; }
const EPSILON = 1e-9;
function turned(angle) {
  // Exact values for quarter turns; elsewhere the platform's sin/cos, nudged by EPSILON so pixel centres on an edge round alike.
  const r = angle * Math.PI / 180, q = ((angle % 360) + 360) % 360;
  return q === 0 ? [1, 0] : q === 90 ? [0, 1] : q === 180 ? [-1, 0] : q === 270 ? [0, -1] : [Math.cos(r), Math.sin(r)];
}
/** tan of a whole-degree skew, exact at 0 and ±45°. */
const slope = deg => !deg ? 0 : Math.abs(deg) === 45 ? Math.sign(deg) : Math.tan(deg * Math.PI / 180);
/** Size of the transformed (unrotated) box on the canvas. */
export function transformedSize(instance, part) {
  const size = instanceSize(instance, part);
  return swapsAxes(instance.transform) ? { width: size.height, height: size.width } : size;
}

/** Per-instance pose properties beyond position and transform; all optional, absent means default. */
export const POSE_KEYS = ['width', 'height', 'angle', 'pivot', 'skew', 'tilt', 'deform', 'stretch', 'sampling'];
/** Default perspective (percent) of a 3D turn when `tilt.perspective` is omitted. */
export const DEFAULT_PERSPECTIVE = 30;
/** The instance's 3D turn `{x, y, perspective}` (degrees, percent), or null when it has none. */
export function instanceTilt(instance) {
  const t = instance.tilt;
  return t && (t.x || t.y) ? { x: t.x || 0, y: t.y || 0, perspective: t.perspective ?? DEFAULT_PERSPECTIVE } : null;
}
export const SAMPLING_MODES = ['nearest', 'rotsprite', 'aa'];
export const DEFORM_KINDS = ['wave', 'bulge', 'twist'];
/** Deep copy of an instance's pose properties (absent ones omitted). */
export function instancePose(instance) {
  return Object.fromEntries(POSE_KEYS.filter(k => instance[k] !== undefined).map(k => [k, typeof instance[k] === 'object' ? { ...instance[k] } : instance[k]]));
}
/** Pivot within the transformed box (continuous): a set pivot pixel's centre, otherwise the exact box centre. */
function pivotPoint(instance, box) {
  return instance.pivot ? { x: instance.pivot.x + .5, y: instance.pivot.y + .5 } : { x: box.width / 2, y: box.height / 2 };
}
/** Canvas point that free rotation, skew and 3D turns act about (pixel centre of a set pivot, otherwise the exact box centre). */
export function instancePivot(instance, part) {
  const p = pivotPoint(instance, transformedSize(instance, part));
  return { x: instance.x + p.x, y: instance.y + p.y };
}
/** Whole-pixel shift of wave row/column `i`: round(amplitude·sin(2π·i/wavelength + phase)). */
export function waveShift(deform, i) {
  return Math.round(deform.amplitude * Math.sin(2 * Math.PI * i / deform.wavelength + deform.phase * Math.PI / 180));
}
/**
 * Inverse deform in box space. Wave moves whole rows (axis x) or columns (axis y) by waveShift. Bulge and twist act
 * inside the ellipse inscribed in the box, in coordinates normalised to the unit circle (r < 1), and leave the rest
 * alone: bulge samples radius r^(2^(strength/100)) (positive magnifies the centre, negative pinches), twist turns by
 * angle·(1−r) (full angle at the centre, none at the edge). Both are bijections of the ellipse, so the box never grows.
 */
function undeform(d, box, x, y) {
  if (d.kind === 'wave') return d.axis === 'x' ? [x - waveShift(d, Math.floor(y + EPSILON)), y] : [x, y - waveShift(d, Math.floor(x + EPSILON))];
  const hw = box.width / 2, hh = box.height / 2, nx = (x - hw) / hw, ny = (y - hh) / hh, r = Math.hypot(nx, ny);
  if (!(r > 0) || r >= 1) return [x, y];
  if (d.kind === 'bulge') { const f = r ** (2 ** (d.strength / 100) - 1); return [hw + nx * f * hw, hh + ny * f * hh]; }
  const a = d.angle * (1 - r) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  return [hw + (nx * cos + ny * sin) * hw, hh + (-nx * sin + ny * cos) * hh];
}
/** Forward deform in box space (inverse of undeform). */
function redeform(d, box, x, y) {
  if (d.kind === 'wave') return d.axis === 'x' ? [x + waveShift(d, Math.floor(y + EPSILON)), y] : [x, y + waveShift(d, Math.floor(x + EPSILON))];
  const hw = box.width / 2, hh = box.height / 2, nx = (x - hw) / hw, ny = (y - hh) / hh, r = Math.hypot(nx, ny);
  if (!(r > 0) || r >= 1) return [x, y];
  if (d.kind === 'bulge') { const f = r ** (1 / 2 ** (d.strength / 100) - 1); return [hw + nx * f * hw, hh + ny * f * hh]; }
  const a = d.angle * (1 - r) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  return [hw + (nx * cos - ny * sin) * hw, hh + (nx * sin + ny * cos) * hh];
}
/** Box point `pt` moved by the instance's deform as rendered (`inverse` undoes it); unchanged without a deform. */
export function deformPoint(instance, part, pt, inverse = false) {
  if (!instance.deform) return { x: pt.x, y: pt.y };
  const [x, y] = (inverse ? undeform : redeform)(instance.deform, transformedSize(instance, part), pt.x, pt.y);
  return { x, y };
}
/** Pivot-relative corners of the box (widened by a wave) after skew: what the 3D turn and rotation act on. */
function skewedCorners(instance, box, c) {
  const d = instance.deform, skew = instance.skew, tx = slope(skew?.x), ty = slope(skew?.y);
  const ax = d?.kind === 'wave' && d.axis === 'x' ? d.amplitude : 0, ay = d?.kind === 'wave' && d.axis === 'y' ? d.amplitude : 0;
  return [[-ax, -ay], [box.width + ax, -ay], [box.width + ax, box.height + ay], [-ax, box.height + ay]].map(([u, v]) => {
    let dx = u - c.x, dy = v - c.y;
    if (skew) { dx += tx*dy; dy += ty*dx; }
    return [dx, dy];
  });
}
/**
 * 3D turn as a plane projective map about the pivot. A pivot-relative point (u,v,0) turns about the vertical axis by
 * tilt.y (positive: the right side goes away), then about the horizontal axis by tilt.x (positive: the top goes away):
 * X = u·cos y, Y = v·cos x + u·sin y·sin x, Z = u·sin y·cos x − v·sin x. It is then projected as (X,Y)/(1 + k·Z) with
 * k = perspective/(200·R), R the farthest skewed corner from the pivot, so |k·Z| ≤ perspective/200 and the far edge
 * shrinks while the near edge grows (at most 1/1.5 and 1/0.5 at 100%). Without perspective a 180° turn is an exact flip.
 * Returns the linear part [a,b,c,d] (x' = a·u + b·v, y' = c·u + d·v before projection) and the projection row [g,h].
 */
function tiltMap(instance, box, c) {
  const t = instanceTilt(instance);
  if (!t) return null;
  const [cy, sy] = turned(t.y), [cx, sx] = turned(t.x);
  const reach = Math.max(...skewedCorners(instance, box, c).map(([x, y]) => Math.hypot(x, y)));
  const k = reach > 0 ? Math.max(0, Math.min(100, t.perspective)) / (200 * reach) : 0;
  return { m: [cy, 0, sy*sx, cx], g: [k*sy*cx, -k*sx] };
}
/** Forward 3D turn of a pivot-relative point. */
function tiltForward({ m: [a, b, c, d], g: [g, h] }, x, y) {
  const w = 1 + g*x + h*y;
  return [(a*x + b*y) / w, (c*x + d*y) / w];
}
/** Inverse 3D turn of a pivot-relative point, or null where nothing of the turned plane shows (edge-on, behind). */
function tiltInverse({ m: [a, b, c, d], g: [g, h] }, x, y) {
  const det = a*d - b*c;
  if (Math.abs(det) < EPSILON) return null;
  const u = (d*x - b*y) / det, v = (-c*x + a*y) / det, w = 1 - g*u - h*v;
  return w > EPSILON ? [u / w, v / w] : null;
}
/** Box coordinate that no part pixel lies at: where the inverse 3D turn finds nothing. */
const NOWHERE = -1e6;
/** Continuous point (px,py) relative to the instance origin, mapped back through rotation, 3D turn, skew and deform to box space. */
function boxPoint(instance, box, px, py) {
  const angle = instanceAngle(instance), skew = instance.skew, tilt = instanceTilt(instance);
  let x = px, y = py;
  if (angle || skew || tilt) {
    const c = pivotPoint(instance, box);
    x -= c.x; y -= c.y;
    if (angle) { const [cos, sin] = turned(angle); [x, y] = [x*cos + y*sin, -x*sin + y*cos]; }
    if (tilt) {
      const back = tiltInverse(tiltMap(instance, box, c), x, y);
      if (!back) return [NOWHERE, NOWHERE];
      [x, y] = back;
    }
    if (skew) { y -= slope(skew.y) * x; x -= slope(skew.x) * y; }
    x += c.x; y += c.y;
  }
  return instance.deform ? undeform(instance.deform, box, x, y) : [x, y];
}
/**
 * Canvas pixel rectangle covered by an instance. Skew and rotation are affine and the 3D turn is projective (it keeps
 * straight lines and, in front of the eye, convexity), so the transformed corners bound them; a wave widens the box by
 * its amplitude first, bulge and twist stay inside it.
 */
export function instanceBox(instance, part) {
  const box = transformedSize(instance, part), { width, height } = box, angle = instanceAngle(instance), skew = instance.skew, d = instance.deform;
  const wave = d?.kind === 'wave', tilt = instanceTilt(instance);
  if (!angle && !skew && !wave && !tilt) return { x: instance.x, y: instance.y, width, height };
  const [cos, sin] = turned(angle), c = pivotPoint(instance, box), ox = instance.x + c.x, oy = instance.y + c.y;
  const map = tilt && tiltMap(instance, box, c), xs = [], ys = [];
  for (let [dx, dy] of skewedCorners(instance, box, c)) {
    if (map) [dx, dy] = tiltForward(map, dx, dy);
    xs.push(ox + dx*cos - dy*sin); ys.push(oy + dx*sin + dy*cos);
  }
  const left = Math.floor(Math.min(...xs) + EPSILON), top = Math.floor(Math.min(...ys) + EPSILON);
  // An edge-on 3D turn flattens the box to a line; it keeps one pixel of width (or height) for its sliver.
  return { x: left, y: top, width: Math.max(1, Math.ceil(Math.max(...xs) - EPSILON) - left), height: Math.max(1, Math.ceil(Math.max(...ys) - EPSILON) - top) };
}

/**
 * Map a canvas pixel into a placed part's untransformed pixel coordinates. Forward order is resize → flip/turn →
 * deform → skew → 3D turn (tilt) → rotate about the pivot; this inverse-maps the pixel centre back in reverse (nearest neighbour), so
 * each canvas pixel shows exactly one part pixel and the part itself never changes. Without deform every step is affine
 * or monotonic, so a pixel past one edge of the box lands past the matching edge of the part (in-place editing grows
 * parts that way).
 */
export function canvasToPartPoint(instance, part, point) {
  const size = instanceSize(instance, part), box = transformedSize(instance, part);
  let x = point.x - instance.x, y = point.y - instance.y;
  if (instance.angle || instance.skew || instance.deform || instanceTilt(instance)) {
    const [u, v] = boxPoint(instance, box, x + .5, y + .5);
    x = Math.floor(u + EPSILON); y = Math.floor(v + EPSILON);
  }
  const local = untransformPoint(instance.transform, size.width, size.height, x, y), seam = resizeSeam(instance, part);
  return { x: sampleIndex(local.x, size.width, part.width, seam.x), y: sampleIndex(local.y, size.height, part.height, seam.y) };
}

/** Whether RotSprite sampling changes this instance's output: only free (non-quarter) angles, skew, 3D turns and deform resample. */
export function smoothSampling(instance) {
  return instance.sampling === 'rotsprite' && Boolean((instance.angle && instance.angle % 90) || instance.skew || instance.deform || instanceTilt(instance));
}
/** Whether the instance resamples its part (free angle, skew, 3D turn, deform or a resize); flips and quarter turns only move pixels. */
export function resamples(instance, part) {
  const size = instanceSize(instance, part);
  return Boolean((instance.angle && instance.angle % 90) || instance.skew || instance.deform || instanceTilt(instance) || size.width !== part.width || size.height !== part.height);
}
/** Continuous part coordinates (part pixel units) under the instance-relative point (px,py). */
function partPoint(instance, part, size, box, px, py) {
  const [u, v] = boxPoint(instance, box, px, py), [a, b, c, d] = matrix(instance.transform);
  // Continuous inverse of the dihedral transform (transpose), measured to box edges rather than pixel indices.
  const lx = a*u + c*v + (a < 0 ? size.width : 0) + (c < 0 ? size.width : 0), ly = b*u + d*v + (b < 0 ? size.height : 0) + (d < 0 ? size.height : 0);
  const seam = resizeSeam(instance, part);
  return [axisToPart(lx, size.width, part.width, seam.x), axisToPart(ly, size.height, part.height, seam.y)];
}
/** Box point of the continuous part point (sx,sy): resize → transform → deform. */
function partToBoxPoint(instance, part, size, box, sx, sy) {
  const [a, b, c, d] = matrix(instance.transform), seam = resizeSeam(instance, part);
  const lx = axisFromPart(sx, size.width, part.width, seam.x), ly = axisFromPart(sy, size.height, part.height, seam.y);
  const x = a*lx + b*ly + (a < 0 ? size.width : 0) + (b < 0 ? size.height : 0), y = c*lx + d*ly + (c < 0 ? size.width : 0) + (d < 0 ? size.height : 0);
  return instance.deform ? redeform(instance.deform, box, x, y) : [x, y];
}
/** Instance-relative canvas point of the continuous part point (sx,sy): the forward map resize → transform → deform → skew → 3D turn → rotate. */
export function partToInstancePoint(instance, part, sx, sy) {
  const box = transformedSize(instance, part);
  let [x, y] = partToBoxPoint(instance, part, instanceSize(instance, part), box, sx, sy);
  if (instance.angle || instance.skew || instanceTilt(instance)) {
    const p = pivotPoint(instance, box), v = poseVector(instance, part, { x: x - p.x, y: y - p.y });
    x = v.x + p.x; y = v.y + p.y;
  }
  return [x, y];
}
/** RotSprite: the cached 8× Scale2x³ image sampled at the pixel centre. */
function rotspritePixel(instance, part, size, box, x, y) {
  const [lx, ly] = partPoint(instance, part, size, box, x + .5, y + .5), image = rotspriteImage(part);
  const sx = Math.floor(lx * ROTSPRITE_SCALE + EPSILON), sy = Math.floor(ly * ROTSPRITE_SCALE + EPSILON);
  return sx < 0 || sy < 0 || sx >= image.width || sy >= image.height ? -1 : image.pixels[sy * image.width + sx];
}
const AA_GRID = 4;
/**
 * Smooth AA: 4×4 supersampled coverage of one pixel. Below 50% coverage the pixel is transparent, else it takes the
 * most covered colour; where a second part colour covers 25–75% of the opaque samples, the palette colour between the
 * two (antialias.paletteBlend) is used instead. Partly covered silhouette pixels (25–75%) also report `edge` coverage
 * so compositing can blend them with what is already beneath in the cel.
 */
function aaPixel(instance, part, size, box, x, y) {
  const counts = new Map();
  let opaque = 0;
  for (let j = 0; j < AA_GRID; j++) for (let i = 0; i < AA_GRID; i++) {
    const [lx, ly] = partPoint(instance, part, size, box, x + (i + .5) / AA_GRID, y + (j + .5) / AA_GRID);
    const sx = Math.floor(lx + EPSILON), sy = Math.floor(ly + EPSILON);
    const v = sx < 0 || sy < 0 || sx >= part.width || sy >= part.height ? -1 : part.pixels[sy * part.width + sx];
    if (v >= 0) { opaque++; counts.set(v, (counts.get(v) || 0) + 1); }
  }
  if (!opaque) return { color: -1 };
  const [[d, nd], [e, ne] = [-1, 0]] = [...counts].sort((p, q) => q[1] - p[1] || p[0] - q[0]);
  const share = ne / (nd + ne);
  let color = d;
  if (share >= .25 && part.palette) { const mix = paletteBlend(part.palette, d, e, share); if (mix >= 0) color = mix; }
  const coverage = opaque / AA_GRID ** 2;
  return { color: coverage >= .5 ? color : -1, raw: d, edge: coverage >= .25 && coverage < .75 ? coverage : 0 };
}

/** Whether a 3D turn shows the plane exactly edge-on (cos of either turn is 0, e.g. 90° or 270°). */
export function edgeOn(instance) {
  const t = instanceTilt(instance);
  return Boolean(t) && Math.abs(turned(t.y)[0] * turned(t.x)[0]) < 1e-6;
}
const SLIVER_SAMPLES = 4;
/**
 * Edge-on, the turned plane would show nothing; it is drawn as a 1px sliver instead (its
 * thickness, as a real card or coin shows). Each part pixel is forward-mapped at 4×4 sample points and every canvas
 * pixel on the line keeps the sample nearest the viewer (smallest depth Z of the 3D turn); on a tie (no depth
 * difference) the first in part order wins. So a Y turn shows, per row, the part pixel on the edge that was nearest
 * (the left edge turning +90°, the right edge at −90°): usually the outline colour. A turn so nearly edge-on that no
 * pixel centre is covered shows the sliver of the nearest exact edge-on turn.
 */
function sliverPixels(instance, part, rect) {
  const size = instanceSize(instance, part), box = transformedSize(instance, part), c = pivotPoint(instance, box), t = instanceTilt(instance);
  const [, sy] = turned(t.y), [cx, sx] = turned(t.x), tx = slope(instance.skew?.x), ty = slope(instance.skew?.y), pw = part.width;
  const pixels = new Array(rect.width * rect.height).fill(-1), depth = new Float64Array(pixels.length).fill(Infinity);
  part.pixels.forEach((value, s) => {
    if (value < 0) return;
    for (let j = 0; j < SLIVER_SAMPLES; j++) for (let i = 0; i < SLIVER_SAMPLES; i++) {
      const px = s % pw + (i + .5) / SLIVER_SAMPLES, py = Math.floor(s / pw) + (j + .5) / SLIVER_SAMPLES, [fx, fy] = partToInstancePoint(instance, part, px, py);
      const x = Math.floor(fx + EPSILON) - rect.x, y = Math.floor(fy + EPSILON) - rect.y;
      if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) continue;
      const [bx, by] = partToBoxPoint(instance, part, size, box, px, py);
      let u = bx - c.x, v = by - c.y;
      if (instance.skew) { u += tx * v; v += ty * u; }
      const z = u * sy * cx - v * sx, k = y * rect.width + x;
      if (z < depth[k] - EPSILON) { depth[k] = z; pixels[k] = value; }
    }
  });
  return pixels;
}

const imageCache = new WeakMap(), IMAGE_CACHE_AREA = 1 << 19;
/**
 * The instance drawn into its own box (relative to the instance origin), for instances that resample their part:
 * `{x, y, width, height, pixels, edge?}`, cached per part image and pose. Every pixel is inverse-mapped from its centre
 * (nearest, RotSprite or Smooth AA), then thin features are repaired so resampling never opens gaps:
 * 1. a part pixel no canvas pixel shows (squashed away, or a rotated pixel whose square holds no pixel centre) is drawn
 *    at its forward-mapped centre, over transparency or over a pixel whose own part pixel shows elsewhere too;
 * 2. two 8-adjacent part pixels of one colour whose canvas pixels no longer touch are bridged with a short line.
 * So 1px lines stay 8-connected and outlines closed under rotation, skew, 3D turns, deforms and squash.
 */
export function instanceImage(instance, part) {
  const key = [instance.transform, instance.width, instance.height, instance.angle, instance.pivot?.x, instance.pivot?.y, JSON.stringify(instance.skew),
    JSON.stringify(instance.tilt), JSON.stringify(instance.deform), instance.stretch, instance.sampling, instance.sampling === 'aa' ? part.palette?.join() : ''].join('|');
  let byPose = imageCache.get(part.pixels);
  if (!byPose) imageCache.set(part.pixels, byPose = Object.assign(new Map(), { area: 0 }));
  const cached = byPose.get(key);
  if (cached) { byPose.delete(key); byPose.set(key, cached); return cached; }
  const rect = instanceBox({ ...instance, x: 0, y: 0 }, part), size = instanceSize(instance, part), box = transformedSize(instance, part);
  if (edgeOn(instance)) return remember(byPose, key, { ...rect, pixels: sliverPixels(instance, part, rect), edge: null });
  const { width, height } = rect, n = width * height, pixels = new Array(n).fill(-1), owner = new Int32Array(n).fill(-1);
  const pw = part.width, ph = part.height, P = part.pixels, count = new Int32Array(pw * ph), best = new Int32Array(pw * ph).fill(-1), bestD = new Float64Array(pw * ph).fill(Infinity);
  const sampling = instance.sampling === 'rotsprite' && smoothSampling(instance) ? 'rotsprite' : instance.sampling === 'aa' ? 'aa' : 'nearest';
  const edge = sampling === 'aa' ? new Map() : null;
  const forward = s => {
    const [fx, fy] = partToInstancePoint(instance, part, s % pw + .5, Math.floor(s / pw) + .5), x = Math.floor(fx + EPSILON) - rect.x, y = Math.floor(fy + EPSILON) - rect.y;
    return x < 0 || y < 0 || x >= width || y >= height ? -1 : y * width + x;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const t = y * width + x, cx = rect.x + x, cy = rect.y + y, local = canvasToPartPoint({ ...instance, x: 0, y: 0 }, part, { x: cx, y: cy });
    const s = local.x < 0 || local.y < 0 || local.x >= pw || local.y >= ph ? -1 : local.y * pw + local.x;
    let color;
    if (sampling === 'nearest') color = s < 0 ? -1 : P[s];
    else if (sampling === 'rotsprite') color = rotspritePixel(instance, part, size, box, cx, cy);
    else { const aa = aaPixel(instance, part, size, box, cx, cy); color = aa.color; if (aa.edge) edge.set(t, { color: aa.raw, coverage: aa.edge }); }
    pixels[t] = color;
    if (color < 0) continue;
    owner[t] = -2;
    if (s < 0) continue;
    // Smoothing may show a neighbouring part pixel's colour: credit the nearest neighbour of that colour that maps next to it.
    const [lx, ly] = partPoint(instance, part, size, box, cx + .5, cy + .5);
    let o = P[s] === color ? s : -1, od = Infinity;
    if (o < 0) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const qx = local.x + dx, qy = local.y + dy, q = qy * pw + qx, dist = Math.hypot(lx - qx - .5, ly - qy - .5);
      if (qx < 0 || qy < 0 || qx >= pw || qy >= ph || P[q] !== color || dist >= od) continue;
      const f = forward(q);
      if (f >= 0 && Math.abs(f % width - x) <= 1 && Math.abs(Math.floor(f / width) - y) <= 1) { o = q; od = dist; }
    }
    if (o < 0) continue;
    owner[t] = o; count[o]++;
    const dist = Math.hypot(lx - o % pw - .5, ly - Math.floor(o / pw) - .5);
    if (dist < bestD[o]) { bestD[o] = dist; best[o] = t; }
  }
  // Turned (nearly) edge-on so that no pixel centre is covered: draw the sliver rather than nothing.
  if (instanceTilt(instance) && !owner.some(o => o !== -1)) {
    const t = instance.tilt, near = a => Math.sign(turned(a || 0)[1]) * 90 || 90;
    return instanceImage({ ...instance, tilt: Math.abs(turned(t.y || 0)[0]) <= Math.abs(turned(t.x || 0)[0]) ? { ...t, y: near(t.y) } : { ...t, x: near(t.x) } }, part);
  }
  const shown = Array.from({ length: P.length }, () => []);
  owner.forEach((o, t) => { if (o >= 0) shown[o].push(t); });
  const touches = (s, q) => { const near = new Set(shown[q]); return shown[s].some(t => { const x = t % width, y = Math.floor(t / width); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < width && ny < height && near.has(ny * width + nx)) return true; } return false; }); };
  // A part pixel whose same-coloured neighbours stay 8-connected without it (and has at least two) can give up its only canvas pixel.
  const RING = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  const removable = s => {
    const x = s % pw, y = Math.floor(s / pw), on = RING.map(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < pw && y + dy < ph && P[(y + dy) * pw + x + dx] === P[s]);
    if (on.filter(Boolean).length < 2) return false;
    // 8-components among the ring: ring neighbours touch, and so do two edge neighbours across a corner.
    const group = [0, 1, 2, 3, 4, 5, 6, 7], root = i => (group[i] === i ? i : (group[i] = root(group[i])));
    for (let i = 0; i < 8; i++) for (const j of [(i + 1) % 8, i % 2 ? (i + 2) % 8 : -1]) if (j >= 0 && on[i] && on[j]) group[root(i)] = root(j);
    return new Set(on.flatMap((v, i) => (v ? [root(i)] : []))).size === 1;
  };
  const locked = new Uint8Array(n);
  // A pixel may be repainted unless it was repaired already or is the only one showing a part pixel on an edge or line.
  const free = t => !locked[t] && (owner[t] < 0 || (count[owner[t]] >= 2 && best[owner[t]] !== t) || removable(owner[t]));
  const paint = (t, s) => {
    const o = owner[t];
    if (o >= 0) { count[o]--; shown[o] = shown[o].filter(k => k !== t); if (best[o] === t) best[o] = shown[o][0] ?? -1; }
    pixels[t] = P[s]; owner[t] = s; count[s]++; shown[s].push(t); locked[t] = 1;
    if (best[s] < 0) best[s] = t;
    edge?.delete(t);
  };
  // Only pixels of features that otherwise survive come back: a stripe squashed away entirely stays away, as nearest sampling has it.
  const linked = s => RING.some(([dx, dy]) => { const x = s % pw + dx, y = Math.floor(s / pw) + dy; return x >= 0 && y >= 0 && x < pw && y < ph && P[y * pw + x] === P[s] && count[y * pw + x] > 0; });
  const queue = [], tried = new Uint8Array(P.length);
  for (let s = 0; s < P.length; s++) if (P[s] >= 0 && !count[s] && linked(s)) queue.push(s);
  while (queue.length) {
    const s = queue.shift();
    if (tried[s] || shown[s].length) continue;
    tried[s] = 1;
    const t = forward(s);
    if (t < 0) continue;
    // Where the same colour already shows, that pixel stands in for this one; elsewhere it is drawn if the pixel is free.
    if (pixels[t] === P[s]) { shown[s].push(t); best[s] = t; } else if (free(t)) paint(t, s); else continue;
    for (const [dx, dy] of RING) { const x = s % pw + dx, y = Math.floor(s / pw) + dy, q = y * pw + x; if (x >= 0 && y >= 0 && x < pw && y < ph && P[q] === P[s] && !shown[q].length && !tried[q]) queue.push(q); }
  }
  const rep = s => (best[s] >= 0 ? best[s] : forward(s));
  for (let s = 0; s < P.length; s++) {
    if (P[s] < 0) continue;
    const sx = s % pw, sy = Math.floor(s / pw);
    for (const [dx, dy] of [[1, 0], [-1, 1], [0, 1], [1, 1]]) {
      const qx = sx + dx, qy = sy + dy, q = qy * pw + qx;
      if (qx < 0 || qx >= pw || qy >= ph || P[q] !== P[s] || (!shown[s].length && !shown[q].length)) continue;
      const a = rep(s), b = rep(q);
      if (a < 0 || b < 0 || touches(s, q)) continue;
      const ax = a % width, ay = Math.floor(a / width), bx = b % width, by = Math.floor(b / width);
      if (Math.max(Math.abs(ax - bx), Math.abs(ay - by)) <= 1) continue;
      const path = linePoints(ax, ay, bx, by);
      for (let k = 1; k < path.length - 1; k++) {
        const t = path[k].y * width + path[k].x;
        if (pixels[t] !== P[s] && free(t)) paint(t, k < path.length / 2 ? s : q);
      }
    }
  }
  return remember(byPose, key, { ...rect, pixels, edge: edge?.size ? edge : null });
}
/** Cache an instance image; least recently used poses go first once the part's cached images exceed the pixel budget. */
function remember(byPose, key, image) {
  const n = image.pixels.length;
  for (const [old, value] of byPose) { if (byPose.area + n <= IMAGE_CACHE_AREA) break; byPose.delete(old); byPose.area -= value.pixels.length; }
  byPose.set(key, image); byPose.area += n;
  return image;
}
/**
 * Palette index (-1 transparent) a placed instance shows at canvas pixel `point`; `part` is a rendered part with pixels.
 * Shared by rendering and hit-testing. Instances that resample read their cached instanceImage; the rest map exactly.
 */
export function instancePixel(instance, part, point) {
  if (!resamples(instance, part)) {
    const local = canvasToPartPoint(instance, part, point);
    return local.x < 0 || local.y < 0 || local.x >= part.width || local.y >= part.height ? -1 : part.pixels[local.y * part.width + local.x];
  }
  const image = instanceImage(instance, part), x = point.x - instance.x - image.x, y = point.y - instance.y - image.y;
  return x < 0 || y < 0 || x >= image.width || y >= image.height ? -1 : image.pixels[y * image.width + x];
}

/** Canvas position of part pixel (x,y) relative to its instance origin, matching the renderer's transforms. */
export function partToCanvasOffset(transform, part, x, y) {
  return transformPoint(transform, part.width, part.height, x, y);
}

/** How far an instance must move so its existing pixels stay put after the part gains `left`/`top` padding and a new size. */
export function grownInstanceShift(transform, before, after, left, top) {
  const a=partToCanvasOffset(transform,before,0,0), b=partToCanvasOffset(transform,after,left,top);
  return {x:a.x-b.x,y:a.y-b.y};
}

/** Skew, 3D turn, then rotate a pivot-relative point as rendering does (`inverse` undoes it). */
export function poseVector(instance, part, v, inverse = false) {
  const [cos, sin] = turned(instanceAngle(instance)), skew = instance.skew, box = transformedSize(instance, part);
  const map = instanceTilt(instance) && tiltMap(instance, box, pivotPoint(instance, box));
  let { x, y } = v;
  if (inverse) {
    [x, y] = [x * cos + y * sin, -x * sin + y * cos];
    if (map) [x, y] = tiltInverse(map, x, y) || [x, y];
    if (skew) { y -= slope(skew.y) * x; x -= slope(skew.x) * y; }
    return { x, y };
  }
  if (skew) { x += slope(skew.x) * y; y += slope(skew.y) * x; }
  if (map) [x, y] = tiltForward(map, x, y);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}
/** Box-relative pivot pixel under canvas point `at`, for the instance as it is shown (rotation, 3D turn, skew and deform undone). */
export function pivotUnder(instance, part, at) {
  const c = instancePivot(instance, part), local = poseVector(instance, part, { x: at.x - c.x, y: at.y - c.y }, true);
  const box = deformPoint(instance, part, { x: c.x - instance.x + local.x, y: c.y - instance.y + local.y }, true);
  const clamp = v => Math.max(PIVOT_MIN, Math.min(PIVOT_MAX, Math.floor(v)));
  return { x: clamp(box.x), y: clamp(box.y) };
}
/**
 * Copy of `instance` with `pivot` set (null: the centre), moved so its artwork stays put: changing the point a
 * transform turns around shifts the art by (M − I)·Δ, which the position undoes to the nearest whole pixel.
 */
export function withPivot(instance, part, pivot) {
  const next = { ...instance };
  if (pivot) next.pivot = { x: pivot.x, y: pivot.y }; else delete next.pivot;
  if (!instance.angle && !instance.skew && !instanceTilt(instance)) return next;
  const a = instancePivot(instance, part), b = instancePivot(next, part), delta = { x: b.x - a.x, y: b.y - a.y }, moved = poseVector(instance, part, delta);
  next.x += Math.round(moved.x - delta.x); next.y += Math.round(moved.y - delta.y);
  return next;
}
