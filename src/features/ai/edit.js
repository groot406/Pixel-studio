/** Scoped, validated PXA edits. No network calls or editor state live here. */
import {
  MAX_COLORS, MAX_LAYERS, MAX_TOTAL_PIXELS,
  getAnimationLayers, getLayerPixels, uid, validateProject,
} from '../../domain/project.js';
import { AI_FORMAT_GUIDE, MAX_AI_FILE_BYTES, decodeAIProject, encodeAIProject } from '../../formats/pxa.js';

import { compareProjects } from './comparison.js';
import { validateDescription, completionMarkerFor, requireCompleteResponse, lines } from './response-contract.js';

const REQUEST_FORMAT = 'pixel-studio-ai-edit';
const utf8 = new TextEncoder();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const quote = value => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function contextFor(project, options) {
  if (!object(options) || !['animation', 'frame', 'project'].includes(options.scope)) {
    throw new Error('Choose an animation, frame, or whole-project edit.');
  }
  const instruction = validateDescription(options.instruction);
  const sourceProject = validateProject(project);
  const scope = options.scope;
  let animationIndex = -1;
  let frameIndex = -1;
  if (scope !== 'project') {
    animationIndex = sourceProject.animations.findIndex(animation => animation.id === options.animationId);
    if (animationIndex < 0) throw new Error('The selected animation no longer exists. Select an animation and try again.');
    if (scope === 'frame') {
      frameIndex = sourceProject.animations[animationIndex].frames.findIndex(frame => frame.id === options.frameId);
      if (frameIndex < 0) throw new Error('The selected frame does not belong to this animation. Select a frame and try again.');
    }
    if (sourceProject.layers.every(layer => layer.locked)) throw new Error('Unlock a layer before requesting an AI edit.');
  }
  const animation = sourceProject.animations[animationIndex];
  const targetProject = validateProject({
    ...sourceProject,
    animations: scope === 'project' ? sourceProject.animations : [{
      ...animation,
      frames: scope === 'frame' ? [animation.frames[frameIndex]] : animation.frames,
    }],
  });
  const totalFrames = sourceProject.animations.reduce((sum, item) => sum + item.frames.length, 0);
  return {
    sourceProject, targetProject, scope, animationIndex, frameIndex,
    animationId: animation?.id ?? null,
    frameId: scope === 'frame' ? animation.frames[frameIndex].id : null,
    instruction,
    maxLayers: Math.min(MAX_LAYERS, Math.floor(MAX_TOTAL_PIXELS / (sourceProject.width * sourceProject.height * totalFrames))),
  };
}

function annotatedSource(project, scope) {
  const source = encodeAIProject(project, {version:1});
  if (scope !== 'project') return source;
  let layerIndex = 0;
  return source.split('\n').map(line => line.startsWith('LAYER ')
    ? `# EDIT_LAYER ${quote(project.layers[layerIndex++].id)}\n${line}` : line).join('\n');
}

function buildEditPrompt(request) {
  const { targetProject: target, scope } = request;
  const selection = scope === 'project'
    ? 'Edit the whole project. Return every animation and frame, in their existing order.'
    : scope === 'animation'
      ? `Edit only the animation ${quote(target.animations[0].name)}. Return that one ANIM section with all its frames. Do not return other animations.`
      : `Edit only frame ${request.frameIndex + 1} of animation ${quote(target.animations[0].name)}. Return that one ANIM section containing exactly one FRAME. It will replace the selected frame at its original position; do not return the other frames or animations.`;
  const layerRules = scope === 'project'
    ? `Keep every existing layer and its identity comment. You may rename or reorder UNLOCKED layers, redistribute their artwork, and add new unlocked layers, up to ${request.maxLayers} layers in total. Do not remove existing layers; a layer emptied by moving its artwork must remain declared. Preserve each existing layer's visibility and lock flags.
Every existing LAYER declaration must have its original # EDIT_LAYER "original-id" comment directly before it, even after renaming or reordering. These comments identify layers independently of their names. Never change, duplicate, or invent an original ID. Immediately before each NEW layer, write # EDIT_LAYER NEW instead. New layers must be unlocked and should have descriptive names.
Locked layers must stay at their original layer indices with the same names, flags, and exact pixel data in every frame.`
    : `Keep exactly ${target.layers.length} layers, in the same order, with the exact names, visibility, and lock flags in the source. Do not add, remove, rename, reorder, hide, show, lock, or unlock layers. Edit only unlocked layers. No layer identity comments are required for this scope.`;
  const plan = target.animations.map((animation, index) =>
    `${index + 1}. ANIM ${quote(animation.name)} ${animation.fps}: exactly ${animation.frames.length} FRAME entries. Durations in frame order (milliseconds): ${animation.frames.map(frame => frame.duration).join(', ')}.`
  ).join('\n');
  return `Edit the existing Pixel Studio pixel artwork described below. Return one complete PXA 1 document, without Markdown fences or explanation. This is an edit of the supplied artwork, not a new project.

EDIT REQUEST
${request.instruction}

EDIT SCOPE AND PROTECTED STRUCTURE
${selection}
Preserve unrelated details inside the selected artwork unless the edit request calls for changing them. The structural rules below take precedence if the edit request asks for incompatible changes.
Keep this exact project name and canvas size:
SIZE ${target.width} ${target.height}
NAME ${quote(target.name)}

PALETTE
Preserve every existing palette slot and its exact color, including duplicate colors. Do not remove, reorder, recolor, or renumber existing slots. You may append new six-digit hex colors after the existing slots, up to ${MAX_COLORS} total colors. Keep this exact prefix on PAL:
PAL ${target.palette.join(' ')}
All frames and layers share this palette. Transparency is a period, not a palette color.

LAYERS
${layerRules}
Preserve each animation's ORDER unless a whole-project request explicitly asks to change it. Frame and animation edits must keep the exact effective layer order. ORDER lists declaration indices bottom to top. When reordering declarations or adding layers in whole-project scope, update ORDER indices to keep their intended layer identities. Locked layers must keep their positions within every animation too.
Locked artwork is immutable, including artwork on hidden layers. Preserve all its pixels, not just its visible result. SHIFT affects every layer, so use it only when the final locked cels remain identical to their originals.

ANIMATION AND TIMING CONTRACT
${plan}
Preserve the exact animation names, capitalization, order, FPS, frame counts, and every duration. Keep deliberate blank frames; never remove them or insert padding frames. The first output frame of each animation must use CLEAR, including when editing a single later frame. PREV only copies the previous output frame in the same animation.

PIXEL ART
Work directly on the ${target.width} × ${target.height} logical grid. Use crisp, whole pixels and solid palette colors. Keep the subject's identity, alignment, scale, and animation continuity unless the request explicitly changes them. Preserve transparency and hidden artwork. Do not draw an editor grid or checkerboard into the image.

PXA 1 FORMAT GUIDE
${AI_FORMAT_GUIDE}

SOURCE PIXEL DATA — ONLY THE REQUESTED SCOPE
${request.sourcePxa}
CHECK BEFORE RETURNING
Return the full edited data for this scope, not a patch or omitted sections. Verify the exact dimensions, name, palette prefix, layer rules, animation order, frame counts, and timings. Copy locked pixels exactly. Use valid SPAN coordinates and palette symbols, and select CEL after each FRAME before writing SPAN.
After the last PXA command, finish with this exact full-line comment as the final nonblank line:
${request.completionMarker}
That final comment confirms the response is complete; it is an allowed PXA comment, not an END command. Never add it until all required artwork and frames have been written.
`;
}

/** Return a JSON-serializable, independent source snapshot and a self-contained edit prompt. */
export function createEditRequest(project, options) {
  const context = contextFor(project, options);
  const id = uid();
  const request = {
    format: REQUEST_FORMAT, version: 1, id,
    ...context,
    completionMarker: completionMarkerFor(id),
    sourcePxa: annotatedSource(context.targetProject, context.scope),
  };
  if (utf8.encode(`${request.sourcePxa}\n${request.completionMarker}\n`).length > MAX_AI_FILE_BYTES) {
    throw new Error('This edit exceeds the 4 MiB PXA limit. Choose a smaller animation or frame scope.');
  }
  request.prompt = buildEditPrompt(request);
  return request;
}

function assertStructure(source, target, edited) {
  if (edited.width !== source.width || edited.height !== source.height) throw new Error('AI edits must preserve the canvas dimensions.');
  if (edited.name !== source.name) throw new Error('AI edits must preserve the project name.');
  if (edited.palette.length < source.palette.length || source.palette.some((color, index) => edited.palette[index] !== color)) {
    throw new Error('AI edits must preserve every existing palette slot and color. New colors may only be appended.');
  }
  if (edited.animations.length !== target.animations.length) throw new Error('The response contains the wrong animations for this edit scope.');
  target.animations.forEach((animation, index) => {
    const next = edited.animations[index];
    if (next.name !== animation.name) throw new Error('AI edits must preserve the exact animation names and order.');
    if (next.fps !== animation.fps) throw new Error(`AI edits must preserve FPS for ${quote(animation.name)}.`);
    if (next.frames.length !== animation.frames.length) throw new Error(`AI edits must return exactly ${animation.frames.length} frames for ${quote(animation.name)}. Keep blank frames too.`);
    if (next.frames.some((frame, frameIndex) => frame.duration !== animation.frames[frameIndex].duration)) {
      throw new Error(`AI edits must preserve every frame duration in ${quote(animation.name)}.`);
    }
  });
}

function layerReferences(text) {
  const references = [];
  let pending;
  let inAnimations = false;
  for (const line of lines(text)) {
    if (/^#\s*EDIT_LAYER(?:\s|$)/.test(line)) {
      if (inAnimations || pending !== undefined) throw new Error('Each layer identity comment must appear once, directly before its LAYER declaration.');
      const value = line.replace(/^#\s*EDIT_LAYER\s*/, '');
      if (value === 'NEW') pending = null;
      else {
        try { pending = JSON.parse(value); } catch { throw new Error('A layer identity comment needs its original quoted ID or NEW.'); }
        if (typeof pending !== 'string' || !pending) throw new Error('A layer identity comment needs its original quoted ID or NEW.');
      }
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (/^LAYER\s/.test(line)) {
      if (pending === undefined) throw new Error('Whole-project edits need an identity comment before every LAYER. Copy the # EDIT_LAYER comments from the prompt.');
      references.push(pending);
      pending = undefined;
    } else {
      if (pending !== undefined) throw new Error('Place each layer identity comment directly before its LAYER declaration.');
      if (/^ANIM\s/.test(line)) inAnimations = true;
    }
  }
  if (pending !== undefined) throw new Error('A layer identity comment is missing its LAYER declaration.');
  return references;
}

function bindLayers(context, edited, text, requestId) {
  const source = context.sourceProject;
  if (context.scope !== 'project') {
    if (edited.layers.length !== source.layers.length || edited.layers.some((layer, index) => {
      const old = source.layers[index];
      return layer.name !== old.name || layer.visible !== old.visible || layer.locked !== old.locked;
    })) throw new Error('Frame and animation edits must keep the same layers, order, names, visibility, and locks. Use whole-project scope to reorganize unlocked layers.');
    return source.layers.map(layer => ({ ...layer }));
  }
  const references = layerReferences(text);
  if (references.length !== edited.layers.length) throw new Error('Every output layer needs one identity comment.');
  const originals = new Map(source.layers.map((layer, index) => [layer.id, { layer, index }]));
  const reservedIds = new Set(source.layers.map(layer => layer.id));
  for (const animation of source.animations) {
    reservedIds.add(animation.id);
    for (const frame of animation.frames) reservedIds.add(frame.id);
  }
  const seen = new Set();
  let added = 0;
  const bound = edited.layers.map((layer, index) => {
    const reference = references[index];
    if (reference === null) {
      if (layer.locked) throw new Error('New AI-created layers must be unlocked.');
      const base = `edit-${requestId.slice(0, 64)}-layer-${added++}`;
      let id = base;
      let suffix = 0;
      while (reservedIds.has(id)) id = `${base}-${++suffix}`;
      reservedIds.add(id);
      return { ...layer, id };
    }
    const original = originals.get(reference);
    if (!original || seen.has(reference)) throw new Error('Layer identity comments must refer to distinct original layers. Use NEW only for added layers.');
    seen.add(reference);
    const old = original.layer;
    if (layer.visible !== old.visible || layer.locked !== old.locked) throw new Error('AI edits must preserve visibility and lock flags on existing layers.');
    if (old.locked && (layer.name !== old.name || index !== original.index)) throw new Error(`Locked layer ${quote(old.name)} must keep its name and layer position.`);
    return { ...layer, id: old.id };
  });
  if (seen.size !== source.layers.length) throw new Error('Removing existing layers is not supported by AI edits. Keep every original layer and its identity comment, even if its artwork moves to another layer.');
  return bound;
}

function assertLockedPixels(source, originalFrame, editedFrame, editedLayers, boundLayers) {
  source.layers.forEach(layer => {
    if (!layer.locked) return;
    const index = boundLayers.findIndex(item => item.id === layer.id);
    const before = getLayerPixels(originalFrame, layer.id);
    const after = getLayerPixels(editedFrame, editedLayers[index].id);
    if (before.some((pixel, offset) => pixel !== after[offset])) throw new Error(`The response changes pixels on locked layer ${quote(layer.name)}. Locked artwork must remain identical.`);
  });
}

/** Validate the complete response, merge only its allowed scope, and return an independent proposal. */
export function prepareEditResult(request, pxaText) {
  if (!object(request) || request.format !== REQUEST_FORMAT || request.version !== 1 || typeof request.id !== 'string' || !/^[a-z0-9_-]{1,100}$/i.test(request.id) || request.completionMarker !== completionMarkerFor(request.id)) {
    throw new Error('This edit request is invalid. Build a new edit prompt and try again.');
  }
  const context = contextFor(request.sourceProject, request);
  requireCompleteResponse(pxaText, request.completionMarker);
  const edited = decodeAIProject(pxaText);
  assertStructure(context.sourceProject, context.targetProject, edited);
  const layers = bindLayers(context, edited, pxaText, request.id);
  const merged = validateProject(context.sourceProject);
  merged.palette = [...edited.palette];
  merged.layers = layers;
  edited.animations.forEach((animation, animationIndex) => {
    const sourceAnimationIndex = context.scope === 'project' ? animationIndex : context.animationIndex;
    const originalAnimation = context.sourceProject.animations[sourceAnimationIndex];
    const order = getAnimationLayers(edited,animation).map(layer => layers[edited.layers.indexOf(layer)].id);
    const originalOrder = getAnimationLayers(context.sourceProject,originalAnimation).map(layer => layer.id);
    if (context.scope !== 'project' && order.some((id,index) => id !== originalOrder[index])) {
      throw new Error('Frame and animation edits must preserve the animation layer order. Use whole-project scope to reorder layers.');
    }
    if (context.scope === 'project') {
      for (const layer of context.sourceProject.layers) {
        if (layer.locked && order.indexOf(layer.id) !== originalOrder.indexOf(layer.id)) throw new Error(`Locked layer ${quote(layer.name)} must keep its position in every animation.`);
      }
      if (animation.layerOrder) merged.animations[sourceAnimationIndex].layerOrder = order;
      else delete merged.animations[sourceAnimationIndex].layerOrder;
    }
    animation.frames.forEach((frame, frameIndex) => {
      const sourceFrameIndex = context.scope === 'frame' ? context.frameIndex : frameIndex;
      const originalFrame = originalAnimation.frames[sourceFrameIndex];
      const frameOrder=getAnimationLayers(edited,animation,frame).map(layer=>layers[edited.layers.indexOf(layer)].id);
      const oldFrameOrder=getAnimationLayers(context.sourceProject,originalAnimation,originalFrame).map(layer=>layer.id);
      if(context.scope!=='project' && frameOrder.some((id,index)=>id!==oldFrameOrder[index]))throw new Error('Scoped edits must preserve frame object order.');
      for(const layer of context.sourceProject.layers)if(layer.locked && frameOrder.indexOf(layer.id)!==oldFrameOrder.indexOf(layer.id))throw new Error(`Locked layer ${quote(layer.name)} must keep its frame position.`);
      if(context.scope==='project') {
        if(frame.layerOrder)merged.animations[sourceAnimationIndex].frames[sourceFrameIndex].layerOrder=frameOrder;
        else delete merged.animations[sourceAnimationIndex].frames[sourceFrameIndex].layerOrder;
      }
      assertLockedPixels(context.sourceProject, originalFrame, frame, edited.layers, layers);
      merged.animations[sourceAnimationIndex].frames[sourceFrameIndex].cels = layers.map((layer, layerIndex) => ({
        layerId: layer.id, pixels: [...getLayerPixels(frame, edited.layers[layerIndex].id)],
      }));
    });
  });
  const project = validateProject(merged);
  const comparison = compareProjects(context.sourceProject, project);
  return {
    project, sourceProject: context.sourceProject, scope: context.scope,
    animationId: context.animationId, frameId: context.frameId,
    ...comparison,
    hasChanges: comparison.changes.pixels > 0 || comparison.changes.visiblePixels > 0 || comparison.changes.layers > 0 || comparison.changes.colorsAdded > 0,
  };
}
