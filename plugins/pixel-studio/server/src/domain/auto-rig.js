/**
 * Turn drawn layers into reusable parts and rig them. `layersToParts` replaces each plain pixel layer with one placed
 * part per frame (identical frames share a part, so editing it updates them all); `autoRig` joins placed parts into a
 * skeleton where they touch, rooted at the body. Both are pure: (project, options) → { project, … }.
 */
import { validateProject } from './project.js';
import { pixelSpans, renderParts, renderOperations } from './artwork.js';
import { attachBone, boneOf } from './skeleton.js';

const slug = (text, fallback = 'part') => String(text || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || fallback;
const uses = cel => (cel?.source?.ops || []).filter(op => op.type === 'use');
const ROOT_NAMES = /\b(torso|body|chest|hips?|pelvis|trunk|armou?r|cloak|core|base|root|spine)\b/i;

function uniqueId(taken, base) {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 90)}_${n}`;
  taken.add(id);
  return id;
}
function crop(pixels, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  pixels.forEach((v, i) => { if (v < 0) return; const x = i % width, y = (i - x) / width; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, out = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push(pixels[y * width + x]);
  return { x: x0, y: y0, width: w, height: h, pixels: out };
}

/** Layers that are drawn pixels only (no placed parts in any frame) and not locked. */
export function pixelLayers(project) {
  const frames = project.animations.flatMap(a => a.frames);
  return project.layers.filter(layer => !layer.locked && frames.every(f => !uses(f.cels.find(c => c.layerId === layer.id)).length)
    && frames.some(f => f.cels.find(c => c.layerId === layer.id)?.pixels.some(v => v >= 0)));
}

/**
 * Replace each pixel layer (`layerIds`, default: every unlocked layer without placed parts) with a part placed at the
 * artwork's position in every frame. The instance keeps the layer's name and the same id in every frame (so it can be
 * rigged); frames with identical drawings share one part. Returns { project, converted: [{layerId, instanceId, parts}] }.
 */
export function layersToParts(project, { layerIds } = {}) {
  const p = validateProject(project), candidates = pixelLayers(p);
  const layers = layerIds ? candidates.filter(l => layerIds.includes(l.id)) : candidates;
  if (!layers.length) throw new Error('There are no drawn pixel layers to turn into parts.');
  p.version = 3; p.parts ||= [];
  const partIds = new Set(p.parts.map(part => part.id)), converted = [];
  for (const layer of layers) {
    const base = slug(layer.name), shapes = new Map(), instanceId = base;
    for (const animation of p.animations) for (const frame of animation.frames) {
      const cel = frame.cels.find(c => c.layerId === layer.id), art = cel && crop(cel.pixels, p.width, p.height);
      if (!art) { if (cel) delete cel.source; continue; }
      const key = `${art.width}x${art.height}:${art.pixels.join(',')}`;
      let partId = shapes.get(key);
      if (!partId) {
        partId = uniqueId(partIds, base);
        p.parts.push({ id: partId, width: art.width, height: art.height, ops: pixelSpans(art.pixels, art.width) });
        shapes.set(key, partId);
      }
      cel.source = { ops: [{ type: 'use', id: instanceId, partId, x: art.x, y: art.y, transform: 'N', name: layer.name.slice(0, 80), visible: true, locked: false }], overrides: [] };
    }
    converted.push({ layerId: layer.id, instanceId, parts: shapes.size });
  }
  return { project: validateProject(p), converted };
}

/**
 * Join the placed parts of a frame into a skeleton. The root is an existing root bone, else a part named like a body
 * (torso, body, hips, armour, cloak…), else the biggest part. Each remaining part hangs from the rigged part it touches
 * most, jointed at the middle of where they touch (or the nearest point when nothing touches). Parts already rigged
 * keep their bones. Returns { project, attached: [{bone, parent}], rootBoneId }.
 */
export function autoRig(project, { animationId, frameId } = {}) {
  let p = validateProject(project);
  const animation = animationId ? p.animations.find(a => a.id === animationId) : p.animations[0];
  if (!animation) throw new Error('This animation no longer exists.');
  const frame = frameId ? animation.frames.find(f => f.id === frameId) : animation.frames[0];
  if (!frame) throw new Error('This frame no longer exists.');
  const { width, height } = p, images = renderParts(p.parts || []);
  const hidden = new Set(p.layers.filter(l => !l.visible).map(l => l.id));
  const items = frame.cels.flatMap(c => hidden.has(c.layerId) ? [] : uses(c).filter(op => op.visible !== false).map(op => ({ layerId: c.layerId, instanceId: op.id, name: op.name || op.partId, op })))
    .map(item => {
      const pixels = renderOperations([item.op], width, height, images), list = [], near = new Uint8Array(width * height);
      pixels.forEach((v, i) => { if (v >= 0) list.push(i); });
      for (const i of list) { const x = i % width, y = (i - x) / width; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) near[(y + dy) * width + x + dx] = 1; }
      return { ...item, list, near, rigged: Boolean(boneOf(p, item.layerId, item.instanceId)) };
    }).filter(item => item.list.length);
  if (items.length < 2) throw new Error('Rigging needs at least two parts in this frame. Turn your layers into parts first.');
  const centre = item => item.list.reduce((s, i) => ({ x: s.x + (i % width) + .5, y: s.y + Math.floor(i / width) + .5 }), { x: 0, y: 0 });
  const middle = item => { const s = centre(item); return { x: s.x / item.list.length, y: s.y / item.list.length }; };
  const tree = items.filter(item => item.rigged);
  if (!tree.length) {
    const named = items.filter(item => ROOT_NAMES.test(item.name));
    tree.push((named.length ? named : items).reduce((a, b) => b.list.length > a.list.length ? b : a));
  }
  const attached = [];
  for (let rest = items.filter(item => !tree.includes(item)); rest.length; rest = items.filter(item => !tree.includes(item))) {
    let best = null;
    for (const child of rest) for (const parent of tree) {
      const contact = child.list.filter(i => parent.near[i]);
      if (contact.length && (!best || contact.length > best.contact.length)) best = { child, parent, contact };
    }
    if (best) {
      const sum = best.contact.reduce((s, i) => ({ x: s.x + (i % width) + .5, y: s.y + Math.floor(i / width) + .5 }), { x: 0, y: 0 });
      best.point = { x: sum.x / best.contact.length, y: sum.y / best.contact.length };
    } else {
      // Nothing touches: hang the closest part from the closest rigged part, jointed at its pixel nearest that part.
      for (const child of rest) for (const parent of tree) {
        const m = middle(parent);
        for (const i of child.list) {
          const x = (i % width) + .5, y = Math.floor(i / width) + .5, d = Math.hypot(x - m.x, y - m.y);
          if (!best || d < best.d) best = { child, parent, d, point: { x, y } };
        }
      }
    }
    const r = attachBone(p, { animationId: animation.id, frameId: frame.id, child: best.child, parent: best.parent, point: best.point, name: best.child.name });
    p = r.project; tree.push(best.child); attached.push({ bone: r.boneId, parent: r.parentId });
  }
  const rootBone = p.bones.find(b => !b.parent && b.layerId === tree[0].layerId && b.instanceId === tree[0].instanceId) || p.bones.find(b => !b.parent);
  return { project: p, attached, rootBoneId: rootBone?.id };
}

/** One step for drawn characters: turn pixel layers into parts (when there are any), then auto-rig the frame. */
export function partsAndRig(project, { animationId, frameId, layerIds, rig = true } = {}) {
  let p = validateProject(project), converted = [];
  if (pixelLayers(p).some(l => !layerIds || layerIds.includes(l.id))) ({ project: p, converted } = layersToParts(p, { layerIds }));
  if (!rig) return { project: p, converted, attached: [], rootBoneId: null };
  const animation = animationId ? p.animations.find(a => a.id === animationId) : p.animations[0];
  return { ...autoRig(p, { animationId: animation?.id, frameId: frameId || animation?.frames[0]?.id }), converted };
}
