import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAIProject } from '../src/formats/pxa.js';
import { compositeFrame } from '../src/domain/project.js';
import { layersToParts, partsAndRig, pixelLayers } from '../src/domain/auto-rig.js';
import { applyTemplate, lintPxa } from '../local/headless.mjs';

const body = Array.from({ length: 6 }, (_, i) => `SPAN 7 ${8 + i} 111111`).join('\n');
const head = Array.from({ length: 4 }, (_, i) => `SPAN 8 ${4 + i} 2222`).join('\n');
const arm = Array.from({ length: 5 }, (_, i) => `SPAN 13 ${8 + i} 33`).join('\n');
const PXA = `PXA 2
SIZE 20 20
NAME "Guy"
PAL #000000 #ff0000 #00ff00 #0000ff
LAYER torso "Body" 1 0
LAYER head "Head" 1 0
LAYER arm "Arm" 1 0
ANIM idle "Idle" 8
FRAME f1 100 CLEAR
CEL torso RASTER
${body}
CEL head RASTER
${head}
CEL arm RASTER
${arm}
FRAME f2 100 CLEAR
CEL torso RASTER
${body}
CEL head RASTER
${head.replaceAll('SPAN 8 ', 'SPAN 9 ')}
CEL arm RASTER
${arm}
END`;

test('layersToParts keeps pixels and shares identical drawings between frames', () => {
  const p = decodeAIProject(PXA), out = layersToParts(p);
  assert.equal(pixelLayers(out.project).length, 0);
  assert.deepEqual(out.converted.map(c => c.parts), [1, 1, 1]);
  for (const [i, f] of p.animations[0].frames.entries()) assert.deepEqual(compositeFrame(out.project, out.project.animations[0].frames[i]), compositeFrame(p, f));
  const uses = out.project.animations[0].frames.map(f => f.cels.find(c => c.layerId === 'head').source.ops.find(op => op.type === 'use'));
  assert.equal(uses[0].id, uses[1].id);
  assert.equal(uses[1].x, uses[0].x + 1);
});

test('partsAndRig roots the body and joins touching parts so templates work', () => {
  const r = partsAndRig(decodeAIProject(PXA));
  assert.equal(r.project.bones.find(b => b.id === r.rootBoneId).layerId, 'torso');
  assert.deepEqual(r.attached.map(a => a.parent).sort(), [r.rootBoneId, r.rootBoneId]);
  const t = applyTemplate(r.project, { template: 'idle' });
  assert.ok(t.frameIds.length > 1);
});

test('lint warns about raster-only and unrigged characters', () => {
  assert.match(lintPxa(PXA).warnings.join(' '), /make_parts/);
});
