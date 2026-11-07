import { frameObjects } from '../domain/objects.js';
import { renderOperations, renderParts } from '../domain/artwork.js';

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

export function renderObjectsPanel({project,animation,frame,selected,scope,collapsed,onSelect,onAction,onScope,paint}) {
  const list=document.getElementById('object-list'), stacks=frameObjects(project,animation,frame), rows=[];
  const images=renderParts(project.parts || []);
  const row=(stack,node,group=false)=>{
    const {layer}=stack, instance=node?.instance, key=group?'@group':node.key;
    const active=selected?.layerId===layer.id && selected.key===key;
    const visible=group?layer.visible:instance?layer.visible && instance.visible!==false:layer.visible;
    const locked=group?layer.locked:Boolean(layer.locked || instance?.locked);
    const name=group?layer.name:node.type==='pixels' && stack.children.length===1?layer.name:node.name;
    const kind=group?'Group':instance?'Shared part':node.type==='overrides'?'Local edits':'Pixels';
    const index=rows.length; rows.push({layerId:layer.id,key,node,group});
    return `<div class="object-row${active?' selected':''}${!visible?' is-hidden':''}${!group && stack.grouped?' object-child':''}" data-object-row="${index}">
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
  });
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
    ? `${item.node.instance.partId} · ${item.node.instance.x}, ${item.node.instance.y} · double-click to edit in place`
    : item?.group?'Group visibility and locks apply across the project. Group order follows the selected editing scope.':'Use Object (V) to select and move parts. Double-click a part to edit every instance.';
  for(const [id,action] of [['object-up','up'],['object-down','down'],['edit-shared-object','edit'],['object-isolated-edit','isolated'],['object-independent','independent'],['object-delete','delete'],['object-rename','rename'],['object-ungroup','ungroup'],['object-move-group','move-group']]) {
    document.getElementById(id).onclick=()=>{if(item)onAction(action,item);};
  }
}
