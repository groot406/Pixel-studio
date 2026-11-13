/** Copy objects between frames, animations and projects. Clipboards are plain JSON and carry their own palette and part definitions. */
import { validateProject, insertProjectLayer, uid, nearestColor, MAX_COLORS, MAX_LAYERS } from './project.js';
import { assertCanAddLayer } from './project-capacity.js';
import { cloneArtwork, sourceForCel, renderOperations, renderParts } from './artwork.js';
import { celObjects, objectBounds, orderObjects } from './objects.js';
import { nextPartId } from './parts.js';
import { instancePose } from './geometry.js';
import { assertEditScope, scopeFrames } from './frame-scope.js';

export const OBJECT_CLIPBOARD_FORMAT = 'pixel-studio-object';

/** Map source palette indices onto a target palette, adding exact colors while there is room, otherwise using the nearest color. */
export function mapPaletteColors(palette, sourcePalette, indices) {
  const next = [...palette], mapping = new Map();
  const same = next.length === sourcePalette.length && next.every((color, i) => color.toLowerCase() === sourcePalette[i].toLowerCase());
  for (const index of new Set(indices)) {
    if (index < 0) continue;
    if (same) { mapping.set(index, index); continue; }
    const color = sourcePalette[index];
    if (typeof color !== 'string') throw new Error('The copied object uses an unknown color.');
    let found = next.findIndex(existing => existing.toLowerCase() === color.toLowerCase());
    if (found < 0 && next.length < MAX_COLORS) { next.push(color); found = next.length - 1; }
    if (found < 0) found = nearestColor(...color.slice(1).match(/.{2}/g).map(c => parseInt(c, 16)), next);
    mapping.set(index, found);
  }
  return { palette: next, mapping };
}

function locate(project, target) {
  const animation = project.animations.find(a => a.id === target.animationId);
  const frame = animation?.frames.find(f => f.id === target.frameId);
  const layer = project.layers.find(l => l.id === target.layerId);
  const cel = frame?.cels.find(c => c.layerId === target.layerId);
  if (!animation || !frame || !layer || !cel) throw new Error('This object no longer exists.');
  return { animation, frame, layer, cel };
}

/** Instances a clipboard item carries, as {layerId, instanceId} of the copied project. */
function clipInstances(clip) {
  if (clip.kind === 'instance') return [{ layerId: clip.layerId, instanceId: clip.instance.id }];
  const ids = new Set();
  for (const data of [clip, ...Object.values(clip.frames || {})]) for (const op of data.source?.ops || []) if (op.type === 'use') ids.add(op.id);
  return [...ids].map(instanceId => ({ layerId: clip.layerId, instanceId }));
}
/** The clipboard with the skeleton bones of the instances it carries (parents outside the copy are dropped later). */
function withBones(project, clip) {
  const items = clip.kind === 'multi' ? clip.items : [clip], keys = new Set(items.flatMap(clipInstances).map(i => `${i.layerId}/${i.instanceId}`));
  const bones = (project.bones || []).filter(b => keys.has(`${b.layerId}/${b.instanceId}`));
  return bones.length ? { ...clip, bones: cloneArtwork(bones) } : clip;
}

/** Capture what the object looks like in one frame. Instances keep their shared definition; groups keep their retained source; rigged instances bring their bones. */
export function copyObject(project, target, key) {
  return withBones(project, copyOne(project, target, key));
}
function copyOne(project, target, key) {
  const { animation, layer, cel } = locate(project, target);
  const nodes = celObjects(cel), base = { format: OBJECT_CLIPBOARD_FORMAT, version: 1, palette: [...project.palette], width: project.width, height: project.height, animationId: animation.id, layerId: layer.id };
  const celIn = frame => frame.cels.find(c => c.layerId === layer.id);
  const usedParts = ops => {
    const ids = new Set(ops.filter(op => op.type === 'use').map(op => op.partId));
    return cloneArtwork((project.parts || []).filter(part => ids.has(part.id)));
  };
  if (key === '@group' || (nodes.length === 1 && nodes[0].key === key && nodes[0].type === 'pixels')) {
    // Each frame of the source animation is kept so pasting back into it (Duplicate) preserves the animation.
    const frames = Object.fromEntries(animation.frames.map(f => { const c = celIn(f); return [f.id, { source: c.source ? cloneArtwork(c.source) : null, pixels: [...c.pixels] }]; }));
    return { ...base, kind: 'container', name: layer.name, group: key === '@group' && layer.group !== false,
      source: cel.source ? cloneArtwork(cel.source) : null, pixels: [...cel.pixels], frames,
      parts: usedParts(animation.frames.flatMap(f => celIn(f).source?.ops || [])) };
  }
  const node = nodes.find(n => n.key === key);
  if (!node) throw new Error('Select an object to copy.');
  if (node.type === 'instance') {
    const op = node.instance, frames = {};
    for (const f of animation.frames) {
      const pose = celIn(f).source?.ops.find(o => o.type === 'use' && o.id === op.id && o.partId === op.partId);
      if (pose) frames[f.id] = { x: pose.x, y: pose.y, transform: pose.transform, ...instancePose(pose) };
    }
    return { ...base, kind: 'instance', name: node.name, instance: { id: op.id, partId: op.partId, x: op.x, y: op.y, transform: op.transform, ...instancePose(op) }, frames, parts: usedParts([op]) };
  }
  const ops = node.type === 'overrides' ? cel.source.overrides : cel.source.ops.slice(node.start, node.end);
  return { ...base, kind: 'container', name: nodes.length === 1 ? layer.name : node.name, group: false,
    source: node.type === 'overrides' ? null : { ops: cloneArtwork(ops), overrides: [] }, pixels: renderOperations(ops, project.width, project.height), parts: [] };
}

/** Copy several objects of one frame; one item gives a normal clipboard, more give a `multi` clipboard in stacking order. */
export function copyObjects(project, target, items) {
  const frame = locate(project, target).frame, ordered = orderObjects(project, frame, items);
  if (!ordered.length) throw new Error('Select an object to copy.');
  if (ordered.length === 1) return copyObject(project, { ...target, layerId: ordered[0].layerId }, ordered[0].key);
  return withBones(project, { format: OBJECT_CLIPBOARD_FORMAT, version: 1, kind: 'multi', name: `${ordered.length} objects`,
    items: ordered.map(item => copyOne(project, { ...target, layerId: item.layerId }, item.key)) });
}

/** Paste a `multi` clipboard bottom to top, each item above the previous one, so the copied stacking order is kept. */
function pasteObjects(project, target, clip, options) {
  if (!Array.isArray(clip.items) || !clip.items.length || clip.items.length > MAX_LAYERS) throw new Error('The copied objects are incomplete.');
  const host = project.layers.find(l => l.id === target.layerId), group = host && host.group !== false && !host.locked ? host.id : null;
  let p = project, layerId = target.layerId;
  const items = [], placed = [];
  for (const item of clip.items) {
    if (item?.kind === 'multi') throw new Error('The copied objects are incomplete.');
    const result = pasteOne(p, { ...target, layerId }, item, { ...options, intoGroup: layerId === group });
    p = result.project; layerId = result.layerId;
    items.push({ layerId: result.layerId, key: result.key }); placed.push(...result.placed);
  }
  return { project: p, layerId, key: items.at(-1).key, items, placed };
}

function readClipboard(clip) {
  if (!clip || clip.format !== OBJECT_CLIPBOARD_FORMAT || !['instance', 'container'].includes(clip.kind)) throw new Error('Copy an object first.');
  if (!Array.isArray(clip.palette) || !clip.palette.length || !Array.isArray(clip.parts)) throw new Error('The copied object is incomplete.');
  return clip;
}
function usedColors(clip) {
  const colors = [];
  const add = ops => { for (const op of ops || []) op.type === 'span' ? colors.push(...op.values) : op.type !== 'use' && colors.push(op.color); };
  for (const part of clip.parts) add(part.ops);
  for (const data of [clip, ...(clip.kind === 'container' ? Object.values(clip.frames || {}) : [])]) {
    if (data.source) { add(data.source.ops); add(data.source.overrides); }
    if (data.pixels) colors.push(...data.pixels);
  }
  return colors;
}
function uniqueName(project, base) {
  const names = new Set(project.layers.map(layer => layer.name.toLowerCase()));
  let name = String(base || 'Object').slice(0, 80), n = 2;
  while (names.has(name.toLowerCase())) { const suffix = ` ${n++}`; name = String(base).slice(0, 80 - suffix.length) + suffix; }
  return name;
}
function addContainer(p, afterId, name, group) {
  assertCanAddLayer(p);
  const layer = { id: uid(), name: uniqueName(p, name), group, visible: true, locked: false };
  insertProjectLayer(p, layer, afterId);
  return layer;
}

/**
 * Paste a copied object into the target frame, or every frame of its animation.
 * Instances go into the selected group when it is an unlocked group, otherwise into a new object above the selection.
 * Identical part definitions are reused so the paste stays a shared instance; `independent` always copies the definition.
 * With `fill`, frames where the object was absent or empty get the copied frame's version, so it appears in every frame;
 * without it (Duplicate), only frames that had the object get a copy.
 */
export function pasteObject(project, target, clipboard, options = {}) {
  const multi = clipboard?.kind === 'multi' && clipboard.format === OBJECT_CLIPBOARD_FORMAT;
  const { placed, ...result } = multi ? pasteObjects(project, target, clipboard, options) : pasteOne(project, target, clipboard, options);
  return Array.isArray(clipboard.bones) && clipboard.bones.length ? { ...result, project: pasteBones(result.project, clipboard.bones, placed) } : result;
}
/**
 * Bones for pasted instances: each copied bone whose instance was pasted gets a new bone (unique id and name, the same
 * anchor, limit and rest angle) on the copy. Parents are mapped within the copy; a bone whose parent was not copied
 * becomes a root (validation then drops roots left without children, e.g. a lone copied part).
 */
export function pasteBones(project, bones, placed) {
  const p = validateProject(project), to = new Map(placed.map(m => [`${m.from.layerId}/${m.from.instanceId}`, m.to])), ids = new Map();
  const taken = new Set((p.bones || []).map(b => b.id)), names = new Set((p.bones || []).map(b => (b.name ?? b.id).toLowerCase()));
  const copied = bones.filter(b => to.has(`${b.layerId}/${b.instanceId}`) && !(p.bones || []).some(x => x.layerId === to.get(`${b.layerId}/${b.instanceId}`).layerId && x.instanceId === to.get(`${b.layerId}/${b.instanceId}`).instanceId));
  for (const bone of copied) {
    let id = String(bone.id).slice(0, 90);
    for (let n = 2; taken.has(id); n++) id = `${String(bone.id).slice(0, 90)}-${n}`;
    taken.add(id); ids.set(bone.id, id);
  }
  const added = copied.map(bone => {
    const base = String(bone.name ?? bone.id).slice(0, 56);
    let name = base;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    names.add(name.toLowerCase());
    const where = to.get(`${bone.layerId}/${bone.instanceId}`), parent = ids.get(bone.parent) || null;
    return { id: ids.get(bone.id), name, layerId: where.layerId, instanceId: where.instanceId, parent,
      ...(parent && bone.anchor ? { anchor: { ...bone.anchor } } : {}), ...(bone.limit ? { limit: { ...bone.limit } } : {}), ...(bone.rest ? { rest: bone.rest } : {}) };
  });
  if (!added.length) return p;
  p.bones = [...(p.bones || []), ...added];
  return validateProject(p);
}
function pasteOne(project, target, clipboard, { scope = 'animation', independent = false, offset = 0, fill = true, intoGroup = true } = {}) {
  const clip = readClipboard(clipboard);
  assertEditScope(scope);
  const p = validateProject(project), { animation, frame } = locate(p, target);
  const frames = scopeFrames(animation, frame, scope);
  const { palette, mapping } = mapPaletteColors(p.palette, clip.palette, usedColors(clip));
  p.palette = palette;
  const color = c => c < 0 ? c : mapping.get(c);
  const remap = ops => (ops || []).map(op => op.type === 'span' ? { ...op, values: op.values.map(color) } : op.type === 'use' ? { ...op } : { ...op, color: color(op.color) });
  const sameSize = clip.width === p.width && clip.height === p.height;
  const keepsSource = clip.kind === 'instance' || (clip.source && sameSize) || Boolean(clip.frames && sameSize && clip.kind === 'container');
  // Pasting back into the copied animation keeps each frame's pose or artwork; elsewhere the copied frame is used.
  const perFrame = scope !== 'frame' && clip.frames && clip.animationId === animation.id && sameSize && frames.some(f => clip.frames[f.id]);
  const partIds = new Map();
  if (keepsSource) for (const part of clip.parts) {
    const definition = { id: part.id, width: part.width, height: part.height, ops: remap(part.ops) };
    const existing = (p.parts || []).find(x => x.id === part.id);
    if (!independent && existing && JSON.stringify({ ...existing, id: part.id }) === JSON.stringify(definition)) { partIds.set(part.id, part.id); continue; }
    p.version = 3; p.parts ||= [];
    const id = existing || p.parts.some(x => x.id === part.id) ? nextPartId(p, `${part.id}_copy`) : part.id;
    p.parts.push({ ...definition, id });
    partIds.set(part.id, id);
  }
  const host = p.layers.find(l => l.id === target.layerId);
  if (clip.kind === 'instance') {
    const part = p.parts.find(x => x.id === partIds.get(clip.instance.partId));
    if (!part) throw new Error('The copied object is incomplete.');
    p.version = 3; p.parts ||= [];
    const layer = intoGroup && host && host.group !== false && !host.locked ? host : addContainer(p, target.layerId, clip.name, false);
    const celOf = f => f.cels.find(c => c.layerId === layer.id);
    const poses = new Map();
    for (const f of frames) {
      const pose = perFrame ? clip.frames[f.id] || (fill ? clip.instance : null) : clip.instance;
      if (!pose) continue;
      let x = pose.x + offset, y = pose.y + offset;
      const size = instancePose(pose);
      const bounds = objectBounds(p, { type: 'instance', instance: { partId: part.id, transform: pose.transform, x, y, ...size } });
      if (!perFrame && (bounds.x >= p.width || bounds.y >= p.height || bounds.x + bounds.width <= 0 || bounds.y + bounds.height <= 0)) { x -= bounds.x; y -= bounds.y; }
      poses.set(f, { x, y, transform: pose.transform, ...size });
    }
    let id = clip.instance.id, n = 2;
    while (frames.some(f => celOf(f).source?.ops.some(op => op.type === 'use' && op.id === id))) id = `${clip.instance.id.slice(0, 85)}_${n++}`;
    for (const [f, pose] of poses) {
      const cel = celOf(f);
      cel.source = sourceForCel(cel, p.width);
      cel.source.ops.push({ type: 'use', id, partId: part.id, ...pose, name: clip.name.slice(0, 80) });
    }
    return { project: validateProject(p), layerId: layer.id, key: id, items: [{ layerId: layer.id, key: id }], placed: poses.size ? [{ from: { layerId: clip.layerId, instanceId: clip.instance.id }, to: { layerId: layer.id, instanceId: id } }] : [] };
  }
  const layer = addContainer(p, host ? host.id : p.layers.at(-1).id, clip.name, Boolean(clip.group));
  for (const f of frames) {
    const own = perFrame ? clip.frames[f.id] : clip;
    const data = own && (!fill || own === clip || own.pixels.some(v => v >= 0)) ? own : fill ? clip : null;
    const cel = f.cels.find(c => c.layerId === layer.id);
    if (!data) continue;
    if (keepsSource && data.source) {
      p.version = 3; p.parts ||= [];
      cel.source = { ops: remap(data.source.ops).map(op => op.type === 'use' ? { ...op, partId: partIds.get(op.partId) } : op), overrides: remap(data.source.overrides) };
    } else {
      // Different canvas sizes keep the artwork at the same coordinates and crop what falls outside.
      for (let yy = 0; yy < Math.min(clip.height, p.height); yy++) for (let xx = 0; xx < Math.min(clip.width, p.width); xx++) {
        const value = data.pixels[yy * clip.width + xx];
        if (value >= 0) cel.pixels[yy * p.width + xx] = color(value);
      }
    }
  }
  const clean = validateProject(p), cel = clean.animations.find(a => a.id === animation.id).frames.find(f => f.id === frame.id).cels.find(c => c.layerId === layer.id);
  const key = layer.group ? '@group' : celObjects(cel).at(-1).key, kept = new Set(clean.animations.flatMap(a => a.frames).flatMap(f => f.cels.find(c => c.layerId === layer.id).source?.ops || []).filter(op => op.type === 'use').map(op => op.id));
  const placed = keepsSource ? clipInstances(clip).filter(i => kept.has(i.instanceId)).map(from => ({ from, to: { layerId: layer.id, instanceId: from.instanceId } })) : [];
  return { project: clean, layerId: layer.id, key, items: [{ layerId: layer.id, key }], placed };
}

/** Bounding box of a node's visible pixels in one frame, for canvas highlighting. */
export function objectPixelBounds(project, cel, key) {
  const nodes = celObjects(cel), node = key === '@group' ? null : nodes.find(n => n.key === key);
  let pixels;
  if (!node || !cel.source) pixels = cel.pixels;
  else if (node.type === 'instance') return objectBounds(project, node);
  else pixels = renderOperations(node.type === 'overrides' ? cel.source.overrides : cel.source.ops.slice(node.start, node.end), project.width, project.height, renderParts(project.parts || []));
  let left = Infinity, top = Infinity, right = -1, bottom = -1;
  pixels.forEach((value, i) => {
    if (value < 0) return;
    const x = i % project.width, y = Math.floor(i / project.width);
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  });
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
