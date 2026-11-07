import { TRANSFORMS } from '../domain/artwork.js';
import { nextPartId, referencesToPart, extractPart, placePart, changeInstance, forkInstance, flattenCel } from '../domain/parts.js';

const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $=id=>document.getElementById(id);

/** Controls operate on independent domain proposals and use the editor's single Undo boundary. */
export function openPartsDialog({getProject,target,selection,openDialog,onChange,onEditPart}) {
  let selectedPart='', selectedInstance='';
  function update(action) {
    try { onChange(action()); show(); }
    catch(error) { $('parts-error').textContent=error.message; $('parts-error').hidden=false; }
  }
  function show() {
    const project=getProject(), parts=project.parts||[], layer=project.layers.find(l=>l.id===target.layerId);
    const cel=project.animations.find(a=>a.id===target.animationId).frames.find(f=>f.id===target.frameId).cels.find(c=>c.layerId===target.layerId);
    const instances=(cel.source?.ops||[]).filter(op=>op.type==='use');
    if(!parts.some(p=>p.id===selectedPart)) selectedPart=parts[0]?.id||'';
    if(!instances.some(op=>op.id===selectedInstance)) selectedInstance=instances[0]?.id||'';
    const instance=instances.find(op=>op.id===selectedInstance);
    const disabled=layer.locked||!layer.visible;
    openDialog('Reusable parts',`<p class="modal-body-text">Parts are shared drawings. Place them in any frame; painting on the main canvas adds local overrides. Double-click a part on the canvas to open its shared artwork editor.</p>
      <p id="parts-error" role="alert" class="helper-text parts-error" hidden></p>
      <label class="field"><span class="field-label">New part name</span><input id="part-name" maxlength="100" value="${escape(nextPartId(project))}" pattern="[a-zA-Z0-9_-]+"></label>
      <button id="part-extract" class="button" ${disabled?'disabled':''}>Create from ${selection?'selection':'current pixels'}</button>
      <div class="form-grid parts-grid"><label class="field"><span class="field-label">Part library</span><select id="part-library">${parts.map(p=>`<option value="${escape(p.id)}" ${p.id===selectedPart?'selected':''}>${escape(p.id)} · ${p.width} × ${p.height}</option>`).join('')}</select></label>
      <label class="field"><span class="field-label">Instance in this frame</span><select id="part-instance"><option value="">Choose an instance</option>${instances.map(op=>`<option value="${escape(op.id)}" ${op.id===selectedInstance?'selected':''}>${escape(op.id)} → ${escape(op.partId)}</option>`).join('')}</select></label></div>
      <div class="form-grid parts-grid"><label class="field"><span class="field-label">X</span><input id="part-x" type="number" min="-128" max="128" value="${instance?.x||0}"></label><label class="field"><span class="field-label">Y</span><input id="part-y" type="number" min="-128" max="128" value="${instance?.y||0}"></label></div>
      <label class="field"><span class="field-label">Transform</span><select id="part-transform">${TRANSFORMS.map((v,i)=>`<option value="${v}" ${instance?.transform===v?'selected':''}>${['Original','Flip horizontally','Flip vertically','Rotate 90°','Rotate 180°','Rotate 270°'][i]}</option>`).join('')}</select></label>
      <div class="modal-actions parts-actions"><button id="part-place" class="button" ${disabled||!parts.length?'disabled':''}>Place in this frame</button><button id="part-move" class="button" ${disabled||!instance?'disabled':''}>Update instance</button><button id="part-fork" class="button" ${disabled||!instance?'disabled':''}>Make instance independent</button></div>
      <p id="part-usage" class="helper-text"></p>
      <button id="part-open-editor" class="button" ${!parts.length?'disabled':''}>Open shared artwork editor</button>
      <p class="helper-text">Flattening this cel makes its current pixels independent. Resizing the canvas also bakes retained cels. Undo restores their structure.</p><div class="modal-actions parts-actions"><button id="part-flatten" class="button" ${disabled||!cel.source?'disabled':''}>Flatten current pixels</button><button id="parts-close" class="button primary">Done</button></div>`,'PARTS');
    $('parts-close').onclick=()=>$('modal').close();
    $('part-extract').onclick=()=>update(()=>{
      selectedPart=$('part-name').value.trim();
      return extractPart(getProject(),target,selection||{x:0,y:0,width:project.width,height:project.height},selectedPart);
    });
    $('part-library').onchange=()=>{selectedPart=$('part-library').value;show();};
    $('part-instance').onchange=()=>{selectedInstance=$('part-instance').value;selectedPart=instances.find(op=>op.id===selectedInstance)?.partId||selectedPart;show();};
    $('part-place').onclick=()=>update(()=>placePart(getProject(),target,selectedPart,Number($('part-x').value),Number($('part-y').value)));
    $('part-move').onclick=()=>update(()=>changeInstance(getProject(),target,selectedInstance,{x:Number($('part-x').value),y:Number($('part-y').value),transform:$('part-transform').value}));
    $('part-fork').onclick=()=>update(()=>{
      const next=forkInstance(getProject(),target,selectedInstance);
      selectedPart=next.animations.find(a=>a.id===target.animationId).frames.find(f=>f.id===target.frameId).cels.find(c=>c.layerId===target.layerId).source.ops.find(op=>op.type==='use'&&op.id===selectedInstance).partId;
      return next;
    });
    $('part-flatten').onclick=()=>update(()=>flattenCel(getProject(),target));
    const refs=referencesToPart(project,selectedPart), locked=refs.some(ref=>ref.locked || project.layers.find(l=>l.id===ref.layerId).locked);
    $('part-usage').textContent=selectedPart?`${refs.length} instance${refs.length===1?'':'s'} use this part. ${locked?'Unlock its objects or groups before shared editing.':'Edit shared artwork to update every instance.'}`:'Create a part from pixels, then place it in another frame.';
    $('part-open-editor').onclick=()=>onEditPart(selectedPart);
  }
  show();
}
