/**
 * Project tab management: right-click / ⋯ context menu (close others, to the right, all…), the "all tabs" list,
 * drag to reorder, middle-click to close, keyboard shortcuts and palette commands. Tab state lives in app.js.
 */
import { tabsToClose } from '../domain/tabs.js';
import { registerCommandSource } from '../plugins/command-palette.js';

let d, menu = null, returnFocus = null;
const $ = id => document.getElementById(id);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const alt = isMac ? '⌥' : 'Alt+';
export const TAB_SHORTCUTS = { close: `${alt}W`, reopen: `${alt}⇧T`.replace('Alt+⇧', 'Alt+Shift+'), others: `${alt}⇧W`.replace('Alt+⇧', 'Alt+Shift+') };

// ---- a small accessible menu ----------------------------------------------------------------------------------
function closeMenu({ focus = true } = {}) {
  if (!menu) return;
  menu.remove(); menu = null;
  if (focus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}

/** items: { label, hint, icon, disabled, checked, danger, run } or 'sep' or { heading }. at: { x, y } or an element. */
export function openMenu(items, at, { label = 'Menu' } = {}) {
  closeMenu({ focus: false });
  returnFocus = document.activeElement;
  menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  menu.innerHTML = items.map((item, index) => {
    if (item === 'sep') return '<div class="context-sep" role="separator"></div>';
    if (item.heading) return `<div class="context-heading">${d.escapeHTML(item.heading)}</div>`;
    return `<button type="button" role="${item.checked === undefined ? 'menuitem' : 'menuitemradio'}"${item.checked !== undefined ? ` aria-checked="${!!item.checked}"` : ''} class="context-item${item.danger ? ' danger' : ''}${item.dot ? ' with-dot' : ''}" data-index="${index}" tabindex="-1"${item.disabled ? ' aria-disabled="true"' : ''}>
      <span class="context-icon">${item.checked ? d.icon('check') : item.icon ? d.icon(item.icon) : ''}</span><span class="context-label">${d.escapeHTML(item.label)}</span>${item.dot ? '<i class="context-dot" title="Unsaved changes"></i>' : ''}${item.hint ? `<kbd>${d.escapeHTML(item.hint)}</kbd>` : ''}</button>`;
  }).join('');
  document.body.appendChild(menu);
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
  const box = menu.getBoundingClientRect();
  const x = Math.max(8, Math.min(innerWidth - box.width - 8, at instanceof Element ? r.right - box.width : r.left));
  const y = r.bottom + 4 + box.height > innerHeight - 8 ? Math.max(8, r.top - box.height - 4) : r.bottom + (at instanceof Element ? 4 : 0);
  Object.assign(menu.style, { left: `${x}px`, top: `${y}px`, maxHeight: `${innerHeight - 16}px` });
  const buttons = [...menu.querySelectorAll('.context-item:not([aria-disabled])')];
  (menu.querySelector('.context-item[aria-checked="true"]:not([aria-disabled])') || buttons[0])?.focus({ preventScroll: true });
  menu.addEventListener('click', event => {
    const button = event.target.closest('.context-item');
    if (!button || button.hasAttribute('aria-disabled')) return;
    const item = items[Number(button.dataset.index)];
    closeMenu({ focus: !item.keepFocus });
    item.run();
  });
  menu.addEventListener('keydown', event => {
    const at = buttons.indexOf(document.activeElement);
    const go = index => { event.preventDefault(); buttons[(index + buttons.length) % buttons.length]?.focus(); };
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(buttons.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); closeMenu(); }
  });
  return menu;
}
document.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target)) closeMenu({ focus: false }); }, true);
addEventListener('resize', () => closeMenu({ focus: false }));
addEventListener('blur', () => closeMenu({ focus: false }));

// ---- tab actions ----------------------------------------------------------------------------------------------
function closeGroup(id, mode) {
  const ids = tabsToClose(d.state.openIds, id, mode, d.isSaved);
  if (!ids.length) return d.toast(mode === 'saved' ? 'Every open tab has unsaved changes.' : 'No other tabs to close.');
  return d.closeDocuments(ids);
}

function tabItems(id) {
  const ids = d.state.openIds, at = ids.indexOf(id), many = ids.length > 1;
  return [
    { label: 'Rename…', icon: 'pencil', run: () => d.renameTab(id), keepFocus: true },
    { label: 'Duplicate tab', icon: 'copy', run: () => d.duplicateTab(id) },
    { label: 'Move left', icon: 'left', disabled: at <= 0, run: () => d.moveTab(id, at - 1) },
    { label: 'Move right', icon: 'chevron', disabled: at >= ids.length - 1, run: () => d.moveTab(id, at + 1) },
    'sep',
    { label: 'Close', icon: 'close', hint: id === d.state.documentId ? TAB_SHORTCUTS.close : '', run: () => closeGroup(id, 'this') },
    { label: 'Close other tabs', disabled: !many, hint: id === d.state.documentId ? TAB_SHORTCUTS.others : '', run: () => closeGroup(id, 'others') },
    { label: 'Close tabs to the right', disabled: at >= ids.length - 1, run: () => closeGroup(id, 'right') },
    { label: 'Close tabs to the left', disabled: at <= 0, run: () => closeGroup(id, 'left') },
    { label: 'Close saved tabs', disabled: !ids.some(d.isSaved), run: () => closeGroup(id, 'saved') },
    { label: 'Close all tabs', danger: true, run: () => closeGroup(id, 'all') },
    'sep',
    { label: 'Reopen closed tab', icon: 'undo', hint: TAB_SHORTCUTS.reopen, disabled: !d.state.closedTabs.length, run: () => d.reopenClosedTab() },
  ];
}

export function openTabMenu(id, at) {
  if (!d.state.openIds.includes(id)) return;
  openMenu(tabItems(id), at, { label: `Tab: ${d.name(id)}` });
}

function openTabList() {
  const active = d.state.documentId;
  openMenu([
    { heading: `${d.state.openIds.length} open ${d.state.openIds.length === 1 ? 'tab' : 'tabs'}` },
    ...d.state.openIds.map(id => ({ label: d.name(id), checked: id === active, dot: !d.isSaved(id), run: () => d.switchDocument(id) })),
    'sep',
    { label: 'Close other tabs', disabled: d.state.openIds.length < 2, run: () => closeGroup(active, 'others') },
    { label: 'Close saved tabs', disabled: !d.state.openIds.some(d.isSaved), run: () => closeGroup(active, 'saved') },
    { label: 'Close all tabs', danger: true, run: () => closeGroup(active, 'all') },
    'sep',
    { label: 'Reopen closed tab', icon: 'undo', hint: TAB_SHORTCUTS.reopen, disabled: !d.state.closedTabs.length, run: () => d.reopenClosedTab() },
    { label: 'Saved projects…', icon: 'folder', run: () => $('open-saved-projects').click() },
  ], $('tab-list-button'), { label: 'Open tabs' });
}

// ---- drag to reorder ------------------------------------------------------------------------------------------
let suppressClick = false;
function startTabDrag(event, id) {
  if (event.button !== 0 || d.state.openIds.length < 2) return;
  const list = $('project-tabs'), sx = event.clientX, handle = event.currentTarget;
  let line = null, index = null, dragging = false;
  const tab = handle.closest('.project-tab');
  const move = e => {
    if (!dragging && Math.abs(e.clientX - sx) < 6) return;
    if (!dragging) {
      dragging = true;
      handle.setPointerCapture?.(e.pointerId);
      line = Object.assign(document.createElement('div'), { className: 'tab-drop-line' });
      document.body.appendChild(line);
      tab.classList.add('dragging');
      document.body.classList.add('is-dragging-tab');
    }
    // Auto-scroll near the edges of an overflowing tab strip.
    const lr = list.getBoundingClientRect();
    if (e.clientX < lr.left + 24) list.scrollLeft -= 12; else if (e.clientX > lr.right - 24) list.scrollLeft += 12;
    const others = [...list.querySelectorAll('.project-tab')].filter(el => el !== tab);
    const before = others.findIndex(el => { const b = el.getBoundingClientRect(); return e.clientX < b.left + b.width / 2; });
    index = before < 0 ? others.length : before;
    const ref = others[index]?.getBoundingClientRect(), last = others.at(-1)?.getBoundingClientRect();
    const x = ref ? ref.left - 2 : last ? last.right + 1 : lr.left;
    Object.assign(line.style, { left: `${Math.max(lr.left, Math.min(lr.right, x)) - 1}px`, top: `${lr.top + 6}px`, height: `${lr.height - 10}px` });
  };
  const end = e => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    if (!dragging) return;
    line.remove(); tab.classList.remove('dragging'); document.body.classList.remove('is-dragging-tab');
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
    if (e.type === 'pointerup' && index !== null) d.moveTab(id, index);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
}

/** Bind the events of a freshly rendered tab strip. */
export function bindTabs(list) {
  for (const tab of list.querySelectorAll('.project-tab')) {
    const select = tab.querySelector('[data-document]'), id = select.dataset.document;
    select.addEventListener('pointerdown', event => startTabDrag(event, id));
    select.addEventListener('click', event => { if (suppressClick) { event.stopImmediatePropagation(); event.preventDefault(); } }, true);
    select.addEventListener('dblclick', () => d.renameTab(id));
    tab.addEventListener('contextmenu', event => { event.preventDefault(); openTabMenu(id, { x: event.clientX, y: event.clientY }); });
    tab.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); closeGroup(id, 'this'); } });
    tab.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); }); // no autoscroll cursor
  }
}

const typing = el => el?.closest?.('input, textarea, select, [contenteditable="true"]');

/**
 * deps: { state, toast, icon, escapeHTML, name(id), isSaved(id), switchDocument, closeDocuments(ids), reopenClosedTab,
 * duplicateTab(id), renameTab(id), moveTab(id, index) }.
 */
export function initTabTools(deps) {
  d = deps;
  $('tab-list-button')?.addEventListener('click', event => { event.stopPropagation(); if (menu) closeMenu(); else openTabList(); });
  $('project-tabs').addEventListener('keydown', event => {
    const tab = event.target.closest('[data-document]');
    if (!tab) return;
    const id = tab.dataset.document, at = d.state.openIds.indexOf(id);
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openTabMenu(id, tab); }
    else if (event.key === 'Delete') { event.preventDefault(); closeGroup(id, 'this'); }
    else if (event.key === 'F2') { event.preventDefault(); d.renameTab(id); }
    else if (event.altKey && event.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      d.moveTab(id, at + (event.key === 'ArrowLeft' ? -1 : 1));
      $(`project-tab-${id}`)?.focus();
    }
  }, true);
  addEventListener('keydown', event => {
    if (!event.altKey || event.metaKey || event.ctrlKey || typing(event.target) || $('modal')?.open) return;
    const run = event.code === 'KeyW' ? () => closeGroup(d.state.documentId, event.shiftKey ? 'others' : 'this')
      : event.code === 'KeyT' && event.shiftKey ? () => d.reopenClosedTab() : null;
    if (!run) return;
    // Capture phase so single-letter tool shortcuts (T, W…) never see these.
    event.preventDefault(); event.stopImmediatePropagation();
    if (!event.repeat) run();
  }, true);
  registerCommandSource(() => {
    const id = d.state.documentId, many = d.state.openIds.length > 1, none = 'Only one tab is open';
    return [
      { key: 'tab:close', title: 'Close tab', description: `Close this project tab · ${TAB_SHORTCUTS.close}`, group: 'Tabs', disabled: '', run: () => closeGroup(id, 'this') },
      { key: 'tab:others', title: 'Close other tabs', description: `Keep only this tab · ${TAB_SHORTCUTS.others}`, group: 'Tabs', disabled: many ? '' : none, run: () => closeGroup(id, 'others') },
      { key: 'tab:right', title: 'Close tabs to the right', description: 'Tabs', group: 'Tabs', disabled: d.state.openIds.at(-1) !== id ? '' : 'No tabs to the right', run: () => closeGroup(id, 'right') },
      { key: 'tab:saved', title: 'Close saved tabs', description: 'Close every tab without unsaved changes', group: 'Tabs', disabled: '', run: () => closeGroup(id, 'saved') },
      { key: 'tab:all', title: 'Close all tabs', description: 'Everything stays in Saved projects', group: 'Tabs', disabled: '', run: () => closeGroup(id, 'all') },
      { key: 'tab:reopen', title: 'Reopen closed tab', description: TAB_SHORTCUTS.reopen, group: 'Tabs', disabled: d.state.closedTabs.length ? '' : 'No closed tabs', run: () => d.reopenClosedTab() },
      { key: 'tab:duplicate', title: 'Duplicate tab', description: 'Open a copy of this project in a new tab', group: 'Tabs', disabled: '', run: () => d.duplicateTab(id) },
    ];
  });
}
