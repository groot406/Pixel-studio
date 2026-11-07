/** Detached object painting. The editor owns gesture lifecycle and the project commit boundary. */
import { validateProject, compositeFrame, floodFill, linePoints, rectanglePoints, ellipsePoints, MAX_TOTAL_PIXELS } from '../../domain/project.js';
import { renderParts, renderSource, MAX_PARTS } from '../../domain/artwork.js';
import { canvasToPartPoint } from '../../domain/geometry.js';
import { referencesToPart, forkInstance, paintSharedPart } from '../../domain/parts.js';
import { brushPoints, snapLineEnd, replaceColor } from '../../domain/toolbox.js';

export const PART_EDIT_TOOLS=['pencil','eraser','line','rectangle','ellipse','fill','replace','eyedropper'];
const BRUSH_TOOLS=['pencil','eraser','line'];

export function createInPlaceEdit(project,target,scope='shared') {
  const sourceProject=validateProject(project), layer=sourceProject.layers.find(l=>l.id===target.layerId);
  const animation=sourceProject.animations.find(a=>a.id===target.animationId), frame=animation?.frames.find(f=>f.id===target.frameId);
  const instance=frame?.cels.find(c=>c.layerId===layer?.id)?.source?.ops.find(op=>op.type==='use' && op.id===target.instanceId);
  if(!instance || !layer)throw new Error('Choose a part instance to edit on the canvas.');
  if(!layer.visible || layer.locked || instance.visible===false || instance.locked)throw new Error('Show and unlock this object and its group before editing it.');
  const images=renderParts(sourceProject.parts), image=images.get(instance.partId);
  let previewId='in_place_preview';
  while(images.has(previewId))previewId+='_';
  const session={sourceProject,target:{...target},frame,instance,partId:instance.partId,width:image.width,height:image.height,
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

export function inPlaceDirty(session) { return session.pixels.some((value,index)=>value!==session.original[index]); }
export function inPlacePoint(session,point) { return canvasToPartPoint(session.instance,session,point); }
function insidePart(session,p) { return p.x>=0 && p.y>=0 && p.x<session.width && p.y<session.height; }

function stamp(session,stroke,points) {
  const sized=BRUSH_TOOLS.includes(stroke.tool);
  const footprint=brushPoints(points,sized?stroke.brushSize:1,sized?stroke.brushShape:'square',session.sourceProject.width,session.sourceProject.height,stroke.symmetry);
  for(const point of footprint) {
    const local=inPlacePoint(session,point);
    if(insidePart(session,local))session.pixels[local.y*session.width+local.x]=stroke.color;
  }
}

export function beginInPlaceStroke(session,point,options) {
  const restriction=inPlaceRestriction(session);
  if(restriction)throw new Error(restriction);
  if(!PART_EDIT_TOOLS.includes(options.tool) || options.tool==='eyedropper')throw new Error('Choose a drawing tool.');
  const local=inPlacePoint(session,point);
  if(!insidePart(session,local))return null;
  if(!Number.isInteger(options.color) || options.color< -1 || options.color>=session.sourceProject.palette.length)throw new Error('Choose a palette color.');
  const stroke={...options,brushSize:options.brushSize || 1,brushShape:options.brushShape || 'square',symmetry:options.symmetry || 'none',
    origin:{...point},last:{...point},base:[...session.pixels]};
  if(stroke.tool==='eraser')stroke.color=-1;
  if(stroke.tool==='fill')floodFill(session.pixels,local.x,local.y,stroke.color,session.width,session.height);
  else if(stroke.tool==='replace')session.pixels=replaceColor(session.pixels,session.width,session.height,session.pixels[local.y*session.width+local.x],stroke.color);
  else stamp(session,stroke,[point]);
  session.revision++;
  return stroke;
}

export function moveInPlaceStroke(session,stroke,point,shift=false) {
  if(stroke.tool==='pencil' || stroke.tool==='eraser')stamp(session,stroke,linePoints(stroke.last.x,stroke.last.y,point.x,point.y));
  else if(stroke.tool==='line') {
    session.pixels=[...stroke.base];const end=shift?snapLineEnd(stroke.origin,point):point;
    stamp(session,stroke,linePoints(stroke.origin.x,stroke.origin.y,end.x,end.y));
  } else if(stroke.tool==='rectangle' || stroke.tool==='ellipse') {
    session.pixels=[...stroke.base];let end={...point};
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
  if(cancel)session.pixels=[...stroke.base];
  else if(session.pixels.some((value,index)=>value!==stroke.base[index])) {
    session.undo.push(stroke.base);if(session.undo.length>40)session.undo.shift();session.redo=[];
  }
  session.revision++;
}

export function restoreInPlace(session,redo=false) {
  const from=redo?session.redo:session.undo,to=redo?session.undo:session.redo;
  if(!from.length)return;
  to.push([...session.pixels]);session.pixels=from.pop();session.revision++;
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
    const source=session.scope==='shared'?cel.source:{...cel.source,ops:cel.source.ops.map(op=>op.type==='use' && op.id===session.target.instanceId?{...op,partId:key}:op)};
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
  if(session.scope==='shared' || session.references.length===1)return paintSharedPart(session.sourceProject,session.partId,session.pixels);
  const project=forkInstance(session.sourceProject,session.target,session.target.instanceId);
  const instance=project.animations.find(a=>a.id===session.target.animationId).frames.find(f=>f.id===session.target.frameId).cels.find(c=>c.layerId===session.target.layerId).source.ops.find(op=>op.type==='use' && op.id===session.target.instanceId);
  return paintSharedPart(project,instance.partId,session.pixels);
}
