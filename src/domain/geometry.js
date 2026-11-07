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

/** Map a canvas pixel into a placed part's untransformed pixel coordinates. */
export function canvasToPartPoint(instance, part, point) {
  const size=instanceSize(instance,part), x=point.x-instance.x, y=point.y-instance.y;
  let local;
  switch(instance.transform) {
    case 'N': local={x,y}; break;
    case 'FX': local={x:size.width-1-x,y}; break;
    case 'FY': local={x,y:size.height-1-y}; break;
    case 'R90': local={x:y,y:size.height-1-x}; break;
    case 'R180': local={x:size.width-1-x,y:size.height-1-y}; break;
    case 'R270': local={x:size.width-1-y,y:x}; break;
    default: throw new Error('Unknown instance transform.');
  }
  return {x:sampleIndex(local.x,size.width,part.width),y:sampleIndex(local.y,size.height,part.height)};
}


/** Canvas position of part pixel (x,y) relative to its instance origin, matching the renderer's transforms. */
export function partToCanvasOffset(transform, part, x, y) {
  switch(transform) {
    case 'N': return {x,y};
    case 'FX': return {x:part.width-1-x,y};
    case 'FY': return {x,y:part.height-1-y};
    case 'R90': return {x:part.height-1-y,y:x};
    case 'R180': return {x:part.width-1-x,y:part.height-1-y};
    case 'R270': return {x:y,y:part.width-1-x};
    default: throw new Error('Unknown instance transform.');
  }
}

/** How far an instance must move so its existing pixels stay put after the part gains `left`/`top` padding and a new size. */
export function grownInstanceShift(transform, before, after, left, top) {
  const a=partToCanvasOffset(transform,before,0,0), b=partToCanvasOffset(transform,after,left,top);
  return {x:a.x-b.x,y:a.y-b.y};
}
