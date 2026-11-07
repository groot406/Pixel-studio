import { readFile } from 'node:fs/promises';
import { decodeAIProject } from '../../src/formats/pxa.js';
import { validateProject } from '../../src/domain/project.js';
import { pixelSpans } from '../../src/domain/artwork.js';

export const sparklePxa = `PXA 2
SIZE 16 16
NAME "Reusable sparkle"
PAL #111111 #ffdc70 #ffffff
LAYER back "Background" 1 0
LAYER effects "Effects" 1 0
PART star 5 5
RECT 2 0 1 5 1
RECT 0 2 5 1 1
SPAN 2 2 2
ENDPART
ANIM idle "Idle" 8
FRAME f0 125 CLEAR
CEL back
RECT 0 0 16 16 0
CEL effects
USE glint star 3 4
FRAME f1 125 FROM f0
CEL effects
AT glint 7 4
FRAME f2 250 FROM f0
CEL effects
OVERRIDE 5 6 .
ANIM still "Still" 7.5
FRAME f3 200 FROM f0
END
`;

/** Deliberately authored decomposition of the original key, preserving exact pixels. */
export async function keyPrototype() {
  const original = decodeAIProject(await readFile(new URL('../../public/samples/key.pxa', import.meta.url), 'utf8'));
  const p = structuredClone(original);
  p.version = 3;
  p.layers[0].id = 'art';
  p.parts = [
    { id: 'key', width: 32, height: 32, ops: pixelSpans(original.animations[0].frames[0].cels[0].pixels, 32) },
    { id: 'glint', width: 3, height: 3, ops: [
      { type: 'rect', x: 1, y: 0, width: 1, height: 3, color: 4 },
      { type: 'rect', x: 0, y: 1, width: 3, height: 1, color: 4 },
      { type: 'span', x: 1, y: 1, values: [5] },
    ] },
    { id: 'sparkle', width: 5, height: 5, ops: [
      { type: 'rect', x: 2, y: 0, width: 1, height: 5, color: 5 },
      { type: 'rect', x: 0, y: 2, width: 5, height: 1, color: 5 },
      { type: 'span', x: 2, y: 2, values: [7] },
    ] },
  ];
  for (const [ai, a] of p.animations.entries()) {
    a.id = ai ? 'sparkle' : 'idle';
    for (const [fi, f] of a.frames.entries()) {
      f.id = `${a.id}_${fi}`;
      const ops = [{ type: 'use', id: 'body', partId: 'key', x: 0, y: 0, transform: 'N' }];
      if (ai) {
        ops.push({ type: 'use', id: 'shine', partId: fi % 2 ? 'sparkle' : 'glint', x: [20,19,5,4][fi], y: [6,5,21,20][fi], transform: 'N' });
        if (fi === 1 || fi === 3) ops.push({ type: 'span', x: fi === 1 ? 17 : 2, y: fi === 1 ? 11 : 26, values: [4] });
      }
      f.cels = [{ layerId: 'art', source: { ops, overrides: [] } }];
    }
  }
  return { original, project: validateProject(p) };
}
