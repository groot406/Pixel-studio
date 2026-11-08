/**
 * The Edit switch above the canvas: state.objectScope is 'animation' (All frames), 'frame' (This frame) or
 * 'selected' (the frames picked in the timeline). These helpers turn it into the scope the domain functions take.
 */
import { selectedFrames } from './timeline.js';

const pickedIds = state => {
  const ids = selectedFrames().map(f => f.id);
  return ids.includes(state.frameId) ? ids : [state.frameId, ...ids];
};

/** 'animation' | 'frame' | [frame ids] for domain calls. Selected mode with one picked frame acts as This frame. */
export function editScope(state) {
  if (state.objectScope !== 'selected') return state.objectScope === 'frame' ? 'frame' : 'animation';
  const ids = pickedIds(state);
  return ids.length > 1 ? ids : 'frame';
}

/** The frame ids an edit lands in, in timeline order. */
export function editFrameIds(state, animation) {
  const scope = editScope(state);
  if (scope === 'animation') return animation.frames.map(f => f.id);
  if (scope === 'frame') return [state.frameId];
  return animation.frames.filter(f => scope.includes(f.id)).map(f => f.id);
}

/** "all 6 frames", "3 selected frames" or "this frame", for messages. */
export function editScopeText(state, animation) {
  const scope = editScope(state), n = editFrameIds(state, animation).length;
  if (n <= 1) return 'this frame';
  return scope === 'animation' ? `all ${n} frames` : `${n} selected frames`;
}
