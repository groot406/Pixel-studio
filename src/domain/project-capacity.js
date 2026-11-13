/** Project allocation capacity, shared by object operations and the editor's limits page. */
import { MAX_LAYERS, MAX_TOTAL_PIXELS } from './limits.js';

export function projectCapacity(project) {
  const frames = project.animations.reduce((sum, animation) => sum + animation.frames.length, 0);
  const layers = project.layers.length;
  const pixelsPerLayer = project.width * project.height * frames;
  return { frames, layers, storedPixels: pixelsPerLayer * layers, nextLayerPixels: pixelsPerLayer * (layers + 1) };
}

/** Check the allocation before inserting a container into every frame. */
export function assertCanAddLayer(project) {
  const { frames, layers, storedPixels, nextLayerPixels } = projectCapacity(project);
  if (layers >= MAX_LAYERS) {
    throw new Error(`Layer limit reached (${layers}/${MAX_LAYERS}). Group or merge existing layers, or remove unused layers before adding another. See Help → Limits.`);
  }
  if (nextLayerPixels > MAX_TOTAL_PIXELS) {
    const format = value => value.toLocaleString('en-US');
    throw new Error(`Project pixel limit reached: ${format(storedPixels)} of ${format(MAX_TOTAL_PIXELS)} pixels used. Adding a layer would use ${format(nextLayerPixels)} pixels total (${project.width} × ${project.height} × ${frames} frames × ${layers + 1} layers). Reduce canvas size, frames or layers. See Help → Limits.`);
  }
}
