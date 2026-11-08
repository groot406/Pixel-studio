/** Object editing over the established cel format. Groups retain isolated erase/override semantics. */
import { validateProject, getAnimationLayers, insertProjectLayer, removeProjectLayer, uid, MAX_LAYERS, MAX_TOTAL_PIXELS } from './project.js';
import { PIVOT_MIN, PIVOT_MAX } from './limits.js';
import { cloneArtwork, sourceForCel, renderParts, hasLockedInstances, renderOperations, pixelSpans, translatePixels } from './artwork.js';
import { linePoints, ellipsePoints, instancePixel, instanceSize, instanceBox, transformedSize, swapsAxes, composeTransform, transformPoint } from './geometry.js';
import { nextPartId } from './parts.js';
import { boneDescendants, relPose, layoutFrame } from './skeleton.js';

export function celObjects(cel) {
  if (!cel.source) return [{key:'pixels',type:'pixels',name:'Pixels',start:0,end:0}];
  const nodes = [];
  let start = 0, paint = 0;
  const flush = end => {
    if (end > start) nodes.push({key:`pixels-${paint++}`,type:'pixels',name:paint === 1 ? 'Pixels' : `Pixels ${paint}`,start,end});
  };
  cel.source.ops.forEach((op,index) => {
    if (op.type !== 'use') return;
    flush(index);
    nodes.push({key:op.id,type:'instance',name:op.name || op.partId,start:index,end:index+1,instance:op});
    start = index+1;
  });
  flush(cel.source.ops.length);
  if (cel.source.overrides.length) nodes.push({key:'overrides',type:'overrides',name:'Local pixel edits',start:0,end:0});
  return nodes.length ? nodes : [{key:'pixels-0',type:'pixels',name:'Pixels',start:0,end:0}];
}

export function frameObjects(project,animation,frame) {
  return getAnimationLayers(project,animation,frame).map(layer => ({
    layer, grouped:layer.group !== false,
    children:celObjects(frame.cels.find(cel=>cel.layerId===layer.id)),
  }));
}

function context(project,target,scope) {
  if (!['frame','animation'].includes(scope)) throw new Error('Choose current frame or current animation.');
  const p=validateProject(project), animation=p.animations.find(a=>a.id===target.animationId);
  const layer=p.layers.find(l=>l.id===target.layerId), frame=animation?.frames.find(f=>f.id===target.frameId);
  if (!layer || !frame) throw new Error('This object no longer exists.');
  return {p,animation,layer,frame,frames:scope==='animation'?animation.frames:[frame]};
}
function unlocked(layer,node) {
  if (layer.locked || node?.instance?.locked) throw new Error('Unlock this object or its group first.');
}

export function reorderObjectContainer(project,target,direction,scope='animation') {
  const {p,animation,layer,frame,frames}=context(project,target,scope);
  unlocked(layer);
  if(frames.some(f=>hasLockedInstances(f.cels.find(c=>c.layerId===layer.id))))throw new Error('Unlock objects inside this group before moving its stack.');
  if(![1,-1].includes(direction))throw new Error('Move one position up or down.');
  const order=getAnimationLayers(p,animation,frame).map(l=>l.id), index=order.indexOf(layer.id), neighbour=order[index+direction];
  if(!neighbour)return p;
  const swap=ids=>{const a=ids.indexOf(layer.id),b=ids.indexOf(neighbour);if(Math.abs(a-b)===1)[ids[a],ids[b]]=[ids[b],ids[a]];return ids;};
  if(scope==='animation') {
    for(const f of frames) if(f.layerOrder)f.layerOrder=swap([...f.layerOrder]);
    animation.layerOrder=swap(getAnimationLayers(p,animation).map(l=>l.id));
  } else frame.layerOrder=swap(order);
  return validateProject(p);
}

/** Move one sibling relative to the neighbour selected in the current frame, wherever both exist. */
export function reorderObject(project,target,key,direction,scope='animation') {
  if (![1,-1].includes(direction)) throw new Error('Move one position up or down.');
  const {p,layer,frame,frames}=context(project,target,scope);
  const cel=frame.cels.find(c=>c.layerId===layer.id), nodes=celObjects(cel);
  const index=nodes.findIndex(n=>n.key===key), node=nodes[index], neighbour=nodes[index+direction];
  if (!node || !neighbour) return p;
  unlocked(layer,node); unlocked(layer,neighbour);
  if (node.type==='overrides' || neighbour.type==='overrides') throw new Error('Local pixel edits stay above this group. Flatten them before reordering.');
  for (const f of frames) {
    const c=f.cels.find(c=>c.layerId===layer.id), siblings=celObjects(c);
    const selected=siblings.find(n=>n.key===key), other=siblings.find(n=>n.key===neighbour.key);
    if (!selected || !other) continue;
    unlocked(layer,selected); unlocked(layer,other);
    if (Math.abs(siblings.indexOf(selected)-siblings.indexOf(other))!==1) continue;
    const low=selected.start<other.start?selected:other, high=low===selected?other:selected;
    c.source.ops.splice(low.start,high.end-low.start,...c.source.ops.slice(high.start,high.end),...c.source.ops.slice(low.start,low.end));
  }
  return validateProject(p);
}

/** Drag-and-drop: move a container directly above or below another container in the scoped stack. */
export function placeObjectContainer(project,target,anchorLayerId,position,scope='animation') {
  if(!['above','below'].includes(position))throw new Error('Drop above or below another object.');
  const {p,animation,layer,frame,frames}=context(project,target,scope);
  if(anchorLayerId===layer.id || !p.layers.some(l=>l.id===anchorLayerId))return p;
  unlocked(layer);
  if(frames.some(f=>hasLockedInstances(f.cels.find(c=>c.layerId===layer.id))))throw new Error('Unlock objects inside this group before moving its stack.');
  const place=ids=>{
    const order=ids.filter(id=>id!==layer.id), index=order.indexOf(anchorLayerId);
    if(index<0)return ids;
    order.splice(position==='above'?index+1:index,0,layer.id);return order;
  };
  if(scope==='animation') {
    for(const f of frames) if(f.layerOrder)f.layerOrder=place([...f.layerOrder]);
    animation.layerOrder=place(getAnimationLayers(p,animation).map(l=>l.id));
  } else frame.layerOrder=place(getAnimationLayers(p,animation,frame).map(l=>l.id));
  return validateProject(p);
}

/** Drag-and-drop: move a sibling directly above or below another sibling, wherever both exist in scope. */
export function placeObject(project,target,key,anchorKey,position,scope='animation') {
  if(!['above','below'].includes(position))throw new Error('Drop above or below another object.');
  const {p,layer,frames}=context(project,target,scope);
  unlocked(layer);
  if(key===anchorKey)return p;
  for(const f of frames) {
    const cel=f.cels.find(c=>c.layerId===layer.id);
    if(!cel.source)continue;
    const nodes=celObjects(cel), from=nodes.findIndex(n=>n.key===key), to=nodes.findIndex(n=>n.key===anchorKey);
    if(from<0 || to<0)continue;
    const [low,high]=from<to?[from+1,position==='above'?to:to-1]:[position==='above'?to+1:to,from-1];
    for(const node of [nodes[from],...nodes.slice(low,high+1)]) {
      unlocked(layer,node);
      if(node.type==='overrides')throw new Error('Local pixel edits stay above this group. Flatten them before reordering.');
    }
    if(nodes[to].type==='overrides')throw new Error('Local pixel edits stay above this group. Flatten them before reordering.');
    const node=nodes[from], anchor=nodes[to], moved=cel.source.ops.splice(node.start,node.end-node.start);
    let at=position==='above'?anchor.end:anchor.start;
    if(node.start<anchor.start)at-=moved.length;
    cel.source.ops.splice(at,0,...moved);
  }
  return validateProject(p);
}

/** Optional per-instance effects; `null` in a change resets one to its default (centre pivot, no skew/3D turn/deform, nearest). */
export const EFFECT_KEYS=['pivot','skew','tilt','deform','sampling'];
function applyEffects(op,changes) {
  for(const key of EFFECT_KEYS) if(key in changes) { if(changes[key]===null || changes[key]===undefined) delete op[key]; else op[key]=cloneArtwork(changes[key]); }
}

export function updateObject(project,target,key,changes,scope='animation') {
  const {p,layer,frames}=context(project,target,scope);
  unlocked(layer);
  for (const name of Object.keys(changes)) if (!['name','visible','locked','x','y','transform',...EFFECT_KEYS].includes(name)) throw new Error('Unsupported object setting.');
  for (const frame of frames) {
    const op=frame.cels.find(c=>c.layerId===layer.id).source?.ops.find(op=>op.type==='use' && op.id===key);
    if (!op) continue;
    if (Object.keys(changes).some(name=>name!=='locked')) unlocked(layer,{instance:op});
    applyEffects(Object.assign(op,changes),changes);
  }
  return validateProject(p);
}

/**
 * Show an instance at a new on-canvas box without touching its shared part. `box` is the box in the target frame;
 * other frames in scope get the same size and move by the same offset, so per-frame poses are kept.
 * The original part size clears the resize. Rendering samples the part, so resizing is always reversible.
 */
export function resizeObject(project,target,key,box,scope='animation') {
  if(![box?.x,box?.y,box?.width,box?.height].every(Number.isInteger) || box.width<1 || box.height<1) throw new Error('Object sizes use whole pixels.');
  const {p,layer,frame,frames}=context(project,target,scope);
  const here=frame.cels.find(c=>c.layerId===layer.id).source?.ops.find(op=>op.type==='use' && op.id===key);
  if(!here) throw new Error('Choose an object in this frame.');
  if(here.angle || here.tilt) throw new Error('Reset the rotation and 3D turn before resizing with handles.');
  const part=p.parts.find(part=>part.id===here.partId), rotated=swapsAxes(here.transform);
  const size={width:rotated?box.height:box.width,height:rotated?box.width:box.height};
  const dx=box.x-here.x, dy=box.y-here.y;
  for(const frame of frames) {
    const op=frame.cels.find(c=>c.layerId===layer.id).source?.ops.find(op=>op.type==='use' && op.id===key);
    if(!op || op.partId!==here.partId)continue;
    unlocked(layer,{instance:op});
    op.x+=dx; op.y+=dy;
    for(const axis of ['width','height']) { if(size[axis]===part[axis]) delete op[axis]; else op[axis]=size[axis]; }
  }
  return validateProject(p);
}

/** Move each appearance by the same offset while preserving its authored pose; rigged parts below it come along. */
export function translateObject(project,target,key,dx,dy,scope='animation') {
  if(!Number.isInteger(dx) || !Number.isInteger(dy))throw new Error('Object movement uses whole pixels.');
  const {p,layer,frames}=context(project,target,scope);
  const refs=[{layerId:layer.id,instanceId:key},...boneDescendants(p,layer.id,key)];
  for(const frame of frames) for(const ref of refs) {
    const op=frame.cels.find(c=>c.layerId===ref.layerId)?.source?.ops.find(op=>op.type==='use' && op.id===ref.instanceId);
    if(!op)continue;
    unlocked(p.layers.find(l=>l.id===ref.layerId),{instance:op}); op.x+=dx;op.y+=dy;
  }
  return validateProject(p);
}

/**
 * Move a pixel object (plain raster, or a run of drawing operations between placed objects) in every frame of the
 * scope that has it. Pixels pushed past the canvas edge are clipped; erasing operations move with the drawing.
 */
export function translatePixelObject(project,target,key,dx,dy,scope='animation') {
  if(!Number.isInteger(dx) || !Number.isInteger(dy))throw new Error('Object movement uses whole pixels.');
  const {p,layer,frames}=context(project,target,scope);
  unlocked(layer);
  const {width,height}=p;
  let moved=0;
  for(const frame of frames) {
    const cel=frame.cels.find(c=>c.layerId===layer.id), node=cel && celObjects(cel).find(n=>n.key===key);
    if(!node || node.type!=='pixels')continue;
    moved++;
    if(!cel.source){cel.pixels=translatePixels(cel.pixels,width,height,dx,dy);continue;}
    const ops=cel.source.ops.slice(node.start,node.end);
    if(!ops.length)continue;
    const values=translatePixels(renderOperations(ops,width,height),width,height,dx,dy);
    // Erasing operations also count as drawn, so they keep clearing what lies beneath them.
    const touched=translatePixels(renderOperations(ops.map(op=>op.type==='span'?{...op,values:op.values.map(()=>0)}:{...op,color:0}),width,height),width,height,dx,dy);
    cel.source.ops.splice(node.start,ops.length,...pixelSpans(values,width,i=>touched[i]>=0));
  }
  if(!moved)throw new Error('This pixel object is not in the current frame.');
  return validateProject(p);
}

/** Selected objects of one frame without duplicates or children of a selected group, bottom to top (layer order, then stack order). */
export function orderObjects(project,frame,items) {
  const seen=new Set(), groups=new Set(items.filter(i=>i.key==='@group').map(i=>i.layerId));
  const rank=new Map(project.layers.map((l,i)=>[l.id,i]));
  return items.filter(item=>{
    const id=`${item.layerId}/${item.key}`;
    if(seen.has(id) || !rank.has(item.layerId) || (item.key!=='@group' && groups.has(item.layerId)))return false;
    seen.add(id);
    const cel=frame.cels.find(c=>c.layerId===item.layerId);
    return Boolean(cel) && (item.key==='@group' || celObjects(cel).some(n=>n.key===item.key));
  }).map(item=>({layerId:item.layerId,key:item.key,index:item.key==='@group'?-1:celObjects(frame.cels.find(c=>c.layerId===item.layerId)).findIndex(n=>n.key===item.key)}))
    .sort((a,b)=>rank.get(a.layerId)-rank.get(b.layerId) || a.index-b.index).map(({layerId,key})=>({layerId,key}));
}

/** Move every selected object (placed objects, pixel objects, or whole groups) by the same amount. Returns the project and how many moved. */
export function translateObjects(project,target,items,dx,dy,scope='animation') {
  const frame=project.animations.find(a=>a.id===target.animationId)?.frames.find(f=>f.id===target.frameId);
  if(!frame)throw new Error('This object no longer exists.');
  const expanded=orderObjects(project,frame,items).flatMap(item=>item.key!=='@group'?[item]
    :celObjects(frame.cels.find(c=>c.layerId===item.layerId)).filter(n=>n.type!=='overrides').map(n=>({layerId:item.layerId,key:n.key})));
  let p=project, moved=0;
  const carried=new Set(expanded.flatMap(item=>boneDescendants(project,item.layerId,item.key)).map(r=>`${r.layerId}/${r.instanceId}`));
  const nodes=expanded.map(item=>({item,node:celObjects(frame.cels.find(c=>c.layerId===item.layerId)).find(n=>n.key===item.key)}));
  // Pixel object keys count runs from the bottom, so move the top ones first in case a run is clipped away.
  for(const {item,node} of nodes.reverse()) {
    if(!node || node.type==='overrides')continue;
    if(carried.has(`${item.layerId}/${item.key}`)){moved++;continue;}
    const at={...target,layerId:item.layerId};
    p=node.instance?translateObject(p,at,item.key,dx,dy,scope):translatePixelObject(p,at,item.key,dx,dy,scope);moved++;
  }
  if(!moved)throw new Error('Choose an object to move.');
  return {project:p,moved};
}

function eachSelectedInstance(project,target,items,scope,change) {
  const frame=project.animations.find(a=>a.id===target.animationId)?.frames.find(f=>f.id===target.frameId);
  if(!frame)throw new Error('This object no longer exists.');
  const instances=orderObjects(project,frame,items).filter(item=>celObjects(frame.cels.find(c=>c.layerId===item.layerId)).find(n=>n.key===item.key)?.instance);
  if(!instances.length)throw new Error('Only placed objects can be turned or rotated.');
  const {p,frames}=context(project,target,scope), poses=p.bones?new Map(frames.map(f=>[f,relPose(p,f)])):null;
  for(const item of instances) {
    const layer=p.layers.find(l=>l.id===item.layerId);
    const partId=frame.cels.find(c=>c.layerId===item.layerId).source.ops.find(op=>op.type==='use' && op.id===item.key).partId;
    for(const f of frames) {
      const op=f.cels.find(c=>c.layerId===layer.id).source?.ops.find(op=>op.type==='use' && op.id===item.key);
      if(!op || op.partId!==partId)continue;
      unlocked(layer,{instance:op});
      change(op,p.parts.find(part=>part.id===op.partId));
    }
  }
  if(poses) {
    const changed=new Set(instances.map(i=>`${i.layerId}/${i.key}`));
    for(const [f,rels] of poses) {
      for(const bone of p.bones) if(changed.has(`${bone.layerId}/${bone.instanceId}`))rels.delete(bone.id);
      layoutFrame(p,f,rels);
    }
  }
  return validateProject(p);
}

/**
 * Lossless quarter turns and flips of each selected object about its own centre. Turns compose with the stored
 * transform (R90·Rθ = Rθ·R90); flips also negate a free angle (FX·Rθ = R−θ·FX), so the result is exactly mirrored.
 * When width and height swap, the origin moves by trunc((w−h)/2), which returns to the start after a full turn.
 */
export function turnObjects(project,target,items,turn,scope='animation') {
  if(!['R90','R180','R270','FX','FY'].includes(turn))throw new Error('Choose a quarter turn or a flip.');
  return eachSelectedInstance(project,target,items,scope,(op,part)=>{
    const before=transformedSize(op,part), transform=composeTransform(op.transform,turn);
    if(swapsAxes(transform)!==swapsAxes(op.transform)){op.x+=Math.trunc((before.width-before.height)/2);op.y+=Math.trunc((before.height-before.width)/2);}
    // The pivot follows its artwork pixel; flips mirror skew and twist, and quarter turns swap the skew axes.
    // A flip negates the 3D turn about the mirrored axis' partner (FX: y, FY: x); quarter turns swap the axes.
    if(op.pivot){const p=transformPoint(turn,before.width,before.height,op.pivot.x,op.pivot.y);op.pivot={x:Math.max(PIVOT_MIN,Math.min(PIVOT_MAX,p.x)),y:Math.max(PIVOT_MIN,Math.min(PIVOT_MAX,p.y))};}
    op.transform=transform;
    if(turn==='FX' || turn==='FY') {
      if(op.angle)op.angle=-op.angle;
      if(op.skew)op.skew={x:-op.skew.x,y:-op.skew.y};
      if(op.deform?.kind==='twist')op.deform={...op.deform,angle:-op.deform.angle};
      if(op.tilt)op.tilt=turn==='FX'?{...op.tilt,y:flipTilt(op.tilt.y)}:{...op.tilt,x:flipTilt(op.tilt.x)};
    } else {
      if(op.skew && turn!=='R180')op.skew={x:-op.skew.y,y:-op.skew.x};
      if(op.tilt) {
        const {x,y}=op.tilt;
        op.tilt={...op.tilt,...(turn==='R90'?{x:flipTilt(y),y:x}:turn==='R270'?{x:y,y:flipTilt(x)}:{x:flipTilt(x),y:flipTilt(y)})};
      }
    }
  });
}

/**
 * Set or reset (`null`) pivot, skew, deform and sampling of each selected object in every frame of the scope, for
 * example `{skew:{x:-15,y:0}, deform:{kind:'wave',axis:'x',amplitude:2,wavelength:8,phase:0}, sampling:'rotsprite'}`.
 */
export function setObjectEffects(project,target,items,changes,scope='animation') {
  for(const name of Object.keys(changes)) if(!EFFECT_KEYS.includes(name)) throw new Error('Unsupported object effect.');
  return eachSelectedInstance(project,target,items,scope,op=>applyEffects(op,changes));
}

/** Add `delta` whole degrees of free rotation to each selected object (about its centre), in every frame of the scope. */
export function rotateObjects(project,target,items,delta,scope='animation') {
  if(!Number.isInteger(delta))throw new Error('Rotation uses whole degrees.');
  return eachSelectedInstance(project,target,items,scope,op=>{
    const angle=((((op.angle || 0)+delta)%360)+540)%360-180;
    if(angle)op.angle=angle===-180?180:angle;else delete op.angle;
  });
}

/** Negated 3D turn angle in -179..180 (−180 and 180 are the same turn). */
const flipTilt=v=>v===180 || v===-180?180:(-v || 0);
/** Wrap degrees into -179..180. */
const wrapTilt=v=>((((v%360)+540)%360)-180) || 0;
/**
 * Add whole degrees of 3D turn (`{x, y}`: tip about the horizontal axis, turn about the vertical axis) to each selected
 * object in every frame of the scope; each keeps its perspective. Both angles back at 0 removes the turn.
 */
export function tiltObjects(project,target,items,delta,scope='animation') {
  if(!Number.isInteger(delta?.x ?? 0) || !Number.isInteger(delta?.y ?? 0))throw new Error('3D turns use whole degrees.');
  return eachSelectedInstance(project,target,items,scope,op=>{
    const x=wrapTilt((op.tilt?.x || 0)+(delta.x || 0)), y=wrapTilt((op.tilt?.y || 0)+(delta.y || 0)), x1=x===-180?180:x, y1=y===-180?180:y;
    if(x1 || y1)op.tilt={...op.tilt,x:x1,y:y1};else delete op.tilt;
  });
}

/** Delete several objects at once, top first so pixel-object keys of lower items stay valid. */
export function deleteObjects(project,target,items,scope='animation') {
  const frame=project.animations.find(a=>a.id===target.animationId)?.frames.find(f=>f.id===target.frameId);
  if(!frame)throw new Error('This object no longer exists.');
  let p=project;
  for(const item of orderObjects(project,frame,items).reverse())
    p=item.key==='@group'?removeObjectContainer(p,item.layerId):deleteObject(p,{...target,layerId:item.layerId},item.key,scope);
  return p;
}

export function forkObject(project,target,key,scope='animation') {
  const {p,layer,frames}=context(project,target,scope), copies=new Map();
  for(const frame of frames) {
    const op=frame.cels.find(c=>c.layerId===layer.id).source?.ops.find(op=>op.type==='use' && op.id===key);
    if(!op)continue;
    unlocked(layer,{instance:op});
    if(!copies.has(op.partId)) {
      const part=cloneArtwork(p.parts.find(part=>part.id===op.partId));
      const id=nextPartId(p,`${part.id}_copy`);p.parts.push({...part,id});copies.set(part.id,id);
    }
    op.partId=copies.get(op.partId);
  }
  return validateProject(p);
}

export function deleteObject(project,target,key,scope='animation') {
  const {p,layer,frames}=context(project,target,scope);
  for (const frame of frames) {
    const cel=frame.cels.find(c=>c.layerId===layer.id), node=celObjects(cel).find(n=>n.key===key);
    if (!node) continue;
    unlocked(layer,node);
    if (node.type==='overrides') cel.source.overrides=[];
    else if (cel.source) cel.source.ops.splice(node.start,node.end-node.start);
    else cel.pixels.fill(-1);
  }
  return pruneEmptyContainer(validateProject(p),layer.id);
}

/** Remove an ungrouped container once it holds nothing in any frame (the last container always stays). */
export function pruneEmptyContainer(p,layerId) {
  const layer=p.layers.find(l=>l.id===layerId);
  if(!layer || layer.group!==false || layer.locked || p.layers.length<2 || !emptyContainer(p,layerId))return p;
  return removeObjectContainer(p,layerId);
}

/** True when a pixels node holds nothing to show: a placeholder or an all-transparent raster cel. */
export function isEmptyNode(cel,node) {
  if(node.type!=='pixels')return false;
  return cel.source?node.end<=node.start:cel.pixels.every(v=>v<0);
}

export function addObjectContainer(project,afterId,name,group=false) {
  const p=validateProject(project), frames=p.animations.reduce((n,a)=>n+a.frames.length,0);
  if (p.layers.length>=MAX_LAYERS || frames*(p.layers.length+1)*p.width*p.height>MAX_TOTAL_PIXELS) throw new Error('The project has reached its object storage limit.');
  const layer={id:uid(),name,group,visible:true,locked:false};
  insertProjectLayer(p,layer,afterId);
  return {project:validateProject(p),layerId:layer.id};
}

/** Move an instance into an optional group; its shared definition, placement and identity survive. */
export function moveObjectToGroup(project,target,key,destinationId,scope='animation') {
  const {p,layer,frames}=context(project,target,scope), destination=p.layers.find(l=>l.id===destinationId);
  if (!destination || destination.id===layer.id) return p;
  unlocked(layer); unlocked(destination);
  for (const frame of frames) {
    const source=frame.cels.find(c=>c.layerId===layer.id), dest=frame.cels.find(c=>c.layerId===destination.id);
    const index=source.source?.ops.findIndex(op=>op.type==='use' && op.id===key) ?? -1;
    if(index<0) continue;
    const op=source.source.ops[index]; unlocked(layer,{instance:op});
    dest.source=sourceForCel(dest,p.width);
    if(dest.source.ops.some(item=>item.type==='use' && item.id===op.id)) throw new Error('The destination already contains an object with this ID. Rename the instance in the file or choose another group.');
    source.source.ops.splice(index,1); dest.source.ops.push(op);
  }
  return pruneEmptyContainer(validateProject(p),layer.id);
}

export function removeObjectContainer(project,layerId) {
  const p=validateProject(project), layer=p.layers.find(l=>l.id===layerId);
  if(!layer) throw new Error('Unknown group.');
  unlocked(layer);
  if(p.animations.some(a=>a.frames.some(f=>hasLockedInstances(f.cels.find(c=>c.layerId===layerId))))) throw new Error('Unlock objects inside the group before deleting it.');
  if(p.layers.length===1) {
    for(const a of p.animations) for(const f of a.frames) f.cels=[{layerId,pixels:Array(p.width*p.height).fill(-1)}];
    layer.group=false;
  } else removeProjectLayer(p,layerId);
  return validateProject(p);
}

/** True when a container holds no artwork in any frame. */
function emptyContainer(p,layerId) {
  return p.animations.every(a=>a.frames.every(f=>{
    const cel=f.cels.find(c=>c.layerId===layerId);
    return !cel.source?.ops.length && !cel.source?.overrides.length && cel.pixels.every(v=>v<0);
  }));
}

/**
 * Drag-and-drop in the Objects panel. `source`/`anchor` are rows: {layerId,key,outer}, where `outer`
 * marks a row that represents its whole container (a group header or a lone ungrouped object).
 * `position` is 'above', 'below' or 'into' (an unlocked group). Returns the moved row.
 * Ungrouped containers left empty by a move are removed.
 */
export function dropObject(project,target,source,anchor,position,scope='animation') {
  if(!['above','below','into'].includes(position))throw new Error('Drop above, below or into an object.');
  const at=layerId=>({...target,layerId});
  let p=validateProject(project);
  const sourceLayer=p.layers.find(l=>l.id===source.layerId), anchorLayer=p.layers.find(l=>l.id===anchor.layerId);
  if(!sourceLayer || !anchorLayer)throw new Error('This object no longer exists.');
  const frame=p.animations.find(a=>a.id===target.animationId)?.frames.find(f=>f.id===target.frameId);
  const node=celObjects(frame.cels.find(c=>c.layerId===source.layerId)).find(n=>n.key===source.key);
  const side=position==='into'?'above':position;
  // A lone ungrouped instance joins the anchor's group when dropped into it or among its children.
  const movesContainer=source.outer && !(node?.instance && sourceLayer.group===false && (position==='into' || !anchor.outer));
  if(movesContainer) {
    if(source.layerId===anchor.layerId)return {project:p,layerId:source.layerId,key:source.key};
    return {project:placeObjectContainer(p,at(source.layerId),anchor.layerId,side,scope),layerId:source.layerId,key:source.key};
  }
  if(!node?.instance) {
    if(anchor.layerId!==source.layerId || anchor.outer)throw new Error('Pixel artwork stays in its group. Drag it among its siblings, or drag the group.');
    return {project:placeObject(p,at(source.layerId),source.key,anchor.key,side,scope),layerId:source.layerId,key:source.key};
  }
  let layerId;
  if(position==='into') {
    if(anchorLayer.group===false)throw new Error('Drop into a group, or above or below an object.');
    p=moveObjectToGroup(p,at(source.layerId),source.key,anchor.layerId,scope);layerId=anchor.layerId;
  } else if(!anchor.outer) {
    if(anchor.layerId!==source.layerId)p=moveObjectToGroup(p,at(source.layerId),source.key,anchor.layerId,scope);
    layerId=anchor.layerId;
    p=placeObject(p,at(layerId),source.key,anchor.key,side,scope);
  } else {
    const added=addObjectContainer(p,anchor.layerId,node.name,false);
    p=moveObjectToGroup(added.project,at(source.layerId),source.key,added.layerId,scope);layerId=added.layerId;
    if(side==='below')p=placeObjectContainer(p,at(layerId),anchor.layerId,'below',scope);
  }
  if(layerId!==source.layerId)p=pruneEmptyContainer(p,source.layerId);
  return {project:p,layerId,key:source.key};
}

export function objectBounds(project,node) {
  if(node.type!=='instance') return null;
  return instanceBox(node.instance,project.parts.find(p=>p.id===node.instance.partId));
}

function operationPixel(op,x,y,images,width,height) {
  if(op.type==='use') {
    if(op.visible===false)return undefined;
    const color=instancePixel(op,images.get(op.partId),{x,y});
    return color<0?undefined:color;
  }
  if(op.type==='span')return y===op.y && x>=op.x && x<op.x+op.values.length?op.values[x-op.x]:undefined;
  if(op.type==='line')return linePoints(op.x,op.y,op.x2,op.y2).some(p=>p.x===x && p.y===y)?op.color:undefined;
  if(x<op.x || y<op.y || x>=op.x+op.width || y>=op.y+op.height)return undefined;
  if(op.type==='rect')return op.color;
  return ellipsePoints(op.x,op.y,op.x+op.width-1,op.y+op.height-1,true,width,height).some(p=>p.x===x && p.y===y)?op.color:undefined;
}

/** Hit-test the final visible pixel, including erasures, hidden objects, and local overrides. */
export function hitTestObject(project,animation,frame,x,y) {
  if(x<0 || y<0 || x>=project.width || y>=project.height) return null;
  const images=renderParts(project.parts || []), index=y*project.width+x;
  for(const {layer,children} of frameObjects(project,animation,frame).reverse()) {
    if(!layer.visible) continue;
    const cel=frame.cels.find(c=>c.layerId===layer.id);
    if(cel.pixels[index]<0) continue;
    if(!cel.source) return {layerId:layer.id,key:'pixels',type:'pixels'};
    let owner=null;
    for(const node of children) {
      if(node.type==='overrides') {
        for(const op of cel.source.overrides) if(op.y===y && x>=op.x && x<op.x+op.values.length) owner=op.values[x-op.x]<0?null:node;
        continue;
      }
      for(const op of cel.source.ops.slice(node.start,node.end)) {
        const value=operationPixel(op,x,y,images,project.width,project.height);
        if(value!==undefined)owner=value<0?null:node;
      }
    }
    if(owner) return {layerId:layer.id,key:owner.key,type:owner.type};
  }
  return null;
}
