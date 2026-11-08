import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAIProject, encodeAIProject } from '../src/formats/pxa.js';
import { encodePixelProject, decodePixelProject } from '../src/formats/pxs.js';
import { validateProject, compositeFrame, makeLayeredFrame, blankProject, getAnimationLayers } from '../src/domain/project.js';
import { copyObject, pasteObject, copyObjects } from '../src/domain/object-clipboard.js';
import { celObjects, frameObjects, reorderObject, reorderObjectContainer, translateObject, forkObject, updateObject, deleteObject, addObjectContainer, moveObjectToGroup, removeObjectContainer, hitTestObject, objectBounds, placeObject, dropObject, placeObjectContainer, orderObjects, translateObjects, translatePixelObject, deleteObjects, isEmptyNode } from '../src/domain/objects.js';
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
  assert.throws(()=>translateObject(p,target,'square',256,0),/integer/);
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

test('dragging places objects and stacks relative to a drop target within the selected scope',()=>{
  const p=overlapping();
  const above=placeObject(p,target,'glint','square','above','animation');
  for(const f of above.animations[0].frames)assert.equal(f.cels[1].source.ops.filter(o=>o.type==='use').at(-1).id,'glint');
  assert.deepEqual(above.animations[1],p.animations[1]);
  const frameOnly=placeObject(p,target,'glint','square','above','frame');
  assert.equal(frameOnly.animations[0].frames[0].cels[1].source.ops.at(-1).id,'glint');
  assert.equal(frameOnly.animations[0].frames[1].cels[1].source.ops.at(-1).id,'square');
  assert.deepEqual(placeObject(p,target,'glint','square','below','animation').animations,p.animations);
  const stacked=placeObjectContainer(p,{...target,layerId:'back'},'effects','above','animation');
  assert.deepEqual(stacked.animations[0].layerOrder,['effects','back']);
  assert.equal(stacked.animations[1].layerOrder,undefined);
  const locked=updateObject(p,target,'square',{locked:true},'animation');
  assert.throws(()=>placeObject(locked,target,'square','glint','below'),/Unlock/);
});

test('copied instances paste into other animations and projects, reusing or remapping shared parts',()=>{
  const p=overlapping(), clip=JSON.parse(JSON.stringify(copyObject(p,target,'glint')));
  const still={animationId:'still',frameId:'f3',layerId:'effects'};
  const pasted=pasteObject(p,still,clip,{scope:'animation'});
  assert.equal(pasted.key,'glint_2');
  assert.equal(pasted.project.parts.length,p.parts.length);
  assert.ok(pasted.project.animations[1].frames[0].cels[1].source.ops.some(o=>o.id==='glint_2' && o.partId==='star'));
  assert.deepEqual(pasted.project.animations[0],p.animations[0]);
  const independent=pasteObject(p,still,clip,{independent:true});
  assert.equal(independent.project.parts.length,p.parts.length+1);

  const other=blankProject('Other',16,16);
  const target2={animationId:other.animations[0].id,frameId:other.animations[0].frames[0].id,layerId:other.layers[0].id};
  const first=pasteObject(other,target2,clip,{scope:'frame'});
  const frame=first.project.animations[0].frames[0], pixels=compositeFrame(first.project,frame);
  assert.equal(first.project.palette[pixels[6*16+5]],'#ffffff');
  assert.equal(first.project.palette[pixels[4*16+5]],'#ffdc70');
  assert.notEqual(first.layerId,target2.layerId);
  const again=pasteObject(first.project,{...target2,layerId:first.layerId},clip,{scope:'frame'});
  assert.equal(again.project.parts.length,1);
  // Another project may reuse the same animation ID; its frames still get the copied pose.
  const twin=blankProject('Twin',16,16);
  twin.animations[0].id=clip.animationId;
  const twinTarget={animationId:clip.animationId,frameId:twin.animations[0].frames[0].id,layerId:twin.layers[0].id};
  const twinPaste=pasteObject(twin,twinTarget,clip,{scope:'animation'});
  assert.ok(twinPaste.project.animations[0].frames[0].cels.some(c=>c.source?.ops.some(o=>o.id===twinPaste.key)));

  // Duplicating within the copied animation keeps each frame's own pose.
  const duplicate=pasteObject(p,target,clip,{scope:'animation'});
  for(const frame of p.animations[0].frames) {
    const original=frame.cels.find(c=>c.layerId==='effects').source?.ops.find(o=>o.id==='glint');
    const copy=duplicate.project.animations[0].frames.find(f=>f.id===frame.id).cels.find(c=>c.layerId==='effects').source?.ops.find(o=>o.id===duplicate.key);
    assert.deepEqual(copy && {x:copy.x,y:copy.y,transform:copy.transform},original && {x:original.x,y:original.y,transform:original.transform});
  }
});

test('copied groups keep their retained source on equal canvases and bake to pixels otherwise',()=>{
  const p=overlapping(), clip=copyObject(p,target,'@group');
  const same=blankProject('Same',16,16), t={animationId:same.animations[0].id,frameId:same.animations[0].frames[0].id,layerId:same.layers[0].id};
  const pasted=pasteObject(same,t,clip,{scope:'frame'});
  const cel=pasted.project.animations[0].frames[0].cels.find(c=>c.layerId===pasted.layerId);
  assert.equal(pasted.key,'@group');
  assert.ok(cel.source.ops.some(o=>o.type==='use' && o.id==='square'));
  assert.deepEqual(cel.pixels.map(v=>v<0?null:pasted.project.palette[v]),p.animations[0].frames[0].cels[1].pixels.map(v=>v<0?null:p.palette[v]));
  const small=blankProject('Small',8,8), s={animationId:small.animations[0].id,frameId:small.animations[0].frames[0].id,layerId:small.layers[0].id};
  const baked=pasteObject(small,s,clip,{scope:'frame'}), bakedCel=baked.project.animations[0].frames[0].cels.find(c=>c.layerId===baked.layerId);
  assert.equal(bakedCel.source,undefined);
  assert.equal(baked.project.palette[bakedCel.pixels[4*8+5]],p.palette[p.animations[0].frames[0].cels[1].pixels[4*16+5]]);
});

test('dropping rows moves instances between groups, creates stacks beside groups and cleans up empty ones',()=>{
  const p=overlapping(), sparkle=p.layers[0].id;
  // Into another group.
  let r=dropObject(p,target,{layerId:'effects',key:'square'},{layerId:sparkle,key:'@group',outer:true},'into');
  const ops=l=>r.project.animations[0].frames[0].cels.find(c=>c.layerId===l).source?.ops.filter(o=>o.type==='use').map(o=>o.id) || [];
  assert.equal(r.layerId,sparkle);assert.ok(ops(sparkle).includes('square'));assert.ok(!ops('effects').includes('square'));
  // Beside a group header: a new ungrouped stack below it.
  r=dropObject(p,target,{layerId:'effects',key:'square'},{layerId:sparkle,key:'@group',outer:true},'below');
  const order=getAnimationLayers(r.project,r.project.animations[0]).map(l=>l.id);
  assert.equal(order[0],r.layerId);assert.equal(r.project.layers.find(l=>l.id===r.layerId).group,false);
  // Dragging that lone object back into the group removes its now-empty stack.
  const back=dropObject(r.project,{...target,layerId:r.layerId},{layerId:r.layerId,key:'square',outer:true},{layerId:'effects',key:'glint'},'above');
  assert.equal(back.layerId,'effects');assert.ok(!back.project.layers.some(l=>l.id===r.layerId));
  assert.deepEqual(compositeFrame(back.project,back.project.animations[0].frames[1]).length,p.width*p.height);
  // Pixel runs cannot leave their group.
  assert.throws(()=>dropObject(p,target,{layerId:sparkle,key:'pixels'},{layerId:'effects',key:'glint'},'above'),/stays in its group/);
});

test('several objects can be ordered, copied, pasted, moved and deleted together',()=>{
  const p=overlapping(), frame=p.animations[0].frames[0];
  const mixed=[{layerId:'effects',key:'square'},{layerId:'back',key:'pixels-0'},{layerId:'effects',key:'glint'},{layerId:'effects',key:'glint'},{layerId:'gone',key:'x'}];
  assert.deepEqual(orderObjects(p,frame,mixed),[{layerId:'back',key:'pixels-0'},{layerId:'effects',key:'glint'},{layerId:'effects',key:'square'}]);
  assert.deepEqual(orderObjects(p,frame,[{layerId:'effects',key:'square'},{layerId:'effects',key:'@group'}]),[{layerId:'effects',key:'@group'}]);
  assert.equal(copyObjects(p,target,[{layerId:'effects',key:'glint'}]).kind,'instance');

  // Into the selected group: both instances land in it, in the copied order, with fresh ids.
  const pair=JSON.parse(JSON.stringify(copyObjects(p,target,[{layerId:'effects',key:'square'},{layerId:'effects',key:'glint'}])));
  assert.equal(pair.kind,'multi');assert.deepEqual(pair.items.map(i=>i.instance.id),['glint','square']);
  const again=pasteObject(p,target,pair,{scope:'animation'});
  assert.deepEqual(again.items.map(i=>i.layerId),['effects','effects']);
  const ids=again.project.animations[0].frames[0].cels.find(c=>c.layerId==='effects').source.ops.filter(o=>o.type==='use').map(o=>o.id);
  assert.deepEqual(ids.slice(-2),again.items.map(i=>i.key));assert.equal(new Set(ids).size,ids.length);

  // Into another animation: each item gets its own row, stacked bottom to top.
  const all=copyObjects(p,target,mixed), still={animationId:'still',frameId:'f3',layerId:'back'};
  const pasted=pasteObject(p,still,all,{scope:'animation'});
  const order=pasted.project.layers.map(l=>l.id), rows=pasted.items.map(i=>order.indexOf(i.layerId));
  assert.equal(pasted.items.length,3);assert.deepEqual(rows,[...rows].sort((a,b)=>a-b));assert.equal(new Set(rows).size,3);
  assert.deepEqual(pasted.items.slice(1).map(i=>i.key),['glint','square']);

  const moved=translateObjects(p,target,mixed,2,-1,'animation');
  assert.equal(moved.moved,3);
  for(const f of moved.project.animations[0].frames)for(const op of f.cels.find(c=>c.layerId==='effects').source.ops.filter(o=>o.type==='use')) {
    const was=p.animations[0].frames.find(x=>x.id===f.id).cels.find(c=>c.layerId==='effects').source.ops.find(o=>o.id===op.id);
    assert.deepEqual([op.x,op.y],[was.x+2,was.y-1]);
  }
  const back=f=>f.cels.find(c=>c.layerId==='back').pixels;
  for(const f of moved.project.animations[0].frames) {
    const was=back(p.animations[0].frames.find(x=>x.id===f.id)), w=p.width;
    back(f).forEach((v,i)=>{const x=i%w,y=Math.floor(i/w),sx=x-2,sy=y+1;assert.equal(v,sx>=0&&sy<p.height&&sx<w?was[sy*w+sx]:-1);});
  }
  assert.throws(()=>translateObjects(p,target,[{layerId:'overlay',key:'nope'}],1,0),/Choose an object/);

  const deleted=deleteObjects(p,target,[{layerId:'effects',key:'glint'},{layerId:'effects',key:'square'}],'frame');
  assert.ok(!celObjects(deleted.animations[0].frames[0].cels.find(c=>c.layerId==='effects')).some(n=>n.instance));
  assert.ok(celObjects(deleted.animations[0].frames[1].cels.find(c=>c.layerId==='effects')).some(n=>n.key==='glint'));
});

test('ungrouped containers emptied by delete or move disappear; partly used ones stay',()=>{
  const p=overlapping(), added=addObjectContainer(p,'effects','Lone',false), at={...target,layerId:added.layerId};
  const cel=added.project.animations[0].frames[0].cels.find(c=>c.layerId===added.layerId);
  assert.ok(isEmptyNode(cel,celObjects(cel)[0]));
  assert.ok(!deleteObject(added.project,at,'pixels-0','frame').layers.some(l=>l.id===added.layerId));
  const moved=moveObjectToGroup(added.project,target,'square',added.layerId,'animation');
  const once=deleteObject(moved,at,'square','frame');
  assert.ok(once.layers.some(l=>l.id===added.layerId));
  assert.ok(!deleteObject(once,at,'square','animation').layers.some(l=>l.id===added.layerId));
  const back=moveObjectToGroup(moved,at,'square','effects','animation');
  assert.ok(!back.layers.some(l=>l.id===added.layerId));
});

test('pixel objects move like placed objects: plain raster layers and drawing runs between instances, with erasures',()=>{
  const p=decodeAIProject(`PXA 2
SIZE 8 4
NAME "Pixels"
PAL #000000 #ff0000
LAYER L "Shield" 1 0
ANIM A "Idle" 8
FRAME f0 100 CLEAR
CEL L RASTER
SPAN 0 1 11
FRAME f1 100 CLEAR
CEL L RASTER
SPAN 1 1 1
END`), t={animationId:p.animations[0].id,frameId:p.animations[0].frames[0].id,layerId:p.layers[0].id};
  assert.equal(hitTestObject(p,p.animations[0],p.animations[0].frames[0],0,1).type,'pixels');
  const moved=translatePixelObject(p,t,'pixels',3,1,'animation');
  const rows=f=>f.cels[0].pixels.map(v=>v<0?'.':'1').join('').match(/.{8}/g);
  assert.deepEqual(rows(moved.animations[0].frames[0]),['........','........','...11...','........']);
  assert.deepEqual(rows(moved.animations[0].frames[1]),['........','........','....1...','........']);
  const one=translatePixelObject(p,t,'pixels',-1,0,'frame');
  assert.deepEqual(rows(one.animations[0].frames[0])[1],'1.......');
  assert.deepEqual(rows(one.animations[0].frames[1])[1],'.1......');

  const q=overlapping(), cel=q.animations[0].frames[0].cels.find(c=>c.layerId==='effects');
  cel.source.ops.unshift({type:'rect',x:0,y:0,width:2,height:2,color:1},{type:'rect',x:1,y:1,width:1,height:1,color:-1});
  const r=validateProject(q), key=celObjects(r.animations[0].frames[0].cels.find(c=>c.layerId==='effects')).find(n=>n.type==='pixels').key;
  const after=translatePixelObject(r,target,key,1,0,'frame'), ops=after.animations[0].frames[0].cels.find(c=>c.layerId==='effects').source.ops;
  const instances=c=>c.source.ops.filter(o=>o.type==='use');
  assert.deepEqual(instances(after.animations[0].frames[0].cels.find(c=>c.layerId==='effects')),instances(r.animations[0].frames[0].cels.find(c=>c.layerId==='effects')));
  assert.ok(ops.some(o=>o.type==='span' && o.y===1 && o.x===1 && o.values[0]===1 && o.values[1]===-1),'the erased pixel moves with its drawing');
  const locked=structuredClone(r);locked.layers.find(l=>l.id==='effects').locked=true;
  assert.throws(()=>translatePixelObject(locked,target,key,1,0),/Unlock/);
});
