/**
 * Apply validated plugin results to a project — pure, (project, …) → { project, …info }, validated. Pixel results are
 * written like the built-in effects (domain/effects.js applyPixelEffect): only into the active container's cel, only
 * inside the selection when there is one, via writeCelPixels (retained cels keep their objects), and never into a cel
 * holding a locked object.
 */
import { validateProject, makeLayeredFrame } from '../domain/project.js';
import { writeCelPixels, hasLockedInstances } from '../domain/artwork.js';
import { applyMask, selectionMask } from '../domain/pixel-fx.js';
import { canInsertFrames } from '../domain/animate.js';
import { decodeAIProject } from '../formats/pxa.js';

function locate(project, animationId, layerId) {
  const animation = project.animations.find(a => a.id === animationId), layer = project.layers.find(l => l.id === layerId);
  if (!animation || !layer) throw new Error('This animation or container no longer exists.');
  if (layer.locked || !layer.visible) throw new Error('Select a visible, unlocked container.');
  return { animation, layer };
}
const celOf = (frame, layerId) => frame.cels.find(c => c.layerId === layerId);

/** Selection as a 0/1 mask, or null for the whole canvas. `selection` is { mask } (Uint8Array) or { rect }. */
export function selectionToMask(selection, width, height) {
  if (!selection) return null;
  if (selection.mask) { if (selection.mask.length !== width * height) throw new Error('The selection does not match the canvas.'); return selection.mask; }
  return selection.rect ? selectionMask(selection.rect, width, height) : null;
}

/**
 * Frames a pixel command runs on: the target frame, or every frame of the animation in 'animation' edit scope.
 * Frames whose cel holds a locked object are skipped (an error in frame scope), like applyPixelEffect.
 * Returns { frames: [{ id, index, pixels }], skipped }.
 */
export function pixelFrames(project, { animationId, frameId, layerId, editScope = 'frame' }) {
  const { animation } = locate(project, animationId, layerId), frames = [];
  let skipped = 0;
  const list = editScope === 'animation' ? animation.frames : Array.isArray(editScope) ? animation.frames.filter(f => f.id === frameId || editScope.includes(f.id)) : animation.frames.filter(f => f.id === frameId);
  if (!list.length) throw new Error('This frame no longer exists.');
  for (const frame of list) {
    const cel = celOf(frame, layerId);
    if (hasLockedInstances(cel)) {
      if (editScope === 'frame') throw new Error('Unlock objects in this container first.');
      skipped++; continue;
    }
    frames.push({ id: frame.id, index: animation.frames.indexOf(frame), pixels: cel.pixels });
  }
  return { frames, skipped };
}

/**
 * Write per-frame pixel results [{ frameId, pixels }] into container `layerId`, limited to `selection`; `palette`
 * (optional) replaces the palette first. Returns { project, frameIds (changed) }.
 */
export function applyPixelResults(project, { animationId, layerId, selection }, results, palette) {
  const p = validateProject(project), { animation } = locate(p, animationId, layerId);
  if (palette) p.palette = [...palette];
  const mask = selectionToMask(selection, p.width, p.height), frameIds = [];
  for (const { frameId, pixels } of results) {
    const frame = animation.frames.find(f => f.id === frameId), cel = frame && celOf(frame, layerId);
    if (!cel) throw new Error('A frame changed while the plugin ran.');
    if (hasLockedInstances(cel)) throw new Error('Unlock objects in this container first.');
    const next = mask ? applyMask(cel.pixels, pixels, mask) : pixels;
    if (next.some((v, i) => v !== cel.pixels[i])) { writeCelPixels(cel, next, p.width); frameIds.push(frame.id); }
  }
  return { project: validateProject(p), frameIds };
}

/**
 * Replace container `layerId`'s pixels across the animation with `frames` [{ pixels, duration? }]. Extra frames are
 * added at the end as copies of the last frame (every other container keeps that frame's artwork).
 * Returns { project, frameIds, added }.
 */
export function applyAnimationResult(project, { animationId, layerId }, frames, palette) {
  const p = validateProject(project), { animation } = locate(p, animationId, layerId);
  if (palette) p.palette = [...palette];
  if (animation.frames.some(f => hasLockedInstances(celOf(f, layerId)))) throw new Error('Unlock objects in this container first: an animation command rewrites every frame.');
  const added = frames.length - animation.frames.length;
  if (added < 0) throw new Error('An animation command may add frames, not remove them.');
  if (added && !canInsertFrames(p, animation.id, added)) throw new Error('This project has reached its frame limit.');
  for (let k = 0; k < added; k++) animation.frames.push(makeLayeredFrame(p, animation.frames.at(-1)));
  const frameIds = [];
  frames.forEach((result, i) => {
    const frame = animation.frames[i], cel = celOf(frame, layerId);
    if (result.duration) frame.duration = result.duration;
    if (result.pixels.some((v, j) => v !== cel.pixels[j])) writeCelPixels(cel, result.pixels, p.width);
    frameIds.push(frame.id);
  });
  return { project: validateProject(p), frameIds, added };
}

/** Decode and validate a project command's PXA text (PXA 1 or 2), like a pasted AI result. */
export function applyProjectResult(text) {
  return { project: validateProject(decodeAIProject(text)) };
}
