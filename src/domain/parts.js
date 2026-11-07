/** Part editing use cases shared by the editor's part controls. */
import { validateProject, MAX_SIZE } from './project.js';
import { grownInstanceShift, transformedSize } from './geometry.js';
import { sourceForCel, pixelSpans, cloneArtwork, artworkId, renderOperations, hasLockedInstances } from './artwork.js';

export function referencesToPart(project, partId) {
  const refs = [];
  for (const a of project.animations) for (const f of a.frames) for (const c of f.cels) for (const op of c.source?.ops || []) {
    if (op.type === 'use' && op.partId === partId) refs.push({ animationId:a.id, frameId:f.id, layerId:c.layerId, instanceId:op.id, locked:Boolean(op.locked) });
  }
  return refs;
}
export function nextPartId(project, base = 'part') {
  const prefix = base.slice(0,85);
  let i = 1;
  while ((project.parts || []).some(p => p.id === `${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}
function editable(project, target) {
  const p = validateProject(project);
  const layer = p.layers.find(l => l.id === target.layerId);
  if (!layer || layer.locked || !layer.visible) throw new Error('Select a visible, unlocked layer.');
  const cel = p.animations.find(a => a.id === target.animationId)?.frames.find(f => f.id === target.frameId)?.cels.find(c => c.layerId === target.layerId);
  if (!cel) throw new Error('Unknown target cel.');
  p.version = 3; p.parts ||= [];
  cel.source = sourceForCel(cel,p.width);
  return {p,cel};
}
function instanceId(source, base) {
  let id=base, n=2;
  while(source.ops.some(op=>op.type==='use' && op.id===id)) id=`${base.slice(0,85)}_${n++}`;
  return id;
}
export function extractPart(project, target, rect, id) {
  const {p,cel}=editable(project,target);
  if (hasLockedInstances(cel)) throw new Error('Unlock objects in this group before extracting its pixels.');
  artworkId(id);
  if(p.parts.some(part=>part.id===id)) throw new Error('A part with that name already exists.');
  const {x,y,width,height}=rect;
  if (![x,y,width,height].every(Number.isInteger) || x<0 || y<0 || width<1 || height<1 || x+width>p.width || y+height>p.height) throw new Error('Invalid extraction rectangle.');
  const pixels=[];
  for(let yy=y;yy<y+height;yy++) for(let xx=x;xx<x+width;xx++) pixels.push(cel.pixels[yy*p.width+xx]);
  if(pixels.every(v=>v<0)) throw new Error('Select some artwork to create a part.');
  p.parts.push({id,width,height,ops:pixelSpans(pixels,width)});
  cel.source.ops.push({type:'rect',x,y,width,height,color:-1},{type:'use',id:instanceId(cel.source,id),partId:id,x,y,transform:'N'});
  // The extracted image includes these local edits; remove overrides inside the new part's bounds.
  const keep = new Map();
  for(const op of cel.source.overrides) op.values.forEach((v,i)=>{
    const xx=op.x+i;
    if(xx<x || xx>=x+width || op.y<y || op.y>=y+height) keep.set(op.y*p.width+xx,v);
  });
  cel.source.overrides=pixelSpans(cel.pixels.map((v,i)=>keep.has(i)?keep.get(i):v),p.width,i=>keep.has(i));
  return validateProject(p);
}
export function placePart(project,target,partId,x=0,y=0) {
  const {p,cel}=editable(project,target);
  if(!p.parts.some(part=>part.id===partId)) throw new Error('Choose a part.');
  cel.source.ops.push({type:'use',id:instanceId(cel.source,partId),partId,x,y,transform:'N'});
  return validateProject(p);
}
export function changeInstance(project,target,id,changes) {
  const {p,cel}=editable(project,target);
  const op=cel.source.ops.find(op=>op.type==='use' && op.id===id);
  if(!op) throw new Error('Choose an instance in this frame.');
  if(op.locked) throw new Error('Unlock this object before moving it.');
  for(const field of Object.keys(changes)) if(!['x','y','transform'].includes(field)) throw new Error('Unsupported instance change.');
  Object.assign(op,changes);
  return validateProject(p);
}
export function forkInstance(project,target,id) {
  const {p,cel}=editable(project,target);
  const op=cel.source.ops.find(op=>op.type==='use' && op.id===id);
  if(!op) throw new Error('Choose an instance in this frame.');
  if(op.locked) throw new Error('Unlock this object before making it independent.');
  const part=cloneArtwork(p.parts.find(part=>part.id===op.partId));
  part.id=nextPartId(p,`${part.id}_copy`);
  p.parts.push(part); op.partId=part.id;
  return validateProject(p);
}
export function paintSharedPart(project,partId,pixels) {
  const p=validateProject(project), part=p.parts?.find(part=>part.id===partId);
  if(!part) throw new Error('Choose a part.');
  if(referencesToPart(p,partId).some(ref=>ref.locked || p.layers.find(l=>l.id===ref.layerId).locked)) throw new Error('This part is used by a locked object or group. Unlock it before editing the shared artwork.');
  if(!Array.isArray(pixels) || pixels.length!==part.width*part.height || pixels.some(v=>!Number.isInteger(v)||v< -1||v>=p.palette.length)) throw new Error('Invalid part pixels.');
  const before=renderOperations(part.ops,part.width,part.height);
  part.ops.push(...pixelSpans(pixels,part.width,(i,v)=>v!==before[i]));
  return validateProject(p);
}
export function flattenCel(project,target) {
  const {p,cel}=editable(project,target);
  if (hasLockedInstances(cel)) throw new Error('Unlock objects in this group before flattening it.');
  delete cel.source;
  return validateProject(p);
}

/**
 * Free angles and skew act about the pivot. A set pivot follows its artwork pixel (it moves by −shift inside the box),
 * so nothing moves. The default pivot is the box centre, which moves when the box grows by d = shift + (new − old size)/2;
 * moving the origin by shift − (I − L)·d, with L = rotation·3D turn·skew, keeps the old pixels in place (rounded to the pixel).
 */
function keepTurnedPivot(op,shift,before,after) {
  if(op.pivot) { op.pivot={x:Math.max(-128,Math.min(256,op.pivot.x-shift.x)),y:Math.max(-128,Math.min(256,op.pivot.y-shift.y))}; return; }
  if(!op.angle && !op.skew && !op.tilt)return;
  const r=(op.angle || 0)*Math.PI/180, cos=Math.cos(r), sin=Math.sin(r), tan=deg=>Math.tan((deg || 0)*Math.PI/180), rad=deg=>(deg || 0)*Math.PI/180;
  const dx=shift.x+(after.width-before.width)/2, dy=shift.y+(after.height-before.height)/2;
  let sx=dx+tan(op.skew?.x)*dy, sy=dy+tan(op.skew?.y)*sx;
  // The 3D turn's linear part (perspective is ignored here: it shifts the art by less than a pixel for small growth).
  if(op.tilt)[sx,sy]=[Math.cos(rad(op.tilt.y))*sx,Math.sin(rad(op.tilt.y))*Math.sin(rad(op.tilt.x))*sx+Math.cos(rad(op.tilt.x))*sy];
  shift.x=Math.round(shift.x-(dx-(sx*cos-sy*sin)));
  shift.y=Math.round(shift.y-(dy-(sx*sin+sy*cos)));
}
/**
 * Grow a part's canvas by padding it on each side. Existing artwork keeps its canvas position in every
 * instance, whatever its transform.
 */
export function growPart(project,partId,{left=0,top=0,right=0,bottom=0}) {
  const p=validateProject(project), part=p.parts?.find(part=>part.id===partId);
  if(!part) throw new Error('Choose a part.');
  if(![left,top,right,bottom].every(v=>Number.isInteger(v) && v>=0)) throw new Error('Parts can only grow by whole pixels.');
  if(!(left||top||right||bottom)) return p;
  const before={width:part.width,height:part.height}, after={width:part.width+left+right,height:part.height+top+bottom};
  if(after.width>MAX_SIZE || after.height>MAX_SIZE) throw new Error(`Parts can be at most ${MAX_SIZE} × ${MAX_SIZE} pixels.`);
  part.ops=part.ops.map(op=>op.type==='line'?{...op,x:op.x+left,y:op.y+top,x2:op.x2+left,y2:op.y2+top}:{...op,x:op.x+left,y:op.y+top});
  Object.assign(part,after);
  for(const a of p.animations) for(const f of a.frames) for(const c of f.cels) for(const op of c.source?.ops || []) {
    if(op.type==='use' && op.partId===partId) Object.assign(op,grownInstance(op,before,after,left,top));
  }
  return validateProject(p);
}

/**
 * A `use` op after its part grew from `before` to `after` by `left`/`top` padding, placed so existing artwork
 * stays where it was on the canvas, including resized and rotated instances.
 */
export function grownInstance(instance,before,after,left,top) {
  const op={...instance}, box=transformedSize(op,before);
  if(op.width===undefined && op.height===undefined) {
    const shift=grownInstanceShift(op.transform,before,after,left,top);
    keepTurnedPivot(op,shift,box,transformedSize(op,after));
    op.x+=shift.x; op.y+=shift.y; return op;
  }
  // Resized instances keep their scale: padding grows by the same factor so the artwork stays put (to the pixel).
  const sx=(op.width??before.width)/before.width, sy=(op.height??before.height)/before.height;
  const shown={width:Math.round(after.width*sx),height:Math.round(after.height*sy)};
  const shift=grownInstanceShift(op.transform,{width:op.width??before.width,height:op.height??before.height},shown,Math.round(left*sx),Math.round(top*sy));
  op.width=shown.width; op.height=shown.height;
  keepTurnedPivot(op,shift,box,transformedSize(op,before));
  op.x+=shift.x; op.y+=shift.y;
  return op;
}

/**
 * Where each part is used: instance count plus, per animation, the frame indices that place it.
 * Feeds the part library ("Used 6× · Idle 1–4, Walk 2").
 */
export function partUsage(project) {
  const usage=new Map((project.parts || []).map(part=>[part.id,{instances:0,animations:[]}]));
  for(const animation of project.animations) {
    const perPart=new Map();
    animation.frames.forEach((frame,index)=>{
      for(const cel of frame.cels) for(const op of cel.source?.ops || []) {
        if(op.type!=='use' || !usage.has(op.partId))continue;
        usage.get(op.partId).instances++;
        const frames=perPart.get(op.partId) || new Set();frames.add(index);perPart.set(op.partId,frames);
      }
    });
    for(const [partId,frames] of perPart)usage.get(partId).animations.push({id:animation.id,name:animation.name,frames:[...frames].sort((a,b)=>a-b)});
  }
  return usage;
}

/** "1–4, 6" style list of zero-based frame indices, shown one-based. */
export function frameRanges(indices) {
  const ranges=[];
  for(const i of indices) {
    const last=ranges.at(-1);
    if(last && i===last[1]+1)last[1]=i;else ranges.push([i,i]);
  }
  return ranges.map(([a,b])=>a===b?`${a+1}`:`${a+1}–${b+1}`).join(', ');
}

/** Rename a part and every instance that points at it. */
export function renamePart(project,partId,nextId) {
  const id=artworkId(nextId);
  const p=validateProject(project);
  if(!p.parts?.some(part=>part.id===partId))throw new Error('Choose a part.');
  if(id===partId)return p;
  if(p.parts.some(part=>part.id===id))throw new Error(`A part named ${id} already exists.`);
  p.parts.find(part=>part.id===partId).id=id;
  for(const animation of p.animations) for(const frame of animation.frames) for(const cel of frame.cels)
    for(const op of cel.source?.ops || []) if(op.type==='use' && op.partId===partId)op.partId=id;
  return validateProject(p);
}

/** Delete a part that nothing uses any more. */
export function removePart(project,partId) {
  if(referencesToPart(project,partId).length)throw new Error('This part is still placed. Delete its objects first.');
  const p=validateProject(project);
  if(!p.parts?.some(part=>part.id===partId))throw new Error('Choose a part.');
  p.parts=p.parts.filter(part=>part.id!==partId);
  return validateProject(p);
}

/**
 * Place a part at the same position in several frames of one animation. Every new instance shares one id
 * when possible, so the Objects panel treats it as one object across the animation.
 * Returns the project and the instance id used in the first frame.
 */
export function placePartInFrames(project,{animationId,layerId,frameIds},partId,x=0,y=0) {
  if(!frameIds.length)throw new Error('Choose at least one frame.');
  let p=project, id=null;
  for(const frameId of frameIds) {
    const target={animationId,frameId,layerId};
    const before=new Set(opsAt(p,target).map(op=>op.id));
    p=placePart(p,target,partId,x,y);
    const added=opsAt(p,target).find(op=>op.type==='use' && !before.has(op.id));
    id??=added.id;
  }
  return {project:p,instanceId:id};
}
function opsAt(project,{animationId,frameId,layerId}) {
  return project.animations.find(a=>a.id===animationId).frames.find(f=>f.id===frameId).cels.find(c=>c.layerId===layerId).source?.ops || [];
}
