/** Resizable sidebars/timeline and floating (popped-out) panel sections. Layout is remembered per browser. */
export const LAYOUT_KEY='pixel-studio.layout.v1';
export const SIZE_LIMITS={tools:[180,440],details:[200,480],timeline:[120,520]};
const FLOAT_MIN={width:200,height:120};

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

/** Accept only sane stored values; anything else falls back to the stylesheet defaults. */
export function sanitizeLayout(raw) {
  const layout={sizes:{},floating:{},timelineCollapsed:raw?.timelineCollapsed===true};
  for(const [name,[min,max]] of Object.entries(SIZE_LIMITS)) {
    const value=raw?.sizes?.[name];
    if(Number.isFinite(value))layout.sizes[name]=clamp(Math.round(value),min,max);
  }
  for(const [name,rect] of Object.entries(raw?.floating || {})) {
    if(!/^[a-z-]{1,30}$/.test(name) || !rect || !['x','y','width','height'].every(k=>Number.isFinite(rect[k])))continue;
    layout.floating[name]={x:Math.round(rect.x),y:Math.round(rect.y),width:Math.max(FLOAT_MIN.width,Math.round(rect.width)),height:Math.max(FLOAT_MIN.height,Math.round(rect.height))};
  }
  return layout;
}

/** Keep a floating panel reachable: its title bar always stays inside the viewport. */
export function fitFloatRect(rect,viewport) {
  const width=clamp(rect.width,FLOAT_MIN.width,Math.max(FLOAT_MIN.width,viewport.width-16));
  const height=clamp(rect.height,FLOAT_MIN.height,Math.max(FLOAT_MIN.height,viewport.height-16));
  return {width,height,x:clamp(rect.x,8-width+80,viewport.width-80),y:clamp(rect.y,8,viewport.height-40)};
}

export function initPanelLayout({onLayout=()=>{},narrow=()=>matchMedia('(max-width: 760px)').matches}={}) {
  const workbench=document.getElementById('workbench'), column=workbench.querySelector('.editor-column');
  let layout;
  try{layout=sanitizeLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'));}catch{layout=sanitizeLayout(null);}
  const save=()=>{try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(layout));}catch{}};

  // --- Splitters -------------------------------------------------------------------------------------------------
  const applySizes=()=>{
    for(const name of Object.keys(SIZE_LIMITS)) {
      const value=layout.sizes[name];
      if(value===undefined)workbench.style.removeProperty(`--${name}-size`);
      else workbench.style.setProperty(`--${name}-size`,`${value}px`);
    }
  };
  const current=name=>name==='timeline'?column.querySelector('.timeline').getBoundingClientRect().height
    :document.getElementById(name==='tools'?'tools-panel':'details-panel').getBoundingClientRect().width;
  const setSize=(name,value)=>{
    const [min,max]=SIZE_LIMITS[name];
    let limit=max;
    if(name==='timeline')limit=Math.min(max,column.getBoundingClientRect().height-220);
    else limit=Math.min(max,workbench.getBoundingClientRect().width-current(name==='tools'?'details':'tools')-360);
    layout.sizes[name]=clamp(Math.round(value),min,Math.max(min,limit));
    applySizes();onLayout();
  };
  const splitters=[
    ['tools','vertical','Resize toolbox',workbench],
    ['details','vertical','Resize side panel',workbench],
    ['timeline','horizontal','Resize timeline',column],
  ].map(([name,orientation,label,parent])=>{
    const handle=document.createElement('div');
    Object.assign(handle,{className:`panel-splitter splitter-${name}`,tabIndex:0,title:`${label} · double-click to reset`});
    handle.setAttribute('role','separator');handle.setAttribute('aria-orientation',orientation);handle.setAttribute('aria-label',label);
    handle.dataset.splitter=name;
    parent.appendChild(handle);
    // Dragging right grows the toolbox; left grows the side panel; up grows the timeline.
    const sign=name==='tools'?1:-1, axis=name==='timeline'?'clientY':'clientX';
    handle.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;
      event.preventDefault();handle.setPointerCapture(event.pointerId);
      const start=event[axis], base=current(name);
      document.body.classList.add('is-resizing-panels');handle.classList.add('active');
      const move=e=>setSize(name,base+sign*(e[axis]-start));
      const end=()=>{handle.removeEventListener('pointermove',move);handle.classList.remove('active');document.body.classList.remove('is-resizing-panels');save();};
      handle.addEventListener('pointermove',move);
      handle.addEventListener('pointerup',end,{once:true});handle.addEventListener('pointercancel',end,{once:true});
    });
    handle.addEventListener('dblclick',()=>{delete layout.sizes[name];applySizes();save();onLayout();});
    handle.addEventListener('keydown',event=>{
      const keys=name==='timeline'?{ArrowUp:1,ArrowDown:-1}:{ArrowRight:sign,ArrowLeft:-sign};
      if(!(event.key in keys))return;
      event.preventDefault();setSize(name,current(name)+keys[event.key]*(event.shiftKey?48:16));save();
    });
    return handle;
  });

  // --- Floating panels -------------------------------------------------------------------------------------------
  const sections=[...document.querySelectorAll('details[data-panel]')];
  const homes=new Map(), floats=new Map();
  let top=40;
  const titleOf=section=>section.querySelector(':scope > summary h2')?.firstChild?.textContent.trim() || section.dataset.panel;
  const rememberRect=(name,box)=>{const r=box.getBoundingClientRect();layout.floating[name]={x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)};save();};
  const placeBox=(box,rect)=>{
    const fitted=fitFloatRect(rect,{width:innerWidth,height:innerHeight});
    Object.assign(box.style,{left:`${fitted.x}px`,top:`${fitted.y}px`,width:`${fitted.width}px`,height:`${fitted.height}px`});
  };
  const raise=box=>{box.style.zIndex=String(++top);};

  function popOut(section,rect=null) {
    const name=section.dataset.panel;
    if(floats.has(name))return;
    const home=document.createElement('span');
    home.className='panel-home';home.hidden=true;home.dataset.home=name;
    section.before(home);homes.set(name,{placeholder:home,wasOpen:section.open,side:section.closest('#details-panel')?'details-panel':'tools-panel'});
    const box=document.createElement('div');
    box.className='floating-panel';box.dataset.float=name;box.dataset.home=homes.get(name).side;
    box.setAttribute('role','dialog');box.setAttribute('aria-label',`${titleOf(section)} (floating)`);
    box.innerHTML=`<div class="float-bar" title="Drag to move"><span class="float-title"></span><button class="icon-button float-dock" type="button" title="Dock back into the sidebar" aria-label="Dock ${titleOf(section)} back into the sidebar">⇲</button></div><div class="float-body"></div>`;
    box.querySelector('.float-title').textContent=titleOf(section);
    box.querySelector('.float-body').appendChild(section);
    section.open=true;section.classList.add('is-floating');
    document.body.appendChild(box);
    const r=section.getBoundingClientRect();
    placeBox(box,rect || {x:innerWidth-r.width-360,y:140+floats.size*28,width:Math.max(260,r.width+24),height:Math.min(innerHeight-180,Math.max(220,r.height+56))});
    raise(box);floats.set(name,box);
    box.addEventListener('pointerdown',()=>raise(box));
    box.querySelector('.float-dock').onclick=()=>dock(name);
    const bar=box.querySelector('.float-bar');
    bar.addEventListener('pointerdown',event=>{
      if(event.button!==0 || event.target.closest('button'))return;
      event.preventDefault();bar.setPointerCapture(event.pointerId);
      const sx=event.clientX, sy=event.clientY, b=box.getBoundingClientRect();
      const move=e=>placeBox(box,{x:b.left+e.clientX-sx,y:b.top+e.clientY-sy,width:b.width,height:b.height});
      const end=()=>{bar.removeEventListener('pointermove',move);rememberRect(name,box);};
      bar.addEventListener('pointermove',move);bar.addEventListener('pointerup',end,{once:true});bar.addEventListener('pointercancel',end,{once:true});
    });
    // CSS `resize: both` changes the size; remember it once the user lets go.
    new ResizeObserver(()=>{if(floats.get(name)===box && box.isConnected)rememberRect(name,box);}).observe(box);
    rememberRect(name,box);renderButtons();onLayout();
  }
  function dock(name) {
    const box=floats.get(name), home=homes.get(name);
    if(!box || !home)return;
    const section=box.querySelector('details[data-panel]');
    home.placeholder.replaceWith(section);
    section.classList.remove('is-floating');section.open=home.wasOpen;
    box.remove();floats.delete(name);homes.delete(name);
    delete layout.floating[name];save();renderButtons();onLayout();
  }
  function renderButtons() {
    for(const section of sections) {
      const button=section.querySelector(':scope > summary .panel-popout');
      if(button)button.hidden=floats.has(section.dataset.panel);
    }
  }
  for(const section of sections) {
    const summary=section.querySelector(':scope > summary');
    const button=document.createElement('button');
    Object.assign(button,{type:'button',className:'panel-popout',title:'Pop out as a floating panel',textContent:'⇱'});
    button.setAttribute('aria-label',`Pop out ${titleOf(section)}`);
    // Inside <summary>, a click would also toggle the section.
    button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();popOut(section);});
    const chevron=summary.querySelector('.panel-chevron');
    if(chevron)chevron.before(button);else summary.appendChild(button);
  }

  const restore=()=>{
    if(narrow()){for(const name of [...floats.keys()])dock(name);return;}
    for(const box of floats.values())placeBox(box,box.getBoundingClientRect());
  };
  addEventListener('resize',restore);
  applySizes();

  // --- Minimised frames panel (keeps only its heading, for small screens) -----------------------------------------
  const timelineToggle=document.getElementById('toggle-timeline');
  const setTimelineCollapsed=collapsed=>{
    layout.timelineCollapsed=!!collapsed;
    workbench.classList.toggle('timeline-collapsed',layout.timelineCollapsed);
    if(timelineToggle) {
      timelineToggle.setAttribute('aria-expanded',String(!layout.timelineCollapsed));
      timelineToggle.title=layout.timelineCollapsed?'Show frames':'Minimise frames panel';
      timelineToggle.setAttribute('aria-label',timelineToggle.title);
    }
    save();onLayout();
  };
  if(timelineToggle)timelineToggle.addEventListener('click',()=>setTimelineCollapsed(!layout.timelineCollapsed));
  setTimelineCollapsed(layout.timelineCollapsed);
  if(!narrow())for(const [name,rect] of Object.entries(layout.floating)) {
    const section=sections.find(s=>s.dataset.panel===name);
    if(section)popOut(section,rect);
  }
  return {setTimelineCollapsed,timelineCollapsed:()=>layout.timelineCollapsed,popOut:name=>{const s=sections.find(x=>x.dataset.panel===name);if(s)popOut(s);},dock,floating:()=>[...floats.keys()],splitters};
}
