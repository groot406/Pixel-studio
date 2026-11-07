import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAIProject, encodeAIProject } from '../src/formats/pxa.js';
import { validateProject, compositeFrame, floodFill } from '../src/domain/project.js';
import { extractPart, placePart, changeInstance, forkInstance, paintSharedPart, flattenCel } from '../src/domain/parts.js';
import { commitRasterEdits } from '../src/domain/artwork.js';
import { sparklePxa } from './fixtures/pxa-v2.mjs';
const target={animationId:'idle',frameId:'f0',layerId:'effects'};

test('extracting and placing parts preserves the original image and existing references',()=>{
  const p=decodeAIProject(sparklePxa), old=compositeFrame(p,p.animations[0].frames[0]);
  const next=extractPart(p,target,{x:3,y:4,width:5,height:5},'extracted');
  assert.deepEqual(compositeFrame(next,next.animations[0].frames[0]),old);
  assert.equal(next.animations[0].frames[0].cels[1].source.ops[0].id,'glint');
  const moved=changeInstance(next,target,'extracted',{x:10,y:8});
  assert.equal(moved.animations[0].frames[0].cels[1].pixels[6*16+5],-1);
  const placed=placePart(moved,target,'star',0,0);
  assert.deepEqual(decodeAIProject(encodeAIProject(placed)),placed);
});
test('independent instance edits, shared locks, and explicit flattening have distinct effects',()=>{
  const p=decodeAIProject(sparklePxa), independent=forkInstance(p,target,'glint');
  const id=independent.animations[0].frames[0].cels[1].source.ops[0].partId;
  const edited=paintSharedPart(independent,id,Array(25).fill(1));
  assert.deepEqual(edited.animations[0].frames[1],p.animations[0].frames[1]);
  edited.layers[1].locked=true;
  assert.throws(()=>paintSharedPart(edited,id,Array(25).fill(2)),/locked/);
  edited.layers[1].locked=false;
  const flat=flattenCel(edited,target);
  assert.equal(flat.animations[0].frames[0].cels[1].source,undefined);
  assert.deepEqual(flat.animations[0].frames[0].cels[1].pixels,edited.animations[0].frames[0].cels[1].pixels);
});
test('flood fill on a retained cel commits locally and shared edits do not become local overrides',()=>{
  const before=decodeAIProject(sparklePxa), next=structuredClone(before);
  floodFill(next.animations[0].frames[0].cels[1].pixels,5,6,0,16,16);
  commitRasterEdits(before,next);
  assert.equal(validateProject(next).animations[0].frames[0].cels[1].pixels[6*16+5],0);
  const shared=paintSharedPart(before,'star',Array(25).fill(1));
  commitRasterEdits(before,shared);
  assert.deepEqual(shared.animations[0].frames[0].cels[1].source.overrides,[]);
});
