/**
 * Live outline: a project setting (project.outline) applied when frames are composited, so the outline is never baked
 * into the artwork and always follows moved, rotated or redrawn parts. Plus stripOutlines, which removes baked-in
 * outline pixels (outline-coloured pixels on the edge of each layer's drawing and each part) so the live outline can
 * take over.
 *
 * project.outline = { color, style: 'single'|'selective', mode: 'outside'|'inside', corners, thickness 1–3,
 *   separate, skip: [layerIds] }. color is a palette index (single) or -1 (selective: the darkest colour of the fill's
 * ramp). separate outlines each layer on its own (lines between overlapping layers); otherwise the combined drawing of
 * every layer not in skip is outlined once.
 */
import { autoOutline } from './shading.js';
import { renderOperations, renderParts, pixelSpans, writeCelPixels, cloneArtwork } from './artwork.js';

const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Normalise an outline setting; undefined/null/false means off. layerIds maps stored layer IDs to project IDs. */
export function readOutline(value, paletteLength, layerIds) {
  if (value === undefined || value === null || value === false) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('The outline setting must be an object.');
  const style = value.style ?? (Number.isInteger(value.color) && value.color >= 0 ? 'single' : 'selective');
  if (!['single', 'selective'].includes(style)) throw new Error('Outline style must be single or selective.');
  const mode = value.mode ?? 'outside';
  if (!['outside', 'inside'].includes(mode)) throw new Error('Outline mode must be outside or inside.');
  let color = -1;
  if (style === 'single') {
    color = value.color;
    if (!Number.isInteger(color) || color < 0 || color >= paletteLength) throw new Error('The outline colour must be a palette colour.');
  }
  const thickness = value.thickness ?? 1;
  if (!Number.isInteger(thickness) || thickness < 1 || thickness > 3) throw new Error('Outline thickness must be 1, 2 or 3 pixels.');
  if (value.skip !== undefined && !Array.isArray(value.skip)) throw new Error('Outline skip must be a list of layer IDs.');
  const skip = [...new Set((value.skip || []).map(id => layerIds?.get(id) ?? id).filter(id => !layerIds || [...layerIds.values()].includes(id)))];
  return { color, style, mode, corners: Boolean(value.corners), thickness: mode === 'inside' ? 1 : thickness, separate: Boolean(value.separate), ...(skip.length ? { skip } : {}) };
}

/** Outline `pixels` (art only, -1 transparent) with setting `o`: returns the art with its outline. */
export function outlineArt(pixels, width, height, palette, o) {
  let out = pixels;
  for (let pass = 0; pass < o.thickness; pass++) out = autoOutline(out, width, height, palette, { mode: o.mode, corners: o.corners, style: o.style, ...(o.style === 'single' ? { color: o.color } : {}) });
  return out;
}

/**
 * Composite visible `layers` (bottom to top, each {id, pixels}) with the live outline. Separate: each outlined layer
 * gets its own outline beneath it. Combined: the union of outlined layers is outlined and changed pixels are laid on top.
 */
export function compositeWithOutline(layers, width, height, palette, o) {
  const count = width * height, pixels = Array(count).fill(-1), skip = new Set(o.skip || []);
  if (o.separate) {
    for (const { id, pixels: cel } of layers) {
      const art = skip.has(id) ? cel : outlineArt(cel, width, height, palette, o);
      for (let i = 0; i < count; i++) if (art[i] !== -1) pixels[i] = art[i];
    }
    return pixels;
  }
  const art = Array(count).fill(-1);
  for (const { id, pixels: cel } of layers) for (let i = 0; i < count; i++) if (cel[i] !== -1) { pixels[i] = cel[i]; if (!skip.has(id)) art[i] = cel[i]; }
  const lined = outlineArt(art, width, height, palette, o);
  for (let i = 0; i < count; i++) if (lined[i] !== art[i]) pixels[i] = lined[i];
  return pixels;
}

/** Edge pixels (a transparent or off-canvas 4-neighbour) whose colour is in `colors`, removed `passes` times. */
export function stripEdges(pixels, width, height, colors, { passes = 1, candidate = () => true } = {}) {
  let out = pixels.slice(), removed = 0;
  for (let pass = 0; pass < passes; pass++) {
    const next = out.slice();
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (out[i] < 0 || !colors.has(out[i]) || !candidate(i)) continue;
      if (ORTHO.some(([dx, dy]) => { const nx = x + dx, ny = y + dy; return nx < 0 || ny < 0 || nx >= width || ny >= height || out[ny * width + nx] < 0; })) { next[i] = -1; removed++; }
    }
    out = next;
  }
  return { pixels: out, removed };
}

const usesOf = cel => (cel.source?.ops || []).filter(op => op.type === 'use');
const targetLayers = (project, layerIds) => project.layers.filter(l => !l.locked && (layerIds ? layerIds.includes(l.id) : l.visible));

/**
 * Which colours sit on the edges of the drawings (layer cels and parts): [{color, count, share}], most common first.
 * The darkest frequent edge colour is usually the baked-in outline.
 */
export function edgeColours(project, { layerIds } = {}) {
  const counts = new Map(), W = project.width, H = project.height, ids = new Set(targetLayers(project, layerIds).map(l => l.id));
  const tally = (pixels, w, h) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = pixels[y * w + x];
      if (c >= 0 && ORTHO.some(([dx, dy]) => { const nx = x + dx, ny = y + dy; return nx < 0 || ny < 0 || nx >= w || ny >= h || pixels[ny * w + nx] < 0; })) counts.set(c, (counts.get(c) || 0) + 1);
    }
  };
  const partIds = new Set(), images = renderParts(project.parts || []);
  for (const a of project.animations) for (const f of a.frames) for (const cel of f.cels) if (ids.has(cel.layerId)) {
    usesOf(cel).forEach(op => partIds.add(op.partId));
    tally(cel.source ? drawnPixels(cel, W, H, images) : cel.pixels, W, H);
  }
  for (const id of partIds) { const part = images.get(id); if (part) tally(part.pixels, part.width, part.height); }
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  return [...counts].map(([color, count]) => ({ color, count, share: count / total })).sort((a, b) => b.count - a.count || a.color - b.color);
}

/** Suggested outline colours: the most common edge colour plus any other dark colour that is common on edges. */
export function suggestOutlineColours(project, options) {
  const list = edgeColours(project, options);
  if (!list.length) return [];
  const lum = i => { const h = project.palette[i]; const [r, g, b] = [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16)); return 0.299 * r + 0.587 * g + 0.114 * b; };
  const top = list[0];
  return [top.color, ...list.slice(1).filter(e => e.share >= 0.15 && lum(e.color) <= lum(top.color) + 24).map(e => e.color)];
}

// A sourced cel's own drawing (not its placed parts, which are counted on their own).
function drawnPixels(cel, width, height, images) {
  const fromParts = renderOperations(usesOf(cel), width, height, images);
  return cel.pixels.map((c, i) => (fromParts[i] < 0 || fromParts[i] !== c ? c : -1));
}

/**
 * Remove baked-in outlines: on every frame of the chosen layers (default: visible, unlocked), outline-coloured pixels
 * on the edge of the layer's drawing; and the same on every part placed on those layers (its own edge, so the part
 * stays clean when rotated). Returns { project, removed, parts } and leaves `project` untouched.
 */
export function stripOutlines(project, { colors, layerIds, passes = 1, parts = true } = {}) {
  const set = new Set(colors?.length ? colors : suggestOutlineColours(project, { layerIds }));
  if (!set.size) return { project, removed: 0, parts: 0 };
  if (![...set].every(c => Number.isInteger(c) && c >= 0 && c < project.palette.length)) throw new Error('Outline colours must be palette colours.');
  if (!Number.isInteger(passes) || passes < 1 || passes > 3) throw new Error('Passes must be 1, 2 or 3.');
  const p = cloneArtwork(project), W = p.width, H = p.height, ids = new Set(targetLayers(p, layerIds).map(l => l.id));
  if (!ids.size) throw new Error('Choose a visible, unlocked layer.');
  let removed = 0, partCount = 0;
  if (parts && p.parts?.length) {
    const used = new Set();
    for (const a of p.animations) for (const f of a.frames) for (const cel of f.cels) if (ids.has(cel.layerId)) usesOf(cel).forEach(op => used.add(op.partId));
    const images = renderParts(p.parts);
    for (const part of p.parts) if (used.has(part.id)) {
      const r = stripEdges(images.get(part.id).pixels, part.width, part.height, set, { passes });
      if (!r.removed || r.pixels.every(c => c < 0)) continue;
      part.ops = pixelSpans(r.pixels, part.width); removed += r.removed; partCount++;
    }
  }
  const partImages = renderParts(p.parts || []);
  for (const a of p.animations) for (const f of a.frames) for (const cel of f.cels) {
    if (!ids.has(cel.layerId)) continue;
    if (cel.source) {
      cel.pixels = renderOperations(cel.source.ops, W, H, partImages);
      for (const op of cel.source.overrides) op.values.forEach((c, i) => { cel.pixels[op.y * W + op.x + i] = c; });
      const fromParts = renderOperations(usesOf(cel), W, H, partImages), before = cel.pixels.slice();
      const r = stripEdges(cel.pixels, W, H, set, { passes, candidate: i => fromParts[i] < 0 || fromParts[i] !== before[i] });
      if (r.removed) { cel.pixels = before; writeCelPixels(cel, r.pixels, W); removed += r.removed; }
    } else {
      const r = stripEdges(cel.pixels, W, H, set, { passes });
      if (r.removed) { cel.pixels = r.pixels; removed += r.removed; }
    }
  }
  return { project: p, removed, parts: partCount };
}
