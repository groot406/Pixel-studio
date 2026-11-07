/** Exact, indexed pixel operations. Transparent pixels use index -1. */
import { artworkId, artworkBudget, validateParts, validateSource, renderParts, renderSource, cloneArtwork } from './artwork.js';
import { SIZE, MAX_SIZE, MAX_TOTAL_PIXELS, MAX_COLORS, MAX_LAYERS, pixelCount } from './limits.js';
export { SIZE, MAX_SIZE, MAX_TOTAL_PIXELS, MAX_COLORS, MAX_LAYERS } from './limits.js';
export { linePoints, rectanglePoints, ellipsePoints } from './geometry.js';
export const DEFAULT_PALETTE = Object.freeze([
  '#232a36', '#465060', '#87929f', '#d4dae0',
  '#fff7e8', '#e8c99c', '#ce956b', '#875546',
  '#4d6354', '#6f9972', '#abc889', '#e4ce74',
  '#f2ac53', '#d86850', '#8d6689', '#638bac',
]);

const MAX_ANIMATIONS = 100;
const MAX_FRAMES_PER_ANIMATION = 256;
const MAX_TOTAL_FRAMES = 1024;
let nextId = 0;

export function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  nextId += 1;
  return `pixel-${Date.now().toString(36)}-${nextId.toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function makeFrame(pixels, width = SIZE, height = SIZE) {
  const count = pixelCount(width, height);
  if (pixels !== undefined && (!pixels || pixels.length !== count)) {
    throw new Error(`A ${width} × ${height} frame must contain exactly ${count.toLocaleString('en-US')} pixels.`);
  }
  return { id: uid(), duration: 125, pixels: pixels === undefined ? Array(count).fill(-1) : Array.from(pixels) };
}

export function blankProject(name = 'Untitled sprite', width = SIZE, height = SIZE) {
  const count = pixelCount(width, height);
  const layer = { id: uid(), name: 'Pixels', visible: true, locked: false, group: false };
  return {
    format: 'pixel-studio',
    version: 2,
    name,
    width,
    height,
    palette: [...DEFAULT_PALETTE],
    layers: [layer],
    animations: [{ id: uid(), name: 'Idle', fps: 8, frames: [{ id: uid(), duration: 125, cels: [{ layerId: layer.id, pixels: Array(count).fill(-1) }] }] }],
  };
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readName(value, label, maxLength = 80) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must contain 1–${maxLength} characters.`);
  }
  return value.trim();
}

function readPixels(value, count, paletteLength, label) {
  if (!Array.isArray(value) || value.length !== count) {
    throw new Error(`${label} must contain exactly ${count.toLocaleString('en-US')} pixels.`);
  }
  const pixels = Array(count);
  for (let index = 0; index < count; index += 1) {
    const color = value[index];
    if (!Number.isInteger(color) || color < -1 || color >= paletteLength) {
      throw new Error(`${label} contains a pixel outside its palette. Use -1 for transparency.`);
    }
    pixels[index] = color;
  }
  return pixels;
}

/** Validate and clone without removing blank frames. Version 1 files migrate losslessly to version 2. */
export function validateProject(input) {
  if (!object(input) || input.format !== 'pixel-studio' || ![1, 2, 3].includes(input.version)) {
    throw new Error('This is not a supported Pixel Studio data file (versions 1, 2 and 3).');
  }
  const { width, height } = input;
  const count = pixelCount(width, height);
  const name = readName(input.name, 'Project name', 120);
  if (!Array.isArray(input.palette) || input.palette.length < 1 || input.palette.length > MAX_COLORS) {
    throw new Error(`The palette must contain 1–${MAX_COLORS} colors.`);
  }
  const palette = Array.from(input.palette, (color) => {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
      throw new Error('Palette colors must be six-digit hex colors, such as #ffcc66.');
    }
    return color.toLowerCase();
  });
  const ids = new Set();
  const readId = (value) => {
    if (input.version === 3) {
      artworkId(value);
      if (ids.has(value)) throw new Error(`Duplicate project ID ${value}.`);
      ids.add(value);
      return value;
    }
    let id = typeof value === 'string' && /^[a-z0-9_-]{1,100}$/i.test(value) && !ids.has(value) ? value : uid();
    while (ids.has(id)) id = uid();
    ids.add(id);
    return id;
  };
  const layerIds = new Map();
  let layers;
  if (input.version === 1) {
    layers = [{ id: readId(), name: 'Layer 1', visible: true, locked: false }];
  } else {
    if (!Array.isArray(input.layers) || input.layers.length < 1 || input.layers.length > MAX_LAYERS) {
      throw new Error(`A project must contain 1–${MAX_LAYERS} layers.`);
    }
    layers = Array.from(input.layers, (layer, index) => {
      if (!object(layer)) throw new Error(`Layer ${index + 1} must be an object.`);
      if (typeof layer.id !== 'string' || !layer.id || layer.id.length > 1000) {
        throw new Error(`Layer ${index + 1} needs a nonempty layer ID.`);
      }
      if (layerIds.has(layer.id)) throw new Error('Layer IDs must be unique so each cel has an unambiguous layer.');
      const layerName = readName(layer.name, `Layer ${index + 1} name`);
      if (typeof layer.visible !== 'boolean' || typeof layer.locked !== 'boolean') {
        throw new Error(`“${layerName}” needs boolean visible and locked settings.`);
      }
      const id = readId(layer.id);
      layerIds.set(layer.id, id);
      if (layer.group !== undefined && typeof layer.group !== 'boolean') throw new Error('Group settings must be boolean.');
      return { id, name: layerName, visible: layer.visible, locked: layer.locked, ...(layer.group !== undefined ? {group:layer.group} : {}) };
    });
  }
  if (!Array.isArray(input.animations) || input.animations.length < 1 || input.animations.length > MAX_ANIMATIONS) {
    throw new Error(`A project must contain 1–${MAX_ANIMATIONS} animations.`);
  }
  // Bound stored pixels, including hidden layers, before copying any pixel arrays.
  let totalFrames = 0;
  for (const animation of input.animations) {
    if (!object(animation) || !Array.isArray(animation.frames) || animation.frames.length < 1 || animation.frames.length > MAX_FRAMES_PER_ANIMATION) {
      throw new Error(`Every animation needs 1–${MAX_FRAMES_PER_ANIMATION} frames.`);
    }
    totalFrames += animation.frames.length;
    if (totalFrames > MAX_TOTAL_FRAMES) throw new Error(`A project can contain at most ${MAX_TOTAL_FRAMES.toLocaleString('en-US')} frames in total.`);
    if (totalFrames * count * layers.length > MAX_TOTAL_PIXELS) throw new Error(`A project can contain at most ${MAX_TOTAL_PIXELS.toLocaleString('en-US')} stored pixels across all frames and layers. Reduce its canvas size, frame count, or layer count.`);
  }
  const budget = artworkBudget();
  const parts = input.version === 3 ? validateParts(input.parts, palette.length, budget) : [];
  const partImages = renderParts(parts);
  const readLayerOrder=(value,label)=>{
    if(value===undefined)return undefined;
    if(!Array.isArray(value) || value.length!==layers.length || new Set(value).size!==layers.length || Array.from(value).some(id=>!layerIds.has(id))) throw new Error(`${label} layer order must contain every layer ID exactly once.`);
    return value.map(id=>layerIds.get(id));
  };
  const animations = input.animations.map((animation, animationIndex) => {
    const animationName = readName(animation.name, `Animation ${animationIndex + 1} name`);
    const layerOrder=readLayerOrder(animation.layerOrder,`“${animationName}”`);
    if (!Number.isFinite(animation.fps) || animation.fps < 1 || animation.fps > 60) {
      throw new Error(`“${animationName}” needs a playback speed from 1 to 60 FPS.`);
    }
    return {
      id: readId(animation.id),
      name: animationName,
      fps: animation.fps,
      ...(layerOrder ? { layerOrder } : {}),
      frames: animation.frames.map((frame, frameIndex) => {
        const label = `Frame ${frameIndex + 1} in “${animationName}”`;
        if (!object(frame)) throw new Error(`${label} must be an object.`);
        const duration = frame.duration === undefined ? Math.round(1000 / animation.fps) : frame.duration;
        if (!Number.isInteger(duration) || duration < 1 || duration > 60000) {
          throw new Error(`${label} needs a duration from 1 to 60,000 milliseconds.`);
        }
        let cels;
        if (input.version === 1) {
          cels = [{ layerId: layers[0].id, pixels: readPixels(frame.pixels, count, palette.length, label) }];
        } else {
          if (!Array.isArray(frame.cels) || frame.cels.length !== layers.length) {
            throw new Error(`${label} needs exactly one cel for each of its ${layers.length} layers.`);
          }
          const celByLayer = new Map();
          for (const cel of frame.cels) {
            if (!object(cel) || typeof cel.layerId !== 'string' || !layerIds.has(cel.layerId)) {
              throw new Error(`${label} has a cel with an unknown or missing layer ID.`);
            }
            const layerId = layerIds.get(cel.layerId);
            if (celByLayer.has(layerId)) throw new Error(`${label} has duplicate cels for the same layer.`);
            celByLayer.set(layerId, cel);
          }
          cels = layers.map((layer) => {
            const cel = celByLayer.get(layer.id);
            if (!cel) throw new Error(`${label} is missing a cel for “${layer.name}”.`);
            if (input.version === 3 && cel.source !== undefined) {
              const source = validateSource(cel.source, width, height, palette.length, parts, budget);
              return { layerId: layer.id, source, pixels: renderSource(source, width, height, partImages) };
            }
            return { layerId: layer.id, pixels: readPixels(cel.pixels, count, palette.length, `${label}, layer “${layer.name}”`) };
          });
        }
        const frameOrder=readLayerOrder(frame.layerOrder,label);
        return { id: readId(frame.id), duration, cels, ...(frameOrder?{layerOrder:frameOrder}:{}) };
      }),
    };
  });
  const bones = input.version === 3 ? readBones(input.bones, layerIds, animations) : [];
  return { format: 'pixel-studio', version: input.version === 3 ? 3 : 2, name, width, height, palette, layers, animations, ...(input.version === 3 ? { parts } : {}), ...(bones.length ? { bones } : {}) };
}

const MAX_BONES = 256, BONE_ID = /^[A-Za-z0-9_-]{1,100}$/;
/**
 * Skeleton bones (version 3): {id, name?, layerId, instanceId, parent, anchor?, limit?, rest?}. A bone is one placed
 * instance (stable across frames); `anchor` is the joint on the parent in the parent's part pixels (continuous). Bones
 * whose instance is gone are dropped (or follow it to the one other layer that has it), cycles and orphans become
 * roots, and roots without children are removed.
 */
function readBones(value, layerIds, animations) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_BONES) throw new Error(`Skeletons hold at most ${MAX_BONES} bones.`);
  const where = new Map();
  for (const animation of animations) for (const frame of animation.frames) for (const cel of frame.cels) for (const op of cel.source?.ops || []) {
    if (op.type !== 'use') continue;
    if (!where.has(op.id)) where.set(op.id, new Set());
    where.get(op.id).add(cel.layerId);
  }
  const seen = new Set(), used = new Set(), num = (v, label) => { if (!Number.isFinite(v) || Math.abs(v) > 4096) throw new Error(`${label} must be a number.`); return v; };
  const angle = (v, label) => { if (!Number.isInteger(v) || v < -360 || v > 360) throw new Error(`${label} must be whole degrees (-360..360).`); return v; };
  let bones = value.map((bone, index) => {
    const label = `Bone ${index + 1}`;
    if (!object(bone) || typeof bone.id !== 'string' || !BONE_ID.test(bone.id)) throw new Error(`${label} needs an ID of letters, digits, _ or -.`);
    if (seen.has(bone.id)) throw new Error(`Duplicate bone ID ${bone.id}.`);
    seen.add(bone.id);
    if (typeof bone.layerId !== 'string' || typeof bone.instanceId !== 'string') throw new Error(`${label} needs a layer and instance ID.`);
    if (bone.parent !== undefined && bone.parent !== null && typeof bone.parent !== 'string') throw new Error(`${label} has an invalid parent.`);
    const out = { id: bone.id, layerId: layerIds.get(bone.layerId) ?? bone.layerId, instanceId: bone.instanceId, parent: bone.parent || null };
    if (bone.name !== undefined) out.name = readName(bone.name, `${label} name`, 60);
    if (bone.anchor !== undefined) {
      if (!object(bone.anchor)) throw new Error(`${label} joint needs x and y.`);
      out.anchor = { x: num(bone.anchor.x, `${label} joint x`), y: num(bone.anchor.y, `${label} joint y`) };
    }
    if (bone.limit !== undefined) {
      if (!object(bone.limit)) throw new Error(`${label} limit needs min and max.`);
      const min = angle(bone.limit.min, `${label} limit`), max = angle(bone.limit.max, `${label} limit`);
      if (min > max) throw new Error(`${label} limit min must not exceed max.`);
      out.limit = { min, max };
    }
    if (bone.rest !== undefined) out.rest = angle(bone.rest, `${label} rest angle`);
    return out;
  }).filter(bone => {
    const layers = where.get(bone.instanceId);
    if (!layers) return false;
    if (!layers.has(bone.layerId)) { if (layers.size !== 1) return false; bone.layerId = [...layers][0]; }
    const key = `${bone.layerId}\u0000${bone.instanceId}`;
    if (used.has(key)) return false;
    used.add(key);
    return true;
  });
  const byId = new Map(bones.map(b => [b.id, b]));
  for (const bone of bones) {
    if (bone.parent && (!byId.has(bone.parent) || !bone.anchor)) bone.parent = null;
    for (let at = bone.parent, steps = 0; at; at = byId.get(at).parent) if (at === bone.id || ++steps > bones.length) { bone.parent = null; break; }
    if (!bone.parent) delete bone.anchor;
  }
  const parents = new Set(bones.map(b => b.parent).filter(Boolean));
  bones = bones.filter(b => b.parent || parents.has(b.id));
  return bones;
}

/** Return the actual editable cel array. Callers must pass a normalized layered frame. */
export function getLayerPixels(frame, layerId) {
  const cel = frame?.cels?.find((item) => item.layerId === layerId);
  if (!cel || !Array.isArray(cel.pixels)) throw new Error('The frame is missing pixel data for the selected layer.');
  return cel.pixels;
}

/** Create a fresh frame, optionally cloning every source cel and its duration. */
export function makeLayeredFrame(project, sourceFrame) {
  const count = pixelCount(project.width, project.height);
  if (!Array.isArray(project.layers) || project.layers.length < 1 || project.layers.length > MAX_LAYERS) {
    throw new Error(`A project must contain 1–${MAX_LAYERS} layers.`);
  }
  const duration = sourceFrame === undefined ? 125 : sourceFrame.duration;
  if (!Number.isInteger(duration) || duration < 1 || duration > 60000) throw new Error('A frame needs a duration from 1 to 60,000 milliseconds.');
  const cels = project.layers.map(layer => {
    const source = sourceFrame?.cels.find(c => c.layerId === layer.id)?.source;
    return {
      layerId: layer.id,
      ...(source ? { source: cloneArtwork(source) } : {}),
      pixels: sourceFrame === undefined ? Array(count).fill(-1) : readPixels(getLayerPixels(sourceFrame, layer.id), count, project.palette.length, `Layer “${layer.name}”`),
    };
  });
  return { id: uid(), duration, cels, ...(sourceFrame?.layerOrder?{layerOrder:[...sourceFrame.layerOrder]}:{}) };
}

/** Flatten visible layers from bottom to top. The returned array never aliases a cel. */
export function compositeFrame(project, frame) {
  const count = pixelCount(project.width, project.height);
  const pixels = Array(count).fill(-1);
  const animation = project.animations.find(a => a.frames.some(f => f.id === frame.id));
  for (const layer of getAnimationLayers(project, animation, frame)) {
    if (!layer.visible) continue;
    const cel = getLayerPixels(frame, layer.id);
    for (let index = 0; index < count; index += 1) {
      if (cel[index] !== -1) pixels[index] = cel[index];
    }
  }
  return pixels;
}

/** Layer definitions are shared; each animation may override their bottom-to-top order. */
export function getAnimationLayers(project, animation, frame) {
  const order=frame?.layerOrder || animation?.layerOrder;
  if (!order) return project.layers;
  const layers = new Map(project.layers.map(layer => [layer.id, layer]));
  return order.map(id => layers.get(id));
}

export function moveAnimationLayer(project, animation, layerId, direction) {
  if (direction !== -1 && direction !== 1) throw new Error('Layer moves must be one position up or down.');
  const order = getAnimationLayers(project, animation).map(layer => layer.id);
  const index = order.indexOf(layerId), target = index + direction;
  if (index < 0 || target < 0 || target >= order.length) return false;
  [order[index], order[target]] = [order[target], order[index]];
  animation.layerOrder = order;
  return true;
}

/** Add the shared layer and its cels, preserving each animation's existing stack. */
export function insertProjectLayer(project, layer, afterLayerId, sourceLayerId = null) {
  const index = project.layers.findIndex(item => item.id === afterLayerId);
  for (const animation of project.animations) {
    for(const frame of animation.frames) if(frame.layerOrder)frame.layerOrder.splice(frame.layerOrder.indexOf(afterLayerId)+1,0,layer.id);
    if (!animation.layerOrder) continue;
    const position = animation.layerOrder.indexOf(afterLayerId);
    animation.layerOrder.splice(position + 1, 0, layer.id);
  }
  project.layers.splice(index + 1, 0, layer);
  for (const animation of project.animations) for (const frame of animation.frames) {
    const source = sourceLayerId && frame.cels.find(cel => cel.layerId === sourceLayerId);
    frame.cels.push(source ? { ...cloneArtwork(source), layerId: layer.id }
      : { layerId: layer.id, pixels: Array(project.width * project.height).fill(-1) });
  }
}

export function removeProjectLayer(project, layerId) {
  project.layers = project.layers.filter(layer => layer.id !== layerId);
  for (const animation of project.animations) {
    if (animation.layerOrder) animation.layerOrder = animation.layerOrder.filter(id => id !== layerId);
    for(const frame of animation.frames)if(frame.layerOrder)frame.layerOrder=frame.layerOrder.filter(id=>id!==layerId);
    for (const frame of animation.frames) frame.cels = frame.cels.filter(cel => cel.layerId !== layerId);
  }
}

/** A project-wide merge is safe only when the pair is adjacent in this order everywhere. */
export function canMergeLayerDown(project, topId, belowId) {
  const top = project.layers.find(layer => layer.id === topId);
  const below = project.layers.find(layer => layer.id === belowId);
  return Boolean(top?.visible && below?.visible && !top.locked && !below.locked
    && project.animations.every(animation => animation.frames.every(frame => {
      const layers = getAnimationLayers(project, animation, frame), index = layers.findIndex(layer => layer.id === topId);
      return index > 0 && layers[index - 1].id === belowId;
    })));
}

/** Hidden pixels count as content so cleanup cannot silently discard hidden artwork. */
export function isFrameEmpty(project, frame) {
  return project.layers.every((layer) => getLayerPixels(frame, layer.id).every((pixel) => pixel === -1));
}

/** Clone and explicitly remove empty frames/animations; ordinary validation remains lossless. */
export function stripEmptyFrames(input) {
  const project = validateProject(input);
  let skippedFrames = 0;
  let skippedAnimations = 0;
  project.animations = project.animations.filter((animation) => {
    animation.frames = animation.frames.filter((frame) => {
      if (!isFrameEmpty(project, frame)) return true;
      skippedFrames += 1;
      return false;
    });
    if (animation.frames.length) return true;
    skippedAnimations += 1;
    return false;
  });
  if (!project.animations.length) throw new Error('This file contains only empty frames. Uncheck “Skip empty frames” to import them.');
  return { project, skippedFrames, skippedAnimations };
}

/** Four-connected fill, mutating only the supplied frame. */
export function floodFill(pixels, x, y, color, width = SIZE, height = SIZE) {
  const count = pixelCount(width, height);
  if (!pixels || pixels.length !== count) throw new Error(`A ${width} × ${height} frame must contain exactly ${count.toLocaleString('en-US')} pixels.`);
  if (!Number.isInteger(color) || color < -1 || color >= MAX_COLORS) throw new Error('Choose a valid palette color.');
  if (!Number.isInteger(x) || !Number.isInteger(y) || !(x >= 0 && y >= 0 && x < width && y < height)) return false;
  const initial = y * width + x;
  const target = pixels[initial];
  if (target === color) return false;
  const stack = [initial];
  pixels[initial] = color;
  while (stack.length) {
    const index = stack.pop();
    const px = index % width;
    const neighbors = [];
    if (px > 0) neighbors.push(index - 1);
    if (px < width - 1) neighbors.push(index + 1);
    if (index >= width) neighbors.push(index - width);
    if (index < count - width) neighbors.push(index + width);
    for (const neighbor of neighbors) {
      if (pixels[neighbor] !== target) continue;
      pixels[neighbor] = color;
      stack.push(neighbor);
    }
  }
  return true;
}

/** Resize indexed art without inventing colors or changing the source array. */
export function resizePixels(pixels, oldWidth, oldHeight, newWidth, newHeight, mode = 'canvas') {
  const oldCount = pixelCount(oldWidth, oldHeight);
  const newCount = pixelCount(newWidth, newHeight);
  if (!pixels || pixels.length !== oldCount) throw new Error('The source pixels do not match the original canvas dimensions.');
  if (mode !== 'canvas' && mode !== 'scale') throw new Error('Choose canvas resize or nearest-neighbor scaling.');
  const result = Array(newCount).fill(-1);
  if (mode === 'scale') {
    for (let y = 0; y < newHeight; y += 1) {
      const sourceY = Math.min(oldHeight - 1, Math.floor((y + 0.5) * oldHeight / newHeight));
      for (let x = 0; x < newWidth; x += 1) {
        const sourceX = Math.min(oldWidth - 1, Math.floor((x + 0.5) * oldWidth / newWidth));
        result[y * newWidth + x] = pixels[sourceY * oldWidth + sourceX];
      }
    }
    return result;
  }
  // Center each axis. An odd extra row/column stays on the bottom/right.
  const offsetX = Math.trunc((newWidth - oldWidth) / 2);
  const offsetY = Math.trunc((newHeight - oldHeight) / 2);
  for (let y = Math.max(0, offsetY); y < Math.min(newHeight, oldHeight + offsetY); y += 1) {
    for (let x = Math.max(0, offsetX); x < Math.min(newWidth, oldWidth + offsetX); x += 1) {
      result[y * newWidth + x] = pixels[(y - offsetY) * oldWidth + x - offsetX];
    }
  }
  return result;
}

function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hex(r, g, b) {
  return `#${[r, g, b].map((part) => Math.round(part).toString(16).padStart(2, '0')).join('')}`;
}

function nearestIndex(r, g, b, colors) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < colors.length; i += 1) {
    const [pr, pg, pb] = colors[i];
    const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (distance < bestDistance) {
      bestIndex = i;
      bestDistance = distance;
      if (distance === 0) break;
    }
  }
  return bestIndex;
}

export function nearestColor(r, g, b, palette) {
  if (!Array.isArray(palette) || !palette.length) throw new Error('The palette needs at least one color.');
  return nearestIndex(r, g, b, palette.map(rgb));
}

function checkRgba(rgba) {
  if (!rgba || !Number.isSafeInteger(rgba.length) || rgba.length <= 0 || rgba.length % 4 !== 0) {
    throw new Error('RGBA data must contain a positive, whole number of pixels.');
  }
}

/** Preserve small palettes exactly; weighted median-cut bounds larger PNG palettes. */
export function paletteFromRgba(rgba, maxColors = MAX_COLORS) {
  checkRgba(rgba);
  if (!Number.isInteger(maxColors) || maxColors < 1 || maxColors > MAX_COLORS) throw new Error(`Choose a palette limit from 1 to ${MAX_COLORS}.`);
  const histogram = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    const entry = histogram.get(key);
    if (entry) entry.count += 1;
    else histogram.set(key, { values: [rgba[i], rgba[i + 1], rgba[i + 2]], count: 1 });
  }
  const entries = [...histogram.values()];
  if (!entries.length) return [DEFAULT_PALETTE[0]];
  if (entries.length <= maxColors) return entries.map(({ values }) => hex(...values));
  const makeBox = (colors) => {
    const ranges = [0, 1, 2].map((axis) => {
      let min = 255;
      let max = 0;
      for (const color of colors) { min = Math.min(min, color.values[axis]); max = Math.max(max, color.values[axis]); }
      return max - min;
    });
    const population = colors.reduce((sum, color) => sum + color.count, 0);
    const axis = ranges.indexOf(Math.max(...ranges));
    return { colors, axis, population, score: colors.length > 1 ? ranges[axis] * Math.sqrt(population) : -1 };
  };
  const boxes = [makeBox(entries)];
  while (boxes.length < maxColors) {
    let best = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      if (boxes[i].score > (best < 0 ? -1 : boxes[best].score)) best = i;
    }
    if (best < 0) break;
    const box = boxes[best];
    const sorted = [...box.colors].sort((a, b) => a.values[box.axis] - b.values[box.axis]);
    let weight = 0;
    let split = 1;
    for (let i = 0; i < sorted.length - 1; i += 1) {
      weight += sorted[i].count;
      split = i + 1;
      if (weight >= box.population / 2) break;
    }
    boxes.splice(best, 1, makeBox(sorted.slice(0, split)), makeBox(sorted.slice(split)));
  }
  return boxes.map((box) => {
    const totals = [0, 0, 0];
    for (const color of box.colors) {
      for (let axis = 0; axis < 3; axis += 1) totals[axis] += color.values[axis] * color.count;
    }
    return hex(...totals.map((total) => total / box.population));
  });
}

export function mapRgbaToPalette(rgba, palette, width = SIZE, height = SIZE) {
  const count = pixelCount(width, height);
  checkRgba(rgba);
  if (rgba.length !== count * 4) throw new Error(`PNG pixels must first be sized to ${width} × ${height}.`);
  if (!Array.isArray(palette) || !palette.length || palette.length > MAX_COLORS) throw new Error(`The palette needs 1–${MAX_COLORS} colors.`);
  const colors = palette.map(rgb);
  const mapped = new Map();
  const pixels = Array(count);
  for (let i = 0; i < count; i += 1) {
    const offset = i * 4;
    if (rgba[offset + 3] < 128) { pixels[i] = -1; continue; }
    const [r, g, b] = [rgba[offset], rgba[offset + 1], rgba[offset + 2]];
    const key = (r << 16) | (g << 8) | b;
    if (!mapped.has(key)) mapped.set(key, nearestIndex(r, g, b, colors));
    pixels[i] = mapped.get(key);
  }
  return pixels;
}
