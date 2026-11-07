/** Deterministic integer-grid geometry shared by tools and retained artwork. */
import { SIZE, MAX_TOTAL_PIXELS, pixelCount } from './limits.js';

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

/** Free rotation in whole degrees, after size and transform, about the centre of the transformed box. */
export function instanceAngle(instance) { return instance.angle || 0; }
const EPSILON = 1e-9;
function turned(angle) {
  // Exact values for quarter turns; elsewhere the platform's sin/cos, nudged by EPSILON so pixel centres on an edge round alike.
  const r = angle * Math.PI / 180, q = ((angle % 360) + 360) % 360;
  return q === 0 ? [1, 0] : q === 90 ? [0, 1] : q === 180 ? [-1, 0] : q === 270 ? [0, -1] : [Math.cos(r), Math.sin(r)];
}
/** Size of the transformed (unrotated) box on the canvas. */
export function transformedSize(instance, part) {
  const size = instanceSize(instance, part);
  return swapsAxes(instance.transform) ? { width: size.height, height: size.width } : size;
}
/** Canvas pixel rectangle covered by an instance, including free rotation. */
export function instanceBox(instance, part) {
  const { width, height } = transformedSize(instance, part), angle = instanceAngle(instance);
  if (!angle) return { x: instance.x, y: instance.y, width, height };
  const [cos, sin] = turned(angle), cx = instance.x + width / 2, cy = instance.y + height / 2;
  const xs = [], ys = [];
  for (const [dx, dy] of [[-width/2, -height/2], [width/2, -height/2], [width/2, height/2], [-width/2, height/2]]) {
    xs.push(cx + dx*cos - dy*sin); ys.push(cy + dx*sin + dy*cos);
  }
  const left = Math.floor(Math.min(...xs) + EPSILON), top = Math.floor(Math.min(...ys) + EPSILON);
  return { x: left, y: top, width: Math.ceil(Math.max(...xs) - EPSILON) - left, height: Math.ceil(Math.max(...ys) - EPSILON) - top };
}

/**
 * Map a canvas pixel into a placed part's untransformed pixel coordinates. Every step is affine or monotonic, so a
 * pixel past one edge of the box lands past the matching edge of the part (in-place editing grows parts that way).
 * Free angles turn the pixel centre back by -angle about the box centre (inverse-mapped nearest neighbour), so each
 * canvas pixel shows exactly one part pixel and the part itself never changes.
 */
export function canvasToPartPoint(instance, part, point) {
  const size = instanceSize(instance, part), box = transformedSize(instance, part), angle = instanceAngle(instance);
  let x = point.x - instance.x, y = point.y - instance.y;
  if (angle) {
    const [cos, sin] = turned(angle), vx = x + .5 - box.width / 2, vy = y + .5 - box.height / 2;
    x = Math.floor(vx*cos + vy*sin + box.width / 2 + EPSILON);
    y = Math.floor(-vx*sin + vy*cos + box.height / 2 + EPSILON);
  }
  const local = untransformPoint(instance.transform, size.width, size.height, x, y);
  return { x: sampleIndex(local.x, size.width, part.width), y: sampleIndex(local.y, size.height, part.height) };
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
