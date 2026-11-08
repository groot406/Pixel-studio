/**
 * Edit scope: which frames of an animation an edit lands in. 'animation' = every frame, 'frame' = only the target
 * frame, or an array of frame ids = those frames (the target frame is always included).
 */
export function isEditScope(scope) {
  return scope === 'frame' || scope === 'animation' || (Array.isArray(scope) && scope.length > 0 && scope.every(id => typeof id === 'string'));
}
export function assertEditScope(scope, message = 'Choose this frame, selected frames or every frame.') {
  if (!isEditScope(scope)) throw new Error(message);
}
/** The frames of `animation` in scope, in timeline order. */
export function scopeFrames(animation, frame, scope) {
  if (scope === 'animation') return animation.frames;
  if (scope === 'frame') return [frame];
  const ids = new Set(scope);
  return animation.frames.filter(f => f === frame || ids.has(f.id));
}
/** True when the scope covers more than the target frame. */
export const isMultiFrame = (animation, frame, scope) => scopeFrames(animation, frame, scope).length > 1;
