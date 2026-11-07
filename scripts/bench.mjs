/** Editor hot-path benchmark on stress projects (Node, no DOM). `npm run bench [-- --json]`; run with --expose-gc for steadier memory numbers. */
import { performance } from 'node:perf_hooks';
import { makeStressProject, STRESS_PRESETS } from './stress-project.mjs';
import { validateProject, compositeFrame } from '../src/domain/project.js';
import { commitRasterEdits } from '../src/domain/artwork.js';
import { encodeAIProject } from '../src/formats/pxa.js';
import { cloneProject, sameValue, pushHistory } from '../src/domain/history.js';

const clone = value => JSON.parse(JSON.stringify(value));
/** Median milliseconds of `runs` calls (after one warm-up). */
function time(action, runs = 7) {
  action();
  const samples = [];
  for (let i = 0; i < runs; i++) { const start = performance.now(); action(); samples.push(performance.now() - start); }
  return +samples.sort((a, b) => a - b)[runs >> 1].toFixed(2);
}

/** One pencil stroke as the editor commits it: snapshot before, edit the cel buffer, commit raster edits, validate, compare. */
function strokeCommit(project, legacy = false) {
  const copy = legacy ? clone : cloneProject;
  const before = copy(project), after = copy(project);
  const cel = after.animations[0].frames[0].cels.at(-1);
  for (let i = 0; i < 40; i++) cel.pixels[i * 3] = 2;
  commitRasterEdits(before, after);
  const clean = validateProject(after);
  return legacy ? JSON.stringify(before) !== JSON.stringify(clean) : !sameValue(before, clean);
}
/** Approximate heap growth (MB) of 40 one-stroke undo entries, legacy full copies or shared history. */
function undoMemory(project, legacy) {
  globalThis.gc?.();
  const start = process.memoryUsage().heapUsed, stack = [];
  let current = cloneProject(project);
  for (let i = 0; i < 40; i++) {
    const before = { project: legacy ? clone(current) : cloneProject(current) };
    current.animations[0].frames[i % current.animations[0].frames.length].cels[0].pixels[i] = 1;
    if (legacy) stack.push(before); else pushHistory(stack, before);
  }
  globalThis.gc?.();
  return Math.round((process.memoryUsage().heapUsed - start) / 1048576);
}

const rows = [];
for (const [name, preset] of Object.entries(STRESS_PRESETS)) {
  const project = makeStressProject(preset), frames = project.animations.flatMap(a => a.frames);
  const json = JSON.stringify(project);
  rows.push({
    preset: name, size: `${preset.width}×${preset.height}`, layers: preset.layers, frames: preset.frames,
    validateMs: time(() => validateProject(project), 3),
    snapshotLegacyMs: time(() => clone(project)),
    snapshotMs: time(() => cloneProject(project)),
    strokeCommitLegacyMs: time(() => strokeCommit(project, true), 3),
    strokeCommitMs: time(() => strokeCommit(project), 3),
    compositeAllMs: time(() => { for (const frame of frames) compositeFrame(project, frame); }),
    saveRecordMs: time(() => validateProject(project), 3),
    journalJsonMs: time(() => JSON.stringify(project)),
    journalKB: Math.round(json.length / 1024),
    pxaKB: Math.round(encodeAIProject(project, { version: 2 }).length / 1024),
    undo40LegacyMB: undoMemory(project, true),
    undo40MB: undoMemory(project, false),
  });
}
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
else console.table(rows);
