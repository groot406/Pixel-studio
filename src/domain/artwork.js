/** Retained pixel artwork. Source is authoritative; pixels are derived editing buffers. */
import { MAX_SIZE, MAX_TOTAL_PIXELS } from './limits.js';
import { linePoints, rectanglePoints, ellipsePoints } from './geometry.js';

export const MAX_PARTS = 256;
export const MAX_OPERATIONS = 32768;
export const MAX_RENDER_WORK = 8 * MAX_TOTAL_PIXELS;
export const TRANSFORMS = ['N', 'FX', 'FY', 'R90', 'R180', 'R270'];
export const cloneArtwork = value => JSON.parse(JSON.stringify(value));
export const hasLockedInstances = cel => Boolean(cel?.source?.ops.some(op => op.type === 'use' && op.locked));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function artworkId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('IDs need 1–100 letters, digits, underscores or hyphens.');
  return value;
}
export function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}
export function artworkBudget() { return { operations: 0, work: 0, partPixels: 0 }; }
function spend(budget, work = 0) {
  budget.operations++;
  budget.work += work;
  if (budget.operations > MAX_OPERATIONS || budget.work > MAX_RENDER_WORK) throw new Error('Artwork exceeds the operation or expanded rendering budget.');
}

/** Validate before rendering; parts cannot contain instances, so references never recurse. */
export function validateOperations(ops, width, height, paletteLength, parts, budget, allowInstances = true) {
  if (!Array.isArray(ops) || ops.length > MAX_OPERATIONS) throw new Error('Invalid artwork operations.');
  const ids = new Set();
  return ops.map(op => {
    if (!object(op)) throw new Error('Invalid artwork operation.');
    if (op.type === 'use') {
      if (!allowInstances) throw new Error('Parts contain drawing operations only, not other parts.');
      const id = artworkId(op.id), partId = artworkId(op.partId);
      const part = parts.find(p => p.id === partId);
      if (!part) throw new Error(`Unknown part ${partId}.`);
      if (ids.has(id)) throw new Error(`Duplicate instance ${id}.`);
      ids.add(id);
      if (!TRANSFORMS.includes(op.transform)) throw new Error('Unknown instance transform.');
      spend(budget, part.width * part.height);
      const metadata = {};
      for (const flag of ['visible','locked']) if (op[flag] !== undefined) {
        if (typeof op[flag] !== 'boolean') throw new Error(`Instance ${flag} must be boolean.`);
        metadata[flag] = op[flag];
      }
      if (op.name !== undefined) {
        if (typeof op.name !== 'string' || !op.name.trim() || op.name.length > 80) throw new Error('Object names need 1–80 characters.');
        metadata.name = op.name.trim();
      }
      if (Object.keys(metadata).length) {
        metadata.name ||= partId.slice(0,80);
        metadata.visible = op.visible !== false;
        metadata.locked = Boolean(op.locked);
      }
      return { type: 'use', id, partId, x: integer(op.x, -MAX_SIZE, MAX_SIZE, 'x'), y: integer(op.y, -MAX_SIZE, MAX_SIZE, 'y'), transform: op.transform, ...metadata };
    }
    const x = integer(op.x, 0, width - 1, 'x'), y = integer(op.y, 0, height - 1, 'y');
    if (op.type === 'span') {
      if (!Array.isArray(op.values) || !op.values.length || op.values.length > width - x) throw new Error('SPAN exceeds its row.');
      spend(budget, op.values.length);
      return { type: 'span', x, y, values: op.values.map(c => integer(c, -1, paletteLength - 1, 'Pixel color')) };
    }
    const color = integer(op.color, -1, paletteLength - 1, 'Color');
    if (op.type === 'line') {
      const x2 = integer(op.x2, 0, width - 1, 'End x'), y2 = integer(op.y2, 0, height - 1, 'End y');
      spend(budget, Math.max(Math.abs(x - x2), Math.abs(y - y2)) + 1);
      return { type: op.type, x, y, x2, y2, color };
    }
    if (!['rect', 'ellipse'].includes(op.type)) throw new Error(`Unknown artwork operation ${op.type}.`);
    const w = integer(op.width, 1, width - x, 'Shape width'), h = integer(op.height, 1, height - y, 'Shape height');
    spend(budget, w * h);
    return { type: op.type, x, y, width: w, height: h, color };
  });
}

export function validateParts(input, paletteLength, budget) {
  if (!Array.isArray(input) || input.length > MAX_PARTS) throw new Error(`A project allows at most ${MAX_PARTS} parts.`);
  const ids = new Set();
  return input.map(part => {
    if (!object(part)) throw new Error('Invalid part.');
    const id = artworkId(part.id);
    if (ids.has(id)) throw new Error(`Duplicate part ${id}.`);
    ids.add(id);
    const width = integer(part.width, 1, MAX_SIZE, 'Part width'), height = integer(part.height, 1, MAX_SIZE, 'Part height');
    budget.partPixels += width * height;
    if (budget.partPixels > MAX_TOTAL_PIXELS) throw new Error('Parts exceed the stored-pixel budget.');
    return { id, width, height, ops: validateOperations(part.ops, width, height, paletteLength, [], budget, false) };
  });
}

export function validateSource(source, width, height, paletteLength, parts, budget) {
  if (!object(source)) throw new Error('Invalid cel source.');
  const ops = validateOperations(source.ops, width, height, paletteLength, parts, budget);
  const overrides = validateOperations(source.overrides, width, height, paletteLength, [], budget, false);
  if (overrides.some(op => op.type !== 'span')) throw new Error('Pixel overrides must be spans.');
  return { ops, overrides };
}

export function renderOperations(ops, width, height, partImages = new Map()) {
  const pixels = Array(width * height).fill(-1);
  for (const op of ops) {
    if (op.type === 'span') {
      op.values.forEach((color, i) => { pixels[op.y * width + op.x + i] = color; });
    } else if (op.type === 'use') {
      if (op.visible === false) continue;
      const part = partImages.get(op.partId);
      if (!part) throw new Error(`Unknown part ${op.partId}.`);
      for (let y = 0; y < part.height; y++) for (let x = 0; x < part.width; x++) {
        const color = part.pixels[y * part.width + x];
        if (color < 0) continue;
        let tx = x, ty = y;
        if (op.transform === 'FX') tx = part.width - 1 - x;
        if (op.transform === 'FY') ty = part.height - 1 - y;
        if (op.transform === 'R90') { tx = part.height - 1 - y; ty = x; }
        if (op.transform === 'R180') { tx = part.width - 1 - x; ty = part.height - 1 - y; }
        if (op.transform === 'R270') { tx = y; ty = part.width - 1 - x; }
        tx += op.x; ty += op.y;
        if (tx >= 0 && ty >= 0 && tx < width && ty < height) pixels[ty * width + tx] = color;
      }
    } else {
      const points = op.type === 'line' ? linePoints(op.x, op.y, op.x2, op.y2)
        : (op.type === 'rect' ? rectanglePoints : ellipsePoints)(op.x, op.y, op.x + op.width - 1, op.y + op.height - 1, true, width, height);
      for (const p of points) pixels[p.y * width + p.x] = op.color;
    }
  }
  return pixels;
}
export function renderParts(parts) {
  return new Map(parts.map(part => [part.id, { ...part, pixels: renderOperations(part.ops, part.width, part.height) }]));
}
export function renderSource(source, width, height, partImages) {
  const pixels = renderOperations(source.ops, width, height, partImages);
  for (const op of source.overrides) op.values.forEach((c, i) => { pixels[op.y * width + op.x + i] = c; });
  return pixels;
}

/** Contiguous runs of selected pixels. An explicit -1 erases; unselected pixels are absent. */
export function pixelSpans(pixels, width, selected = (_, color) => color >= 0) {
  const spans = [];
  for (let y = 0; y < pixels.length / width; y++) {
    let x = 0;
    while (x < width) {
      if (!selected(y * width + x, pixels[y * width + x])) { x++; continue; }
      const start = x, values = [];
      while (x < width && selected(y * width + x, pixels[y * width + x])) values.push(pixels[y * width + x++]);
      spans.push({ type: 'span', x: start, y, values });
    }
  }
  return spans;
}
export function sourceForCel(cel, width) {
  return cel.source ? cloneArtwork(cel.source) : { ops: pixelSpans(cel.pixels, width), overrides: [] };
}

export function translatePixels(pixels, width, height, dx, dy) {
  const shifted = Array(width * height).fill(-1);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = x - dx, sy = y - dy;
    if (sx >= 0 && sy >= 0 && sx < width && sy < height) shifted[y * width + x] = pixels[sy * width + sx];
  }
  return shifted;
}

/** Commit an editing buffer to a retained cel without mutating its shared parts. */
export function writeCelPixels(cel, pixels, width) {
  if (cel.source) {
    const overrides = new Map();
    for (const op of cel.source.overrides) op.values.forEach((v, i) => overrides.set(op.y * width + op.x + i, v));
    pixels.forEach((v, i) => { if (v !== cel.pixels[i]) overrides.set(i, v); });
    cel.source = { ops: cloneArtwork(cel.source.ops), overrides: pixelSpans(pixels.map((v, i) => overrides.has(i) ? overrides.get(i) : v), width, i => overrides.has(i)) };
  }
  cel.pixels = [...pixels];
}

/** Editor transaction boundary: legacy tools use draft buffers; only differences become overrides. */
export function commitRasterEdits(before, after) {
  if (after.version !== 3 || JSON.stringify(before.parts) !== JSON.stringify(after.parts)) return;
  const frames = new Map(before.animations.flatMap(a => a.frames).map(f => [f.id, f]));
  for (const animation of after.animations) for (const frame of animation.frames) for (const cel of frame.cels) {
    if (!cel.source) continue;
    if (before.width !== after.width || before.height !== after.height) { delete cel.source; continue; }
    const old = frames.get(frame.id)?.cels.find(c => c.layerId === cel.layerId);
    if (!old?.source || JSON.stringify(old.source) !== JSON.stringify(cel.source)) continue;
    if (cel.pixels.some((v, i) => v !== old.pixels[i])) {
      const next = [...cel.pixels];
      cel.pixels = old.pixels;
      writeCelPixels(cel, next, after.width);
    }
  }
}
