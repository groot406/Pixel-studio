import { frameObjects } from '../domain/objects.js';
import { renderOperations, renderParts } from '../domain/artwork.js';

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

let drag=null, menu=null;
function closeMenu() { menu?.remove();menu=null; }
/** Which edge of a row the pointer is over: thirds on group headers (with "into"), halves elsewhere. */
function dropPosition(element,item,event) {
  const box=element.getBoundingClientRect(), y=(event.clientY-box.top)/box.height;
  if(item.group && drag && !drag.group && drag.layerId!==item.layerId)return y<.28?'above':y>.72?'below':'into';
  return y<.5?'above':'below';
}
function uses(project) {
  const seen=new Map();
  for(const a of project.animations)for(const f of a.frames)for(const c of f.cels)for(const op of c.source?.ops || [])
    if(op.type==='use'){const ids=seen.get(op.partId) || new Set();ids.add(`${c.layerId}/${op.id}`);seen.set(op.partId,ids);}
  return partId=>seen.get(partId)?.size || 0;
}

export function renderObjectsPanel({project,animation,frame,selected,scope,collapsed,canPaste,onSelect,onAction,onScope,onDrop,paint}) {
  closeMenu();
  const useCount=uses(project);
  const list=document.getElementById('object-list'), stacks=frameObjects(project,animation,frame), rows=[];
  const images=renderParts(project.parts || []);
  const row=(stack,node,group=false)=>{
    const {layer}=stack, instance=node?.instance, key=group?'@group':node.key;
    const active=selected?.layerId===layer.id && selected.key===key;
    const visible=group?layer.visible:instance?layer.visible && instance.visible!==false:layer.visible;
    const locked=group?layer.locked:Boolean(layer.locked || instance?.locked);
    const name=group?layer.name:node.type==='pixels' && stack.children.length===1?layer.name:node.name;
    const count=instance?useCount(instance.partId):0;
    const kind=group?`Group · ${stack.children.length} item${stack.children.length===1?'':'s'}`:instance?(count>1?`Shared part · ${count} uses`:'Part'):node.type==='overrides'?'Local edits':'Pixels';
    const outer=group || (!stack.grouped && stack.children.length===1);
    const index=rows.length; rows.push({layerId:layer.id,key,node,group,outer,locked});
    return `<div class="object-row${group?' object-group':''}${active?' selected':''}${!visible?' is-hidden':''}${!group && stack.grouped?' object-child':''}" data-object-row="${index}" draggable="${!locked}" title="Drag to reorder or move into a group · right-click for more">
      ${group?`<button class="object-collapse icon-button" aria-label="${collapsed.has(layer.id)?'Expand':'Collapse'} ${escape(name)} group" aria-expanded="${!collapsed.has(layer.id)}">${icon('chevron')}</button>`:'<span class="object-indent"></span>'}
      <button class="object-select" aria-pressed="${active}" aria-label="Select ${escape(name)} ${group?'group':'object'}"><canvas width="24" height="24" class="layer-thumb"></canvas><span class="object-copy"><span class="object-name">${escape(name)}</span><small>${kind}${locked?' · Locked':''}${!layer.visible && !group?' · Group hidden':''}</small></span></button>
      <button class="icon-button object-visibility" aria-label="${visible?'Hide':'Show'} ${escape(name)} ${group?'group':'object'}" aria-pressed="${visible}" ${!group && !instance && stack.grouped?'disabled':''}>${icon(visible?'eye':'eye-off')}</button>
      <button class="icon-button object-lock" aria-label="${locked?'Unlock':'Lock'} ${escape(name)} ${group?'group':'object'}" aria-pressed="${locked}" ${!group && stack.grouped && (layer.locked || !instance)?'disabled':''}>${icon(locked?'lock':'unlock')}</button></div>`;
  };
  const scroll=list.scrollTop;
  list.innerHTML=[...stacks].reverse().map(stack=>{
    const head=stack.grouped?row(stack,null,true):'';
    return head+(stack.grouped && collapsed.has(stack.layer.id)?'':[...stack.children].reverse().map(node=>row(stack,node)).join(''));
  }).join('');
  list.scrollTop=scroll;
  list.querySelectorAll('[data-object-row]').forEach(element=>{
    const item=rows[Number(element.dataset.objectRow)], layer=project.layers.find(l=>l.id===item.layerId), cel=frame.cels.find(c=>c.layerId===item.layerId);
    let pixels=cel.pixels;
    if(!item.group && cel.source) pixels=renderOperations(item.node.type==='overrides'?cel.source.overrides:cel.source.ops.slice(item.node.start,item.node.end),project.width,project.height,images);
    paint(element.querySelector('canvas'),pixels,project.palette,true);
    element.querySelector('.object-select').onclick=()=>onSelect(item);
    element.querySelector('.object-select').ondblclick=()=>{if(item.node?.instance)onAction('edit',item);};
    element.querySelector('.object-visibility').onclick=()=>onAction('visibility',item);
    element.querySelector('.object-lock').onclick=()=>onAction('lock',item);
    element.querySelector('.object-collapse')?.addEventListener('click',()=>onAction('collapse',item));
    element.addEventListener('contextmenu',event=>{event.preventDefault();if(!(selected?.layerId===item.layerId && selected.key===item.key))onSelect(item);openMenu(item,event);});
    element.addEventListener('dragstart',event=>{
      drag=item;element.classList.add('dragging');list.classList.add('is-dragging');
      event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',item.key);
    });
    element.addEventListener('dragend',()=>{drag=null;list.classList.remove('is-dragging');list.querySelectorAll('.dragging,.drop-above,.drop-below,.drop-into').forEach(e=>e.classList.remove('dragging','drop-above','drop-below','drop-into'));});
    element.addEventListener('dragover',event=>{
      if(!drag || drag===item)return;
      event.preventDefault();event.dataTransfer.dropEffect='move';
      const position=dropPosition(element,item,event);
      element.classList.toggle('drop-above',position==='above');element.classList.toggle('drop-below',position==='below');element.classList.toggle('drop-into',position==='into');
    });
    element.addEventListener('dragleave',()=>element.classList.remove('drop-above','drop-below','drop-into'));
    element.addEventListener('drop',event=>{
      if(!drag || drag===item)return;
      event.preventDefault();
      const source=drag, position=dropPosition(element,item,event);
      drag=null;onDrop(source,item,position);
    });
  });
  const openMenu=(item,event)=>{
    closeMenu();
    const instance=item.node?.instance, editable=!item.locked;
    const entries=[
      instance && ['edit','Edit on canvas','pencil',editable],
      ['copy','Copy','copy',true],
      ['cut','Cut','cut',editable],
      ['paste','Paste','paste',canPaste],
      ['paste-independent','Paste as independent copy','paste',canPaste],
      ['duplicate','Duplicate','copy',true],
      ['copy-to','Copy to animation…','layers',true],
      null,
      (item.group || instance || item.outer) && ['rename','Rename…','pencil',editable],
      instance && ['move-group','Move to group…','layers',editable],
      instance && ['independent','Make independent','spark',editable],
      instance && ['isolated','Open isolated editor','fit',true],
      null,
      ['visibility',item.node?.instance?.visible===false || !project.layers.find(l=>l.id===item.layerId).visible?'Show':'Hide','eye',true],
      ['lock',item.locked?'Unlock':'Lock',item.locked?'unlock':'lock',true],
      ['delete','Delete','trash',editable],
    ].filter((entry,i,all)=>entry || (all[i-1] && i<all.length-1));
    menu=document.createElement('div');menu.className='object-menu';menu.setAttribute('role','menu');
    menu.innerHTML=entries.map(entry=>entry?`<button role="menuitem" data-menu="${entry[0]}" ${entry[3]?'':'disabled'}>${icon(entry[2])}<span>${entry[1]}</span></button>`:'<hr>').join('');
    document.body.append(menu);
    const box=menu.getBoundingClientRect();
    menu.style.left=`${Math.min(event.clientX,innerWidth-box.width-8)}px`;menu.style.top=`${Math.min(event.clientY,innerHeight-box.height-8)}px`;
    menu.querySelectorAll('[data-menu]').forEach(button=>button.onclick=()=>{closeMenu();onAction(button.dataset.menu,item);});
    menu.addEventListener('keydown',e=>{
      const items=[...menu.querySelectorAll('button:not([disabled])')], i=items.indexOf(document.activeElement);
      if(e.key==='Escape'){e.preventDefault();closeMenu();list.querySelector('.object-row.selected .object-select')?.focus();}
      else if(e.key==='ArrowDown' || e.key==='ArrowUp'){e.preventDefault();items[(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}
    });
    menu.querySelector('button:not([disabled])')?.focus();
    setTimeout(()=>{const away=e=>{if(!menu?.contains(e.target)){closeMenu();document.removeEventListener('pointerdown',away,true);}};document.addEventListener('pointerdown',away,true);});
  };
  const item=rows.find(r=>r.layerId===selected?.layerId && r.key===selected.key);
  const stack=stacks.find(s=>s.layer.id===item?.layerId), siblings=stack?.children || [];
  const index=siblings.findIndex(n=>n.key===item?.key), layer=stack?.layer;
  const locked=Boolean(layer?.locked || item?.node?.instance?.locked);
  document.getElementById('object-count').textContent=stacks.reduce((n,s)=>n+s.children.length,0);
  document.getElementById('object-scope').value=scope;
  document.getElementById('object-scope').onchange=event=>onScope(event.target.value);
  const editable=Boolean(item && !locked);
  document.getElementById('edit-shared-object').disabled=!item?.node?.instance;
  document.getElementById('object-isolated-edit').disabled=!item?.node?.instance;
  document.getElementById('object-independent').disabled=!item?.node?.instance || locked;
  document.getElementById('object-delete').disabled=!editable;
  document.getElementById('object-rename').disabled=!editable || (!item?.group && !item?.node?.instance && (stack?.grouped || siblings.length>1));
  document.getElementById('object-ungroup').disabled=!stack?.grouped || locked;
  document.getElementById('object-move-group').disabled=!item?.node?.instance || locked;
  const outerIndex=stacks.findIndex(s=>s.layer.id===layer?.id);
  const outer=item?.group || (siblings.length===1 && !stack?.grouped);
  document.getElementById('object-up').disabled=!editable || (outer?outerIndex>=stacks.length-1:index>=siblings.length-1 || item?.node?.type==='overrides' || siblings[index+1]?.type==='overrides');
  document.getElementById('object-down').disabled=!editable || (outer?outerIndex<=0:index<=0 || item?.node?.type==='overrides' || siblings[index-1]?.type==='overrides');
  document.getElementById('object-detail').textContent=item?.node?.instance
    ? `${item.node.instance.partId} · ${item.node.instance.x}, ${item.node.instance.y} · double-click to edit, drag to reorder`
    : item?.group?'Group visibility and locks apply across the project. Group order follows the selected editing scope.':'Drag rows to reorder or into a group. Right-click for copy, paste and more.';
  document.getElementById('object-copy').disabled=!item;
  document.getElementById('object-paste').disabled=!canPaste;
  document.getElementById('object-duplicate').disabled=!item;
  for(const [id,action] of [['object-copy','copy'],['object-paste','paste'],['object-duplicate','duplicate'],['object-up','up'],['object-down','down'],['edit-shared-object','edit'],['object-isolated-edit','isolated'],['object-independent','independent'],['object-delete','delete'],['object-rename','rename'],['object-ungroup','ungroup'],['object-move-group','move-group']]) {
    document.getElementById(id).onclick=event=>{if(item)onAction(action==='paste' && event.shiftKey?'paste-independent':action,item);};
  }
}
