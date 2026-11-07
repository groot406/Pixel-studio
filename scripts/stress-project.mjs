/** Deterministic stress projects for `npm run bench` and the browser profile: layers, frames, parts, rotated/tilted/AA instances and a rig. */
import { validateProject, DEFAULT_PALETTE } from '../src/domain/project.js';
import { attachBone } from '../src/domain/skeleton.js';

/** Presets fill the 1,048,576 stored-pixel budget (or close to it) in different shapes. */
export const STRESS_PRESETS = {
  'big-canvas': { width: 128, height: 128, layers: 8, frames: 8 },
  'many-frames': { width: 40, height: 40, layers: 8, frames: 60 },
  'huge-canvas': { width: 256, height: 256, layers: 8, frames: 8 },
};

/** A seeded project: each layer holds painted spans, 30 instances in total (rotated, tilted, skewed, RotSprite and Smooth AA), and a 3-bone rig. */
export function makeStressProject({ width = 128, height = 128, layers = 8, frames = 8, instances = 30, name = 'Stress test' } = {}) {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const layerList = Array.from({ length: layers }, (_, i) => ({ id: `L${i}`, name: `Layer ${i + 1}`, visible: true, locked: false }));
  const parts = [
    { id: 'body', width: 10, height: 14, ops: [{ type: 'rect', x: 0, y: 0, width: 10, height: 14, color: 7 }, { type: 'ellipse', x: 2, y: 2, width: 6, height: 6, color: 5 }] },
    { id: 'limb', width: 4, height: 10, ops: [{ type: 'rect', x: 0, y: 0, width: 4, height: 10, color: 6 }, { type: 'line', x: 0, y: 0, x2: 3, y2: 9, color: 0 }] },
    { id: 'leaf', width: 12, height: 8, ops: [{ type: 'ellipse', x: 0, y: 0, width: 12, height: 8, color: 9 }, { type: 'line', x: 0, y: 4, x2: 11, y2: 4, color: 8 }] },
    { id: 'gem', width: 8, height: 8, ops: [{ type: 'ellipse', x: 0, y: 0, width: 8, height: 8, color: 15 }, { type: 'rect', x: 3, y: 3, width: 2, height: 2, color: 4 }] },
  ];
  const styles = [{}, { angle: 30 }, { angle: -45, sampling: 'rotsprite' }, { angle: 20, sampling: 'aa' }, { tilt: { x: 30, y: 0 } }, { skew: { x: 15, y: 0 } }, { transform: 'R90' }];
  const placed = Array.from({ length: instances }, (_, i) => ({
    layer: 1 + (i % Math.max(1, layers - 1)) % layers, id: `i${i}`, partId: parts[i % parts.length].id,
    x: Math.floor(random() * (width - 12)), y: Math.floor(random() * (height - 14)), style: styles[i % styles.length],
  }));
  const rig = [{ id: 'torso', partId: 'body', x: 8, y: 8 }, { id: 'arm', partId: 'limb', x: 18, y: 8 }, { id: 'hand', partId: 'limb', x: 18, y: 18 }];
  const frameList = Array.from({ length: frames }, (_, f) => ({
    id: `f${f}`, duration: 100,
    cels: layerList.map((layer, l) => {
      const ops = [];
      // Painted background spans on every layer: one row in four, shifting per frame.
      for (let y = l % 4; y < height; y += 4) {
        const x = (f + l * 3 + y) % Math.max(1, width - 8), length = Math.min(width - x, 6 + ((y + l) % 10));
        ops.push({ type: 'span', x, y, values: Array.from({ length }, (_, k) => (k + y + l + f) % 16) });
      }
      for (const item of placed) if (item.layer === l) {
        const angle = item.style.angle === undefined ? undefined : item.style.angle + f * 3;
        ops.push({ type: 'use', id: item.id, partId: item.partId, x: (item.x + f) % (width - 12), y: item.y, transform: item.style.transform || 'N', ...item.style, ...(angle === undefined ? {} : { angle }) });
      }
      if (l === 0) for (const bone of rig) ops.push({ type: 'use', id: bone.id, partId: bone.partId, x: bone.x, y: bone.y, transform: 'N' });
      return { layerId: layer.id, pixels: Array(width * height).fill(-1), source: { ops, overrides: [] } };
    }),
  }));
  let project = validateProject({
    format: 'pixel-studio', version: 3, name, width, height, palette: [...DEFAULT_PALETTE], layers: layerList, parts,
    animations: [{ id: 'A', name: 'Idle', fps: 12, frames: frameList }],
  });
  const at = { animationId: 'A', frameId: 'f0' };
  project = attachBone(project, { ...at, child: { layerId: 'L0', instanceId: 'arm' }, parent: { layerId: 'L0', instanceId: 'torso' }, point: { x: 18.5, y: 8.5 } }).project;
  project = attachBone(project, { ...at, child: { layerId: 'L0', instanceId: 'hand' }, parent: { layerId: 'L0', instanceId: 'arm' }, point: { x: 18.5, y: 18.5 } }).project;
  return project;
}
