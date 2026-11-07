/** Scoped composition proposals. Format parsing never decides editing authority. */
import { validateProject, uid } from '../../domain/project.js';
import { cloneArtwork, sourceForCel, hasLockedInstances } from '../../domain/artwork.js';
import { encodePXA2, PXA2_COMMAND_GUIDE, pxa2Lines, argumentsCount, partDeclaration, drawingCommand, applyCelCommand } from '../../formats/pxa-v2.js';
import { projectFingerprint } from './patch-engine.js';
import { compareProjects } from './comparison.js';
import { completionMarkerFor, requireCompleteResponse, validateDescription } from './response-contract.js';

const key = (a, f, l) => `${a}/${f}/${l}`;
export function compositionTargets(project, options) {
  if (!['frame','animation','project'].includes(options.scope)) throw new Error('Choose a frame, animation or project scope.');
  const animation = project.animations.find(a => a.id === options.animationId);
  if (options.scope !== 'project' && !animation) throw new Error('Unknown animation.');
  if (options.scope === 'frame' && !animation.frames.some(f => f.id === options.frameId)) throw new Error('Unknown frame.');
  const targets = [];
  for (const a of project.animations) for (const f of a.frames) for (const l of project.layers) {
    if (l.locked || hasLockedInstances(f.cels.find(c=>c.layerId===l.id)) || (options.scope !== 'project' && a.id !== options.animationId) || (options.scope === 'frame' && f.id !== options.frameId)) continue;
    targets.push(key(a.id,f.id,l.id));
  }
  if (!targets.length) throw new Error('Unlock a layer before requesting an edit.');
  return targets;
}
function partUses(project) {
  const uses = new Map();
  for (const a of project.animations) for (const f of a.frames) for (const c of f.cels) for (const op of c.source?.ops || []) {
    if (op.type !== 'use') continue;
    if (!uses.has(op.partId)) uses.set(op.partId, new Set());
    uses.get(op.partId).add(key(a.id,f.id,c.layerId));
  }
  return uses;
}
export function createCompositionRequest(project, options) {
  const sourceProject = validateProject(project), id = uid();
  const instruction = validateDescription(options.instruction);
  const targets = compositionTargets(sourceProject, options), allowed = new Set(targets);
  const context = cloneArtwork(sourceProject);
  context.animations = context.animations.filter(a => options.scope === 'project' || a.id === options.animationId);
  if (options.scope === 'frame') context.animations[0].frames = context.animations[0].frames.filter(f => f.id === options.frameId);
  const uses = partUses(sourceProject), needed = new Set(partUses(context).keys());
  if (context.parts) context.parts = context.parts.filter(p => needed.has(p.id));
  const completionMarker = completionMarkerFor(id), baseFingerprint = projectFingerprint(sourceProject);
  const libraryRules = [...needed].map(partId => `${partId}: ${[...uses.get(partId)].every(k => allowed.has(k)) ? 'shared definition editable' : 'shared definition protected; fork it and SWAP selected instances'}`).join('\n');
  const prompt = `Edit this Pixel Studio artwork: ${instruction}
Return only PXAPATCH 2, not a whole project. Keep unrelated artwork, palette, objects, groups, names, timing and frame counts. Preserve object visibility and lock flags. Groups containing locked objects are protected.
Required header:
PXAPATCH 2
BASE ${baseFingerprint}
Select only allowed TARGET animation-id frame-id layer-id entries from:
${targets.map(t => t.split('/').join(' ')).join('\n')}
After TARGET, use PXA 2 cel drawing/instance commands or CLEAR to empty that cel. SPAN/OVERRIDE coordinates are x then y. Omitted targets and pixels stay unchanged. Use absolute AT positions.
PART id width height ... ENDPART replaces that definition completely. PART new-id FROM old-id ... ENDPART copies a part and applies drawing commands. All references to an edited shared definition must be in scope and unlocked, even hidden ones. Prefer a fork plus SWAP for local changes. No nested parts. Preserve palette slots; use the separate recolor action to recolor them.
${libraryRules}
Finish commands with END, then this exact final comment:
${completionMarker}
PXA 2 drawing reference (use TARGET instead of CEL):
${PXA2_COMMAND_GUIDE}
READ-ONLY SOURCE FOR THIS SCOPE (other frames remain in the host project):
${encodePXA2(context)}`;
  return { format:'pixel-studio-ai-composition', version:2, id, mode:options.mode === 'compose' ? 'compose' : 'edit', scope:options.scope, animationId:options.animationId, frameId:options.frameId, instruction, sourceProject, baseFingerprint, completionMarker, prompt };
}

export function prepareCompositionResult(request, text) {
  if (request?.format !== 'pixel-studio-ai-composition' || request.version !== 2 || request.completionMarker !== completionMarkerFor(request.id)) throw new Error('Invalid composition request.');
  requireCompleteResponse(text, request.completionMarker);
  const before = validateProject(request.sourceProject), allowed = new Set(compositionTargets(before, request));
  if (projectFingerprint(before) !== request.baseFingerprint) throw new Error('Project changed since the request.');
  const project = cloneArtwork(before);
  project.version = 3; project.parts ||= [];
  let cel, part, seenBase = false;
  const touchedParts = new Set();
  for (const {tokens:t, number} of pxa2Lines(text,'PXAPATCH 2')) {
    try {
      if (!seenBase) {
        argumentsCount(t,1);
        if (t[0] !== 'BASE' || t[1] !== request.baseFingerprint) throw new Error('Wrong BASE fingerprint.');
        seenBase = true; continue;
      }
      if (part) {
        if (t[0] === 'ENDPART') {
          argumentsCount(t,0);
          const i = project.parts.findIndex(p => p.id === part.id);
          if (i < 0) project.parts.push(part); else project.parts[i] = part;
          touchedParts.add(part.id); part = null; continue;
        }
        const draw = drawingCommand(t);
        if (!draw || t[0] === 'OVERRIDE') throw new Error('Expected a part drawing command or ENDPART.');
        part.ops.push(draw); continue;
      }
      if (t[0] === 'PART') { part = partDeclaration(t, project.parts, true); cel = null; continue; }
      if (t[0] === 'TARGET') {
        argumentsCount(t,3);
        if (!allowed.has(key(t[1],t[2],t[3]))) throw new Error('Target is locked or outside the edit scope.');
        cel = project.animations.find(a => a.id === t[1]).frames.find(f => f.id === t[2]).cels.find(c => c.layerId === t[3]);
        cel.source = sourceForCel(cel,project.width); continue;
      }
      if (!cel) throw new Error('Select TARGET before editing artwork.');
      if (t[0] === 'CLEAR') { argumentsCount(t,0); cel.source = {ops:[],overrides:[]}; }
      else applyCelCommand(cel.source,t);
    } catch(error) { throw new Error(`Line ${number}: ${error.message}`); }
  }
  if (!seenBase || part) throw new Error('Incomplete composition patch.');
  const uses = partUses(before);
  for (const id of touchedParts) {
    const old = before.parts?.find(p => p.id === id), next = project.parts.find(p => p.id === id);
    if (old && JSON.stringify(old) !== JSON.stringify(next) && [...(uses.get(id) || [])].some(k => !allowed.has(k))) throw new Error(`Shared part ${id} affects locked or out-of-scope artwork. Fork it and SWAP selected instances instead.`);
  }
  const result = validateProject(project);
  // Defense in depth: inspect final cels as well as the command targets and reference graph.
  for (const a of before.animations) for (const f of a.frames) for (const c of f.cels) {
    if (allowed.has(key(a.id,f.id,c.layerId))) continue;
    const next = result.animations.find(x => x.id === a.id).frames.find(x => x.id === f.id).cels.find(x => x.layerId === c.layerId);
    if (JSON.stringify(c) !== JSON.stringify(next)) throw new Error('Patch changes protected artwork.');
  }
  const comparison = compareProjects(before,result);
  return {project:result,sourceProject:before,scope:request.scope,animationId:request.animationId,frameId:request.frameId,...comparison,hasChanges:JSON.stringify(before)!==JSON.stringify(result)};
}
