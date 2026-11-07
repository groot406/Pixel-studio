/** Retained pixel artwork. Source is authoritative; pixels are derived editing buffers. */
import { MAX_SIZE, MAX_TOTAL_PIXELS } from './limits.js';
import { linePoints, rectanglePoints, ellipsePoints, instancePixel, instanceBox, instanceImage, resamples, smoothSampling, TRANSFORM_NAMES, SAMPLING_MODES, DEFAULT_PERSPECTIVE } from './geometry.js';
import { paletteBlend } from './antialias.js';
import { ROTSPRITE_SCALE } from './rotsprite.js';
import { sameValue } from './history.js';

export const MAX_PARTS = 256;
export const MAX_OPERATIONS = 32768;
export const MAX_RENDER_WORK = 8 * MAX_TOTAL_PIXELS;
export const TRANSFORMS = TRANSFORM_NAMES;
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

const absent = value => value === undefined || value === null;
/** Normalised optional pivot/skew/tilt/deform/sampling of a `use` op; defaults (centre, no skew, no 3D turn, no deform, nearest, 30% perspective) are omitted. */
export function instanceEffects(op) {
  const out = {};
  if (!absent(op.pivot)) {
    if (!object(op.pivot)) throw new Error('Instance pivot needs x and y.');
    out.pivot = { x: integer(op.pivot.x, -128, 256, 'Pivot x'), y: integer(op.pivot.y, -128, 256, 'Pivot y') };
  }
  if (!absent(op.skew)) {
    if (!object(op.skew)) throw new Error('Instance skew needs x and y.');
    const x = integer(op.skew.x, -60, 60, 'Skew x'), y = integer(op.skew.y, -60, 60, 'Skew y');
    if (x || y) out.skew = { x, y };
  }
  if (!absent(op.tilt)) {
    if (!object(op.tilt)) throw new Error('Instance 3D turn needs x and y.');
    const x = integer(op.tilt.x ?? 0, -180, 180, '3D turn x'), y = integer(op.tilt.y ?? 0, -180, 180, '3D turn y');
    const perspective = integer(op.tilt.perspective ?? DEFAULT_PERSPECTIVE, 0, 100, 'Perspective');
    if (x || y) out.tilt = perspective === DEFAULT_PERSPECTIVE ? { x, y } : { x, y, perspective };
  }
  if (!absent(op.deform)) {
    const d = op.deform;
    if (!object(d)) throw new Error('Invalid instance deform.');
    if (d.kind === 'wave') {
      if (!['x', 'y'].includes(d.axis)) throw new Error('Wave axis must be x or y.');
      out.deform = { kind: 'wave', axis: d.axis, amplitude: integer(d.amplitude, 1, 32, 'Wave amplitude'), wavelength: integer(d.wavelength, 2, 256, 'Wave wavelength'),
        phase: (integer(d.phase ?? 0, -360, 720, 'Wave phase') + 360) % 360 };
    } else if (d.kind === 'bulge') {
      const strength = integer(d.strength, -100, 100, 'Bulge strength');
      if (strength) out.deform = { kind: 'bulge', strength };
    } else if (d.kind === 'twist') {
      const angle = integer(d.angle, -360, 360, 'Twist angle');
      if (angle) out.deform = { kind: 'twist', angle };
    } else throw new Error('Deform must be wave, bulge or twist.');
  }
  if (!absent(op.sampling)) {
    if (!SAMPLING_MODES.includes(op.sampling)) throw new Error('Sampling must be nearest, rotsprite or aa.');
    if (op.sampling !== 'nearest') out.sampling = op.sampling;
  }
  return out;
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
      const metadata = {};
      // A resized instance stores both axes; the part's own size is the default and is not stored.
      const width = op.width === undefined ? part.width : integer(op.width, 1, MAX_SIZE, 'Instance width');
      const height = op.height === undefined ? part.height : integer(op.height, 1, MAX_SIZE, 'Instance height');
      if (width !== part.width || height !== part.height) Object.assign(metadata, { width, height });
      // Free rotation in whole degrees, normalised to -179…180; quarter turns belong in the lossless transform instead.
      const angle = op.angle === undefined ? 0 : ((integer(op.angle, -360, 360, 'Instance angle') + 539) % 360) - 179;
      if (angle) metadata.angle = angle;
      Object.assign(metadata, instanceEffects(op));
      const pose = { x: 0, y: 0, transform: op.transform, ...metadata, width, height };
      const box = instanceBox(pose, part);
      // Smooth AA takes 4×4 samples per pixel.
      spend(budget, box.width * box.height * (pose.sampling === 'aa' && resamples(pose, part) ? 16 : 1));
      // The 8× RotSprite image costs 64 work units per part pixel, once per part.
      if (smoothSampling(pose) && !(budget.smoothed ||= new Set()).has(partId)) { budget.smoothed.add(partId); budget.work += part.width * part.height * ROTSPRITE_SCALE ** 2; spend(budget); }
      for (const flag of ['visible','locked']) if (op[flag] !== undefined) {
        if (typeof op[flag] !== 'boolean') throw new Error(`Instance ${flag} must be boolean.`);
        metadata[flag] = op[flag];
      }
      if (op.name !== undefined) {
        if (typeof op.name !== 'string' || !op.name.trim() || op.name.length > 80) throw new Error('Object names need 1–80 characters.');
        metadata.name = op.name.trim();
      }
      if (['name','visible','locked'].some(key => key in metadata)) {
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
      if (resamples(op, part)) {
        // Resampled instances come from their cached image; Smooth AA edge pixels blend with what is beneath in this cel.
        const image = instanceImage(op, part), left = op.x + image.x, top = op.y + image.y;
        for (let y = Math.max(0, top); y < Math.min(height, top + image.height); y++) for (let x = Math.max(0, left); x < Math.min(width, left + image.width); x++) {
          const t = (y - top) * image.width + x - left, edge = image.edge?.get(t), under = pixels[y * width + x];
          let color = image.pixels[t];
          if (edge && under >= 0 && part.palette) { const mix = paletteBlend(part.palette, under, edge.color, edge.coverage); if (mix >= 0) color = mix; }
          if (color >= 0) pixels[y * width + x] = color;
        }
        continue;
      }
      const box = instanceBox(op, part);
      for (let y = Math.max(0, box.y); y < Math.min(height, box.y + box.height); y++) for (let x = Math.max(0, box.x); x < Math.min(width, box.x + box.width); x++) {
        const color = instancePixel(op, part, { x, y });
        if (color >= 0) pixels[y * width + x] = color;
      }
    } else {
      const points = op.type === 'line' ? linePoints(op.x, op.y, op.x2, op.y2)
        : (op.type === 'rect' ? rectanglePoints : ellipsePoints)(op.x, op.y, op.x + op.width - 1, op.y + op.height - 1, true, width, height);
      for (const p of points) pixels[p.y * width + p.x] = op.color;
    }
  }
  return pixels;
}
const partCache = new Map(), PART_CACHE = 512;
/** Rendered pixels of a part definition, shared (frozen) across identical definitions so per-image instance caches survive re-validation. */
export function partPixels(part) {
  const key = `${part.width}x${part.height}:${JSON.stringify(part.ops)}`;
  let pixels = partCache.get(key);
  if (pixels) { partCache.delete(key); partCache.set(key, pixels); return pixels; }
  pixels = Object.freeze(renderOperations(part.ops, part.width, part.height));
  partCache.set(key, pixels);
  if (partCache.size > PART_CACHE) partCache.delete(partCache.keys().next().value);
  return pixels;
}
/** Rendered part images by id; with the project `palette`, Smooth AA instances can blend between palette colours. */
export function renderParts(parts, palette) {
  return new Map(parts.map(part => [part.id, { ...part, pixels: partPixels(part), ...(palette ? { palette } : {}) }]));
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
  if (after.version !== 3 || !sameValue(before.parts, after.parts)) return;
  const frames = new Map(before.animations.flatMap(a => a.frames).map(f => [f.id, f]));
  for (const animation of after.animations) for (const frame of animation.frames) for (const cel of frame.cels) {
    if (!cel.source) continue;
    if (before.width !== after.width || before.height !== after.height) { delete cel.source; continue; }
    const old = frames.get(frame.id)?.cels.find(c => c.layerId === cel.layerId);
    if (!old?.source || !sameValue(old.source, cel.source)) continue;
    if (cel.pixels.some((v, i) => v !== old.pixels[i])) {
      const next = [...cel.pixels];
      cel.pixels = old.pixels;
      writeCelPixels(cel, next, after.width);
    }
  }
}
