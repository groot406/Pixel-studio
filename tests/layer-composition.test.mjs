import test from 'node:test';
import assert from 'node:assert/strict';
import { blankProject, makeLayeredFrame, validateProject, compositeFrame, getAnimationLayers } from '../src/domain/project.js';
import { groupLayers, mergeLayers, compositionSelection, groupSelection, mergeSelection } from '../src/domain/layer-composition.js';
import { translateObjects } from '../src/domain/objects.js';
import { encodeAIProject, decodeAIProject } from '../src/formats/pxa.js';

function layers() {
  const p=blankProject('Character',8,8);
  p.layers=[{id:'body',name:'Body',visible:true,locked:false,group:false},{id:'hat',name:'Hat',visible:true,locked:false,group:false}];
  p.animations=[{id:'idle',name:'Idle',fps:8,frames:[]},{id:'walk',name:'Walk',fps:10,frames:[]}];
  for(const [ai,a] of p.animations.entries()) for(let i=0;i<2;i++) {
    const f=makeLayeredFrame(p);f.id=`${a.id}_${i}`;f.duration=100+i*200;
    f.cels[0].pixels[3*8+1+i+ai]=0;f.cels[1].pixels[2*8+1+i+ai]=1;
    a.frames.push(f);
  }
  p.animations[1].frames[1].layerOrder=['hat','body'];
  return validateProject(p);
}
const pictures=p=>p.animations.flatMap(a=>a.frames.map(f=>compositeFrame(p,f)));
function objects() {
  const p=layers();p.version=3;p.parts=[{id:'dot',width:1,height:1,ops:[{type:'rect',x:0,y:0,width:1,height:1,color:0}]}];
  for(const a of p.animations)for(const f of a.frames)for(const c of f.cels) {
    c.source={ops:[{type:'use',id:'piece',partId:'dot',x:c.layerId==='body'?1:2,y:2,transform:'N',name:c.layerId}],overrides:[]};
  }
  p.bones=[{id:'root',layerId:'body',instanceId:'piece',parent:null},{id:'head',layerId:'hat',instanceId:'piece',parent:'root',anchor:{x:0,y:0}}];
  p.poses=[{id:'pose',name:'Pose',bones:{root:0,head:15}}];
  return validateProject(p);
}

test('grouping keeps separate editable raster objects, every frame, per-frame order and saved structure',()=>{
  const p=layers(),before=structuredClone(p),next=groupLayers(p,['body','hat'],'hat','Character').project;
  assert.deepEqual(p,before);
  assert.deepEqual(pictures(next),pictures(p));
  assert.equal(next.layers.length,1);assert.equal(next.layers[0].group,true);assert.equal(next.layers[0].name,'Character');
  for(let ai=0;ai<p.animations.length;ai++)for(let fi=0;fi<2;fi++) {
    const f=next.animations[ai].frames[fi],old=p.animations[ai].frames[fi];
    assert.equal(f.id,old.id);assert.equal(f.duration,old.duration);
    assert.deepEqual(f.cels[0].source.ops.map(op=>op.name),getAnimationLayers(p,p.animations[ai],old).map(l=>l.name));
    assert.equal(f.cels[0].source.ops.filter(op=>op.type==='use').length,2);
  }
  assert.deepEqual(decodeAIProject(encodeAIProject(next,{version:2})),next);
  const moved=translateObjects(next,{animationId:'idle',frameId:'idle_0',layerId:'hat'},[{layerId:'hat',key:'@group'}],1,0,'animation').project;
  assert.deepEqual(moved.animations[1],next.animations[1]);
  assert.ok(moved.animations[0].frames[0].cels[0].source.ops.every(op=>op.x===2));
});

test('grouping renames colliding instance IDs consistently and retains parts, bones and poses',()=>{
  const p=objects(),next=groupLayers(p,['body','hat'],'hat').project;
  assert.deepEqual(pictures(next),pictures(p));assert.deepEqual(next.parts,p.parts);assert.deepEqual(next.poses,p.poses);
  assert.equal(next.bones.length,2);assert.ok(next.bones.every(b=>b.layerId==='hat'));
  assert.notEqual(next.bones[0].instanceId,next.bones[1].instanceId);
  for(const a of next.animations)for(const f of a.frames)for(const bone of next.bones)assert.ok(f.cels[0].source.ops.some(op=>op.id===bone.instanceId));
});

test('merging flattens objects in every animation without baking live outlines or modifying shared parts',()=>{
  const p=objects();p.outline={color:1,style:'single',mode:'outside',corners:false,thickness:1,separate:false};
  const before=structuredClone(p),next=mergeLayers(p,['body','hat'],'hat').project;
  assert.deepEqual(p,before);assert.deepEqual(pictures(next),pictures(p));
  assert.deepEqual(next.parts,p.parts);assert.deepEqual(next.outline,p.outline);
  assert.equal(next.bones,undefined);assert.equal(next.poses,undefined);assert.equal(next.layers[0].group,false);
  for(const a of next.animations)for(const f of a.frames)assert.equal(f.cels[0].source,undefined);
});

test('merging one group flattens that group and keeps unrelated layers unchanged',()=>{
  const p=objects(),next=mergeLayers(p,['hat'],'hat').project;
  assert.equal(next.layers.length,2);assert.deepEqual(pictures(next),pictures(p));
  for(let ai=0;ai<2;ai++)for(let fi=0;fi<2;fi++)assert.deepEqual(next.animations[ai].frames[fi].cels[0],p.animations[ai].frames[fi].cels[0]);
  // A duplicate instance name on another layer must not inherit the flattened bone.
  assert.equal(next.bones,undefined);
});

test('selection distinguishes whole layers from a subset of their objects',()=>{
  const p=objects(),f=p.animations[0].frames[0];
  f.cels[0].source.ops.push({...f.cels[0].source.ops[0],id:'other'});
  assert.equal(compositionSelection(p,f,[{layerId:'body',key:'@group'}]).whole,true);
  assert.equal(compositionSelection(p,f,[{layerId:'body',key:'piece'},{layerId:'body',key:'other'}]).whole,true);
  assert.equal(compositionSelection(p,f,[{layerId:'body',key:'piece'}]).whole,false);
  assert.throws(()=>compositionSelection(p,f,[]),/Select objects/);
  assert.throws(()=>compositionSelection(p,f,[{layerId:'missing',key:'@group'}]),/Select objects/);
});

test('hidden layers and locks in later animations reject grouping and merging without mutating the project',()=>{
  for(const action of [groupLayers,mergeLayers]) {
    let p=objects();p.layers[0].locked=true;assert.throws(()=>action(p,['body','hat'],'hat'),/Unlock/);
    p=objects();p.layers[0].visible=false;assert.throws(()=>action(p,['body','hat'],'hat'),/Show/);
    p=objects();p.animations[1].frames[1].cels[0].source.ops[0].locked=true;
    const before=structuredClone(p);assert.throws(()=>action(p,['body','hat'],'hat'),/every frame/);assert.deepEqual(p,before);
  }
});

test('a non-selected layer between selected layers in any frame prevents a reorder during composition',()=>{
  const p=layers();p.layers.push({id:'other',name:'Other',visible:true,locked:false,group:false});
  for(const a of p.animations)for(const f of a.frames)f.cels.push({layerId:'other',pixels:Array(64).fill(-1)});
  p.animations[1].frames[1].layerOrder=['body','other','hat'];
  for(const action of [groupLayers,mergeLayers])assert.throws(()=>action(p,['body','hat'],'hat'),/neighbouring/);
});

test('isolated transparent overrides cannot erase lower layers after grouping; explicit merge remains lossless',()=>{
  const p=objects();p.animations[0].frames[0].cels[1].source.overrides=[{type:'span',x:1,y:2,values:[-1]}];
  const clean=validateProject(p),before=structuredClone(clean);
  assert.throws(()=>groupLayers(clean,['body','hat'],'hat'),/isolated erasures/);assert.deepEqual(clean,before);
  assert.deepEqual(pictures(mergeLayers(clean,['body','hat'],'hat').project),pictures(clean));
});

test('separate or differently skipped live outlines cannot silently change during composition',()=>{
  const p=layers();p.outline={color:1,style:'single',mode:'outside',corners:false,thickness:1,separate:true};
  for(const action of [groupLayers,mergeLayers]) {
    assert.throws(()=>action(p,['body','hat'],'hat'),/live outlines/);
    assert.throws(()=>action({...p,outline:{...p.outline,separate:false,skip:['body']}},['body','hat'],'hat'),/live outlines/);
  }
});

function birdParts() {
  const p=layers();p.version=3;p.layers=[{id:'bird',name:'Bird',visible:true,locked:false,group:false}];
  const ids=['left-wing','right-wing','body','head','eyes','crest'];
  p.parts=ids.map((id,i)=>({id,width:1,height:1,ops:[{type:'rect',x:0,y:0,width:1,height:1,color:i%2}]}));
  for(const a of p.animations)for(const [fi,f] of a.frames.entries()) {
    delete f.layerOrder;
    f.cels=[{layerId:'bird',source:{ops:ids.map((id,i)=>({type:'use',id,partId:id,x:1+i,y:2+fi,transform:'N',name:id})),overrides:[]}}];
  }
  p.bones=[{id:'root',layerId:'bird',instanceId:'body',parent:null},{id:'left',layerId:'bird',instanceId:'left-wing',parent:'root',anchor:{x:0,y:0}},{id:'right',layerId:'bird',instanceId:'right-wing',parent:'root',anchor:{x:0,y:0}}];
  return validateProject(p);
}
const wingTarget={animationId:'idle',frameId:'idle_0',layerId:'bird'};
const wings=[{layerId:'bird',key:'left-wing'},{layerId:'bird',key:'right-wing'}];

test('two wings selected from six parts form an editable group without taking the other four parts',()=>{
  const p=birdParts(),before=structuredClone(p),plan=compositionSelection(p,p.animations[0].frames[0],wings);
  assert.equal(plan.whole,false);assert.equal(plan.items.length,2);
  const result=groupSelection(p,wingTarget,wings,'Wings'),next=result.project;
  assert.deepEqual(p,before);assert.deepEqual(pictures(next),pictures(p));assert.deepEqual(next.parts,p.parts);
  for(let ai=0;ai<2;ai++)for(let fi=0;fi<2;fi++) {
    const f=next.animations[ai].frames[fi];
    assert.deepEqual(f.cels.find(c=>c.layerId==='bird').source.ops,p.animations[ai].frames[fi].cels[0].source.ops.slice(2));
    assert.deepEqual(f.cels.find(c=>c.layerId===result.layerId).source.ops.map(op=>op.id),['left-wing','right-wing']);
    assert.deepEqual(f.layerOrder,[result.layerId,'bird']);
  }
  assert.equal(next.bones.find(b=>b.id==='root').layerId,'bird');
  assert.ok(next.bones.filter(b=>b.id!=='root').every(b=>b.layerId===result.layerId));
  assert.deepEqual(decodeAIProject(encodeAIProject(next,{version:2})),next);
});

test('merging two wings flattens only those parts and retains the four unselected objects and part definitions',()=>{
  const p=birdParts(),before=structuredClone(p),result=mergeSelection(p,wingTarget,wings),next=result.project;
  assert.deepEqual(p,before);assert.deepEqual(pictures(next),pictures(p));assert.deepEqual(next.parts,p.parts);
  for(let ai=0;ai<2;ai++)for(let fi=0;fi<2;fi++) {
    const f=next.animations[ai].frames[fi],cel=f.cels.find(c=>c.layerId===result.layerId);
    assert.equal(cel.source,undefined);assert.equal(cel.pixels.filter(v=>v>=0).length,2);
    assert.deepEqual(f.cels.find(c=>c.layerId==='bird').source.ops,p.animations[ai].frames[fi].cels[0].source.ops.slice(2));
  }
  assert.equal(next.bones,undefined);
});

test('a subset spanning non-neighbouring layers can be combined without deleting the layer in between',()=>{
  const p=layers();p.layers.splice(1,0,{id:'middle',name:'Middle',visible:true,locked:false,group:false});
  for(const a of p.animations)for(const f of a.frames) {
    f.layerOrder=['body','middle','hat'];f.cels.push({layerId:'middle',pixels:Array(64).fill(-1).map((_,i)=>i===63?1:-1)});
  }
  const items=[{layerId:'body',key:'pixels'},{layerId:'hat',key:'pixels'}],at={animationId:'idle',frameId:'idle_0',layerId:'hat'};
  for(const combine of [groupSelection,mergeSelection]) {
    const next=combine(p,at,items,'Selection').project;
    assert.equal(next.layers.length,2);assert.ok(next.layers.some(l=>l.id==='middle'));
    for(let ai=0;ai<2;ai++)for(let fi=0;fi<2;fi++)assert.deepEqual(next.animations[ai].frames[fi].cels.find(c=>c.layerId==='middle'),p.animations[ai].frames[fi].cels.find(c=>c.layerId==='middle'));
    assert.deepEqual(pictures(next),pictures(p));
  }
});

test('unselected locked parts stay untouched, but a selected part locked in another frame prevents the action',()=>{
  const p=birdParts();for(const a of p.animations)for(const f of a.frames)f.cels[0].source.ops[2].locked=true;
  for(const combine of [groupSelection,mergeSelection])assert.doesNotThrow(()=>combine(p,wingTarget,wings,'Wings'));
  p.animations[1].frames[1].cels[0].source.ops[0].locked=true;
  for(const combine of [groupSelection,mergeSelection])assert.throws(()=>combine(p,wingTarget,wings,'Wings'),/Unlock the selected objects/);
});

test('partial grouping retains a selected pixel run as a separate editable part',()=>{
  const p=birdParts();for(const a of p.animations)for(const f of a.frames)f.cels[0].source.ops.unshift({type:'rect',x:0,y:0,width:1,height:1,color:1});
  const clean=validateProject(p),items=[{layerId:'bird',key:'pixels-0'},wings[0]];
  const result=groupSelection(clean,wingTarget,items,'Drawing and wing');
  for(const a of result.project.animations)for(const f of a.frames)assert.equal(f.cels.find(c=>c.layerId===result.layerId).source.ops.filter(op=>op.type==='use').length,2);
  assert.deepEqual(pictures(result.project),pictures(clean));
});

test('a whole pixel layer with transparent overrides can join a partial object selection without restoring erased pixels',()=>{
  const p=birdParts();p.layers.unshift({id:'drawing',name:'Drawing',visible:true,locked:false,group:false});
  for(const a of p.animations)for(const f of a.frames)f.cels.push({layerId:'drawing',source:{ops:[{type:'rect',x:0,y:0,width:2,height:1,color:1}],overrides:[{type:'span',x:0,y:0,values:[-1]}]}});
  const clean=validateProject(p),result=groupSelection(clean,wingTarget,[{layerId:'drawing',key:'pixels-0'},...wings],'Selection');
  assert.deepEqual(pictures(result.project),pictures(clean));
  for(const a of result.project.animations)for(const f of a.frames)assert.equal(f.cels.find(c=>c.layerId==='bird').source.ops.length,4);
});
