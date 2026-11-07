/** Deterministic integer-grid geometry shared by tools and retained artwork. */
import { SIZE, MAX_TOTAL_PIXELS, pixelCount } from './limits.js';
import { rotspriteImage, ROTSPRITE_SCALE } from './rotsprite.js';

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
 * 8 rows to 4 keeps rows 1,3,5,7 and stretching 4 columns to 8 doubles every column. Out-of-range input stays out of range.
 */
export function sampleIndex(i, target, source) {
  return target===source ? i : Math.floor(((2*i+1)*source)/(2*target));
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
export const POSE_KEYS = ['width', 'height', 'angle', 'pivot', 'skew', 'tilt', 'deform', 'sampling'];
/** Default perspective (percent) of a 3D turn when `tilt.perspective` is omitted. */
export const DEFAULT_PERSPECTIVE = 30;
/** The instance's 3D turn `{x, y, perspective}` (degrees, percent), or null when it has none. */
export function instanceTilt(instance) {
  const t = instance.tilt;
  return t && (t.x || t.y) ? { x: t.x || 0, y: t.y || 0, perspective: t.perspective ?? DEFAULT_PERSPECTIVE } : null;
}
export const SAMPLING_MODES = ['nearest', 'rotsprite'];
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
  return { x: left, y: top, width: Math.ceil(Math.max(...xs) - EPSILON) - left, height: Math.ceil(Math.max(...ys) - EPSILON) - top };
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
  const local = untransformPoint(instance.transform, size.width, size.height, x, y);
  return { x: sampleIndex(local.x, size.width, part.width), y: sampleIndex(local.y, size.height, part.height) };
}

/** Whether RotSprite sampling changes this instance's output: only free (non-quarter) angles, skew, 3D turns and deform resample. */
export function smoothSampling(instance) {
  return instance.sampling === 'rotsprite' && Boolean((instance.angle && instance.angle % 90) || instance.skew || instance.deform || instanceTilt(instance));
}
/**
 * Palette index (-1 transparent) a placed instance shows at canvas pixel `point`; `part` is a rendered part with pixels.
 * Shared by rendering and hit-testing. RotSprite instances sample the cached 8× Scale2x³ image at the pixel centre.
 */
export function instancePixel(instance, part, point) {
  if (!smoothSampling(instance)) {
    const local = canvasToPartPoint(instance, part, point);
    return local.x < 0 || local.y < 0 || local.x >= part.width || local.y >= part.height ? -1 : part.pixels[local.y * part.width + local.x];
  }
  const size = instanceSize(instance, part), box = transformedSize(instance, part);
  const [u, v] = boxPoint(instance, box, point.x - instance.x + .5, point.y - instance.y + .5);
  const [a, b, c, d] = matrix(instance.transform);
  // Continuous inverse of the dihedral transform (transpose), measured to box edges rather than pixel indices.
  const lx = a*u + c*v + (a < 0 ? size.width : 0) + (c < 0 ? size.width : 0), ly = b*u + d*v + (b < 0 ? size.height : 0) + (d < 0 ? size.height : 0);
  const image = rotspriteImage(part);
  const sx = Math.floor(lx * part.width / size.width * ROTSPRITE_SCALE + EPSILON), sy = Math.floor(ly * part.height / size.height * ROTSPRITE_SCALE + EPSILON);
  return sx < 0 || sy < 0 || sx >= image.width || sy >= image.height ? -1 : image.pixels[sy * image.width + sx];
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
function poseVector(instance, part, v, inverse = false) {
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
/** Box-relative pivot pixel under canvas point `at`, for the instance as it is shown (rotation, 3D turn and skew undone). */
export function pivotUnder(instance, part, at) {
  const c = instancePivot(instance, part), local = poseVector(instance, part, { x: at.x - c.x, y: at.y - c.y }, true);
  const clamp = v => Math.max(-128, Math.min(256, Math.floor(v)));
  return { x: clamp(c.x - instance.x + local.x), y: clamp(c.y - instance.y + local.y) };
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
