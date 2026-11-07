/** Pure, indexed-pixel selection and outline operations. Transparency is -1. */
import { MAX_SIZE } from './limits.js';

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIZE || height > MAX_SIZE) {
    throw new Error(`Canvas width and height must be whole numbers from 1 to ${MAX_SIZE}.`);
  }
  return width * height;
}

function integer(value, label) {
  if (!Number.isFinite(value) || !Number.isSafeInteger(Math.round(value))) throw new Error(`${label} must be a finite pixel coordinate.`);
  return Math.round(value);
}

function rectangle(selection, width, height) {
  dimensions(width, height);
  if (!selection || !['x', 'y', 'width', 'height'].every((key) => Number.isInteger(selection[key])) || selection.width < 1 || selection.height < 1 || selection.x < 0 || selection.y < 0 || selection.x + selection.width > width || selection.y + selection.height > height) {
    throw new Error('The selection must be a nonempty rectangle inside the canvas.');
  }
  return selection;
}

function readPixels(pixels, width, height) {
  const count = dimensions(width, height);
  if (!Array.isArray(pixels) || pixels.length !== count) throw new Error(`Expected exactly ${count} indexed pixels.`);
  for (let i = 0; i < count; i += 1) {
    if (!Number.isInteger(pixels[i]) || pixels[i] < -1 || pixels[i] > 63) throw new Error('Pixels must be palette indices from -1 to 63.');
  }
}

/** Inclusive endpoint rectangle, with both endpoints clamped to the canvas. */
export function selectionBounds(x0, y0, x1, y1, width, height) {
  dimensions(width, height);
  x0 = Math.max(0, Math.min(width - 1, integer(x0, 'Selection x')));
  x1 = Math.max(0, Math.min(width - 1, integer(x1, 'Selection x')));
  y0 = Math.max(0, Math.min(height - 1, integer(y0, 'Selection y')));
  y1 = Math.max(0, Math.min(height - 1, integer(y1, 'Selection y')));
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0) + 1, height: Math.abs(y1 - y0) + 1 };
}

/** Keep the complete selection inside the canvas, even for a very large move. */
export function clampSelectionOffset(selection, dx, dy, canvasW, canvasH) {
  rectangle(selection, canvasW, canvasH);
  dx = integer(dx, 'Horizontal movement');
  dy = integer(dy, 'Vertical movement');
  return {
    dx: Math.max(-selection.x, Math.min(canvasW - selection.x - selection.width, dx)),
    dy: Math.max(-selection.y, Math.min(canvasH - selection.y - selection.height, dy)),
  };
}

/** Cut and move every selected pixel, including transparency, without mutating the source. */
export function moveSelectedPixels(pixels, canvasW, canvasH, selection, dx, dy) {
  readPixels(pixels, canvasW, canvasH);
  ({ dx, dy } = clampSelectionOffset(selection, dx, dy, canvasW, canvasH));
  const result = pixels.slice();
  for (let y = selection.y; y < selection.y + selection.height; y += 1) {
    for (let x = selection.x; x < selection.x + selection.width; x += 1) result[y * canvasW + x] = -1;
  }
  // Read from the untouched source so overlapping moves never smear pixels.
  for (let y = selection.y; y < selection.y + selection.height; y += 1) {
    for (let x = selection.x; x < selection.x + selection.width; x += 1) result[(y + dy) * canvasW + x + dx] = pixels[y * canvasW + x];
  }
  return { pixels: result, selection: { x: selection.x + dx, y: selection.y + dy, width: selection.width, height: selection.height }, dx, dy };
}

/** A separate transparent cel containing only pixels outside the original opaque artwork. */
export function outlinePixels(pixels, width, height, color, thickness = 1, diagonal = false) {
  readPixels(pixels, width, height);
  if (!Number.isInteger(color) || color < 0 || color > 63) throw new Error('Outline color must be a palette index from 0 to 63.');
  if (!Number.isInteger(thickness) || thickness < 1 || thickness > 3) throw new Error('Outline thickness must be 1, 2, or 3 pixels.');
  const result = Array(pixels.length).fill(-1);
  const visited = new Uint8Array(pixels.length);
  let frontier = [];
  for (let index = 0; index < pixels.length; index += 1) {
    if (pixels[index] !== -1) { visited[index] = 1; frontier.push(index); }
  }
  const directions = diagonal
    ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
    : [[0, -1], [-1, 0], [1, 0], [0, 1]];
  for (let distance = 0; distance < thickness && frontier.length; distance += 1) {
    const next = [];
    for (const index of frontier) {
      const x = index % width;
      const y = Math.floor(index / width);
      for (const [dx, dy] of directions) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const target = ny * width + nx;
        if (visited[target]) continue;
        visited[target] = 1;
        result[target] = color;
        next.push(target);
      }
    }
    frontier = next;
  }
  return result;
}

/** Bounding rectangle of canvas pixel indices (a wand mask). */
export function maskBounds(mask, canvasW) {
  if (!mask?.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (const index of mask) {
    const x = index % canvasW, y = (index - x) / canvasW;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Move only the masked pixels; the gap they leave becomes transparent. */
export function moveMaskedPixels(pixels, canvasW, canvasH, mask, dx, dy) {
  readPixels(pixels, canvasW, canvasH);
  ({ dx, dy } = clampSelectionOffset(maskBounds(mask, canvasW), dx, dy, canvasW, canvasH));
  const result = pixels.slice(), moved = mask.map(index => index + dy * canvasW + dx);
  for (const index of mask) result[index] = -1;
  mask.forEach((index, i) => { result[moved[i]] = pixels[index]; });
  return { pixels: result, mask: moved, selection: maskBounds(moved, canvasW), dx, dy };
}
