/** Object editing over the established cel format. Groups retain isolated erase/override semantics. */
import { validateProject, getAnimationLayers, insertProjectLayer, removeProjectLayer, uid, MAX_LAYERS, MAX_TOTAL_PIXELS } from './project.js';
import { cloneArtwork, sourceForCel, renderParts, hasLockedInstances } from './artwork.js';
import { linePoints, ellipsePoints, canvasToPartPoint } from './geometry.js';
import { nextPartId } from './parts.js';

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

export function updateObject(project,target,key,changes,scope='animation') {
  const {p,layer,frames}=context(project,target,scope);
  unlocked(layer);
  for (const name of Object.keys(changes)) if (!['name','visible','locked','x','y','transform'].includes(name)) throw new Error('Unsupported object setting.');
  for (const frame of frames) {
    const op=frame.cels.find(c=>c.layerId===layer.id).source?.ops.find(op=>op.type==='use' && op.id===key);
    if (!op) continue;
    if (Object.keys(changes).some(name=>name!=='locked')) unlocked(layer,{instance:op});
    Object.assign(op,changes);
  }
  return validateProject(p);
}

/** Move each appearance by the same offset while preserving its authored pose. */
export function translateObject(project,target,key,dx,dy,scope='animation') {
  if(!Number.isInteger(dx) || !Number.isInteger(dy))throw new Error('Object movement uses whole pixels.');
  const {p,layer,frames}=context(project,target,scope);
  for(const frame of frames) {
    const op=frame.cels.find(c=>c.layerId===layer.id).source?.ops.find(op=>op.type==='use' && op.id===key);
    if(!op)continue;
    unlocked(layer,{instance:op}); op.x+=dx;op.y+=dy;
  }
  return validateProject(p);
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
  return validateProject(p);
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
  return validateProject(p);
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
  if(layerId!==source.layerId && sourceLayer.group===false && p.layers.length>1 && emptyContainer(p,source.layerId))p=removeObjectContainer(p,source.layerId);
  return {project:p,layerId,key:source.key};
}

export function objectBounds(project,node) {
  if(node.type!=='instance') return null;
  const part=project.parts.find(p=>p.id===node.instance.partId), op=node.instance;
  const rotated=['R90','R270'].includes(op.transform);
  return {x:op.x,y:op.y,width:rotated?part.height:part.width,height:rotated?part.width:part.height};
}

function operationPixel(op,x,y,images,width,height) {
  if(op.type==='use') {
    if(op.visible===false)return undefined;
    const part=images.get(op.partId), local=canvasToPartPoint(op,part,{x,y});
    if(local.x<0 || local.y<0 || local.x>=part.width || local.y>=part.height)return undefined;
    const color=part.pixels[local.y*part.width+local.x];
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
