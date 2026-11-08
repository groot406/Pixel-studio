/**
 * Pixel and colour use cases: pixel-fx.js and colour.js applied to the cels of a project. Pure — (project, …) →
 * { project, …info }, validated. Pixels are written like a paint stroke (artwork.writeCelPixels): raster cels get new
 * pixels, retained cels keep their objects and record the difference as local pixel edits. A cel holding a locked
 * object is skipped, like the paint tools do when editing all frames.
 */
import { validateProject, getAnimationLayers, makeLayeredFrame } from './project.js';
import { writeCelPixels, hasLockedInstances, partPixels, pixelSpans, cloneArtwork } from './artwork.js';
import { growPart, nextPartId, referencesToPart } from './parts.js';
import { linePoints } from './geometry.js';
import {
  outline, selOut, innerGlow, rimLight, autoShade, cleanupDoubles, offsetWrap, gradientFill, gradientStopsBetween, floodRegion,
  ditherMix, applyMask, selectionMask, pixelPerfect, wrapPoints, cleanLinePoints, seamScore,
} from './pixel-fx.js';
import { rampFromPalette, darkerMap, lighterMap, shadingRamp, addRampToPalette, cycleRamp, cycleLoopLength } from './colour.js';
import { canInsertFrames } from './animate.js';
import { autoOutline } from './shading.js';
import { applyFixes } from './cleanup.js';
import { smoothJaggies } from './antialias.js';
import { assertEditScope, scopeFrames } from './frame-scope.js';

/** Map palette index → its hue-family ramp (indices, dark → light), the `ramps` autoShade and selOut take. */
export function rampsForPalette(palette, { hueTolerance = 35 } = {}) {
  return new Map(palette.map((_, i) => [i, rampFromPalette(palette, i, { hueTolerance })]));
}

/** Gradient colour stops from one palette index to another: the ramp between them when they share a hue family, else just the two. */
export function gradientStops(palette, fromIndex, toIndex) {
  const ramp = rampFromPalette(palette, fromIndex);
  return ramp.includes(toIndex) ? gradientStopsBetween(ramp, fromIndex, toIndex) : [fromIndex, toIndex];
}

export const PIXEL_EFFECTS = ['outline', 'selOut', 'innerGlow', 'rimLight', 'autoShade', 'cleanup', 'offsetWrap', 'gradient', 'dither', 'autoOutline', 'pixelFix', 'smoothJaggies'];

/** One effect on one cel's pixels; palette-derived maps/ramps fill in missing options. */
function run(effect, pixels, width, height, palette, o) {
  switch (effect) {
    case 'outline': return outline(pixels, width, height, o);
    case 'selOut': return selOut(pixels, width, height, o.ramps ? o : { darkenMap: darkerMap(palette), lightenMap: lighterMap(palette), ...o });
    case 'innerGlow': return innerGlow(pixels, width, height, o);
    case 'rimLight': return rimLight(pixels, width, height, o);
    case 'autoShade': return autoShade(pixels, width, height, { ramps: rampsForPalette(palette), ...o });
    case 'cleanup': return cleanupDoubles(pixels, width, height, o.color);
    case 'autoOutline': return autoOutline(pixels, width, height, palette, o);
    case 'pixelFix': return applyFixes(pixels, o.fixes || []);
    case 'smoothJaggies': return smoothJaggies(pixels, width, height, palette, { strength: o.strength ?? 1, background: o.background ?? -1 });
    case 'offsetWrap': return offsetWrap(pixels, width, height, o.dx ?? Math.floor(width / 2), o.dy ?? Math.floor(height / 2));
    case 'gradient': return gradientFill(pixels, width, height, { ...o, colors: o.colors ?? gradientStops(palette, o.fromIndex, o.toIndex) });
    case 'dither': {
      const { a, b, ratio = 0.5, matrix = 4, region = 'all', seed } = o;
      const flood = region === 'flood' ? floodRegion(pixels, width, height, seed) : null;
      return pixels.map((v, i) => (flood && !flood[i]) || (region === 'opaque' && v < 0) ? v : ditherMix(a, b, ratio, i % width, Math.floor(i / width), matrix));
    }
    default: throw new Error(`Unknown effect ${effect}.`);
  }
}

/** Selection as a mask: `mask` (0/1 per pixel) or `rect` {x,y,width,height}; null when the whole cel is in scope. */
function scopeMask({ mask, rect }, width, height) {
  if (mask) { if (mask.length !== width * height) throw new Error('The selection mask does not match the canvas.'); return mask; }
  return rect ? selectionMask(rect, width, height) : null;
}

/**
 * Apply a pixel effect to one container's cel in the target frame (`scope: 'frame'`, default) or in every frame of the
 * animation (`'animation'`), limited to an optional selection (`mask` or `rect`). Effects and their options:
 * - outline {color, thickness=1, corners=true, mode:'outside'|'inside'}
 * - selOut {light?, lit:'omit'|'lighter'|'fill', mode, corners, darkenMap?/lightenMap?/ramps? (default: palette darker/lighter maps)}
 * - innerGlow {color (index or edge→inward array), size=1, metric}
 * - rimLight {color, light:{x,y} toward the light, size=1}
 * - autoShade {light?, depth=3, ramps? (default rampsForPalette)}
 * - cleanup {color?} removes doubled L-corners from 1px lines
 * - offsetWrap {dx, dy} (default half the canvas) shifts with wrap-around, for checking tile seams
 * - gradient {from, to, shape:'linear'|'radial'|'diamond'|'angle', colors | fromIndex+toIndex, style:'bands'|'dither',
 *   matrix:2|4|8, repeat:'clamp'|'repeat'|'mirror', region:'all'|'flood'|'mask', seed (flood start)}
 * - dither {a, b, ratio 0..1, matrix, region:'all'|'opaque'|'flood', seed} ordered (Bayer) two-colour fill
 * - autoOutline {mode:'outside'|'inside', corners, style:'selective'|'single', color} darkest-of-ramp outline (shading.js)
 * - pixelFix {fixes:[{index, value}]} applies Pixel cleanup fixes (cleanup.js)
 * Errors: locked/hidden container, unknown effect or invalid options (messages from pixel-fx), a locked object in
 * frame scope. Returns { project, frameIds (changed frames), skipped (frames with locked objects) }.
 */
export function applyPixelEffect(project, { animationId, frameId, layerId, scope = 'frame', mask, rect }, effect, options = {}) {
  if (!PIXEL_EFFECTS.includes(effect)) throw new Error(`Unknown effect ${effect}.`);
  assertEditScope(scope);
  const p = validateProject(project), animation = p.animations.find(a => a.id === animationId), frame = animation?.frames.find(f => f.id === frameId);
  const layer = p.layers.find(l => l.id === layerId);
  if (!frame || !layer) throw new Error('This frame or container no longer exists.');
  if (layer.locked || !layer.visible) throw new Error('Select a visible, unlocked layer.');
  const { width, height, palette } = p, selected = scopeMask({ mask, rect }, width, height);
  const o = effect === 'gradient' && options.region === 'mask' ? { ...options, mask: options.mask ?? selected } : options;
  const frameIds = [];
  let skipped = 0;
  for (const f of scopeFrames(animation, frame, scope)) {
    const cel = f.cels.find(c => c.layerId === layerId);
    if (hasLockedInstances(cel)) {
      if (scope === 'frame') throw new Error('Unlock objects in this container first.');
      skipped++; continue;
    }
    const result = run(effect, cel.pixels, width, height, palette, o), next = selected ? applyMask(cel.pixels, result, selected) : result;
    if (next.some((v, i) => v !== cel.pixels[i])) { writeCelPixels(cel, next, width); frameIds.push(f.id); }
  }
  return { project: validateProject(p), frameIds, skipped };
}

/** Effects that work on a part's own pixels (the rest are tied to canvas coordinates). */
export const INSTANCE_EFFECTS = ['outline', 'selOut', 'innerGlow', 'rimLight', 'autoShade', 'cleanup', 'dither', 'autoOutline', 'smoothJaggies'];
/** Room an effect may need around a part's artwork. */
function effectMargin(effect, o) {
  if (effect === 'outline') return o.mode === 'inside' ? 0 : Math.max(1, o.thickness || 1);
  if (effect === 'autoOutline') return o.mode === 'inside' ? 0 : 1;
  return effect === 'smoothJaggies' ? 1 : 0;
}

/**
 * Apply a pixel effect to the part an instance (`instanceId`, a `use` op in the target cel) draws, so the object itself
 * changes and keeps the result when it moves. `scope` 'animation' paints the shared part (every copy changes, as
 * editing the part does); 'frame' or a frame-id list gives this instance its own copy of the part in those frames,
 * unless no other instance uses the part. The part grows when the result (an outline, say) needs more room, keeping
 * every instance in place. Returns { project, partId (the part that changed), grown: {left, top, right, bottom} }.
 */
export function applyInstanceEffect(project, { animationId, frameId, layerId, instanceId, scope = 'frame' }, effect, options = {}) {
  if (!INSTANCE_EFFECTS.includes(effect)) throw new Error('This effect works on the whole canvas. Select pixels or a pixel object instead.');
  assertEditScope(scope);
  let p = validateProject(project);
  const animation = p.animations.find(a => a.id === animationId), frame = animation?.frames.find(f => f.id === frameId);
  const layer = p.layers.find(l => l.id === layerId);
  if (!frame || !layer) throw new Error('This frame or container no longer exists.');
  if (layer.locked || !layer.visible) throw new Error('Select a visible, unlocked layer.');
  const op = frame.cels.find(c => c.layerId === layerId)?.source?.ops.find(o => o.type === 'use' && o.id === instanceId);
  if (!op) throw new Error('Choose an object in this frame.');
  if (op.locked) throw new Error('Unlock this object first.');
  let partId = op.partId;
  const before = p.parts.find(part => part.id === partId);
  const m = effectMargin(effect, options), w = before.width + 2 * m, h = before.height + 2 * m;
  const src = partPixels(before), padded = new Array(w * h).fill(-1);
  for (let y = 0; y < before.height; y++) for (let x = 0; x < before.width; x++) padded[(y + m) * w + x + m] = src[y * before.width + x];
  const result = run(effect, padded, w, h, p.palette, options);
  if (result.every((v, i) => v === padded[i])) return { project: p, partId, grown: { left: 0, top: 0, right: 0, bottom: 0 }, changed: false };
  const used = (x, y) => result[y * w + x] >= 0;
  // How many margin columns/rows (from the outside in) the result actually uses on each side.
  const side = (count, at) => { for (let n = m; n > 0; n--) if (Array.from({ length: count }, (_, i) => at(m - n, i)).some(Boolean)) return n; return 0; };
  const grown = {
    left: side(h, (d, y) => used(d, y)), right: side(h, (d, y) => used(w - 1 - d, y)),
    top: side(w, (d, x) => used(x, d)), bottom: side(w, (d, x) => used(x, h - 1 - d)),
  };

  const scopeIds = new Set(scopeFrames(animation, frame, scope).map(f => f.id));
  const inScope = ref => ref.animationId === animationId && ref.layerId === layerId && ref.instanceId === instanceId && scopeIds.has(ref.frameId);
  if (scope !== 'animation' && !referencesToPart(p, partId).every(inScope)) {
    const copy = cloneArtwork(before);
    copy.id = nextPartId(p, `${partId}_copy`);
    p.parts.push(copy);
    for (const f of animation.frames) if (scopeIds.has(f.id)) for (const o of f.cels.find(c => c.layerId === layerId)?.source?.ops || []) {
      if (o.type === 'use' && o.id === instanceId && o.partId === partId && !o.locked) o.partId = copy.id;
    }
    partId = copy.id;
    p = validateProject(p);
  } else if (referencesToPart(p, partId).some(ref => ref.locked || p.layers.find(l => l.id === ref.layerId)?.locked)) {
    throw new Error('This part is used by a locked object. Unlock it, or use This frame to change only this copy.');
  }
  p = growPart(p, partId, grown);
  const part = p.parts.find(item => item.id === partId), now = partPixels(part);
  const next = new Array(part.width * part.height);
  for (let y = 0; y < part.height; y++) for (let x = 0; x < part.width; x++) next[y * part.width + x] = result[(y - grown.top + m) * w + x - grown.left + m];
  part.ops.push(...pixelSpans(next, part.width, (i, v) => v !== now[i]));
  return { project: validateProject(p), partId, grown, changed: true };
}

/** Gradient fill with palette colours; `options` as the gradient effect of applyPixelEffect. */
export function applyGradient(project, target, options) { return applyPixelEffect(project, target, 'gradient', options); }

/**
 * Add a hue-shifted OKLCH shading ramp around palette colour `baseIndex` (shadows cooler, highlights warmer), reusing
 * near-identical existing colours. Options: steps (2–16, default 5), hueShift (default 20), lightnessSpan, chromaDrop.
 * Errors when the 64-colour palette would overflow. Returns { project, indices (palette slots, dark → light), colours }.
 */
export function addShadingRamp(project, baseIndex, options = {}) {
  const p = validateProject(project);
  if (!Number.isInteger(baseIndex) || baseIndex < 0 || baseIndex >= p.palette.length) throw new Error('Choose a palette colour.');
  const colours = shadingRamp(p.palette[baseIndex], options), { palette, indices } = addRampToPalette(p.palette, colours);
  p.palette = palette;
  return { project: validateProject(p), indices, colours };
}

/**
 * Colour cycling (palette animation) along `rampIndices`, `stepsPerFrame` ramp positions per frame (`direction` ±1).
 * frames 'existing' cycles every frame of the animation by its index; a number n or 'loop' (one full cycle,
 * cycleLoopLength) inserts n-1 cycled copies of the source frame `frameId` (default the first) right after it.
 * Applies to container `layerId`, or every visible, unlocked container without locked objects.
 * Returns { project, frameIds (cycled frames, in order), loopLength }.
 */
export function colourCycle(project, { animationId, frameId, layerId, rampIndices, stepsPerFrame = 1, direction = 1, frames = 'existing' }) {
  const p = validateProject(project), animation = p.animations.find(a => a.id === animationId);
  if (!animation) throw new Error('This animation no longer exists.');
  if (!Array.isArray(rampIndices) || rampIndices.length < 2 || rampIndices.some(i => !Number.isInteger(i) || i < 0 || i >= p.palette.length)) throw new Error('Choose at least two palette colours to cycle.');
  if (direction !== 1 && direction !== -1) throw new Error('Cycle direction must be 1 or -1.');
  const loopLength = cycleLoopLength(rampIndices, stepsPerFrame);
  const layers = getAnimationLayers(p, animation).filter(l => (layerId ? l.id === layerId : l.visible && !l.locked));
  if (layerId && (!layers.length || layers[0].locked)) throw new Error('Select an unlocked layer.');
  let list = animation.frames;
  if (frames !== 'existing') {
    const n = frames === 'loop' ? loopLength : frames;
    if (!Number.isInteger(n) || n < 2) throw new Error('Cycle over at least two frames.');
    const at = frameId ? animation.frames.findIndex(f => f.id === frameId) : 0;
    if (at < 0) throw new Error('This frame no longer exists.');
    if (!canInsertFrames(p, animation.id, n - 1)) throw new Error('This project has reached its frame limit.');
    animation.frames.splice(at + 1, 0, ...Array.from({ length: n - 1 }, () => makeLayeredFrame(p, animation.frames[at])));
    list = animation.frames.slice(at, at + n);
  }
  list.forEach((f, k) => {
    for (const layer of layers) {
      const cel = f.cels.find(c => c.layerId === layer.id);
      if (!k || hasLockedInstances(cel)) continue;
      writeCelPixels(cel, cycleRamp(cel.pixels, rampIndices, k * stepsPerFrame * direction), p.width);
    }
  });
  return { project: validateProject(p), frameIds: list.map(f => f.id), loopLength };
}

/**
 * Points a freehand stroke paints: optional pixel-perfect corner removal, then optional wrap-around (seamless tile
 * drawing) into the width × height canvas. Without wrap, points stay unclipped.
 */
export function strokePoints(points, { pixelPerfect: perfect = false, wrap = false, width, height } = {}) {
  const path = perfect ? pixelPerfect(points) : points;
  return wrap ? wrapPoints(path, width, height) : path;
}

/** Points of the line tool: a clean slope (uniform 1:n runs, end snapped) or the plain Bresenham line; optional wrap. */
export function toolLinePoints(x0, y0, x1, y1, { clean = false, wrap = false, width, height } = {}) {
  const points = clean ? cleanLinePoints(x0, y0, x1, y1) : linePoints(x0, y0, x1, y1);
  return wrap ? wrapPoints(points, width, height) : points;
}

/** Wrapped-edge mismatches of a frame's composite or one container, for a "seamless tile" indicator (0 = seamless edges). */
export function tileSeams(pixels, width, height) { return seamScore(pixels, width, height); }
