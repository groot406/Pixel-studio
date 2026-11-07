import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAIProject, encodeAIProject } from '../src/formats/pxa.js';
import { validateProject, makeLayeredFrame } from '../src/domain/project.js';
import { commitRasterEdits } from '../src/domain/artwork.js';
import { encodePixelProject, decodePixelProject } from '../src/formats/pxs.js';
import { artwork } from './fixtures/project.mjs';
import { readFile } from 'node:fs/promises';
import { AI_FORMAT_GUIDE } from '../src/formats/pxa.js';
import { PXA2_GUIDE } from '../src/formats/pxa-v2.js';
import { sparklePxa, keyPrototype } from './fixtures/pxa-v2.mjs';

test('prototype key shares its body and sparkles with exact legacy artwork', async () => {
  const { original, project } = await keyPrototype();
  assert.deepEqual(artwork(project), artwork(original));
  assert.deepEqual(decodeAIProject(encodeAIProject(project)), project);
  assert.deepEqual(decodeAIProject(encodeAIProject(project).replace('PXA 2', 'PXA\t2').replace(/\n/g, '\r')), project);
  assert.deepEqual(artwork(decodeAIProject(encodeAIProject(project, {version:1}))), artwork(original));
  assert.deepEqual(artwork(await decodePixelProject(await encodePixelProject(project))), artwork(original));
});
test('placements rebuild without trails, snapshot frames are independent, and overrides erase', () => {
  const p = decodeAIProject(sparklePxa);
  assert.equal(p.version, 3);
  const [a,b,c] = p.animations[0].frames;
  assert.equal(a.cels[1].pixels[6*16+5], 2);
  assert.equal(b.cels[1].pixels[6*16+5], -1);
  assert.equal(b.cels[1].pixels[6*16+9], 2);
  assert.equal(c.cels[1].pixels[6*16+5], -1);
  a.cels[1].source.ops[0].x = 1;
  assert.equal(b.cels[1].source.ops[0].x, 7);
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(p))), decodeAIProject(encodeAIProject(p)));
});
test('paint commits local overrides and shared part edits survive reload', () => {
  const before = decodeAIProject(sparklePxa), after = structuredClone(before);
  after.animations[0].frames[0].cels[1].pixels[6*16+5] = -1;
  commitRasterEdits(before, after);
  const stored = validateProject(JSON.parse(JSON.stringify(after)));
  stored.parts[0].ops[2].values = [1];
  const changed = validateProject(stored);
  assert.equal(changed.animations[0].frames[0].cels[1].pixels[6*16+5], -1);
  assert.equal(changed.animations[0].frames[1].cels[1].pixels[6*16+9], 1);
  const copy = makeLayeredFrame(changed, changed.animations[0].frames[0]);
  assert.deepEqual(copy.cels, changed.animations[0].frames[0].cels);
  copy.cels[1].source.ops[0].x++;
  assert.notDeepEqual(copy.cels[1].source, changed.animations[0].frames[0].cels[1].source);
});
test('v2 rejects incomplete, ambiguous and excessive input before use', () => {
  for (const [from,to] of [
    ['END\n',''], ['USE glint star','USE glint missing'], ['AT glint 7 4','AT missing 7 4'],
    ['SPAN 2 2 2','SPAN 4 2 2{200}'], ['PART star 5 5','PART star 129 5'],
    ['FRAME f1 125 FROM f0','FRAME f1 125 FROM f1'], ['LAYER back','LAYER effects'],
    ['SPAN 2 2 2','USE recursive star 0 0'], ['FRAME f1','FRAME f0'],
    ['RECT 0 2 5 1 1','RECT 0 2 6 1 1'], ['PAL #111111','PAL nope'],
  ]) assert.throws(() => decodeAIProject(sparklePxa.replace(from,to)), `${from} -> ${to}`);
});
test('rotation preserves asymmetric pixels on a rectangular part', () => {
  const p = decodeAIProject(sparklePxa.replace('PART star 5 5\nRECT 2 0 1 5 1\nRECT 0 2 5 1 1\nSPAN 2 2 2', 'PART star 2 3\nSPAN 0 0 12\nSPAN 1 2 2').replace('USE glint star 3 4','USE glint star 3 4 R90'));
  const pixels = p.animations[0].frames[0].cels[1].pixels;
  assert.equal(pixels[4*16+5], 1);
  assert.equal(pixels[5*16+5], 2);
  assert.equal(pixels[5*16+3], 2);
});

test('guides used by prompts and downloads remain identical', async () => {
  assert.equal(await readFile(new URL('../public/pxa-format.txt',import.meta.url),'utf8'),AI_FORMAT_GUIDE+'\n');
  assert.equal(await readFile(new URL('../public/pxa-v2-format.txt',import.meta.url),'utf8'),PXA2_GUIDE+'\n');
});
test('bounded frame inheritance round trips at the operation budget and rejects excessive rendering', () => {
  const p=decodeAIProject('PXA 2\nSIZE 1 1\nNAME "Budget"\nPAL #123456\nLAYER art "Art" 1 0\nANIM a "A" 8\nFRAME f 125 CLEAR\nCEL art\nRECT 0 0 1 1 0\nEND');
  const source={ops:Array.from({length:32},()=>({type:'rect',x:0,y:0,width:1,height:1,color:0})),overrides:[]};
  p.animations=Array.from({length:4},(_,a)=>({id:`a${a}`,name:`A${a}`,fps:8,frames:Array.from({length:256},(_,f)=>({id:`f${a}_${f}`,duration:125,cels:[{layerId:'art',source:structuredClone(source)}]}))}));
  const clean=validateProject(p);
  assert.deepEqual(decodeAIProject(encodeAIProject(clean)),clean);
  const excessive='PXA 2\nSIZE 1 1\nNAME "Work"\nPAL #123456\nLAYER art "Art" 1 0\nPART huge 128 128\nRECT 0 0 128 128 0\nENDPART\nANIM a "A" 8\nFRAME f 125 CLEAR\nCEL art\n'+Array.from({length:513},(_,i)=>`USE p${i} huge 0 0`).join('\n')+'\nEND';
  assert.throws(()=>decodeAIProject(excessive),/budget/);
});

test('raster decoding bounds repeated full-canvas shifts', () => {
  const text = 'PXA 2\nSIZE 128 128\nNAME "Shift budget"\nPAL #123456\nLAYER art "Art" 1 0\nANIM a "A" 8\nFRAME f 125 CLEAR\nCEL art RASTER\n';
  assert.throws(() => decodeAIProject(text + 'SHIFT 1 0\n'.repeat(513) + 'END'), /Raster decoding work budget/);
});
