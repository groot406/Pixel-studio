import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAIProject, encodeAIProject } from '../src/formats/pxa.js';
import { validateProject, compositeFrame, floodFill } from '../src/domain/project.js';
import { extractPart, placePart, changeInstance, forkInstance, paintSharedPart, flattenCel, partUsage, frameRanges, renamePart, removePart, placePartInFrames, referencesToPart } from '../src/domain/parts.js';
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

test('rotated and resized objects are edited as their original artwork and keep their pose',async()=>{
  const m=await import('../src/features/objects/in-place-edit.js');
  const opOf=project=>project.animations.find(a=>a.id===target.animationId).frames.find(f=>f.id===target.frameId).cels.find(c=>c.layerId===target.layerId).source.ops.find(op=>op.id==='glint');
  for(const pose of [{angle:30},{width:8,height:3},{transform:'R90',angle:-45,width:6,height:4}]) {
    const raw=decodeAIProject(sparklePxa);Object.assign(opOf(raw),pose);
    const p=validateProject(raw);
    const placed=opOf(p);
    const session=m.createInPlaceEdit(p,{...target,instanceId:'glint'}), label=JSON.stringify(pose);
    assert.equal(session.instance.angle,undefined,label);
    assert.equal(session.instance.width,undefined,label);
    assert.equal(session.instance.transform,placed.transform,label);
    assert.ok(m.inPlacePlacement(session),label);
    // The outline is the part at its own size, so canvas pixels map 1:1 to part pixels.
    const rect=m.inPlaceCanvasRect(session);
    assert.deepEqual([rect.width*rect.height],[session.width*session.height],label);
    const corner=m.inPlacePoint(session,{x:rect.x,y:rect.y});
    const dot=m.beginInPlaceStroke(session,{x:rect.x,y:rect.y},{tool:'pencil',color:2});
    m.finishInPlaceStroke(session,dot);
    assert.equal(session.pixels[corner.y*session.width+corner.x],2,label);
    // The live preview shows the original pose; applying keeps the placed pose untouched.
    const preview=m.previewInPlaceEdit(session);
    assert.equal(preview[rect.y*p.width+rect.x],2,label);
    const next=m.prepareInPlaceEdit(session);
    assert.deepEqual(opOf(next),placed,label);
    assert.deepEqual(m.previewInPlaceEdit(session,true),compositeFrame(next,next.animations[0].frames[0]),label);
    const part=next.parts.find(x=>x.id===placed.partId);
    assert.ok(part.width===session.width && part.height===session.height,label);
    // Drawing past the edge grows the part; the placed object keeps its angle and scale.
    const grow=m.createInPlaceEdit(p,{...target,instanceId:'glint'});
    const line=m.beginInPlaceStroke(grow,{x:rect.x-2,y:rect.y},{tool:'pencil',color:1});
    m.finishInPlaceStroke(grow,line);
    assert.ok(grow.width*grow.height>grow.originalWidth*grow.originalHeight,label);
    const applied=m.prepareInPlaceEdit(grow), grown=opOf(applied);
    assert.deepEqual(m.previewInPlaceEdit(grow,true),compositeFrame(applied,applied.animations[0].frames[0]),label);
    assert.equal(grown.angle,placed.angle,label);
    assert.equal(m.inPlacePlacement(grow).angle,placed.angle || 0,label);
  }
});

test('“this frame only” edits a rotated object exactly as drawn and bakes it into this placement',async()=>{
  const m=await import('../src/features/objects/in-place-edit.js');
  const opOf=project=>project.animations.find(a=>a.id===target.animationId).frames.find(f=>f.id===target.frameId).cels.find(c=>c.layerId===target.layerId).source.ops.find(op=>op.id==='glint');
  for(const pose of [{angle:30},{transform:'FX',angle:-60,width:9,height:5}]) {
    const raw=decodeAIProject(sparklePxa);Object.assign(opOf(raw),pose);
    const p=validateProject(raw);
    const label=JSON.stringify(pose), frames=project=>project.animations.flatMap(a=>a.frames.filter(f=>f.id!==target.frameId).map(f=>compositeFrame(project,f)));
    const frame=p.animations.find(a=>a.id===target.animationId).frames.find(f=>f.id===target.frameId), shown=compositeFrame(p,frame);
    const session=m.createInPlaceEdit(p,{...target,instanceId:'glint'},'frame');
    assert.equal(m.inPlaceMode(session),'baked',label);
    assert.equal(m.inPlacePlacement(session),null,label);
    assert.deepEqual(m.previewInPlaceEdit(session),shown,label);
    assert.deepEqual(m.previewInPlaceEdit(session,true),shown,label);
    // Fix one pixel where the frame shows it.
    const rect=m.inPlaceCanvasRect(session), first=session.pixels.findIndex(v=>v>=0);
    const at={x:rect.x+first%session.width,y:rect.y+Math.floor(first/session.width)}, lit=at.y*p.width+at.x;
    assert.equal(shown[lit],session.pixels[first],label);
    const color=(session.pixels[first]+1)%p.palette.length;
    const dot=m.beginInPlaceStroke(session,at,{tool:'pencil',color});
    m.finishInPlaceStroke(session,dot);
    const preview=m.previewInPlaceEdit(session), next=m.prepareInPlaceEdit(session);
    assert.equal(preview[lit],color,label);
    assert.deepEqual(compositeFrame(next,next.animations.find(a=>a.id===target.animationId).frames.find(f=>f.id===target.frameId)),preview,label);
    const op=opOf(next);
    assert.ok(op.angle===undefined && op.width===undefined && op.transform==='N',label);
    assert.deepEqual(frames(next),frames(p),label);
    // Switching to the shared original with a dirty draft is refused; a clean draft switches.
    assert.throws(()=>m.setInPlaceScope(session,'shared'),/Apply or cancel/);
    m.restoreInPlace(session);
    m.setInPlaceScope(session,'shared');
    assert.equal(m.inPlaceMode(session),'original',label);
  }
});

test('part library: usage per animation, rename keeps references, delete only when unused',()=>{
  const p=decodeAIProject(sparklePxa);
  const usage=partUsage(p).get('star');
  assert.equal(usage.instances,4);
  assert.deepEqual(usage.animations.map(a=>[a.id,a.frames]),[['idle',[0,1,2]],['still',[0]]]);
  assert.equal(frameRanges([0,1,2,4,6,7]),'1–3, 5, 7–8');
  const renamed=renamePart(p,'star','spark');
  assert.equal(referencesToPart(renamed,'spark').length,4);
  assert.equal(referencesToPart(renamed,'star').length,0);
  assert.deepEqual(compositeFrame(renamed,renamed.animations[0].frames[1]),compositeFrame(p,p.animations[0].frames[1]));
  assert.throws(()=>renamePart(p,'star','bad name'),/./);
  assert.throws(()=>removePart(p,'star'),/still placed/);
  const extracted=extractPart(p,target,{x:3,y:4,width:5,height:5},'corner');
  const flat=flattenCel(extracted,target);
  assert.equal(removePart(flat,'corner').parts.some(part=>part.id==='corner'),false);
});
test('placing a part in every frame uses one instance id so it is one object across the animation',()=>{
  const p=decodeAIProject(sparklePxa);
  const {project,instanceId}=placePartInFrames(p,{animationId:'idle',layerId:'effects',frameIds:['f0','f1','f2']},'star',2,3);
  const placed=project.animations[0].frames.map(f=>f.cels.find(c=>c.layerId==='effects').source.ops.filter(op=>op.id===instanceId));
  assert.ok(placed.every(ops=>ops.length===1 && ops[0].x===2 && ops[0].y===3));
  assert.equal(partUsage(project).get('star').instances,7);
});
