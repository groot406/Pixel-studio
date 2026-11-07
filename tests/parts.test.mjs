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

test('growing a part keeps every transformed instance in place',async()=>{
  const { growPart } = await import('../src/domain/parts.js');
  for(const transform of ['N','FX','FY','R90','R180','R270']) {
    const p=changeInstance(decodeAIProject(sparklePxa),target,'glint',{transform});
    const before=p.animations.map(a=>a.frames.map(f=>compositeFrame(p,f)));
    const id=p.animations[0].frames[0].cels[1].source.ops[0].partId, size=p.parts.find(x=>x.id===id);
    const grown=growPart(p,id,{left:2,top:1,right:3,bottom:4});
    assert.deepEqual(grown.parts.find(x=>x.id===id).width,size.width+5,transform);
    assert.deepEqual(grown.animations.map(a=>a.frames.map(f=>compositeFrame(grown,f))),before,transform);
  }
});

test('in-place drawing beyond the outline extends the part and selections edit part pixels',async()=>{
  const m=await import('../src/features/objects/in-place-edit.js');
  for(const transform of ['N','R90','FX']) {
    const p=changeInstance(decodeAIProject(sparklePxa),target,'glint',{transform});
    const session=m.createInPlaceEdit(p,{...target,instanceId:'glint'});
    const rect=m.inPlaceCanvasRect(session), outside={x:rect.x-2,y:rect.y+rect.height+1};
    const line=m.beginInPlaceStroke(session,outside,{tool:'pencil',color:1,from:{x:rect.x,y:rect.y}});
    m.finishInPlaceStroke(session,line);
    assert.ok(session.width*session.height>session.originalWidth*session.originalHeight,transform);
    const preview=m.previewInPlaceEdit(session), next=m.prepareInPlaceEdit(session);
    assert.deepEqual(compositeFrame(next,next.animations[0].frames[0]),preview,transform);
    assert.equal(preview[outside.y*p.width+outside.x],1,transform);
    m.restoreInPlace(session);
    assert.equal(session.width,session.originalWidth);
    m.restoreInPlace(session,true);
    m.selectAllInPlace(session);
    const copied=m.copyInPlaceSelection(session);
    assert.equal(copied.width*copied.height,session.pixels.length);
    m.clearInPlaceSelection(session);
    assert.ok(session.pixels.every(v=>v===-1));
    m.pasteInPlace(session,copied);
    assert.deepEqual(session.selection,{x:0,y:0,width:session.width,height:session.height});
    m.restoreInPlace(session);
    assert.ok(session.pixels.every(v=>v===-1));
  }
});
