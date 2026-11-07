import { renderParts, cloneArtwork, pixelSpans } from '../domain/artwork.js';
import { validateProject, compositeFrame, linePoints, floodFill } from '../domain/project.js';
import { referencesToPart, paintSharedPart } from '../domain/parts.js';

const $=id=>document.getElementById(id);
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** A detached part-sized editing buffer; Apply changes its definition in one project Undo step. */
export function openSharedPartEditor({project,partId,animationId,frameId,openDialog,onApply}) {
  const part=project.parts?.find(p=>p.id===partId), image=renderParts(project.parts || []).get(partId);
  if(!part || !image) throw new Error('This shared part no longer exists.');
  const refs=referencesToPart(project,partId), locked=refs.filter(ref=>ref.locked || project.layers.find(l=>l.id===ref.layerId).locked);
  let pixels=[...image.pixels], undo=[], redo=[], stroke=null, tool='pencil', color=project.palette.length>1?1:0, cursor={x:0,y:0};
  const animation=project.animations.find(a=>a.id===animationId) || project.animations[0];
  let previewFrameId=animation.frames.some(f=>f.id===frameId)?frameId:animation.frames[0].id;
  openDialog(`Edit ${partId}`,`<div class="shared-part-layout">
    <div class="shared-part-workspace"><div class="shared-part-tools" role="group" aria-label="Part drawing tools">
      <button class="button small" data-part-tool="pencil" aria-pressed="true">Paint <kbd>B</kbd></button><button class="button small" data-part-tool="eraser" aria-pressed="false">Erase <kbd>E</kbd></button><button class="button small" data-part-tool="fill" aria-pressed="false">Fill <kbd>F</kbd></button>
      <button id="part-undo" class="button small" disabled>Undo</button><button id="part-redo" class="button small" disabled>Redo</button></div>
      <div class="shared-part-stage"><canvas id="shared-part-canvas" width="${part.width}" height="${part.height}" tabindex="0" role="img" aria-label="Shared part pixels. Arrow keys move the cursor; Space paints; B paints, E erases, F fills."></canvas></div>
      <p class="shared-part-hint">${part.width} × ${part.height} pixels · drag to paint · right-click to erase · arrow keys + Space also work</p>
      <div id="shared-part-palette" class="shared-part-palette" role="group" aria-label="Part paint colors">${project.palette.map((hex,i)=>`<button class="swatch" data-part-color="${i}" style="--swatch:${hex}" aria-label="Paint color ${i}: ${hex}" aria-pressed="${i===color}" title="${hex}"></button>`).join('')}<button class="swatch transparent" data-part-color="-1" aria-label="Transparent paint" aria-pressed="false">Erase</button></div>
    </div><aside class="shared-part-context"><h3>In the artwork</h3><canvas id="shared-part-preview" width="${project.width}" height="${project.height}" aria-label="Full sprite preview with shared part changes"></canvas>
      <label class="field"><span class="field-label">Preview frame · all animations</span><select id="shared-preview-frame">${project.animations.map(a=>`<optgroup label="${escape(a.name)}">${a.frames.map((f,i)=>`<option value="${escape(f.id)}" ${f.id===previewFrameId?'selected':''}>Frame ${i+1}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <p>Changes update all <strong>${refs.length} instance${refs.length===1?'':'s'}</strong> across the project.</p><p>Use the full sprite preview to check overlaps. An outline around the combined silhouette avoids seams between parts. Local pixel overrides may cover shared changes.</p>
      ${locked.length?`<p class="parts-error" role="alert">${locked.length} instance${locked.length===1?' is':'s are'} locked. Unlock the object or its group before applying shared edits.</p>`:''}</aside></div>
    <p id="shared-part-error" class="parts-error" role="alert" hidden></p><div class="shared-part-footer"><span id="shared-part-dirty">Shared artwork · no changes</span><button id="shared-part-cancel" class="button">Cancel</button><button id="shared-part-apply" class="button primary" ${locked.length?'disabled':''}>Apply to all ${refs.length} instance${refs.length===1?'':'s'}</button></div>`);
  $('modal').classList.add('shared-part-modal');
  const canvas=$('shared-part-canvas'), context=canvas.getContext('2d');
  function sprite(canvas,values,palette,width) {
    const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
    values.forEach((v,i)=>{if(v>=0){ctx.fillStyle=palette[v];ctx.fillRect(i%width,Math.floor(i/width),1,1);}});
  }
  function render() {
    sprite(canvas,pixels,project.palette,part.width);
    if(document.activeElement===canvas) {
      context.strokeStyle=project.palette[color] || '#285b47'; context.lineWidth=.12;
      context.strokeRect(cursor.x+.06,cursor.y+.06,.88,.88);
    }
    const draft=cloneArtwork(project), definition=draft.parts.find(p=>p.id===partId);
    definition.ops=pixelSpans(pixels,part.width);
    draft.animations=draft.animations.filter(a=>a.frames.some(f=>f.id===previewFrameId));
    draft.animations[0].frames=draft.animations[0].frames.filter(f=>f.id===previewFrameId);
    const rendered=validateProject(draft), frame=rendered.animations[0].frames[0];
    sprite($('shared-part-preview'),compositeFrame(rendered,frame),project.palette,project.width);
    $('part-undo').disabled=!undo.length; $('part-redo').disabled=!redo.length;
    const dirty=pixels.some((v,i)=>v!==image.pixels[i]);
    $('shared-part-dirty').textContent=dirty?'Unsaved shared changes':'Shared artwork · no changes';
    $('shared-part-apply').disabled=locked.length>0 || !dirty || Boolean(stroke);
  }
  const point=event=>{const rect=canvas.getBoundingClientRect();return {x:Math.floor((event.clientX-rect.left)*part.width/rect.width),y:Math.floor((event.clientY-rect.top)*part.height/rect.height)};};
  function draw(point,erase=false) {
    if(point.x<0 || point.y<0 || point.x>=part.width || point.y>=part.height)return;
    cursor=point;
    const value=erase || tool==='eraser'?-1:color;
    if(tool==='fill' && !erase) floodFill(pixels,point.x,point.y,value,part.width,part.height);
    else for(const p of linePoints(stroke?.last.x??point.x,stroke?.last.y??point.y,point.x,point.y)) if(p.x>=0&&p.y>=0&&p.x<part.width&&p.y<part.height)pixels[p.y*part.width+p.x]=value;
    if(stroke)stroke.last=point;
    render();
  }
  function end(cancel=false) {
    if(!stroke)return;
    if(cancel)pixels=stroke.before;
    else if(pixels.some((v,i)=>v!==stroke.before[i])) {undo.push(stroke.before);if(undo.length>40)undo.shift();redo=[];}
    const id=stroke.pointerId;stroke=null;
    if(canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);
    render();
  }
  canvas.onpointerdown=event=>{
    if(locked.length || stroke || ![0,2].includes(event.button))return;
    event.preventDefault();canvas.focus();canvas.setPointerCapture(event.pointerId);
    const origin=point(event);stroke={pointerId:event.pointerId,before:[...pixels],last:origin,erase:event.button===2};draw(origin,stroke.erase);
  };
  canvas.onpointermove=event=>{if(stroke && event.pointerId===stroke.pointerId && tool!=='fill')draw(point(event),stroke.erase);};
  canvas.onpointerup=event=>{if(stroke?.pointerId===event.pointerId)end();};
  canvas.onpointercancel=()=>end(true); canvas.onlostpointercapture=()=>end(true);
  canvas.oncontextmenu=event=>event.preventDefault(); canvas.onfocus=render; canvas.onblur=render;
  const history=(from,to)=>{end();if(!from.length)return;to.push([...pixels]);pixels=from.pop();render();};
  $('part-undo').onclick=()=>history(undo,redo);$('part-redo').onclick=()=>history(redo,undo);
  const selectTool=value=>{tool=value;document.querySelectorAll('[data-part-tool]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.partTool===tool));};
  document.querySelectorAll('[data-part-tool]').forEach(b=>b.onclick=()=>selectTool(b.dataset.partTool));
  document.querySelectorAll('[data-part-color]').forEach(b=>b.onclick=()=>{color=Number(b.dataset.partColor);document.querySelectorAll('[data-part-color]').forEach(c=>c.setAttribute('aria-pressed',c===b));});
  canvas.onkeydown=event=>{
    const key=event.key.toLowerCase();
    if((event.ctrlKey||event.metaKey) && key==='z'){event.preventDefault();history(event.shiftKey?redo:undo,event.shiftKey?undo:redo);return;}
    const move={arrowleft:[-1,0],arrowright:[1,0],arrowup:[0,-1],arrowdown:[0,1]}[key];
    if(move){event.preventDefault();cursor={x:Math.max(0,Math.min(part.width-1,cursor.x+move[0])),y:Math.max(0,Math.min(part.height-1,cursor.y+move[1]))};render();}
    if(['b','e','f'].includes(key)){event.preventDefault();selectTool({b:'pencil',e:'eraser',f:'fill'}[key]);}
    if(key===' ' && !locked.length){event.preventDefault();const before=[...pixels];draw(cursor);if(pixels.some((v,i)=>v!==before[i])){undo.push(before);if(undo.length>40)undo.shift();redo=[];}render();}
  };
  $('shared-preview-frame').onchange=event=>{previewFrameId=event.target.value;render();};
  $('shared-part-cancel').onclick=()=>$('modal').close();
  $('shared-part-apply').onclick=()=>{
    end();
    try{onApply(paintSharedPart(project,partId,pixels));$('modal').close();}
    catch(error){$('shared-part-error').textContent=error.message;$('shared-part-error').hidden=false;}
  };
  const fit=()=>{
    const available=canvas.parentElement.clientWidth-32;
    const maxHeight=window.innerHeight*(window.matchMedia('(max-width: 760px)').matches?.4:.52);
    const scale=Math.max(1,Math.floor(Math.min(448/part.width,available/part.width,maxHeight/part.height)));
    canvas.style.width=`${part.width*scale}px`;canvas.style.height=`${part.height*scale}px`;
  };
  const observer=new ResizeObserver(fit);observer.observe(canvas.parentElement);
  const modal=$('modal');
  const cleanup=()=>{observer.disconnect();modal.removeEventListener('close',cleanup);modal.removeEventListener('pixel-studio:dialog-replace',cleanup);};
  modal.addEventListener('close',cleanup);modal.addEventListener('pixel-studio:dialog-replace',cleanup);
  render();requestAnimationFrame(()=>{fit();canvas.focus();});
}
