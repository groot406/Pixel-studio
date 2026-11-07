import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAIProject, encodeAIProject } from '../src/formats/pxa.js';
import { encodePixelProject, decodePixelProject } from '../src/formats/pxs.js';
import { validateProject, compositeFrame, makeLayeredFrame } from '../src/domain/project.js';
import { celObjects, frameObjects, reorderObject, reorderObjectContainer, translateObject, forkObject, updateObject, deleteObject, addObjectContainer, moveObjectToGroup, removeObjectContainer, hitTestObject, objectBounds } from '../src/domain/objects.js';
import { paintSharedPart, flattenCel } from '../src/domain/parts.js';
import { createAIRequest, prepareAIResult } from '../src/features/ai/requests.js';
import { projectFingerprint } from '../src/features/ai/patch-engine.js';
import { sparklePxa } from './fixtures/pxa-v2.mjs';

const target={animationId:'idle',frameId:'f0',layerId:'effects'};
function overlapping() {
  const p=decodeAIProject(sparklePxa);
  p.parts.push({id:'solid',width:5,height:5,ops:[{type:'rect',x:0,y:0,width:5,height:5,color:2}]});
  for(const a of p.animations)for(const f of a.frames) {
    f.cels[1].source.ops.push({type:'use',id:'square',partId:'solid',x:3,y:4,transform:'N'});
  }
  return validateProject(p);
}

test('legacy layers become optional groups without changing retained pixels, IDs, overrides or timings',()=>{
  const p=decodeAIProject(sparklePxa), before=structuredClone(p);
  assert.ok(frameObjects(p,p.animations[0],p.animations[0].frames[0]).every(n=>n.grouped));
  p.layers[1].group=false;
  const next=validateProject(p);
  assert.deepEqual(next.animations,before.animations);
  for(let i=0;i<p.animations.length;i++)for(let j=0;j<p.animations[i].frames.length;j++)assert.deepEqual(compositeFrame(next,next.animations[i].frames[j]),compositeFrame(before,before.animations[i].frames[j]));
  assert.equal(frameObjects(next,next.animations[0],next.animations[0].frames[0])[1].grouped,false);
});

test('instance order changes the animation without touching shared definitions or other animations',()=>{
  const p=overlapping(), before=structuredClone(p), index=6*16+5;
  assert.equal(p.animations[0].frames[0].cels[1].pixels[index],2);
  const next=reorderObject(p,target,'square',-1,'animation');
  assert.equal(next.animations[0].frames[0].cels[1].pixels[index],2); // star centre is white too
  assert.equal(next.animations[0].frames[0].cels[1].pixels[4*16+5],1);
  assert.deepEqual(next.parts,p.parts);
  assert.deepEqual(next.animations[1],p.animations[1]);
  assert.deepEqual(p,before);
  assert.equal(next.animations[0].frames[1].cels[1].source.ops.at(-1).id,'glint');
});

test('frame-only ordering, instance movement and deletion preserve every other appearance',()=>{
  const p=overlapping(), next=reorderObject(p,target,'square',-1,'frame');
  assert.deepEqual(next.animations[0].frames[1],p.animations[0].frames[1]);
  const moved=translateObject(next,target,'glint',2,-1,'animation');
  assert.equal(moved.animations[0].frames[0].cels[1].source.ops.find(o=>o.id==='glint').x,5);
  assert.equal(moved.animations[0].frames[1].cels[1].source.ops.find(o=>o.id==='glint').x,9);
  assert.deepEqual(moved.animations[1],p.animations[1]);
  const deleted=deleteObject(moved,target,'square','frame');
  assert.ok(!deleted.animations[0].frames[0].cels[1].source.ops.some(o=>o.id==='square'));
  assert.ok(deleted.animations[0].frames[1].cels[1].source.ops.some(o=>o.id==='square'));
  assert.throws(()=>translateObject(p,target,'square',128,0),/integer/);
});

test('hit testing respects topmost overlap, hidden objects, erasures, transforms and locked selection',()=>{
  const p=overlapping(), a=p.animations[0], f=a.frames[0];
  assert.deepEqual(hitTestObject(p,a,f,5,4),{layerId:'effects',key:'square',type:'instance'});
  const hidden=updateObject(p,target,'square',{visible:false},'frame');
  assert.equal(hitTestObject(hidden,hidden.animations[0],hidden.animations[0].frames[0],5,4).key,'glint');
  const locked=updateObject(p,target,'square',{locked:true},'frame');
  assert.equal(hitTestObject(locked,locked.animations[0],locked.animations[0].frames[0],5,4).key,'square');
  assert.throws(()=>translateObject(locked,target,'square',1,0),/Unlock/);
  assert.throws(()=>reorderObject(locked,target,'glint',1),/Unlock/);
  const erased=structuredClone(p);erased.animations[0].frames[0].cels[1].source.overrides.push({type:'span',x:5,y:4,values:[-1]});
  const clean=validateProject(erased);
  assert.equal(hitTestObject(clean,clean.animations[0],clean.animations[0].frames[0],5,4).layerId,'back');
  assert.equal(hitTestObject(p,a,f,-1,0),null);
  const node=celObjects(f.cels[1]).find(n=>n.key==='glint');node.instance.transform='R90';
  assert.deepEqual(objectBounds(p,node),{x:3,y:4,width:5,height:5});
});

test('shared editing updates all appearances, preserves overrides, and respects hidden locked instances',()=>{
  const p=overlapping(), painted=paintSharedPart(p,'star',Array(25).fill(0));
  assert.equal(painted.animations[0].frames[1].cels[1].pixels[4*16+8],0);
  assert.equal(painted.animations[1].frames[0].cels[1].pixels[4*16+5],2); // square is still above
  assert.equal(painted.animations[0].frames[2].cels[1].pixels[6*16+5],-1); // explicit local erase survives
  const locked=updateObject(p,{...target,animationId:'still',frameId:'f3'},'glint',{visible:false,locked:true},'frame');
  assert.throws(()=>paintSharedPart(locked,'star',Array(25).fill(0)),/locked/);
  assert.throws(()=>flattenCel(locked,{...target,animationId:'still',frameId:'f3'}),/Unlock/);
  assert.notEqual(projectFingerprint(p),projectFingerprint(locked));
});

test('optional group creation, moving instances and ungrouping retain object identity and source',()=>{
  const p=overlapping(), {project:added,layerId}=addObjectContainer(p,'effects','Equipment',true);
  const moved=moveObjectToGroup(added,target,'square',layerId,'animation');
  for(const frame of moved.animations[0].frames) {
    assert.ok(!frame.cels.find(c=>c.layerId==='effects').source.ops.some(o=>o.id==='square'));
    assert.equal(frame.cels.find(c=>c.layerId===layerId).source.ops.at(-1).id,'square');
  }
  assert.deepEqual(moved.parts,p.parts);
  assert.deepEqual(moved.animations[1].frames[0].cels.find(c=>c.layerId==='effects'),p.animations[1].frames[0].cels[1]);
  moved.layers.find(l=>l.id===layerId).group=false;
  assert.deepEqual(decodeAIProject(encodeAIProject(moved)),validateProject(moved));
  assert.equal(removeObjectContainer(moved,layerId).layers.length,p.layers.length);
});

test('object metadata and frame stack orders survive native JSON and PXA 2, and raster exports retain appearance',async()=>{
  const p=overlapping();p.layers[1].group=false;
  const named=updateObject(p,target,'glint',{name:'Sparkle',visible:false,locked:true},'frame');
  const next=reorderObjectContainer(named,{...target,layerId:'back'},1,'frame');
  assert.deepEqual(next.animations[0].frames[0].layerOrder,['effects','back']);
  assert.equal(next.animations[0].frames[1].layerOrder,undefined);
  assert.deepEqual(decodeAIProject(encodeAIProject(next,{version:2})),next);
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(next))),next);
  assert.deepEqual(makeLayeredFrame(next,next.animations[0].frames[0]).layerOrder,['effects','back']);
  for(const exported of [decodeAIProject(encodeAIProject(next,{version:1})),await decodePixelProject(await encodePixelProject(next))]) {
    for(let i=0;i<next.animations.length;i++)for(let j=0;j<next.animations[i].frames.length;j++)assert.deepEqual(compositeFrame(exported,exported.animations[i].frames[j]),compositeFrame(next,next.animations[i].frames[j]));
  }
});

test('invalid metadata, frame orders and misplaced text commands fail at the boundary',()=>{
  const p=overlapping();p.layers[1].group='yes';assert.throws(()=>validateProject(p),/boolean/);p.layers[1].group=true;
  p.animations[0].frames[0].layerOrder=['back','back'];assert.throws(()=>validateProject(p),/layer order/);delete p.animations[0].frames[0].layerOrder;
  for(const change of [{visible:0},{locked:'true'},{name:''}])assert.throws(()=>updateObject(p,target,'glint',change),/boolean|names/);
  const text=encodeAIProject(p);
  assert.throws(()=>decodeAIProject(text.replace('USE glint','INSTANCE missing "Name" 1 0\nUSE glint')),/Unknown instance/);
  assert.throws(()=>decodeAIProject(text.replace('CEL effects','CEL effects\nFRAMEORDER effects back')),/FRAMEORDER/);
});

test('AI patches cannot modify groups or shared definitions used by locked objects',()=>{
  const p=updateObject(overlapping(),target,'glint',{locked:true},'frame');
  const opts={mode:'compose',scope:'project',animationId:'idle',frameId:'f0',instruction:'Edit the artwork.'};
  const request=createAIRequest(p,opts), reply=body=>`PXAPATCH 2\nBASE ${request.baseFingerprint}\n${body}\nEND\n${request.completionMarker}`;
  assert.throws(()=>prepareAIResult(request,reply('TARGET idle f0 effects\nCLEAR')),/locked|scope/);
  assert.throws(()=>prepareAIResult(request,reply('PART star 5 5\nRECT 0 0 5 5 0\nENDPART')),/locked|scope/);
});

test('making an object independent forks once per definition within the selected scope',()=>{
  const p=overlapping(), independent=forkObject(p,target,'glint','animation');
  const ids=independent.animations[0].frames.map(f=>f.cels[1].source.ops.find(o=>o.id==='glint').partId);
  assert.equal(new Set(ids).size,1);
  assert.notEqual(ids[0],'star');
  assert.equal(independent.animations[1].frames[0].cels[1].source.ops.find(o=>o.id==='glint').partId,'star');
  const changed=paintSharedPart(independent,ids[0],Array(25).fill(0));
  assert.deepEqual(changed.animations[1],p.animations[1]);
  const frameOnly=forkObject(p,target,'glint','frame');
  assert.equal(frameOnly.animations[0].frames[1].cels[1].source.ops.find(o=>o.id==='glint').partId,'star');
});

test('canvas hits match rendered transparent pixels under every non-square part transform',()=>{
  const p=decodeAIProject(sparklePxa);
  p.parts.push({id:'diagonal',width:2,height:3,ops:[{type:'span',x:0,y:0,values:[0]},{type:'span',x:1,y:2,values:[1]}]});
  for(const transform of ['N','FX','FY','R90','R180','R270']) {
    p.animations[0].frames[0].cels[1].source={ops:[{type:'use',id:'marker',partId:'diagonal',x:3,y:4,transform}],overrides:[]};
    const clean=validateProject(p), animation=clean.animations[0], frame=animation.frames[0];
    for(let y=0;y<clean.height;y++)for(let x=0;x<clean.width;x++) {
      const hit=hitTestObject(clean,animation,frame,x,y);
      assert.equal(hit.layerId,frame.cels[1].pixels[y*clean.width+x]>=0?'effects':'back',`${transform} at ${x},${y}`);
    }
  }
});
