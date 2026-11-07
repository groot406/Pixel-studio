import { createCompositionRequest, prepareCompositionResult } from './composition-edit.js';
import { commitRasterEdits } from '../../domain/artwork.js';
import { uid, validateProject } from '../../domain/project.js';
import { encodeAIProject } from '../../formats/pxa.js';
import { createEditRequest, prepareEditResult } from './edit.js';
import { buildInpaintPrompt, buildRecolorPrompt, previewInpaint, previewRecolor, selectionRect, allowedTargets } from './patch-engine.js';
import { compareProjects } from './comparison.js';
import { completionMarkerFor, requireCompleteResponse, validateDescription } from './response-contract.js';

/**
 * @typedef {object} EditOptions
 * @property {'edit'|'compose'|'inpaint'|'recolor'} mode
 * @property {'frame'|'animation'|'project'} scope
 * @property {string} instruction
 * @property {string} animationId
 * @property {string} frameId
 * @property {string} [layerId]
 * @property {{x:number,y:number,width:number,height:number}|null} [selection]
 */

/** All editing modes return independent snapshots; the dialog never edits live state. */
export function createAIRequest(project, /** @type {EditOptions} */ options) {
  if (options.mode === 'compose' || (options.mode === 'edit' && project.version === 3)) return createCompositionRequest(project, options);
  if (options.mode === 'edit') return { ...createEditRequest(project, options), mode: 'edit' };
  if (!['inpaint', 'recolor'].includes(options.mode)) throw new Error('Choose an AI editing action.');

  const sourceProject = validateProject(project);
  const instruction = validateDescription(options.instruction);
  const id = uid();
  const request = {
    format: 'pixel-studio-ai-patch', version: 1, id, mode: options.mode,
    instruction, sourceProject, completionMarker: completionMarkerFor(id),
    scope: options.mode === 'recolor' ? 'project' : options.scope,
    animationId: options.animationId, frameId: options.frameId, layerId: options.layerId,
  };

  if (options.mode === 'inpaint') {
    const animationIndex = sourceProject.animations.findIndex(animation => animation.id === options.animationId);
    const frameIndex = sourceProject.animations[animationIndex]?.frames.findIndex(frame => frame.id === options.frameId) ?? -1;
    const layerIndex = sourceProject.layers.findIndex(layer => layer.id === options.layerId);
    request.target = {
      scope: options.scope, animationIndex, frameIndex, layerIndex,
      selection: selectionRect(sourceProject, options.selection),
    };
    allowedTargets(sourceProject, request.target);
    request.prompt = buildInpaintPrompt({ project: sourceProject, request: request.target, description: instruction, originalPxa: encodeAIProject(sourceProject, {version:1}) });
  } else {
    request.prompt = buildRecolorPrompt({ project: sourceProject, description: instruction });
  }
  request.prompt += `\n\nAfter all required patch commands, finish with this exact comment as the final nonblank line:\n${request.completionMarker}\nDo not add it until the entire response is complete.\n`;
  return request;
}

/** Validate before preview, including completion, fingerprint, scope, and locks. */
export function prepareAIResult(request, text) {
  if (request?.format === 'pixel-studio-ai-composition') return prepareCompositionResult(request, text);
  if (request?.mode === 'edit') return prepareEditResult(request, text);
  if (request?.format !== 'pixel-studio-ai-patch' || request.version !== 1 || !['inpaint', 'recolor'].includes(request.mode) || typeof request.id !== 'string' || request.completionMarker !== completionMarkerFor(request.id)) {
    throw new Error('This edit request is invalid. Build a new edit prompt and try again.');
  }
  requireCompleteResponse(text, request.completionMarker);
  const result = request.mode === 'inpaint'
    ? previewInpaint(request.sourceProject, text, request.target)
    : previewRecolor(request.sourceProject, text);
  commitRasterEdits(request.sourceProject, result.project);
  const project = validateProject(result.project);
  return {
    ...result, project, sourceProject: request.sourceProject, scope: request.scope,
    animationId: request.animationId, frameId: request.frameId,
    ...compareProjects(request.sourceProject, project), hasChanges: true,
  };
}
