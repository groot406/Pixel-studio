/**
 * Phone layout (≤760px): the canvas fills the screen, a bottom dock opens the existing sidebar panels as
 * bottom sheets, and touch gestures handle zoom, pan and undo. Desktop layout is untouched.
 */
export const MOBILE_QUERY='(max-width: 760px)';

/** Which panel sections each dock button shows in its sheet. */
export const SHEETS=[
  {key:'tools',label:'Tools',panels:['tools','transforms']},
  {key:'palette',label:'Colour',panels:['palette']},
  {key:'layers',label:'Objects',icon:'layers',panels:['layers','parts']},
  {key:'animate',label:'Animate',icon:'animate',panels:['animate','effects']},
  {key:'preview',label:'Preview',icon:'play',panels:['preview','animations']},
];

/** Two-finger gesture state → zoom factor and pan delta (pure, for tests). */
export function pinchStep(start,now) {
  const dist=p=>Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y), mid=p=>({x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2});
  const a=mid(start), b=mid(now);
  return {factor:dist(now)/Math.max(1,dist(start)),dx:b.x-a.x,dy:b.y-a.y};
}

/** A quick two/three-finger tap (short, barely moved) means undo/redo. */
export function isTap({fingers,duration,moved}) {
  return fingers>=2 && duration<300 && moved<12;
}

export function initMobileLayout({icon,getScale,setZoom,cancelStroke,isDrawing}) {
  const media=matchMedia(MOBILE_QUERY), $=id=>document.getElementById(id);
  const dock=document.createElement('nav');
  dock.id='mobile-dock';dock.className='mobile-dock';dock.setAttribute('aria-label','Panels');
  dock.innerHTML=SHEETS.map(s=>`<button type="button" data-sheet="${s.key}" aria-expanded="false" aria-label="${s.label}">${s.key==='tools'?'<span class="dock-tool"></span>':s.key==='palette'?'<span class="dock-swatch"></span>':icon(s.icon)}<span>${s.label}</span></button>`).join('');
  document.body.appendChild(dock);
  const head=document.createElement('div');
  head.className='mobile-sheet-head';
  head.innerHTML=`<span class="mobile-sheet-grip" aria-hidden="true"></span><strong></strong><button type="button" class="icon-button" aria-label="Close panel">${icon('close')}</button>`;
  head.querySelector('button').addEventListener('click',()=>open(null));
  let current=null;

  function open(key) {
    current=current===key?null:key;
    const sheet=SHEETS.find(s=>s.key===current);
    document.body.classList.toggle('mobile-sheet-open',!!sheet);
    for(const button of dock.querySelectorAll('[data-sheet]')) {
      const on=button.dataset.sheet===current;
      button.classList.toggle('active',on);button.setAttribute('aria-expanded',String(on));
    }
    for(const aside of [$('tools-panel'),$('details-panel')])aside.classList.remove('mobile-sheet');
    for(const section of document.querySelectorAll('[data-panel]'))section.classList.toggle('mobile-show',!!sheet && sheet.panels.includes(section.dataset.panel));
    if(!sheet){head.remove();return;}
    // Panels can live in either sidebar (workspace views move them), so show whichever holds the first one.
    const sections=sheet.panels.map(id=>document.querySelector(`[data-panel="${id}"]`)).filter(Boolean);
    const host=sections[0]?.closest('aside') || $('tools-panel');
    for(const section of sections)if(section.closest('aside')===host && section.tagName==='DETAILS')section.open=true;
    host.classList.add('mobile-sheet');
    head.querySelector('strong').textContent=sheet.label;
    host.prepend(head);host.scrollTop=0;
  }
  dock.addEventListener('click',event=>{const b=event.target.closest('[data-sheet]');if(b)open(b.dataset.sheet);});
  // Picking a tool is usually followed by drawing, so the sheet gets out of the way.
  $('tools-panel').addEventListener('click',event=>{if(media.matches && current==='tools' && event.target.closest('.tool[data-tool]'))setTimeout(()=>open(null),120);});
  document.addEventListener('keydown',event=>{if(event.key==='Escape' && current && !document.querySelector('dialog[open]'))open(null);});
  media.addEventListener('change',()=>{if(!media.matches)open(null);});

  function sync() {
    const tool=document.querySelector('#tools-panel .tool.active');
    const slot=dock.querySelector('.dock-tool');
    if(tool && slot) {
      const svg=tool.querySelector('svg')?.outerHTML || '';
      if(slot.dataset.tool!==tool.dataset.tool){slot.innerHTML=svg;slot.dataset.tool=tool.dataset.tool;}
    }
    const swatch=document.querySelector('#palette-grid .swatch.selected');
    const chip=dock.querySelector('.dock-swatch');
    if(chip){chip.style.setProperty('--swatch',swatch?.style.getPropertyValue('--swatch') || 'transparent');chip.classList.toggle('transparent',!swatch || swatch.classList.contains('transparent'));}
  }

  // --- Touch gestures on the canvas ---------------------------------------------------------------------------
  const stage=$('canvas-stage'), touches=new Map();
  let gesture=null;
  const points=()=>[...touches.values()].slice(0,2);
  const swallow=event=>{event.stopPropagation();event.preventDefault();};
  stage.addEventListener('pointerdown',event=>{
    if(current && media.matches)open(null);
    if(event.pointerType!=='touch')return;
    touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(touches.size===2 && !gesture) {
      // The first finger may already have started a stroke: undo it, this is a gesture.
      if(isDrawing())cancelStroke();
      gesture={start:points().map(p=>({...p})),scale:getScale(),scroll:{x:stage.scrollLeft,y:stage.scrollTop},at:performance.now(),moved:0,fingers:2};
    }
    if(gesture){gesture.fingers=Math.max(gesture.fingers,touches.size);swallow(event);}
  },true);
  stage.addEventListener('pointermove',event=>{
    if(!touches.has(event.pointerId))return;
    touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(!gesture || touches.size<2)return gesture&&swallow(event);
    swallow(event);
    const step=pinchStep(gesture.start,points());
    gesture.moved=Math.max(gesture.moved,Math.hypot(step.dx,step.dy),Math.abs(step.factor-1)*100);
    const scale=Math.round(gesture.scale*step.factor);
    if(scale!==getScale())setZoom(scale);
    stage.scrollLeft=gesture.scroll.x*(getScale()/gesture.scale)-step.dx;
    stage.scrollTop=gesture.scroll.y*(getScale()/gesture.scale)-step.dy;
  },true);
  const lift=event=>{
    if(!touches.has(event.pointerId))return;
    touches.delete(event.pointerId);
    if(!gesture)return;
    swallow(event);
    if(touches.size)return;
    if(isTap({fingers:gesture.fingers,duration:performance.now()-gesture.at,moved:gesture.moved})) {
      const button=$(gesture.fingers>=3?'redo':'undo');
      if(button && !button.disabled)button.click();
    }
    gesture=null;
  };
  stage.addEventListener('pointerup',lift,true);
  stage.addEventListener('pointercancel',lift,true);

  sync();
  return {sync,open,isOpen:()=>current};
}
