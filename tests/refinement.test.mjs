import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readPreviewImages } from '../local/pixel-request.mjs';
import { decodeAIProject } from '../src/formats/pxa.js';
import { createAIRequest, prepareAIResult } from '../src/features/ai/requests.js';
import { createRefinementRequest, refinementFrames, renderRefinementPreview } from '../src/features/ai/refinement.js';
import { sparklePxa } from './fixtures/pxa-v2.mjs';

test('refinement is one optional pass against the proposal and retains scoped validation',()=>{
  const source=decodeAIProject(sparklePxa), original=createAIRequest(source,{mode:'edit',scope:'frame',animationId:'idle',frameId:'f0',instruction:'Move the sparkle.'});
  const proposal=prepareAIResult(original,`PXAPATCH 2\nBASE ${original.baseFingerprint}\nTARGET idle f0 effects\nAT glint 6 4\nEND\n${original.completionMarker}`).project;
  const next=createRefinementRequest(proposal,original);
  assert.deepEqual(next.sourceProject,proposal);
  assert.match(next.prompt,/image 1 is the original/);
  assert.throws(()=>createRefinementRequest(proposal,next),/one extra/);
  assert.throws(()=>prepareAIResult(next,`PXAPATCH 2\nBASE ${next.baseFingerprint}\nTARGET idle f1 effects\nAT glint 8 4\nEND\n${next.completionMarker}`),/scope/);
  const unchanged=prepareAIResult(next,`PXAPATCH 2\nBASE ${next.baseFingerprint}\nEND\n${next.completionMarker}`);
  assert.deepEqual(unchanged.project,proposal);
});
test('contact sheets sample both ends of a long animation and stay within the PNG transport bounds',()=>{
  const p=decodeAIProject(sparklePxa);
  p.animations[0].frames=Array.from({length:40},(_,i)=>({...structuredClone(p.animations[0].frames[0]),id:`f${i}`}));
  const refs=refinementFrames(p,{scope:'animation',animationId:'idle'});
  assert.equal(refs.length,16);assert.equal(refs[0].frameId,'f0');assert.equal(refs.at(-1).frameId,'f39');
  let canvas;
  renderRefinementPreview(p,refs,()=>canvas={getContext:()=>({fillRect(){},fillText(){}}),toDataURL:()=>''});
  assert.ok(canvas.width<=1024 && canvas.height<=1024);
});
test('preview transport accepts bounded PNGs and rejects paths, URLs, oversized images and malformed data',async()=>{
  const png=await readFile(new URL('../public/samples/key.png',import.meta.url));
  const data=`data:image/png;base64,${png.toString('base64')}`;
  assert.deepEqual(readPreviewImages([data]),[png]);
  const huge=Buffer.from(png);huge.writeUInt32BE(100000,16);
  for(const value of [['/private/image.png'],['https://example.test/image.png'],[data,data,data],['data:image/png;base64,bm90LXBuZw=='],[`data:image/png;base64,${huge.toString('base64')}`],null]) assert.throws(()=>readPreviewImages(value));
});
