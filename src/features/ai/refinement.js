import { compositeFrame } from '../../domain/project.js';
import { createCompositionRequest } from './composition-edit.js';

export function refinementFrames(project, request) {
  const frames=project.animations.flatMap(a=>a.frames.map(f=>({animationId:a.id,frameId:f.id})))
    .filter(f=>request.scope==='project'||(f.animationId===request.animationId&&(request.scope!=='frame'||f.frameId===request.frameId)));
  if(frames.length<=16)return frames;
  return Array.from({length:16},(_,i)=>frames[Math.round(i*(frames.length-1)/15)]);
}
export function createRefinementRequest(proposal,request) {
  if(request.refinement || proposal.version!==3) throw new Error('Visual refinement allows one extra pass on a PXA 2 proposal.');
  const next=createCompositionRequest(proposal,{...request,instruction:request.instruction});
  const frames=refinementFrames(proposal,request);
  next.refinement=true;
  next.prompt=`Inspect the attached rendered previews: image 1 is the original artwork; image 2 is the proposed edit. Each tile is enlarged with nearest-neighbor pixels. Gray backgrounds and tile labels are preview UI, not artwork. The following frame IDs label the tiles in reading order:\n${frames.map((f,i)=>`${i+1}: ${f.animationId}/${f.frameId}`).join('\n')}\nThis is one optional correction pass. Keep the requested change and correct visible defects in silhouette, alignment, shading or animation continuity. Use the text source for exact pixel coordinates. Preserve other frames even if they are not pictured. If no correction is needed, return the required BASE and END with the completion comment and no operations.\n\n${next.prompt}`;
  return next;
}

/** Browser adapter: render a bounded contact sheet, not editor chrome or unrelated workspace data. */
export function renderRefinementPreview(project,frames,makeCanvas=()=>document.createElement('canvas')) {
  const columns=Math.min(4,frames.length), rows=Math.ceil(frames.length/columns), tile=240;
  const canvas=makeCanvas();canvas.width=columns*tile;canvas.height=rows*tile;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#e5e5e5';ctx.fillRect(0,0,canvas.width,canvas.height);
  const scale=Math.min(4,Math.floor(216/Math.max(project.width,project.height)));
  frames.forEach((ref,i)=>{
    const f=project.animations.find(a=>a.id===ref.animationId).frames.find(f=>f.id===ref.frameId);
    const x=(i%columns)*tile,y=Math.floor(i/columns)*tile;
    ctx.fillStyle='#333333';ctx.font='12px sans-serif';ctx.fillText(String(i+1),x+8,y+15);
    const pixels=compositeFrame(project,f), left=x+Math.floor((tile-project.width*scale)/2), top=y+22;
    pixels.forEach((v,index)=>{if(v>=0){ctx.fillStyle=project.palette[v];ctx.fillRect(left+(index%project.width)*scale,top+Math.floor(index/project.width)*scale,scale,scale);}});
  });
  return canvas.toDataURL('image/png');
}
