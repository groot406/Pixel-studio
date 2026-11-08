/**
 * Customizable workspace: the View menu (presets, panel placement, timeline, density), drag handles on panel headers
 * and view commands. Placement and order are owned here; sizes/floating panels by panel-layout.js and sidebar
 * visibility / open sections by the app session, so a view is applied through those and captured back from the page.
 */
import { BUILTIN_VIEWS, MAX_CUSTOM_VIEWS, PANEL_IDS, movePanel, normalizeView, normalizeViewStore, sameArrangement, sideOf } from '../domain/workspace-view.js';
import { registerCommandSource } from '../plugins/command-palette.js';

const STORE_KEY = 'pixel-studio.views.v1';
const SIDES = { left: 'tools-panel', right: 'details-panel' };
const NOMINAL = { width: 1280, height: 800, tools: 248, details: 260, timeline: 216 };
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const shortcut = n => (n <= 9 ? `${isMac ? '⌘⌥' : 'Ctrl+Alt+'}${n}` : '');

let d, store, menu = null, button = null, pending = false;
const $ = id => document.getElementById(id);
const section = id => document.querySelector(`details[data-panel="${id}"]`);
const titleOf = id => section(id)?.querySelector(':scope > summary h2')?.firstChild?.textContent.trim().replace(/\s+/g, ' ') || id;
const niceTitle = id => titleOf(id).toLowerCase().replace(/(^|[\s&/])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const layout = () => d.layout();
const views = () => [...BUILTIN_VIEWS, ...store.custom];
const esc = value => d.escapeHTML(String(value));

function load() {
  try { store = normalizeViewStore(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); } catch { store = normalizeViewStore(null); }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* private mode: the view lasts for this session */ }
}

// ---- reading and applying --------------------------------------------------------------------------------------
function dockedOrder(side) {
  return [...$(SIDES[side]).children].map(el => (el.matches('details[data-panel]') ? el.dataset.panel : el.matches('.panel-home') ? el.dataset.home : null))
    .filter(id => id && !section(id).hidden);
}

/** The workspace as it is on screen right now. */
export function captureView() {
  const L = layout(), rects = L?.floatRects() || {}, floating = {};
  for (const id of L?.floating() || []) floating[id] = rects[id] || null;
  const hidden = PANEL_IDS.filter(id => section(id)?.hidden);
  return normalizeView({
    left: dockedOrder('left'), right: dockedOrder('right'), hidden,
    closed: PANEL_IDS.filter(id => !section(id)?.open && !section(id)?.classList.contains('is-floating')),
    floating, sizes: L?.sizes() || {},
    sidebars: { left: !d.state.panels.tools, right: !d.state.panels.details },
    timeline: $('workbench').classList.contains('timeline-hidden') ? 'hidden' : L?.timelineCollapsed() ? 'min' : 'open',
    compact: $('workbench').classList.contains('compact-panels'),
  });
}

/** Order the panels in the DOM and set what is hidden; floating panels must be docked first. */
function arrange(view) {
  const left = $(SIDES.left), right = $(SIDES.right), anchor = left.querySelector(':scope > .account-section');
  // A floating panel keeps its place through the placeholder it returns to when docked.
  const node = id => document.querySelector(`.panel-home[data-home="${id}"]`) || section(id);
  for (const id of view.left) left.insertBefore(node(id), anchor);
  for (const id of view.right) right.appendChild(node(id));
  for (const id of view.hidden) section(id).hidden = true;
  for (const id of [...view.left, ...view.right]) section(id).hidden = false;
  const workbench = $('workbench');
  workbench.classList.toggle('timeline-hidden', view.timeline === 'hidden');
  workbench.classList.toggle('compact-panels', view.compact);
  refresh();
}

const resolveRect = rect => (rect ? {
  ...rect,
  x: rect.x < 0 ? innerWidth + rect.x : rect.x,
  y: rect.y < 0 ? innerHeight + rect.y : rect.y,
} : null);

/** Apply a whole view: placement, open sections, sidebars, sizes, timeline and floating panels. */
export function applyView(raw, { name } = {}) {
  const view = normalizeView(raw), L = layout();
  for (const id of L.floating()) L.dock(id);
  arrange(view);
  for (const id of PANEL_IDS) {
    const open = !view.closed.includes(id);
    if (section(id).open !== open) section(id).open = open;
  }
  d.setSidebars({ tools: !view.sidebars.left, details: !view.sidebars.right });
  L.setSizes(view.sizes);
  L.setTimelineCollapsed(view.timeline === 'min');
  for (const [id, rect] of Object.entries(view.floating)) L.popOut(id, resolveRect(rect));
  remember();
  if (name) d.toast(`View: ${name}`);
}

function remember() {
  store.placement = captureView();
  save();
  refresh();
  if (menu && !menu.hidden) renderMenu();
}

export function applyPreset(id) {
  const item = views().find(v => v.id === id);
  if (!item) return;
  store.active = item.id;
  applyView(item.view, { name: item.name });
}

/** Show the "drop panels here" hint in a sidebar without visible docked panels. */
function refresh() {
  for (const [side, id] of Object.entries(SIDES)) {
    const aside = $(id);
    let hint = aside.querySelector(':scope > .sidebar-empty');
    if (!hint) {
      hint = document.createElement('p');
      hint.className = 'sidebar-empty';
      hint.innerHTML = `No panels here. Drag a panel by its <span aria-hidden="true">⠿</span> handle, or choose them in <button type="button" class="text-button">View</button>.`;
      hint.querySelector('button').onclick = () => toggleMenu(true);
      aside.prepend(hint);
    }
    hint.hidden = !!aside.querySelector(':scope > details[data-panel]:not([hidden])');
  }
  if (button) {
    const active = views().find(v => v.id === store.active);
    const modified = active && !sameArrangement(active.view, store.placement || captureView());
    button.querySelector('span').textContent = active ? `${active.name}${modified ? '*' : ''}` : 'View';
    button.title = `Workspace view${active ? `: ${active.name}${modified ? ' (changed)' : ''}` : ''} · presets, panels and layout`;
  }
}

// ---- drag to rearrange -----------------------------------------------------------------------------------------
/**
 * Pointer drag of one item into one of several vertical lists. `targets()` returns [{ el, key, items: [{ el, id }] }];
 * `onDrop(key, beforeId)` receives the list and the item to insert before (null = at the end).
 */
function startDrag(event, { id, el, label, targets, onDrop }) {
  if (event.button !== 0) return;
  event.preventDefault();
  const sx = event.clientX, sy = event.clientY, handle = event.currentTarget;
  handle.setPointerCapture?.(event.pointerId);
  let ghost = null, line = null, drop = null;
  const begin = () => {
    ghost = Object.assign(document.createElement('div'), { className: 'view-drag-ghost', textContent: label });
    line = Object.assign(document.createElement('div'), { className: 'view-drop-line' });
    document.body.append(ghost, line);
    el.classList.add('view-dragging');
    document.body.classList.add('is-dragging-panel');
  };
  const move = e => {
    if (!ghost && Math.hypot(e.clientX - sx, e.clientY - sy) < 5) return;
    if (!ghost) begin();
    ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
    drop = null;
    for (const target of targets()) {
      const r = target.el.getBoundingClientRect();
      if (!r.width || e.clientX < r.left - 24 || e.clientX > r.right + 24 || e.clientY < r.top - 12 || e.clientY > r.bottom + 12) continue;
      const items = target.items.filter(item => item.id !== id);
      const before = items.find(item => { const b = item.el.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
      const ref = before?.el.getBoundingClientRect(), last = items.at(-1)?.el.getBoundingClientRect();
      const y = ref ? ref.top - 4 : last ? last.bottom + 3 : r.top + 10;
      Object.assign(line.style, { left: `${r.left + 8}px`, width: `${Math.max(40, r.width - 16)}px`, top: `${y}px` });
      drop = { key: target.key, before: before?.id ?? null };
      break;
    }
    line.hidden = !drop;
  };
  const end = e => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    if (!ghost) return;
    ghost.remove(); line.remove();
    el.classList.remove('view-dragging');
    document.body.classList.remove('is-dragging-panel');
    if (e.type === 'pointerup' && drop) onDrop(drop.key, drop.before);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/** Move a panel within the current view (keeps sizes, floating panels and open sections). */
function placePanel(id, side, beforeId) {
  const L = layout(), current = captureView(), wasHidden = current.hidden.includes(id);
  const list = current[side].filter(x => x !== id), index = beforeId ? list.indexOf(beforeId) : -1;
  if (side === 'hidden' && L.floating().includes(id)) L.dock(id);
  arrange(movePanel(current, id, side, index < 0 ? list.length : index));
  if (side !== 'hidden') {
    if (wasHidden) section(id).open = true;
    // Moving a panel into a hidden sidebar shows that sidebar.
    if (side === 'left' && d.state.panels.tools) d.setSidebars({ tools: false, details: d.state.panels.details });
    if (side === 'right' && d.state.panels.details) d.setSidebars({ tools: d.state.panels.tools, details: false });
  }
  remember();
}

const sidebarTargets = () => Object.entries(SIDES).filter(([side]) => !(side === 'left' ? d.state.panels.tools : d.state.panels.details)).map(([key, id]) => ({
  el: $(id), key,
  items: [...$(id).querySelectorAll(':scope > details[data-panel]:not([hidden])')].map(el => ({ el, id: el.dataset.panel })),
}));

function addGrips() {
  for (const id of PANEL_IDS) {
    const summary = section(id)?.querySelector(':scope > summary');
    if (!summary || summary.querySelector('.panel-grip')) continue;
    const grip = document.createElement('button');
    Object.assign(grip, { type: 'button', className: 'panel-grip', title: 'Drag to move this panel (also between sidebars) · arrow keys move it' });
    grip.setAttribute('aria-label', `Move ${niceTitle(id)} panel`);
    grip.innerHTML = d.icon('grip');
    grip.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
    grip.addEventListener('pointerdown', event => {
      event.stopPropagation();
      startDrag(event, { id, el: section(id), label: niceTitle(id), targets: sidebarTargets, onDrop: (side, before) => placePanel(id, side, before) });
    });
    grip.addEventListener('keydown', event => {
      const view = captureView(), side = sideOf(view, id), list = view[side], at = list.indexOf(id);
      let target = null;
      if (event.key === 'ArrowUp' && at > 0) target = [side, list[at - 1]];
      else if (event.key === 'ArrowDown' && at < list.length - 1) target = [side, list[at + 2] ?? null];
      else if (event.key === 'ArrowLeft' && side === 'right') target = ['left', view.left[Math.min(at, view.left.length)] ?? null];
      else if (event.key === 'ArrowRight' && side === 'left') target = ['right', view.right[Math.min(at, view.right.length)] ?? null];
      if (!target && !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (!target) return;
      placePanel(id, target[0], target[1]);
      grip.focus();
    });
    summary.prepend(grip);
  }
}

// ---- the View menu ---------------------------------------------------------------------------------------------
function diagram(view) {
  const v = normalizeView(view), s = { ...NOMINAL, ...v.sizes };
  const pct = (value, of) => `${(value / of * 100).toFixed(1)}%`;
  const stripes = list => list.filter(id => !(id in v.floating)).map(id => `<i class="${v.closed.includes(id) ? 'closed' : ''}${id === 'preview' ? ' preview' : ''}"></i>`).join('');
  const side = (key, width) => (v.sidebars[key] && v[key].length ? `<span class="vd-side" style="width:${pct(width, NOMINAL.width)}">${stripes(v[key])}</span>` : '');
  const timeline = v.timeline === 'hidden' ? '' : `<span class="vd-timeline" style="height:${v.timeline === 'min' ? '9%' : pct(s.timeline, NOMINAL.height)}"></span>`;
  const floats = Object.entries(v.floating).map(([, r]) => {
    const rect = r || { x: -300, y: 140, width: 270, height: 300 };
    const x = rect.x < 0 ? NOMINAL.width + rect.x : rect.x, y = rect.y < 0 ? NOMINAL.height + rect.y : rect.y;
    return `<b style="left:${pct(x, NOMINAL.width)};top:${pct(y - 100, NOMINAL.height - 100)};width:${pct(rect.width, NOMINAL.width)};height:${pct(rect.height, NOMINAL.height)}"></b>`;
  }).join('');
  return `<span class="view-diagram" aria-hidden="true">${side('left', s.tools)}<span class="vd-main"><span class="vd-canvas"></span>${timeline}</span>${side('right', s.details)}${floats}</span>`;
}

function renderMenu() {
  const now = captureView(), list = views(), name = menu.querySelector('#view-save-name')?.value || '';
  const card = (item, index) => {
    const active = item.id === store.active, changed = active && !sameArrangement(item.view, now);
    const custom = item.id.startsWith('custom-');
    return `<div class="view-card${active ? ' active' : ''}" role="listitem">
      <button type="button" class="view-card-main" data-preset="${esc(item.id)}" aria-pressed="${active}" title="${esc(item.description || item.name)}${shortcut(index + 1) ? ` (${shortcut(index + 1)})` : ''}">
        ${diagram(item.view)}<strong>${esc(item.name)}${changed ? ' <em>changed</em>' : ''}</strong><small>${esc(item.description || 'Your saved layout')}</small>${shortcut(index + 1) ? `<kbd>${shortcut(index + 1)}</kbd>` : ''}
      </button>
      ${custom ? `<button type="button" class="view-card-action" data-update="${esc(item.id)}" title="Update “${esc(item.name)}” to the current layout" aria-label="Update ${esc(item.name)} to the current layout">${d.icon('check')}</button><button type="button" class="view-card-action delete" data-delete="${esc(item.id)}" title="Delete “${esc(item.name)}”" aria-label="Delete ${esc(item.name)}">${d.icon('trash')}</button>` : changed ? `<button type="button" class="view-card-action" data-preset="${esc(item.id)}" title="Reset to the “${esc(item.name)}” layout" aria-label="Reset to ${esc(item.name)}">${d.icon('undo')}</button>` : ''}
    </div>`;
  };
  const row = id => {
    const side = sideOf(now, id), floating = id in now.floating;
    return `<li class="view-row${floating ? ' floating' : ''}" data-id="${id}">
      <button type="button" class="view-row-grip" data-grip="${id}" title="Drag to another column or position" aria-label="Move ${esc(niceTitle(id))}">${d.icon('grip')}</button>
      <span class="view-row-name">${esc(niceTitle(id))}${floating ? ' <em>floating</em>' : ''}</span>
      ${side === 'hidden' ? `<button type="button" class="icon-button mini" data-show="${id}" title="Show in the ${DEFAULT_SIDE_LABEL(id)} sidebar" aria-label="Show ${esc(niceTitle(id))}">${d.icon('eye')}</button>` : `
      <button type="button" class="icon-button mini${floating ? ' active' : ''}" data-float="${id}" aria-pressed="${floating}" title="${floating ? 'Dock into the sidebar' : 'Pop out as a floating panel'}" aria-label="${floating ? 'Dock' : 'Float'} ${esc(niceTitle(id))}">${floating ? '⇲' : '⇱'}</button>
      <button type="button" class="icon-button mini" data-hide="${id}" title="Hide this panel" aria-label="Hide ${esc(niceTitle(id))}">${d.icon('eye-off')}</button>`}
    </li>`;
  };
  const column = (key, label, extra = '') => `<div class="view-col" data-col="${key}"><div class="view-col-head"><span>${label}</span>${extra}</div><ol class="view-list" data-list="${key}">${now[key].map(row).join('') || '<li class="view-list-empty">Drop panels here</li>'}</ol></div>`;
  const toggle = (key, label) => `<label class="view-switch" title="Show the ${label.toLowerCase()}"><input type="checkbox" data-sidebar="${key}"${now.sidebars[key] ? ' checked' : ''}><span>Show</span></label>`;
  const seg = (value, label) => `<button type="button" class="view-seg${now.timeline === value ? ' active' : ''}" data-timeline="${value}" aria-pressed="${now.timeline === value}">${label}</button>`;
  menu.innerHTML = `
    <header class="view-menu-head"><strong>Workspace view</strong><span>Pick a layout for the job, or arrange panels your way.</span><button type="button" class="icon-button" data-close title="Close (Esc)" aria-label="Close">${d.icon('close')}</button></header>
    <section class="view-menu-section"><h3>Layouts</h3>
      <div class="view-cards" role="list">${list.map(card).join('')}</div>
      <form class="view-save"><input id="view-save-name" maxlength="40" placeholder="Name this layout, e.g. “Tiles”" value="${esc(name)}" autocomplete="off"><button type="submit" class="button small" ${store.custom.length >= MAX_CUSTOM_VIEWS ? `disabled title="Up to ${MAX_CUSTOM_VIEWS} saved layouts"` : ''}>${d.icon('plus')}<span>Save current</span></button></form>
    </section>
    <section class="view-menu-section"><h3>Panels <small>Drag to reorder or move between sidebars</small></h3>
      <div class="view-cols">${column('left', 'Left sidebar', toggle('left', 'Left sidebar'))}${column('right', 'Right sidebar', toggle('right', 'Right sidebar'))}${column('hidden', 'Hidden')}</div>
    </section>
    <section class="view-menu-section view-options"><h3>Layout</h3>
      <div class="view-option"><span>Frames timeline</span><div class="view-segs" role="group" aria-label="Frames timeline">${seg('open', 'Open')}${seg('min', 'Minimised')}${seg('hidden', 'Hidden')}</div></div>
      <label class="view-option"><span>Compact panels <small>Tighter spacing in the sidebars</small></span><input type="checkbox" data-compact${now.compact ? ' checked' : ''}></label>
      <div class="view-option"><span>Sizes <small>Drag the sidebar and timeline edges; double-click an edge to reset it</small></span><button type="button" class="button small subtle" data-reset-sizes>Reset sizes</button></div>
    </section>`;
}
const DEFAULT_SIDE_LABEL = id => (['tools', 'palette', 'transforms'].includes(id) ? 'left' : 'right');

function menuTargets() {
  return [...menu.querySelectorAll('.view-list')].map(el => ({
    el, key: el.dataset.list,
    items: [...el.querySelectorAll(':scope > .view-row')].map(li => ({ el: li, id: li.dataset.id })),
  }));
}

function onMenuClick(event) {
  const t = event.target.closest('button, input');
  if (!t) return;
  const data = t.dataset;
  if ('close' in data) return toggleMenu(false);
  if (data.preset) return applyPreset(data.preset);
  if (data.delete) {
    const item = store.custom.find(v => v.id === data.delete);
    store.custom = store.custom.filter(v => v.id !== data.delete);
    if (store.active === data.delete) store.active = null;
    save(); renderMenu(); refresh();
    return d.toast(`Deleted the “${item?.name}” layout.`);
  }
  if (data.update) {
    const item = store.custom.find(v => v.id === data.update);
    item.view = captureView(); store.active = item.id;
    save(); renderMenu(); refresh();
    return d.toast(`Updated “${item.name}”.`);
  }
  if (data.show) return placePanel(data.show, DEFAULT_SIDE_LABEL(data.show), null);
  if (data.hide) return placePanel(data.hide, 'hidden', null);
  if (data.float) {
    const L = layout();
    if (L.floating().includes(data.float)) L.dock(data.float);
    else {
      if (window.matchMedia('(max-width: 760px)').matches) return d.toast('Floating panels need a wider window.');
      section(data.float).open = true;
      L.popOut(data.float);
    }
    return remember();
  }
  if (data.timeline) {
    $('workbench').classList.toggle('timeline-hidden', data.timeline === 'hidden');
    layout().setTimelineCollapsed(data.timeline === 'min');
    return remember();
  }
  if ('resetSizes' in data) { layout().setSizes({}); return remember(); }
}

function onMenuChange(event) {
  const t = event.target;
  if (t.dataset.sidebar) {
    const shown = t.checked, key = t.dataset.sidebar;
    d.setSidebars({ tools: key === 'left' ? !shown : d.state.panels.tools, details: key === 'right' ? !shown : d.state.panels.details });
    remember();
  }
  if ('compact' in t.dataset) { $('workbench').classList.toggle('compact-panels', t.checked); remember(); }
}

function saveCurrent(event) {
  event.preventDefault();
  const input = menu.querySelector('#view-save-name'), name = input.value.trim().slice(0, 40);
  if (!name) { input.focus(); return d.toast('Give the layout a name first.'); }
  const existing = store.custom.find(v => v.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.view = captureView();
  else {
    if (store.custom.length >= MAX_CUSTOM_VIEWS) return d.toast(`You can keep up to ${MAX_CUSTOM_VIEWS} layouts.`);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'view';
    store.custom.push({ id: `custom-${slug}-${Date.now().toString(36)}`, name, view: captureView() });
  }
  store.active = (existing || store.custom.at(-1)).id;
  input.value = '';
  save(); renderMenu(); refresh();
  d.toast(`${existing ? 'Updated' : 'Saved'} the “${name}” layout.`);
}

function place() {
  const r = button.getBoundingClientRect(), width = Math.min(600, innerWidth - 16);
  Object.assign(menu.style, {
    width: `${width}px`, top: `${Math.round(r.bottom + 6)}px`,
    left: `${Math.round(Math.max(8, Math.min(innerWidth - width - 8, r.right - width)))}px`,
    maxHeight: `${Math.round(innerHeight - r.bottom - 14)}px`,
  });
}

export function toggleMenu(open = !menu || menu.hidden) {
  if (!menu) {
    menu = document.createElement('div');
    menu.className = 'view-menu';
    menu.id = 'view-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Workspace view');
    document.body.appendChild(menu);
    menu.addEventListener('click', onMenuClick);
    menu.addEventListener('change', onMenuChange);
    menu.addEventListener('submit', saveCurrent);
    menu.addEventListener('pointerdown', event => {
      const grip = event.target.closest('[data-grip]');
      if (!grip) return;
      const id = grip.dataset.grip;
      startDrag(event, { id, el: grip.closest('.view-row'), label: niceTitle(id), targets: menuTargets, onDrop: (side, before) => placePanel(id, side, before) });
    });
    // Capture phase on the document: re-rendering the menu can drop focus out of it (Safari never focuses buttons).
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || menu.hidden || document.getElementById('modal')?.open) return;
      event.preventDefault(); event.stopPropagation();
      toggleMenu(false); button.focus();
    }, true);
    document.addEventListener('pointerdown', event => {
      if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target) && !event.target.closest?.('.panel-grip, .floating-panel, .view-drag-ghost')) toggleMenu(false);
    }, true);
    addEventListener('resize', () => { if (!menu.hidden) place(); });
  }
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (open) { renderMenu(); place(); menu.querySelector('.view-card.active .view-card-main, .view-card-main')?.focus({ preventScroll: true }); }
}

/**
 * Restore the remembered placement before panel-layout pops panels out (so floating panels go home to the right
 * spot). deps: { state, toast, icon, escapeHTML, setSidebars({tools, details}) (true = hidden), layout() }.
 */
export function initWorkspaceViews(deps) {
  d = deps;
  load();
  addGrips();
  if (store.placement) arrange(store.placement);
  button = $('view-button');
  button?.addEventListener('click', () => toggleMenu());
  addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey || !/^Digit[1-9]$/.test(event.code)) return;
    const item = views()[Number(event.code.slice(5)) - 1];
    if (!item || document.getElementById('modal')?.open) return;
    event.preventDefault();
    applyPreset(item.id);
  });
  registerCommandSource(() => views().map((item, index) => ({
    key: `view:${item.id}`, title: `View: ${item.name}`, description: `${item.description || 'Saved layout'}${shortcut(index + 1) ? ` · ${shortcut(index + 1)}` : ''}`,
    group: 'View', disabled: '', run: () => applyPreset(item.id),
  })));
  return {
    afterLayout() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; store.placement = captureView(); save(); refresh(); if (menu && !menu.hidden && !document.body.classList.contains('is-dragging-panel')) renderMenu(); });
    },
    applyPreset, applyView, captureView, toggleMenu,
  };
}
