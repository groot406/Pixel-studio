/** Turn existing pixel artwork into reusable part instances. */
import { validateProject, insertProjectLayer, removeProjectLayer, uid, MAX_LAYERS, MAX_TOTAL_PIXELS } from './project.js';
import { sourceForCel, pixelSpans, renderOperations, hasLockedInstances } from './artwork.js';
import { celObjects } from './objects.js';
import { findIslands } from './toolbox.js';

/** A part ID derived from a display name, e.g. "Left eye" → "left-eye". */
export function partIdFromName(name) {
  const id = String(name || '').toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return id || 'object';
}
function uniquePartId(p, base) {
  if (!p.parts.some(part => part.id === base)) return base;
  let n = 2;
  while (p.parts.some(part => part.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}
function uniqueLayerName(p, base) {
  const names = new Set(p.layers.map(layer => layer.name.toLowerCase()));
  let name = String(base).slice(0, 80), n = 2;
  while (names.has(name.toLowerCase())) { const suffix = ` ${n++}`; name = String(base).slice(0, 80 - suffix.length) + suffix; }
  return name;
}
function addLayer(p, afterId, name, group) {
  const frames = p.animations.reduce((n, a) => n + a.frames.length, 0);
  if (p.layers.length >= MAX_LAYERS || frames * (p.layers.length + 1) * p.width * p.height > MAX_TOTAL_PIXELS) throw new Error('The project has reached its object storage limit.');
  const layer = { id: uid(), name: uniqueLayerName(p, name), group, visible: true, locked: false };
  insertProjectLayer(p, layer, afterId);
  return layer;
}
const emptyCel = cel => !cel.source?.ops.length && !cel.source?.overrides.length && cel.pixels.every(v => v < 0);

/** Remove `indices` from a cel's visible artwork while keeping its retained structure. */
function erase(cel, indices, width) {
  const gone = new Set(indices);
  if (!cel.source) {
    cel.pixels = cel.pixels.map((v, i) => gone.has(i) ? -1 : v);
    return;
  }
  const source = sourceForCel(cel, width), mask = Array(cel.pixels.length).fill(0);
  for (const i of gone) mask[i] = 1;
  source.ops.push(...pixelSpans(mask.map(v => v ? -1 : 0), width, i => mask[i] === 1));
  const overrides = new Map();
  for (const op of source.overrides) op.values.forEach((v, i) => { const index = op.y * width + op.x + i; if (!gone.has(index)) overrides.set(index, v); });
  source.overrides = pixelSpans(cel.pixels.map((v, i) => overrides.get(i) ?? v), width, i => overrides.has(i));
  cel.source = source;
  cel.pixels = cel.pixels.map((v, i) => gone.has(i) ? -1 : v);
}

/**
 * Make a part instance from the pixels inside `rect` (or the exact canvas `mask` indices) of the target object.
 * The part is trimmed to the artwork. With scope 'animation' every frame is converted; frames with identical
 * artwork share one part so editing it updates them all, other frames get their own variant.
 * Placement: grouped sources keep the new object in their group; otherwise it gets its own object above the
 * source (or `destinationId` when given). An ungrouped source left empty everywhere is removed.
 */
export function createObjectFromPixels(project, target, { rect, mask, name = 'Object', scope = 'frame', destinationId } = {}) {
  if (!['frame', 'animation'].includes(scope)) throw new Error('Choose this frame or every frame.');
  const p = validateProject(project);
  const animation = p.animations.find(a => a.id === target.animationId), frame = animation?.frames.find(f => f.id === target.frameId);
  const layer = p.layers.find(l => l.id === target.layerId);
  if (!layer || !frame) throw new Error('This object no longer exists.');
  if (layer.locked || !layer.visible) throw new Error('Show and unlock this object before turning its pixels into an object.');
  const area = mask ? [...new Set(mask)] : [];
  if (!mask) {
    const { x, y, width, height } = rect || { x: 0, y: 0, width: p.width, height: p.height };
    if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > p.width || y + height > p.height) throw new Error('Select an area inside the canvas.');
    for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) area.push(yy * p.width + xx);
  }
  if (!area.length || area.some(i => !Number.isInteger(i) || i < 0 || i >= p.width * p.height)) throw new Error('Select an area inside the canvas.');
  const frames = scope === 'animation' ? animation.frames : [frame];
  const label = String(name).trim().slice(0, 80) || 'Object';
  p.version = 3; p.parts ||= [];
  const baseId = partIdFromName(label), variants = new Map(), placements = [];
  for (const f of frames) {
    const cel = f.cels.find(c => c.layerId === layer.id);
    if (hasLockedInstances(cel)) throw new Error('Unlock objects in this group before turning its pixels into an object.');
    const chosen = area.filter(i => cel.pixels[i] >= 0);
    if (!chosen.length) { if (f === frame) throw new Error('Select some artwork first. The selection is empty.'); continue; }
    const xs = chosen.map(i => i % p.width), ys = chosen.map(i => Math.floor(i / p.width));
    const x = Math.min(...xs), y = Math.min(...ys), width = Math.max(...xs) - x + 1, height = Math.max(...ys) - y + 1;
    const pixels = Array(width * height).fill(-1);
    for (const i of chosen) pixels[(Math.floor(i / p.width) - y) * width + (i % p.width) - x] = cel.pixels[i];
    const signature = `${width}x${height}:${pixels.join(',')}`;
    if (!variants.has(signature)) {
      const id = uniquePartId(p, baseId);
      p.parts.push({ id, width, height, ops: pixelSpans(pixels, width) });
      variants.set(signature, id);
    }
    placements.push({ f, cel, chosen, partId: variants.get(signature), x, y });
  }
  for (const { cel, chosen } of placements) erase(cel, chosen, p.width);
  let destination = destinationId ? p.layers.find(l => l.id === destinationId) : layer.group !== false ? layer : null;
  if (destinationId && (!destination || destination.locked)) throw new Error('Choose an unlocked group.');
  destination ||= addLayer(p, layer.id, label, false);
  const destCel = f => f.cels.find(c => c.layerId === destination.id);
  let id = baseId, n = 2;
  while (placements.some(({ f }) => destCel(f).source?.ops.some(op => op.type === 'use' && op.id === id))) id = `${baseId}-${n++}`;
  for (const { f, partId, x, y } of placements) {
    const cel = destCel(f);
    cel.source = sourceForCel(cel, p.width);
    cel.source.ops.push({ type: 'use', id, partId, x, y, transform: 'N', name: label });
  }
  if (layer.group === false && layer.id !== destination.id && p.layers.length > 1 && p.animations.every(a => a.frames.every(f => emptyCel(f.cels.find(c => c.layerId === layer.id))))) removeProjectLayer(p, layer.id);
  return { project: validateProject(p), layerId: destination.id, key: id, parts: variants.size, frames: placements.length };
}

/** Separate visible shapes (8-connected islands) of a pixel object in this frame, largest first. */
export function pixelIslands(project, target, key, minPixels = 1) {
  const p = validateProject(project);
  const frame = p.animations.find(a => a.id === target.animationId)?.frames.find(f => f.id === target.frameId);
  const cel = frame?.cels.find(c => c.layerId === target.layerId);
  const node = cel && celObjects(cel).find(n => n.key === key);
  if (!node || node.type !== 'pixels') throw new Error('Choose pixel artwork to split.');
  const pixels = cel.source ? renderOperations(cel.source.ops.slice(node.start, node.end), p.width, p.height) : cel.pixels;
  return findIslands(pixels.map((v, i) => v >= 0 && cel.pixels[i] === v ? v : -1), p.width, p.height).filter(island => island.indices.length >= minPixels);
}

/**
 * Split a pixel object into one object per separate shape, named `name 1..n`. Ungrouped artwork gets a new
 * group (`groupName`) holding the shapes; grouped artwork keeps its shapes in the same group. Smaller islands stay pixels.
 */
export function splitIntoObjects(project, target, key, { minPixels = 1, name = 'Shape', groupName = name } = {}) {
  const islands = pixelIslands(project, target, key, minPixels);
  if (!islands.length) throw new Error('There are no shapes to split here.');
  let p = validateProject(project);
  const layer = p.layers.find(l => l.id === target.layerId);
  let destinationId = layer.group !== false ? layer.id : null;
  if (!destinationId) {
    destinationId = addLayer(p, layer.id, groupName, true).id;
    p = validateProject(p);
  }
  const keys = [];
  islands.forEach((island, index) => {
    const result = createObjectFromPixels(p, target, { mask: island.indices, name: `${name} ${index + 1}`, destinationId });
    p = result.project; keys.push(result.key);
  });
  return { project: p, layerId: destinationId, keys };
}
