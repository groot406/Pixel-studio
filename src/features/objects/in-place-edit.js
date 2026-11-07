/** Detached object painting. The editor owns gesture lifecycle and the project commit boundary. */
import { validateProject, compositeFrame, floodFill, linePoints, rectanglePoints, ellipsePoints, MAX_TOTAL_PIXELS, MAX_SIZE } from '../../domain/project.js';
import { renderParts, renderSource, MAX_PARTS } from '../../domain/artwork.js';
import { canvasToPartPoint, partToCanvasOffset, grownInstanceShift } from '../../domain/geometry.js';
import { referencesToPart, forkInstance, paintSharedPart, growPart } from '../../domain/parts.js';
import { brushPoints, snapLineEnd, replaceColor, copyPixels, pastePixels, shadeIndex, ditherCell } from '../../domain/toolbox.js';
import { moveSelectedPixels } from '../../domain/selection.js';

export const PART_EDIT_TOOLS=['pencil','eraser','line','rectangle','ellipse','fill','replace','eyedropper','select','dither','shade'];
const BRUSH_TOOLS=['pencil','eraser','line','dither','shade'];

export function createInPlaceEdit(project,target,scope='shared') {
  const sourceProject=validateProject(project), layer=sourceProject.layers.find(l=>l.id===target.layerId);
  const animation=sourceProject.animations.find(a=>a.id===target.animationId), frame=animation?.frames.find(f=>f.id===target.frameId);
  const instance=frame?.cels.find(c=>c.layerId===layer?.id)?.source?.ops.find(op=>op.type==='use' && op.id===target.instanceId);
  if(!instance || !layer)throw new Error('Choose a part instance to edit on the canvas.');
  if(!layer.visible || layer.locked || instance.visible===false || instance.locked)throw new Error('Show and unlock this object and its group before editing it.');
  if(instance.width!==undefined)throw new Error('This object is resized in this frame. Edit it in a frame where it has its original size, or reset its size with the Resize tool.');
  const images=renderParts(sourceProject.parts), image=images.get(instance.partId);
  let previewId='in_place_preview';
  while(images.has(previewId))previewId+='_';
  const session={sourceProject,target:{...target},frame,instance,partId:instance.partId,width:image.width,height:image.height,
    originalWidth:image.width,originalHeight:image.height,left:0,top:0,selection:null,
    images,previewId,original:[...image.pixels],pixels:[...image.pixels],references:referencesToPart(sourceProject,instance.partId),
    scope:'shared',undo:[],redo:[],revision:0,preview:null};
  setInPlaceScope(session,scope);
  return session;
}

export function setInPlaceScope(session,scope) {
  if(!['shared','frame'].includes(scope))throw new Error('Choose shared artwork or this frame only.');
  session.scope=scope; session.revision++;
}

export function inPlaceRestriction(session) {
  if(session.scope==='shared') {
    const locked=session.references.filter(ref=>ref.locked || session.sourceProject.layers.find(l=>l.id===ref.layerId).locked);
    return locked.length?`Shared artwork has ${locked.length} locked instance${locked.length===1?'':'s'}. Unlock them or choose “This frame only”.`:null;
  }
  if(session.references.length>1) {
    if(session.sourceProject.parts.length>=MAX_PARTS)return 'The part library is full. This frame needs an independent part before it can be edited.';
    const stored=session.sourceProject.parts.reduce((n,p)=>n+p.width*p.height,0)+session.width*session.height;
    if(stored>MAX_TOTAL_PIXELS)return 'There is no room for an independent copy of this part. Reduce the part library first.';
  }
  return null;
}

export function inPlaceDirty(session) { return session.width!==session.originalWidth || session.height!==session.originalHeight || session.pixels.some((value,index)=>value!==session.original[index]); }
/** Padding added around the original part while drawing beyond its edges. */
export function inPlaceGrowth(session) {
  return {left:session.left,top:session.top,right:session.width-session.originalWidth-session.left,bottom:session.height-session.originalHeight-session.top};
}
function grown(session) { return session.left || session.top || session.width!==session.originalWidth || session.height!==session.originalHeight; }
/** Keep an instance's existing pixels in place while the draft part is larger than the original. */
function shifted(session,op) {
  if(!grown(session))return op;
  const shift=grownInstanceShift(op.transform,{width:session.originalWidth,height:session.originalHeight},session,session.left,session.top);
  return {...op,x:op.x+shift.x,y:op.y+shift.y};
}
export function inPlaceInstance(session) { return shifted(session,session.instance); }
export function inPlacePoint(session,point) { return canvasToPartPoint(inPlaceInstance(session),session,point); }
/** Canvas rectangle covered by a part-space rectangle. */
export function inPlaceCanvasRect(session,rect=null) {
  rect||={x:0,y:0,width:session.width,height:session.height};
  const instance=inPlaceInstance(session);
  const a=partToCanvasOffset(instance.transform,session,rect.x,rect.y), b=partToCanvasOffset(instance.transform,session,rect.x+rect.width-1,rect.y+rect.height-1);
  return {x:instance.x+Math.min(a.x,b.x),y:instance.y+Math.min(a.y,b.y),width:Math.abs(a.x-b.x)+1,height:Math.abs(a.y-b.y)+1};
}
function insidePart(session,p) { return p.x>=0 && p.y>=0 && p.x<session.width && p.y<session.height; }
function capture(session) { return {pixels:[...session.pixels],width:session.width,height:session.height,left:session.left,top:session.top,selection:session.selection && {...session.selection}}; }
function apply(session,saved) { Object.assign(session,{pixels:[...saved.pixels],width:saved.width,height:saved.height,left:saved.left,top:saved.top,selection:saved.selection && {...saved.selection}}); }
function same(a,b) { return a.width===b.width && a.height===b.height && a.pixels.every((value,index)=>value===b.pixels[index]); }
function remember(session,before) {
  if(same(session,before))return;
  session.undo.push(before);if(session.undo.length>40)session.undo.shift();session.redo=[];
}

/** Pad the draft so all given part-space points fit, up to the maximum part size. */
function grow(session,locals) {
  if(!locals.length)return;
  let minX=0,minY=0,maxX=session.width-1,maxY=session.height-1;
  for(const p of locals){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}
  const left=Math.min(-minX,MAX_SIZE-session.width), right=Math.max(0,Math.min(maxX-session.width+1,MAX_SIZE-session.width-left));
  const top=Math.min(-minY,MAX_SIZE-session.height), bottom=Math.max(0,Math.min(maxY-session.height+1,MAX_SIZE-session.height-top));
  if(!(left||right||top||bottom))return;
  const width=session.width+left+right, height=session.height+top+bottom, pixels=Array(width*height).fill(-1);
  for(let y=0;y<session.height;y++) for(let x=0;x<session.width;x++) pixels[(y+top)*width+x+left]=session.pixels[y*session.width+x];
  const selection=session.selection && {...session.selection,x:session.selection.x+left,y:session.selection.y+top};
  Object.assign(session,{pixels,width,height,left:session.left+left,top:session.top+top,selection});
}

function stamp(session,stroke,points) {
  const sized=BRUSH_TOOLS.includes(stroke.tool);
  let footprint=brushPoints(points,sized?stroke.brushSize:1,sized?stroke.brushShape:'square',session.sourceProject.width,session.sourceProject.height,stroke.symmetry);
  if(stroke.tool==='shade') {
    // Each pixel shifts one palette step per stroke, however often the brush passes over it.
    stroke.touched||=new Set();
    for(const point of footprint) {
      const local=inPlacePoint(session,point), key=`${point.x},${point.y}`;
      if(!insidePart(session,local) || stroke.touched.has(key))continue;
      stroke.touched.add(key);
      const index=local.y*session.width+local.x, color=session.pixels[index];
      if(color>=0)session.pixels[index]=shadeIndex(session.sourceProject.palette,color,stroke.shade || -1);
    }
    return;
  }
  if(stroke.tool==='dither')footprint=footprint.filter(point=>ditherCell(point.x,point.y));
  // Painting past the outline extends the part; erasing there has nothing to remove.
  if(stroke.color>=0)grow(session,footprint.map(point=>inPlacePoint(session,point)));
  for(const point of footprint) {
    const local=inPlacePoint(session,point);
    if(insidePart(session,local))session.pixels[local.y*session.width+local.x]=stroke.color;
  }
}

/** Start a draft stroke. `from` (pencil/eraser) draws a straight line from that canvas point first. */
export function beginInPlaceStroke(session,point,options) {
  const restriction=inPlaceRestriction(session);
  if(restriction)throw new Error(restriction);
  if(!PART_EDIT_TOOLS.includes(options.tool) || ['eyedropper','select'].includes(options.tool))throw new Error('Choose a drawing tool.');
  const local=inPlacePoint(session,point);
  if(['fill','replace'].includes(options.tool) && !insidePart(session,local))return null;
  if(!Number.isInteger(options.color) || options.color< -1 || options.color>=session.sourceProject.palette.length)throw new Error('Choose a palette color.');
  const stroke={...options,brushSize:options.brushSize || 1,brushShape:options.brushShape || 'square',symmetry:options.symmetry || 'none',
    origin:{...point},last:{...point},base:capture(session)};
  delete stroke.from;
  if(stroke.tool==='eraser')stroke.color=-1;
  if(stroke.tool==='fill')floodFill(session.pixels,local.x,local.y,stroke.color,session.width,session.height);
  else if(stroke.tool==='replace')session.pixels=replaceColor(session.pixels,session.width,session.height,session.pixels[local.y*session.width+local.x],stroke.color);
  else if(options.from && ['pencil','eraser','dither','shade'].includes(stroke.tool))stamp(session,stroke,linePoints(options.from.x,options.from.y,point.x,point.y));
  else stamp(session,stroke,[point]);
  session.revision++;
  return stroke;
}

export function moveInPlaceStroke(session,stroke,point,shift=false) {
  if(['pencil','eraser','dither','shade'].includes(stroke.tool))stamp(session,stroke,linePoints(stroke.last.x,stroke.last.y,point.x,point.y));
  else if(stroke.tool==='line') {
    apply(session,stroke.base);const end=shift?snapLineEnd(stroke.origin,point):point;
    stamp(session,stroke,linePoints(stroke.origin.x,stroke.origin.y,end.x,end.y));
  } else if(stroke.tool==='rectangle' || stroke.tool==='ellipse') {
    apply(session,stroke.base);let end={...point};
    if(shift) {
      const dx=end.x-stroke.origin.x,dy=end.y-stroke.origin.y,size=Math.max(Math.abs(dx),Math.abs(dy));
      end={x:stroke.origin.x+(Math.sign(dx)||1)*size,y:stroke.origin.y+(Math.sign(dy)||1)*size};
    }
    const points=stroke.tool==='rectangle'?rectanglePoints:ellipsePoints;
    stamp(session,stroke,points(stroke.origin.x,stroke.origin.y,end.x,end.y,stroke.filled,session.sourceProject.width,session.sourceProject.height));
  }
  stroke.last={...point};session.revision++;
}

export function finishInPlaceStroke(session,stroke,cancel=false) {
  if(cancel)apply(session,stroke.base);
  else remember(session,stroke.base);
  session.revision++;
}

export function restoreInPlace(session,redo=false) {
  const from=redo?session.redo:session.undo,to=redo?session.undo:session.redo;
  if(!from.length)return;
  to.push(capture(session));apply(session,from.pop());session.revision++;
}

function clampLocal(session,p) { return {x:Math.max(0,Math.min(session.width-1,p.x)),y:Math.max(0,Math.min(session.height-1,p.y))}; }
function localRect(a,b) { return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x)+1,height:Math.abs(a.y-b.y)+1}; }
function contains(rect,p) { return rect && p.x>=rect.x && p.y>=rect.y && p.x<rect.x+rect.width && p.y<rect.y+rect.height; }

/** Start a marquee, or move the selected pixels when the press is inside the selection. Coordinates are in part space. */
export function beginInPlaceSelection(session,point) {
  const local=inPlacePoint(session,point);
  if(contains(session.selection,local))return {selectMode:'move',origin:local,base:capture(session),rect:{...session.selection}};
  const origin=clampLocal(session,local);
  if(!insidePart(session,local) && !session.selection)return null;
  const gesture={selectMode:'marquee',origin,base:capture(session)};
  session.selection=insidePart(session,local)?localRect(origin,origin):null;
  session.revision++;
  return session.selection?gesture:null;
}
export function moveInPlaceSelection(session,gesture,point) {
  const local=inPlacePoint(session,point);
  if(gesture.selectMode==='marquee')session.selection=localRect(gesture.origin,clampLocal(session,local));
  else {
    apply(session,gesture.base);
    const result=moveSelectedPixels(session.pixels,session.width,session.height,gesture.rect,local.x-gesture.origin.x,local.y-gesture.origin.y);
    session.pixels=result.pixels;session.selection=result.selection;
  }
  session.revision++;
}
export function finishInPlaceSelection(session,gesture,cancel=false) {
  if(cancel)apply(session,gesture.base);
  else if(gesture.selectMode==='move')remember(session,gesture.base);
  session.revision++;
}
export function selectAllInPlace(session) { session.selection={x:0,y:0,width:session.width,height:session.height};session.revision++; }
export function deselectInPlace(session) { session.selection=null;session.revision++; }
export function nudgeInPlaceSelection(session,dx,dy) {
  if(!session.selection)return;
  const before=capture(session), result=moveSelectedPixels(session.pixels,session.width,session.height,session.selection,dx,dy);
  session.pixels=result.pixels;session.selection=result.selection;remember(session,before);session.revision++;
}
export function clearInPlaceSelection(session) {
  const rect=session.selection;
  if(!rect)return;
  const before=capture(session);
  for(let y=rect.y;y<rect.y+rect.height;y++) for(let x=rect.x;x<rect.x+rect.width;x++) session.pixels[y*session.width+x]=-1;
  remember(session,before);session.revision++;
}
/** Selected pixels in the same clipboard shape as canvas copies; x/y are canvas coordinates. */
export function copyInPlaceSelection(session) {
  if(!session.selection)return null;
  const rect=inPlaceCanvasRect(session,session.selection);
  return {...copyPixels(session.pixels,session.width,session.height,session.selection),palette:[...session.sourceProject.palette],x:rect.x,y:rect.y};
}
/**
 * Paste clipboard pixels (already mapped to this palette) into the draft at a part-space position,
 * growing the part when they overhang its edges. The pasted area becomes the selection.
 */
export function pasteInPlace(session,clipboard,at=null) {
  const before=capture(session);
  // Without a selection, pixels land where they were copied, relative to this object.
  const origin=at || session.selection || inPlacePoint(session,{x:clipboard.x,y:clipboard.y});
  const corners=[{x:origin.x,y:origin.y},{x:origin.x+clipboard.width-1,y:origin.y+clipboard.height-1}];
  const left0=session.left, top0=session.top;
  grow(session,corners);
  const x=origin.x+session.left-left0, y=origin.y+session.top-top0;
  const result=pastePixels(session.pixels,session.width,session.height,clipboard,Math.max(0,x),Math.max(0,y));
  session.pixels=result.pixels;session.selection=result.selection;
  remember(session,before);session.revision++;
}

/** Rebuild only affected cels in the anchored frame; ordinary project data stays untouched. */
export function previewInPlaceEdit(session) {
  if(session.preview?.revision===session.revision)return session.preview.pixels;
  const images=new Map(session.images), key=session.scope==='shared'?session.partId:session.previewId;
  images.set(key,{width:session.width,height:session.height,pixels:session.pixels});
  const frame={...session.frame,cels:session.frame.cels.map(cel=>{
    if(!cel.source)return cel;
    const affected=session.scope==='shared'?cel.source.ops.some(op=>op.type==='use' && op.partId===session.partId):cel.layerId===session.target.layerId;
    if(!affected)return cel;
    const target=op=>op.type==='use' && (session.scope==='shared'?op.partId===session.partId:op.id===session.target.instanceId);
    const source={...cel.source,ops:cel.source.ops.map(op=>target(op)?{...shifted(session,op),partId:key}:op)};
    return {...cel,pixels:renderSource(source,session.sourceProject.width,session.sourceProject.height,images)};
  })};
  const pixels=compositeFrame(session.sourceProject,frame);
  session.preview={revision:session.revision,pixels};
  return pixels;
}

export function prepareInPlaceEdit(session) {
  const restriction=inPlaceRestriction(session);
  if(restriction)throw new Error(restriction);
  if(!inPlaceDirty(session))return validateProject(session.sourceProject);
  const growth=inPlaceGrowth(session);
  if(session.scope==='shared' || session.references.length===1)return paintSharedPart(growPart(session.sourceProject,session.partId,growth),session.partId,session.pixels);
  const project=forkInstance(session.sourceProject,session.target,session.target.instanceId);
  const instance=project.animations.find(a=>a.id===session.target.animationId).frames.find(f=>f.id===session.target.frameId).cels.find(c=>c.layerId===session.target.layerId).source.ops.find(op=>op.type==='use' && op.id===session.target.instanceId);
  return paintSharedPart(growPart(project,instance.partId,growth),instance.partId,session.pixels);
}
