import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAIProject, encodeAIProject } from '../src/formats/pxa.js';
import { compositeFrame } from '../src/domain/project.js';
import { stripOutlines, suggestOutlineColours } from '../src/domain/live-outline.js';
import { setOutline } from '../local/headless.mjs';

const doc = (head, body) => `PXA 2
SIZE 10 10
NAME "t"
PAL #000000 #ff0000 #ffffff
LAYER bg "Back" 1 0
LAYER a "Art" 1 0
${head}ANIM x "X" 8
${body}
END`;
const grid = px => Array.from({ length: 10 }, (_, y) => px.slice(y * 10, y * 10 + 10).map(v => (v < 0 ? '.' : v)).join(''));
const frames = p => p.animations[0].frames;

test('the live outline follows the art in every frame and is never stored', () => {
  const p = decodeAIProject(doc('OUTLINE 0\n', 'FRAME f1 100 CLEAR\nCEL a RASTER\nSPAN 2 2 11\nFRAME f2 100 FROM f1\nCEL a RASTER\nSHIFT 4 3'));
  assert.deepEqual(grid(compositeFrame(p, frames(p)[1])).slice(4, 7), ['......00..', '.....0110.', '......00..']);
  assert.equal(frames(p)[1].cels[1].pixels.filter(v => v === 0).length, 0);
  assert.equal(compositeFrame(p, frames(p)[0], { outline: false }).filter(v => v === 0).length, 0);
});

test('OUTLINE options round-trip through PXA 2', () => {
  const p = decodeAIProject(doc('OUTLINE AUTO CORNERS THICK 2 SEPARATE SKIP bg\n', 'FRAME f1 100 CLEAR\nCEL a RASTER\nSPAN 4 4 1'));
  assert.deepEqual(p.outline, { color: -1, style: 'selective', mode: 'outside', corners: true, thickness: 2, separate: true, skip: ['bg'] });
  assert.match(encodeAIProject(p, { version: 2 }), /^OUTLINE AUTO CORNERS THICK 2 SEPARATE SKIP bg$/m);
});

test('skipped layers get no outline, separate layers each get their own', () => {
  const body = 'FRAME f1 100 CLEAR\nCEL bg RASTER\nSPAN 0 0 2222222222\nCEL a RASTER\nSPAN 3 5 11\nSPAN 3 6 2';
  const skip = decodeAIProject(doc('OUTLINE 0 SKIP bg\n', body)), pix = compositeFrame(skip, frames(skip)[0]);
  assert.equal(grid(pix)[0], '2222222222');
  assert.equal(grid(pix)[4], '...00.....');
  const sep = decodeAIProject(doc('OUTLINE 0 SEPARATE\n', 'FRAME f1 100 CLEAR\nCEL bg RASTER\nSPAN 2 4 22222\nCEL a RASTER\nSPAN 3 4 2'));
  assert.equal(grid(compositeFrame(sep, frames(sep)[0]))[4], '.0020220..');
});

test('stripOutlines removes baked outlines from raster cels and parts, keeping interior pixels', () => {
  const p = decodeAIProject(doc(`PART blob 4 4
SPAN 0 0 0000
SPAN 0 1 0100
SPAN 0 2 0110
SPAN 0 3 0000
ENDPART
`, `FRAME f1 100 CLEAR
CEL bg RASTER
SPAN 0 7 000
SPAN 0 8 010
SPAN 0 9 000
CEL a
USE b blob 4 1`));
  assert.deepEqual(suggestOutlineColours(p), [0]);
  const r = stripOutlines(p, { colors: [0] });
  assert.equal(r.parts, 1);
  const pix = compositeFrame(r.project, frames(r.project)[0]);
  assert.equal(pix.filter(v => v === 0).length, 1, 'only the interior black pixel of the part remains');
  assert.equal(grid(pix)[8], '.1........');
  const lined = setOutline(r.project, { live: true });
  assert.equal(lined.outline.color, 0);
});
