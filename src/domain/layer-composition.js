/** Project-wide layer composition. Groups keep editable instances; merging explicitly bakes their artwork. */
import { validateProject, getAnimationLayers, removeProjectLayer, insertProjectLayer, uid, compositeFrame } from './project.js';
import { celObjects, isEmptyNode, orderObjects } from './objects.js';
import { sourceForCel, hasLockedInstances, renderOperations, renderParts, pixelSpans } from './artwork.js';
import { nextPartId } from './parts.js';
import { layersToParts, pixelLayers } from './auto-rig.js';

/** Selection rows may describe complete layers or just some objects within a layer. */
export function compositionSelection(project, frame, items) {
  const ordered = orderObjects(project, frame, items);
  if (!ordered.length) throw new Error('Select objects or layers to combine first.');
  const layerIds = [...new Set(ordered.map(item => item.layerId))];
  const wholeLayerIds = layerIds.filter(id => {
    const picked = new Set(ordered.filter(item => item.layerId === id).map(item => item.key));
    const cel = frame.cels.find(c => c.layerId === id);
    return picked.has('@group') || celObjects(cel).every(node => node.type === 'overrides' || isEmptyNode(cel, node) || picked.has(node.key));
  });
  return { items: ordered, layerIds, wholeLayerIds, whole: layerIds.length === wholeLayerIds.length };
}

function adjacentLayers(project, layerIds) {
  const ids = new Set(layerIds);
  return project.animations.every(animation => animation.frames.every(frame => {
    const positions = getAnimationLayers(project, animation, frame).flatMap((layer, i) => ids.has(layer.id) ? [i] : []);
    return positions.at(-1) - positions[0] + 1 === ids.size;
  }));
}

/** Group the actual selection, including a subset of parts in a shared container. */
export function groupSelection(project, target, items, name) {
  return combineSelection(project, target, items, { kind: 'group', name });
}
/** Merge only the selected artwork; unselected parts keep their original source and identities. */
export function mergeSelection(project, target, items) {
  return combineSelection(project, target, items, { kind: 'merge', name: 'Merged selection' });
}

function combineSelection(project, target, items, { kind, name }) {
  const p = validateProject(project);
  const frame = p.animations.find(a => a.id === target.animationId)?.frames.find(f => f.id === target.frameId);
  if (!frame) throw new Error('This frame no longer exists.');
  const plan = compositionSelection(p, frame, items), grouping = kind === 'group';
  const layers = getAnimationLayers(p, p.animations.find(a => a.id === target.animationId), frame).filter(l => plan.layerIds.includes(l.id));
  if (plan.whole && adjacentLayers(p, plan.layerIds)) {
    return grouping ? groupLayers(p, plan.layerIds, layers.at(-1).id, name) : mergeLayers(p, plan.layerIds, layers.at(-1).id);
  }
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('Use a name of 1–80 characters.');
  if (layers.some(l => l.locked || !l.visible)) throw new Error('Show and unlock the selected layers first.');
  if (p.outline && (p.outline.separate || new Set(layers.map(l => Boolean(p.outline.skip?.includes(l.id)))).size > 1)) {
    throw new Error('Use a combined live outline with the same settings for the selected artwork first.');
  }
  const wanted = new Map(plan.layerIds.map(id => [id, new Set(plan.items.filter(item => item.layerId === id).map(item => item.key))]));
  const whole = new Set(plan.wholeLayerIds), names = instanceNames(p, plan.layerIds);
  const destination = { id: uid(), name: name.trim(), visible: true, locked: false, group: grouping };
  const taken = new Set([...names.values()].flatMap(map => [...map.values()])), pixelIds = new Map(), variants = new Map();
  const images = renderParts(p.parts || [], p.palette);
  const pixelPart = (ops, layerId, node) => {
    const pixels = renderOperations(ops, p.width, p.height, images);
    if (pixels.every(pixel => pixel < 0)) return [];
    const key = `${layerId}/${node.key}`, variant = `${key}:${pixels.join(',')}`;
    if (!pixelIds.has(key)) {
      let id = 'pixels'; for (let n = 2; taken.has(id); n++) id = `pixels_${n}`;
      taken.add(id); pixelIds.set(key, id);
    }
    let partId = variants.get(variant);
    if (!partId) {
      p.parts ||= []; partId = nextPartId(p, 'selection');
      p.parts.push({ id: partId, width: p.width, height: p.height, ops: pixelSpans(pixels, p.width) });
      variants.set(variant, partId);
    }
    return [{ type: 'use', id: pixelIds.get(key), partId, x: 0, y: 0, transform: 'N', name: node.name }];
  };
  // Capture order before inserting the new container, including each frame's own stacking order.
  const orders = new Map(p.animations.flatMap(a => a.frames.map(f => [f.id, getAnimationLayers(p, a, f).map(l => l.id)])));
  insertProjectLayer(p, destination, layers.at(-1).id);
  if (p.outline?.skip?.includes(layers[0].id)) p.outline.skip.push(destination.id);
  const moved = new Map(plan.layerIds.map(id => [id, new Set()]));
  for (const animation of p.animations) for (const f of animation.frames) {
    const selectedOps = [], merged = Array(p.width * p.height).fill(-1), selectedIds = orders.get(f.id).filter(id => wanted.has(id));
    let belowAnchor = false;
    for (const layerId of selectedIds) {
      const cel = f.cels.find(c => c.layerId === layerId), nodes = celObjects(cel), keys = wanted.get(layerId);
      const picked = nodes.filter(node => whole.has(layerId) || keys.has(node.key));
      if (!picked.length) continue;
      const source = sourceForCel(cel, p.width);
      if (!whole.has(layerId) && (source.overrides.length || source.ops.some(erases))) {
        throw new Error('This layer has local erasures or overrides. Apply those edits before separating some of its objects.');
      }
      if (picked.some(node => node.instance?.locked)) throw new Error('Unlock the selected objects in every frame first.');
      const indices = new Set(picked.flatMap(node => Array.from({ length: node.end - node.start }, (_, i) => node.start + i)));
      const ops = whole.has(layerId) ? [...source.ops, ...source.overrides]
        : cel.source ? source.ops.filter((_, i) => indices.has(i)) : source.ops;
      if (grouping) {
        if (whole.has(layerId)) {
          if (picked.some(node => node.instance)) {
            if (selectedOps.length && ops.some(erases)) throw new Error('These objects contain isolated erasures. Merge them instead or keep them separate.');
            selectedOps.push(...ops.map(op => op.type === 'use' ? { ...op, id: names.get(layerId).get(op.id) } : op));
            for (const node of picked) if (node.instance) moved.get(layerId).add(node.key);
          } else selectedOps.push(...pixelPart(ops, layerId, { key: 'pixels', name: p.layers.find(l => l.id === layerId).name }));
        } else for (const node of picked) {
          if (node.instance) {
            selectedOps.push({ ...node.instance, id: names.get(layerId).get(node.key) });
            moved.get(layerId).add(node.key);
          } else {
            const art = node.type === 'overrides' ? source.overrides : cel.source ? source.ops.slice(node.start, node.end) : source.ops;
            selectedOps.push(...pixelPart(art, layerId, node));
          }
        }
      } else {
        renderOperations(ops, p.width, p.height, images).forEach((pixel, i) => { if (pixel >= 0) merged[i] = pixel; });
        for (const node of picked) if (node.instance) moved.get(layerId).add(node.key);
      }
      if (layerId === selectedIds.at(-1)) {
        const rest = nodes.filter(node => !picked.includes(node));
        belowAnchor = rest.length > 0 && nodes.indexOf(picked.at(-1)) < nodes.indexOf(rest[0]);
      }
      if (whole.has(layerId) || !cel.source) { cel.pixels.fill(-1); delete cel.source; }
      else { cel.source.ops = source.ops.filter((_, i) => !indices.has(i)); }
    }
    const cel = f.cels.find(c => c.layerId === destination.id);
    if (grouping) cel.source = { ops: selectedOps, overrides: [] };
    else cel.pixels = merged;
    const order = [...orders.get(f.id)], anchor = order.indexOf(selectedIds.at(-1));
    order.splice(anchor + (belowAnchor ? 0 : 1), 0, destination.id); f.layerOrder = order;
  }
  for (const bone of p.bones || []) if (moved.get(bone.layerId)?.has(bone.instanceId) && grouping) {
    bone.instanceId = names.get(bone.layerId).get(bone.instanceId); bone.layerId = destination.id;
  }
  if (!grouping && p.bones) p.bones = p.bones.filter(bone => !moved.get(bone.layerId)?.has(bone.instanceId));
  for (const id of whole) removeProjectLayer(p, id);
  if (p.outline?.skip) p.outline.skip = p.outline.skip.filter(id => p.layers.some(l => l.id === id));
  if (grouping) p.version = 3;
  return { project: validateProject(p), layerId: destination.id, key: grouping ? '@group' : 'pixels' };
}

function compositionContext(project, layerIds) {
  const p = validateProject(project), ids = new Set(layerIds);
  if (!ids.size || [...ids].some(id => !p.layers.some(layer => layer.id === id))) throw new Error('Select existing layers to combine.');
  const layers = p.layers.filter(layer => ids.has(layer.id));
  if (layers.some(layer => layer.locked)) throw new Error('Unlock the selected layers before combining them.');
  if (layers.some(layer => !layer.visible)) throw new Error('Show the selected layers before combining them.');
  const frames = p.animations.flatMap(animation => animation.frames);
  if (frames.some(frame => frame.cels.some(cel => ids.has(cel.layerId) && hasLockedInstances(cel)))) throw new Error('Unlock objects inside the selected layers in every frame first.');
  for (const animation of p.animations) for (const frame of animation.frames) {
    const order = getAnimationLayers(p, animation, frame).map(layer => layer.id), positions = order.flatMap((id, i) => ids.has(id) ? [i] : []);
    if (positions.at(-1) - positions[0] + 1 !== ids.size) throw new Error('Select neighbouring layers in every frame. Reorder the layers first.');
  }
  if (ids.size > 1 && p.outline) {
    const skipped = layers.filter(layer => p.outline.skip?.includes(layer.id)).length;
    if ((skipped > 0 && skipped !== ids.size) || (p.outline.separate && skipped !== ids.size)) {
      throw new Error('These layers have different live outlines. Use a combined outline with the same settings for all selected layers first.');
    }
  }
  return { p, ids };
}

function removeCombinedLayers(p, ids, keepId) {
  for (const id of ids) if (id !== keepId) removeProjectLayer(p, id);
  if (p.outline?.skip) {
    p.outline.skip = p.outline.skip.filter(id => p.layers.some(layer => layer.id === id));
    if (!p.outline.skip.length) delete p.outline.skip;
  }
}

/** Unique instance identities across combined layers, stable across every animation and frame. */
function instanceNames(p, ids) {
  const names = new Map(), taken = new Set();
  for (const layerId of ids) {
    const map = new Map(); names.set(layerId, map);
    for (const animation of p.animations) for (const frame of animation.frames) {
      for (const op of frame.cels.find(c => c.layerId === layerId).source?.ops || []) {
        if (op.type !== 'use' || map.has(op.id)) continue;
        let id = op.id;
        for (let n = 2; taken.has(id); n++) id = `${op.id.slice(0, 85)}_${n}`;
        map.set(op.id, id); taken.add(id);
      }
    }
  }
  return names;
}

const erases = op => op.type !== 'use' && (op.color === -1 || op.values?.includes(-1));

/** Group whole neighbouring layers into the chosen layer, preserving per-frame order, parts and rig identities. */
export function groupLayers(project, layerIds, keepId, name = 'Group') {
  let { p, ids } = compositionContext(project, layerIds);
  if (!ids.has(keepId)) throw new Error('Choose a selected layer for the group.');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('Use a group name of 1–80 characters.');
  // Pure pixel layers become separate placed parts so each remains selectable after grouping.
  const drawn = pixelLayers(p).filter(layer => ids.has(layer.id)).map(layer => layer.id);
  if (drawn.length) ({ project: p } = layersToParts(p, { layerIds: drawn }));
  const names = instanceNames(p, ids);
  for (const animation of p.animations) for (const frame of animation.frames) {
    const layers = getAnimationLayers(p, animation, frame).filter(layer => ids.has(layer.id)), ops = [];
    for (const [i, layer] of layers.entries()) {
      const source = sourceForCel(frame.cels.find(c => c.layerId === layer.id), p.width);
      // Erasing in a higher cel must never start erasing artwork from a lower, formerly isolated cel.
      if (i && [...source.ops, ...source.overrides].some(erases)) throw new Error('These layers contain isolated erasures. Merge the layers instead, or keep them separate.');
      ops.push(...source.ops.map(op => op.type === 'use' ? { ...op, id: names.get(layer.id).get(op.id) } : op), ...source.overrides);
    }
    frame.cels.find(c => c.layerId === keepId).source = { ops, overrides: [] };
  }
  for (const bone of p.bones || []) if (ids.has(bone.layerId)) {
    bone.instanceId = names.get(bone.layerId).get(bone.instanceId);
    bone.layerId = keepId;
  }
  const group = p.layers.find(layer => layer.id === keepId);
  group.group = true; group.name = name.trim();
  removeCombinedLayers(p, ids, keepId);
  const result = validateProject(p);
  // Smooth sampling can blend with lower objects inside a cel. Reject any changed appearance, never silently bake it.
  for (const animation of result.animations) for (const frame of animation.frames) {
    const before = project.animations.find(a => a.id === animation.id).frames.find(f => f.id === frame.id);
    for (const outline of project.outline ? [false, true] : [false]) {
      const expected = compositeFrame(project, before, { outline }), actual = compositeFrame(result, frame, { outline });
      if (expected.some((pixel, i) => pixel !== actual[i])) throw new Error('Grouping would change this artwork. Merge the layers instead, or keep them separate.');
    }
  }
  return { project: result, layerId: keepId, key: '@group' };
}

/** Flatten whole neighbouring layers into one pixel layer across all animations; shared part definitions stay in the library. */
export function mergeLayers(project, layerIds, keepId) {
  const { p, ids } = compositionContext(project, layerIds);
  if (!ids.has(keepId)) throw new Error('Choose a selected layer for the merged artwork.');
  for (const animation of p.animations) for (const frame of animation.frames) {
    const pixels = Array(p.width * p.height).fill(-1);
    for (const layer of getAnimationLayers(p, animation, frame).filter(layer => ids.has(layer.id))) {
      frame.cels.find(c => c.layerId === layer.id).pixels.forEach((pixel, i) => { if (pixel >= 0) pixels[i] = pixel; });
    }
    const cel = frame.cels.find(c => c.layerId === keepId);
    cel.pixels = pixels; delete cel.source;
  }
  // Remove explicit references before validation can infer a similarly named instance on a different layer.
  if (p.bones) p.bones = p.bones.filter(bone => !ids.has(bone.layerId));
  p.layers.find(layer => layer.id === keepId).group = false;
  removeCombinedLayers(p, ids, keepId);
  return { project: validateProject(p), layerId: keepId, key: 'pixels' };
}
