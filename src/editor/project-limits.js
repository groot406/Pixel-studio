/** Read-only help page. Values come from the same limits used by project validation. */
import { MAX_LAYERS, MAX_TOTAL_PIXELS, MAX_SIZE, MAX_COLORS, MAX_ANIMATIONS, MAX_FRAMES_PER_ANIMATION, MAX_TOTAL_FRAMES } from '../domain/limits.js';
import { projectCapacity } from '../domain/project-capacity.js';

const format = value => value.toLocaleString('en-US');

export function projectLimitsMarkup(project) {
  const { frames, layers, storedPixels, nextLayerPixels } = projectCapacity(project);
  const examples = [[32, 32, 8], [128, 128, 16], [256, 256, 16], [256, 256, 64]];
  return `<div class="project-limits">
    <h3>Limits for this project</h3>
    <p>These editor limits protect memory, editing speed and saving. They apply to every plan.</p>
    <dl class="project-limit-usage" aria-label="Current project usage">
      <div><dt>Layers / object containers</dt><dd>${format(layers)} / ${format(MAX_LAYERS)}</dd></div>
      <div><dt>Canvas pixels across all frames and layers</dt><dd>${format(storedPixels)} / ${format(MAX_TOTAL_PIXELS)}</dd></div>
    </dl>
    <h3>How the pixel budget works</h3>
    <p>Canvas width × height × total frames × layers. Every frame in every animation counts, including transparent pixels and hidden layers. A small object in its own layer still uses a full canvas in every frame.</p>
    <p class="project-limit-formula">${format(project.width)} × ${format(project.height)} × ${format(frames)} frame${frames === 1 ? '' : 's'} × ${format(layers)} layer${layers === 1 ? '' : 's'} = <strong>${format(storedPixels)} pixels</strong></p>
    <p>Adding one layer would bring this project to <strong>${format(nextLayerPixels)} pixels</strong>${nextLayerPixels > MAX_TOTAL_PIXELS ? ', above the pixel limit' : ''}${layers >= MAX_LAYERS ? '. The layer limit is already reached' : ''}.</p>
    <table class="project-limit-examples"><caption>Examples: maximum layers within the pixel budget</caption><thead><tr><th scope="col">Canvas</th><th scope="col">Total frames</th><th scope="col">Max. layers</th></tr></thead><tbody>${examples.map(([width, height, count]) => `<tr><td>${width} × ${height}</td><td>${count}</td><td>${Math.min(MAX_LAYERS, Math.floor(MAX_TOTAL_PIXELS / (width * height * count)))}</td></tr>`).join('')}</tbody></table>
    <h3>When you reach a limit</h3>
    <p>Group or merge layers, delete unused layers or frames, reduce the canvas size, or split animations into separate projects. Grouping keeps objects editable; merging bakes their artwork into pixels. Hiding artwork does not free capacity.</p>
    <h3>Other project limits</h3>
    <ul><li>Canvas: up to ${format(MAX_SIZE)} × ${format(MAX_SIZE)} pixels, within the same pixel budget.</li><li>Palette: ${MAX_COLORS} colors.</li><li>Animations: ${MAX_ANIMATIONS}; frames: ${MAX_FRAMES_PER_ANIMATION} per animation and ${format(MAX_TOTAL_FRAMES)} across the project.</li><li>PXA text import/export: 4 MiB. PXS binary payload: 8 MiB. PXA 2 preserves editable shared objects; PXS bakes them into pixels.</li></ul>
    <h3>Cloud storage is a separate limit</h3>
    <p>Cloud editions also have plan-based limits on saved file sizes and project counts. Check your account for your plan’s allowance. These are separate from the editor’s layer and pixel limits.</p>
  </div>`;
}
