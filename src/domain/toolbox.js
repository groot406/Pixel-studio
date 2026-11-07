/** Pure brush, transform, clipboard, and color tools for indexed pixel art. */
import { MAX_SIZE, MAX_COLORS, ellipsePoints } from './project.js';

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIZE || height > MAX_SIZE) {
    throw new Error(`Canvas width and height must be whole numbers from 1 to ${MAX_SIZE}.`);
  }
  return width * height;
}

function coordinate(value, label) {
  if (!Number.isFinite(value) || !Number.isSafeInteger(Math.round(value))) throw new Error(`${label} must be a finite pixel coordinate.`);
  return Math.round(value);
}

function point(value, label) {
  return { x: coordinate(value?.x, `${label} x`), y: coordinate(value?.y, `${label} y`) };
}

function color(value, label) {
  if (!Number.isInteger(value) || value < -1 || value >= MAX_COLORS) {
    throw new Error(`${label} must be a palette index from -1 to ${MAX_COLORS - 1}.`);
  }
}

function readPixels(pixels, width, height) {
  const count = dimensions(width, height);
  if (!Array.isArray(pixels) || pixels.length !== count) throw new Error(`Expected exactly ${count} indexed pixels.`);
  for (let i = 0; i < count; i += 1) color(pixels[i], 'Each pixel');
}

function rectangle(rect, width, height) {
  if (rect == null) return { x: 0, y: 0, width, height };
  if (!['x', 'y', 'width', 'height'].every((key) => Number.isInteger(rect[key])) || rect.width < 1 || rect.height < 1 || rect.x < 0 || rect.y < 0 || rect.x + rect.width > width || rect.y + rect.height > height) {
    throw new Error('The selection must be a nonempty rectangle inside the canvas.');
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** Stamp complete footprints, then reflect their pixels and clip to the canvas. */
export function brushPoints(points, size, shape, width, height, symmetry = 'none') {
  const count = dimensions(width, height);
  if (!Array.isArray(points)) throw new Error('Brush points must be an array of pixel coordinates.');
  if (!Number.isInteger(size) || size < 1 || size > 8) throw new Error('Brush size must be a whole number from 1 to 8.');
  if (shape !== 'square' && shape !== 'round') throw new Error('Brush shape must be square or round.');
  if (!['none', 'x', 'y', 'both'].includes(symmetry)) throw new Error('Brush symmetry must be none, x, y, or both.');
  const footprint = shape === 'round'
    ? ellipsePoints(0, 0, size - 1, size - 1, true, size, size)
    : Array.from({ length: size * size }, (_, index) => ({ x: index % size, y: Math.floor(index / size) }));
  // An even-sized brush extends one extra pixel to the left and top.
  const offset = -Math.floor(size / 2);
  const mirrorX = symmetry === 'x' || symmetry === 'both';
  const mirrorY = symmetry === 'y' || symmetry === 'both';
  const seen = new Uint8Array(count);
  const output = [];
  const add = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (seen[index]) return;
    seen[index] = 1;
    output.push({ x, y });
  };
  for (const value of points) {
    const center = point(value, 'Brush');
    for (const pixel of footprint) {
      const x = center.x + offset + pixel.x;
      const y = center.y + offset + pixel.y;
      add(x, y);
      if (mirrorX) add(width - 1 - x, y);
      if (mirrorY) add(x, height - 1 - y);
      if (mirrorX && mirrorY) add(width - 1 - x, height - 1 - y);
    }
  }
  return output.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Choose the nearest 45-degree direction and project the endpoint onto it. */
export function snapLineEnd(origin, end) {
  const start = point(origin, 'Line origin');
  const finish = point(end, 'Line end');
  const dx = finish.x - start.x;
  const dy = finish.y - start.y;
  if (!Number.isSafeInteger(dx) || !Number.isSafeInteger(dy)) throw new Error('The line coordinates are too far apart.');
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const threshold = Math.SQRT2 - 1; // tan(22.5 degrees), halfway between allowed directions.
  if (ay < ax * threshold) return { x: finish.x, y: start.y };
  if (ax < ay * threshold) return { x: start.x, y: finish.y };
  const distance = Math.round(ax / 2 + ay / 2);
  const result = { x: start.x + Math.sign(dx) * distance, y: start.y + Math.sign(dy) * distance };
  if (!Number.isSafeInteger(result.x) || !Number.isSafeInteger(result.y)) throw new Error('The snapped line exceeds safe pixel coordinates.');
  return result;
}

/** Cut and transform a rectangle, including transparent pixels. A null rect means the canvas. */
export function transformPixels(pixels, width, height, rect, operation) {
  readPixels(pixels, width, height);
  const source = rectangle(rect, width, height);
  if (!['flip-h', 'flip-v', 'rotate-cw', 'rotate-ccw'].includes(operation)) {
    throw new Error('Choose flip-h, flip-v, rotate-cw, or rotate-ccw.');
  }
  const rotating = operation === 'rotate-cw' || operation === 'rotate-ccw';
  const targetWidth = rotating ? source.height : source.width;
  const targetHeight = rotating ? source.width : source.height;
  if (targetWidth > width || targetHeight > height) {
    throw new Error('The rotated selection does not fit inside this canvas. Resize the canvas or select a smaller region.');
  }
  // Truncating the half-size offsets keeps repeated rotations from drifting.
  const selection = {
    x: Math.max(0, Math.min(width - targetWidth, source.x + Math.trunc((source.width - targetWidth) / 2))),
    y: Math.max(0, Math.min(height - targetHeight, source.y + Math.trunc((source.height - targetHeight) / 2))),
    width: targetWidth,
    height: targetHeight,
  };
  const result = pixels.slice();
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) result[(source.y + y) * width + source.x + x] = -1;
  }
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      let tx = x;
      let ty = y;
      if (operation === 'flip-h') tx = source.width - 1 - x;
      else if (operation === 'flip-v') ty = source.height - 1 - y;
      else if (operation === 'rotate-cw') { tx = source.height - 1 - y; ty = x; }
      else { tx = y; ty = source.width - 1 - x; }
      // Read from the original array so overlapping regions never smear.
      result[(selection.y + ty) * width + selection.x + tx] = pixels[(source.y + y) * width + source.x + x];
    }
  }
  return { pixels: result, selection };
}

/** Copy a rectangle to an independent, tightly packed clipboard. */
export function copyPixels(pixels, width, height, rect = null) {
  readPixels(pixels, width, height);
  const source = rectangle(rect, width, height);
  const result = [];
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) result.push(pixels[(source.y + y) * width + source.x + x]);
  }
  return { width: source.width, height: source.height, pixels: result };
}

/** Paste opaque clipboard pixels; transparent pixels leave the destination intact. */
export function pastePixels(pixels, width, height, clipboard, x, y) {
  readPixels(pixels, width, height);
  if (!clipboard || typeof clipboard !== 'object') throw new Error('Copy some pixels before pasting.');
  readPixels(clipboard.pixels, clipboard.width, clipboard.height);
  if (clipboard.width > width || clipboard.height > height) {
    throw new Error('The clipboard is larger than this canvas. Resize the canvas before pasting.');
  }
  const selection = {
    x: Math.max(0, Math.min(width - clipboard.width, coordinate(x, 'Paste x'))),
    y: Math.max(0, Math.min(height - clipboard.height, coordinate(y, 'Paste y'))),
    width: clipboard.width,
    height: clipboard.height,
  };
  const result = pixels.slice();
  for (let cy = 0; cy < clipboard.height; cy += 1) {
    for (let cx = 0; cx < clipboard.width; cx += 1) {
      const value = clipboard.pixels[cy * clipboard.width + cx];
      if (value !== -1) result[(selection.y + cy) * width + selection.x + cx] = value;
    }
  }
  return { pixels: result, selection };
}

/** Replace an exact palette index inside a rectangle, or across the whole canvas. */
export function replaceColor(pixels, width, height, source, target, rect = null) {
  readPixels(pixels, width, height);
  color(source, 'Source color');
  color(target, 'Replacement color');
  const selection = rectangle(rect, width, height);
  const result = pixels.slice();
  for (let y = selection.y; y < selection.y + selection.height; y += 1) {
    for (let x = selection.x; x < selection.x + selection.width; x += 1) {
      const index = y * width + x;
      if (pixels[index] === source) result[index] = target;
    }
  }
  return result;
}

const hexRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * The palette color one shading step darker (direction -1) or lighter (+1): the closest color, by RGB
 * distance, among those noticeably darker or lighter. Returns the same index when no step exists.
 */
export function shadeIndex(palette, index, direction) {
  if (!Array.isArray(palette) || index < 0 || index >= palette.length) return index;
  if (direction !== -1 && direction !== 1) throw new Error('Shade direction must be -1 (darker) or 1 (lighter).');
  const source = hexRgb(palette[index]), light = luminance(source);
  let best = index, bestDistance = Infinity;
  palette.forEach((hex, candidate) => {
    const rgb = hexRgb(hex), step = luminance(rgb) - light;
    if (candidate === index || step * direction < 8) return;
    const distance = rgb.reduce((sum, value, i) => sum + (value - source[i]) ** 2, 0);
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  });
  return best;
}

/** Checkerboard dither mask in canvas coordinates, so neighbouring strokes stay aligned. */
export const ditherCell = (x, y) => ((x + y) & 1) === 0;

/**
 * Pixel-perfect stroke step: append `point` to a 1px path. When the last three pixels form an
 * L-shaped corner, the middle pixel is dropped and returned so the caller can restore it.
 */
export function pixelPerfectStep(path, point) {
  const last = path.at(-1);
  if (last && last.x === point.x && last.y === point.y) return null;
  path.push({ x: point.x, y: point.y });
  if (path.length < 3) return null;
  const [a, b, c] = path.slice(-3);
  const corner = Math.abs(a.x - c.x) === 1 && Math.abs(a.y - c.y) === 1 && (b.x === a.x || b.y === a.y) && (b.x === c.x || b.y === c.y);
  if (!corner) return null;
  path.splice(path.length - 2, 1);
  return b;
}

/**
 * Magic-wand region from (x, y). `shape` selects every connected opaque pixel (8-connected);
 * `color` selects the connected pixels of exactly the clicked color (4-connected).
 * Returns {indices, rect} or null when nothing selectable was clicked.
 */
export function connectedRegion(pixels, width, height, x, y, mode = 'shape') {
  readPixels(pixels, width, height);
  if (!['shape', 'color'].includes(mode)) throw new Error('Wand mode must be shape or color.');
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const start = y * width + x, target = pixels[start];
  if (target < 0) return null;
  const match = mode === 'shape' ? v => v >= 0 : v => v === target;
  const steps = mode === 'shape' ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] : [[0, -1], [-1, 0], [1, 0], [0, 1]];
  const seen = new Uint8Array(width * height), indices = [], stack = [start];
  seen[start] = 1;
  let minX = x, minY = y, maxX = x, maxY = y;
  while (stack.length) {
    const index = stack.pop(), px = index % width, py = (index - px) / width;
    indices.push(index);
    minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    for (const [dx, dy] of steps) {
      const nx = px + dx, ny = py + dy, next = ny * width + nx;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || seen[next] || !match(pixels[next])) continue;
      seen[next] = 1; stack.push(next);
    }
  }
  return { indices: indices.sort((a, b) => a - b), rect: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
}

/** Every separate shape (8-connected opaque island), largest first. */
export function findIslands(pixels, width, height) {
  readPixels(pixels, width, height);
  const taken = new Uint8Array(width * height), islands = [];
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] < 0 || taken[i]) continue;
    const island = connectedRegion(pixels, width, height, i % width, Math.floor(i / width), 'shape');
    for (const index of island.indices) taken[index] = 1;
    islands.push(island);
  }
  return islands.sort((a, b) => b.indices.length - a.indices.length);
}
