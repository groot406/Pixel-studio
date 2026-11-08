/**
 * Frames bar: frame cards as thumbnails or as timing bars (width ∝ duration, drag the right edge to change a hold),
 * multi-select (click, Shift-click range, Ctrl/⌘-click toggle), drag to reorder, key-pose markers (frame.kind) with a
 * ruler, a right-click/Timing menu for bulk operations (ease, even out, hold, speed, reverse, ping-pong) and a
 * playback range the Live Preview loops. Timing maths lives in domain/timing.js.
 */
import {
  KIND_LABELS, nextKind, findKey, easeDurations, evenDurations, scaleDurations, snapDuration, formatHold, totalDuration,
  moveFrames, reverseFrames, pingPongFrames, playbackRange, nextPlaybackIndex,
} from '../domain/timing.js';
import { compositeFrame, makeLayeredFrame } from '../domain/project.js';
import { toggleOnionSettings } from './onion.js';

const VIEW_KEY = 'pixel-studio.timeline-view.v1', PX_PER_MS = 0.5, MIN_BAR = 34, DRAG_START = 6;
let d, sel = new Set(), anchor = null, loopIds = null, drag = null, menu = null, suppressUntil = 0;
let view = (() => { try { return localStorage.getItem(VIEW_KEY) === 'timing' ? 'timing' : 'thumbs'; } catch { return 'thumbs'; } })();

const st = () => d.state;
const frames = () => d.currentAnimation().frames;
const fps = () => d.currentAnimation().fps;
const barWidth = ms => Math.max(MIN_BAR, Math.round(ms * PX_PER_MS));
const seconds = ms => `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Selected frames of the current animation, in timeline order. */
export function selectedFrames() { return frames().filter(f => sel.has(f.id)); }
/** The selection, or every frame when fewer than two are selected (for ease / even out / speed). */
const spanFrames = () => (sel.size > 1 ? selectedFrames() : frames());

function syncSelection() {
  const ids = new Set(frames().map(f => f.id));
  for (const id of [...sel]) if (!ids.has(id)) sel.delete(id);
  if (!sel.has(st().frameId)) { sel = new Set([st().frameId]); anchor = st().frameId; }
  if (loopIds && !loopIds.every(id => ids.has(id))) loopIds = null;
}

function cardHTML(frame, index) {
  const current = frame.id === st().frameId, picked = sel.has(frame.id), kind = frame.kind;
  const label = `Frame ${index + 1}${kind ? ` · ${KIND_LABELS[kind]}` : ''} · ${frame.duration} ms`;
  return `<button class="frame-card${current ? ' selected' : ''}${picked && sel.size > 1 ? ' picked' : ''}${kind ? ` kind-${kind}` : ''}" data-frame="${d.escapeHTML(frame.id)}" data-index="${index}" style="--bar:${barWidth(frame.duration)}px" aria-label="${label}" aria-pressed="${current}" title="${label}${sel.size > 1 ? '' : ' · Shift/Ctrl-click to select several · right-click for more'}"><canvas width="32" height="32"></canvas><span class="frame-number">${String(index + 1).padStart(2, '0')}</span><span class="frame-duration-label">${frame.duration} ms</span>${kind ? `<span class="frame-kind" aria-hidden="true"></span>` : ''}<span class="frame-marker"></span>${view === 'timing' ? '<span class="frame-resize" aria-hidden="true"></span>' : ''}</button>`;
}
function rulerHTML(list) {
  const range = loopIds && playbackRange(list, loopIds);
  return list.map((f, i) => `<span class="ruler-cell${f.id === st().frameId ? ' current' : ''}${sel.has(f.id) && sel.size > 1 ? ' picked' : ''}${range && i >= range.start && i <= range.end ? ' looped' : ''}${f.kind ? ` kind-${f.kind}` : ''}" data-index="${i}" style="flex-grow:${f.duration}" title="Frame ${i + 1}${f.kind ? ` · ${KIND_LABELS[f.kind]}` : ''} · ${f.duration} ms"><i></i></span>`).join('');
}

/** Render the frame cards, the key-pose ruler and the timing summary (called from renderTimeline). */
export function renderFrameCards() {
  syncSelection();
  const list = frames(), animation = d.currentAnimation(), total = totalDuration(list.map(f => f.duration));
  const container = d.$('frame-list');
  container.classList.toggle('timing', view === 'timing');
  container.innerHTML = list.map(cardHTML).join('');
  container.querySelectorAll('[data-frame]').forEach((card, index) => d.paintSprite(card.querySelector('canvas'), compositeFrame(st().project, list[index]), st().project.palette, true));
  d.$('frame-ruler').innerHTML = rulerHTML(list);
  d.$('frame-ruler').title = `${plural(list.length, 'frame')} · ${seconds(total)} · ${animation.fps} fps${loopIds ? ' · preview loops the highlighted range' : ''}`;
  d.$('timeline-total').textContent = `${seconds(total)} · ${animation.fps} fps`;
  d.$('timeline-total').title = `Total time ${total} ms; the average frame shows ${Math.round(total / list.length)} ms (${(list.length * 1000 / total).toFixed(1)} drawings per second)`;
  const n = sel.size;
  d.$('frame-selection-count').textContent = n > 1 ? `${n} selected` : '';
  d.$('frame-hold').textContent = n > 1 ? '' : `≈ ${formatHold(d.currentFrame().duration, animation.fps).split(' · ')[1]}`;
  d.$('frame-duration').title = n > 1 ? `Sets the duration of all ${n} selected frames` : 'Selected frame duration in milliseconds';
  d.$('loop-badge').hidden = !loopIds;
  for (const button of d.$('timeline-view').querySelectorAll('[data-view]')) {
    const on = button.dataset.view === view;
    button.classList.toggle('active', on); button.setAttribute('aria-checked', String(on));
  }
}

function commit(action, message) {
  try { d.mutate(action); if (message) d.toast(message); return true; }
  catch (error) { d.toast(error.message); d.renderAll(); return false; }
}
function setDurations(list, durations) { list.forEach((frame, i) => { frame.duration = durations[i]; }); st().previewTime = 0; }
function copyFrame(frame) { return { ...makeLayeredFrame(st().project, frame), ...(frame.kind ? { kind: frame.kind } : {}) }; }

/** Bulk timeline actions on the selected frames (see the menus). */
export function frameAction(name, arg) {
  const animation = d.currentAnimation(), picked = selectedFrames(), n = picked.length, ids = picked.map(f => f.id);
  const lastIndex = () => animation.frames.findIndex(f => f.id === ids[ids.length - 1]);
  switch (name) {
    case 'kind': return commit(() => { for (const f of selectedFrames()) { if (arg) f.kind = arg; else delete f.kind; } }, arg ? `${plural(n, 'frame')} marked ${KIND_LABELS[arg].toLowerCase()}.` : 'Marker cleared.');
    case 'cycle-kind': { const kind = nextKind(picked[0]?.kind); return frameAction('kind', kind); }
    case 'duplicate': {
      if (n < 2) { d.addFrame(true); return true; }
      return commit(() => {
        const copies = picked.map(copyFrame); animation.frames.splice(lastIndex() + 1, 0, ...copies);
        sel = new Set(copies.map(f => f.id)); anchor = copies[0].id; st().frameId = copies[0].id;
      }, `Duplicated ${n} frames.`);
    }
    case 'delete': {
      if (n >= animation.frames.length) { d.toast('An animation needs at least one frame. Keep one unselected.'); return false; }
      const first = animation.frames.findIndex(f => sel.has(f.id));
      return commit(() => {
        animation.frames = animation.frames.filter(f => !ids.includes(f.id));
        st().frameId = animation.frames[Math.min(first, animation.frames.length - 1)].id;
      }, n > 1 ? `Deleted ${n} frames.` : '');
    }
    case 'reverse': return commit(() => { animation.frames = reverseFrames(animation.frames, ids); }, `Reversed ${n} frames; each keeps its timing.`);
    case 'pingpong': {
      const back = pingPongFrames(picked);
      if (!back.length) { d.toast('Select three or more frames to ping-pong.'); return false; }
      return commit(() => { animation.frames.splice(lastIndex() + 1, 0, ...back.map(copyFrame)); }, `Added ${plural(back.length, 'frame')} playing back to the start.`);
    }
    case 'hold': return commit(() => setDurations(picked, scaleDurations(picked.map(f => f.duration), arg)), `${plural(n, 'frame')} now hold ${arg > 1 ? 'longer' : 'shorter'}.`);
    case 'duration': return commit(() => setDurations(picked, picked.map(() => arg)));
    case 'ease': case 'even': {
      const span = spanFrames();
      if (span.length < 2) { d.toast('Add more frames to ease their timing.'); return false; }
      const durations = span.map(f => f.duration);
      return commit(() => setDurations(span, name === 'even' ? evenDurations(durations) : easeDurations(durations, { easing: arg })),
        `${name === 'even' ? 'Evened out' : 'Eased'} ${sel.size > 1 ? `${span.length} selected frames` : `all ${span.length} frames`} over the same ${totalDuration(durations)} ms.`);
    }
    case 'speed': {
      const span = spanFrames();
      return commit(() => setDurations(span, scaleDurations(span.map(f => f.duration), 1 / arg)), `${sel.size > 1 ? `${span.length} selected frames` : 'Animation'} now play${sel.size > 1 ? '' : 's'} at ×${arg} speed.`);
    }
    case 'loop': {
      const range = arg ? playbackRange(animation.frames, ids) : null;
      loopIds = range ? ids : null; st().previewTime = 0; d.renderAll();
      d.toast(range ? `Live Preview loops frames ${range.start + 1}–${range.end + 1}.` : 'Live Preview plays every frame again.');
      return true;
    }
    case 'select-all': sel = new Set(animation.frames.map(f => f.id)); anchor = animation.frames[0].id; d.renderAll(); return true;
    default: return false;
  }
}

/** Jump to the previous (−1) or next (+1) key pose. */
export function jumpToKey(direction) {
  const list = frames(), i = findKey(list, list.findIndex(f => f.id === st().frameId), direction);
  if (i < 0) { d.toast('Mark key poses first: right-click a frame or press M.'); return; }
  d.selectFrameAt(i);
}
/** Keyboard shortcuts owned by the timeline; returns true when handled. */
export function timelineKey(event, key) {
  if (event.altKey && (key === 'arrowleft' || key === 'arrowright')) { event.preventDefault(); jumpToKey(key === 'arrowleft' ? -1 : 1); return true; }
  if (key === 'm' && !event.altKey) { event.preventDefault(); frameAction('cycle-kind'); return true; }
  if (key === 'o' && event.shiftKey) { event.preventDefault(); toggleOnionSettings(); return true; }
  return false;
}
/** The next Live Preview frame: loops the playback range when one is set on the animation being edited. */
export function nextPreviewIndex(index, animation) {
  const range = loopIds && !st().previewOverride && animation === d.currentAnimation() ? playbackRange(animation.frames, loopIds) : null;
  return nextPlaybackIndex(index, animation.frames.length, range);
}
/** "↻ 2–5" when the preview loops a range. */
export function loopLabel() {
  const range = loopIds && !st().previewOverride && playbackRange(frames(), loopIds);
  return range ? ` · ↻ ${range.start + 1}–${range.end + 1}` : '';
}

function select(id, event) {
  const list = frames();
  if (event.shiftKey && anchor && list.some(f => f.id === anchor)) {
    const a = list.findIndex(f => f.id === anchor), b = list.findIndex(f => f.id === id);
    sel = new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1).map(f => f.id));
  } else if (event.ctrlKey || event.metaKey) {
    if (sel.has(id) && sel.size > 1) { sel.delete(id); id = sel.has(st().frameId) ? st().frameId : [...sel][0]; } else { sel.add(id); anchor = id; }
  } else if (!(st().objectScope === 'selected' && sel.has(id) && sel.size > 1)) { sel = new Set([id]); anchor = id; }
  // With the Edit switch on Selected, clicking a picked frame just moves to it so you can edit the picked frames one by one.
  d.selectFrameAt(list.findIndex(f => f.id === id));
}

function closeMenu() { menu?.remove(); menu = null; document.removeEventListener('pointerdown', menuAway, true); }
function menuAway(event) { if (!menu?.contains(event.target)) closeMenu(); }
function openMenu(x, y, withSpeed = false) {
  closeMenu();
  const n = sel.size, all = frames().length, many = n > 1, span = many ? `${n} selected` : 'all frames', kind = selectedFrames()[0]?.kind;
  const entry = (action, label, ico, enabled = true, arg = '') => ({ action, label, ico, enabled, arg });
  const entries = [
    ...['key', 'breakdown', 'inbetween'].map(k => entry('kind', `${kind === k && !many ? '✓ ' : ''}Mark as ${KIND_LABELS[k].toLowerCase()}`, `kind-${k}`, true, k)),
    entry('kind', 'Clear marker', 'close', selectedFrames().some(f => f.kind), ''),
    null,
    entry('ease', `Ease in · speed up (${span})`, 'ease-in', all > 1, 'easeIn'),
    entry('ease', `Ease out · slow down (${span})`, 'ease-out', all > 1, 'easeOut'),
    entry('ease', `Ease in-out · smooth (${span})`, 'ease-inout', all > 1, 'easeInOut'),
    entry('even', `Even out (${span})`, 'timing', all > 1),
    entry('hold', many ? `Hold ×2 (${n} frames)` : 'Hold ×2', 'plus', true, 2),
    entry('hold', many ? `Hold ×½ (${n} frames)` : 'Hold ×½', 'minus', true, 0.5),
    ...(withSpeed ? [null, ...[[2, 'Speed ×2 (faster)'], [1.5, 'Speed ×1.5'], [0.75, 'Speed ×0.75'], [0.5, 'Speed ×0.5 (slower)']].map(([f, label]) => entry('speed', `${label} · ${span}`, f > 1 ? 'play' : 'pause', true, f))] : []),
    null,
    entry('duplicate', many ? `Duplicate ${n} frames` : 'Duplicate frame', 'copy'),
    entry('reverse', `Reverse ${many ? `${n} frames` : 'order'}`, 'swap', many),
    entry('pingpong', 'Ping-pong (append reversed)', 'cycle', n > 2),
    entry('delete', many ? `Delete ${n} frames` : 'Delete frame', 'trash', n < all),
    null,
    loopIds ? entry('loop', 'Stop looping range in preview', 'close', true, '') : entry('loop', `Loop ${many ? `these ${n} frames` : 'selection'} in preview`, 'cycle', many, '1'),
    entry('select-all', 'Select all frames', 'select-all', n < all),
  ];
  menu = document.createElement('div'); menu.className = 'object-menu frame-menu'; menu.setAttribute('role', 'menu');
  menu.innerHTML = entries.map(e => (e ? `<button role="menuitem" data-menu="${e.action}" data-arg="${e.arg}" ${e.enabled ? '' : 'disabled'}${e.action === 'delete' ? ' data-danger' : ''}>${e.ico.startsWith('kind-') || e.ico.startsWith('ease-') ? `<span class="menu-glyph ${e.ico}" aria-hidden="true"></span>` : d.icon(e.ico)}<span>${e.label}</span></button>` : '<hr>')).join('');
  document.body.append(menu);
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`; menu.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`;
  menu.querySelectorAll('[data-menu]').forEach(button => { button.onclick = () => { const { menu: action, arg } = button.dataset; closeMenu(); frameAction(action, arg === '' ? null : Number.isNaN(Number(arg)) ? arg : Number(arg)); }; });
  menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('button:not([disabled])')], i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); d.$('frame-list').querySelector('.selected')?.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
  });
  menu.querySelector('button:not([disabled])')?.focus();
  document.addEventListener('pointerdown', menuAway, true);
}

function tip(text, x, y) {
  let el = document.getElementById('timing-tip');
  if (!text) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'timing-tip'; el.className = 'timing-tip'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.innerHTML = text;
  el.style.left = `${Math.min(innerWidth - el.offsetWidth - 8, x + 12)}px`; el.style.top = `${Math.max(8, y - el.offsetHeight - 12)}px`;
}
/** Insertion index (0…n) for a reorder drop at clientX, plus the x of the gap for the indicator. */
function dropTarget(clientX) {
  const list = d.$('frame-list'), cards = [...list.querySelectorAll('.frame-card')], box = list.getBoundingClientRect();
  let index = cards.length;
  for (let i = 0; i < cards.length; i++) { const r = cards[i].getBoundingClientRect(); if (clientX < r.left + r.width / 2) { index = i; break; } }
  const ref = cards[Math.min(index, cards.length - 1)].getBoundingClientRect();
  return { index, x: (index < cards.length ? ref.left - 5 : ref.right + 4) - box.left + list.scrollLeft };
}
function onPointerDown(event) {
  suppressUntil = 0;
  if (event.button !== 0 || st().inPlaceEdit) return;
  const card = event.target.closest('.frame-card');
  if (!card) return;
  const frame = frames()[Number(card.dataset.index)];
  if (event.target.closest('.frame-resize')) {
    event.preventDefault();
    const group = event.shiftKey && sel.has(frame.id) && sel.size > 1 ? selectedFrames() : [frame];
    drag = { kind: 'resize', id: frame.id, card, x: event.clientX, start: frame.duration, group, starts: group.map(f => f.duration), value: frame.duration, pointerId: event.pointerId };
    d.$('frame-list').setPointerCapture(event.pointerId);
    card.classList.add('resizing');
    resizeMove(event);
    return;
  }
  if (event.pointerType === 'touch') return;
  drag = { kind: 'pending', id: frame.id, card, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
}
function resizeMove(event) {
  const raw = drag.start + (event.clientX - drag.x) / PX_PER_MS;
  drag.value = event.altKey ? snapDuration(raw, { fps: fps() }) : snapDuration(raw, { step: 10 });
  const ratio = drag.value / drag.start, cards = d.$('frame-list').querySelectorAll('.frame-card');
  drag.values = drag.starts.map(ms => (drag.group.length > 1 ? Math.max(1, Math.min(60000, Math.round(ms * ratio))) : drag.value));
  drag.group.forEach((f, i) => {
    const card = [...cards].find(c => c.dataset.frame === f.id);
    if (card) { card.style.setProperty('--bar', `${barWidth(drag.values[i])}px`); card.querySelector('.frame-duration-label').textContent = `${drag.values[i]} ms`; }
  });
  const group = drag.group.length > 1 ? `<small>${drag.group.length} frames scale ×${ratio.toFixed(2)}</small>` : '';
  tip(`<strong>${formatHold(drag.value, fps())}</strong>${group}<small>${event.altKey ? 'Snapping to whole frames' : 'Alt: snap to whole frames'}${drag.group.length > 1 ? '' : ' · Shift: all selected'}</small>`, event.clientX, event.clientY);
}
function onPointerMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (drag.kind === 'resize') { resizeMove(event); return; }
  if (drag.kind === 'pending') {
    if (Math.abs(event.clientX - drag.x) < DRAG_START && Math.abs(event.clientY - drag.y) < DRAG_START) return;
    drag.kind = 'move'; drag.ids = sel.has(drag.id) ? selectedFrames().map(f => f.id) : [drag.id];
    d.$('frame-list').setPointerCapture(event.pointerId);
    d.$('frame-list').classList.add('reordering');
    for (const card of d.$('frame-list').querySelectorAll('.frame-card')) card.classList.toggle('dragging', drag.ids.includes(card.dataset.frame));
  }
  const list = d.$('frame-list'), box = list.getBoundingClientRect();
  if (event.clientX < box.left + 30) list.scrollLeft -= 12; else if (event.clientX > box.right - 30) list.scrollLeft += 12;
  const target = dropTarget(event.clientX);
  drag.to = target.index;
  let line = list.querySelector('.frame-drop');
  if (!line) { line = document.createElement('span'); line.className = 'frame-drop'; line.setAttribute('aria-hidden', 'true'); list.append(line); }
  line.style.left = `${target.x}px`;
  tip(`Move ${drag.ids.length > 1 ? `${drag.ids.length} frames` : `frame ${frames().findIndex(f => f.id === drag.id) + 1}`} to position ${frames().slice(0, target.index).filter(f => !drag.ids.includes(f.id)).length + 1}`, event.clientX, event.clientY);
}
function endDrag(event, cancel = false) {
  if (!drag || (event && event.pointerId !== drag.pointerId)) return;
  const done = drag; drag = null;
  tip(null);
  const list = d.$('frame-list');
  if (list.hasPointerCapture?.(done.pointerId)) list.releasePointerCapture(done.pointerId);
  list.classList.remove('reordering'); list.querySelector('.frame-drop')?.remove();
  if (done.kind === 'resize') {
    suppressUntil = performance.now() + 400;
    if (cancel || done.values?.every((v, i) => v === done.starts[i])) { d.renderAll(); return; }
    const ids = done.group.map(f => f.id), values = done.values;
    commit(() => { for (const f of frames()) { const i = ids.indexOf(f.id); if (i >= 0) f.duration = values[i]; } st().previewTime = 0; });
  } else if (done.kind === 'move') {
    suppressUntil = performance.now() + 400;
    const order = frames().map(f => f.id), next = moveFrames(frames(), done.ids, done.to ?? order.length).map(f => f.id);
    if (cancel || next.join() === order.join()) { d.renderAll(); return; }
    commit(() => { const animation = d.currentAnimation(); animation.frames = moveFrames(animation.frames, done.ids, done.to); st().previewIndex = animation.frames.findIndex(f => f.id === st().frameId); });
  }
}

export function initTimeline(deps) {
  d = deps;
  const list = d.$('frame-list');
  list.addEventListener('pointerdown', onPointerDown);
  list.addEventListener('pointermove', onPointerMove);
  list.addEventListener('pointerup', event => endDrag(event));
  list.addEventListener('pointercancel', event => endDrag(event, true));
  list.addEventListener('lostpointercapture', event => { if (drag && drag.kind !== 'pending') endDrag(event); });
  list.addEventListener('click', event => {
    const card = event.target.closest('.frame-card');
    if (performance.now() < suppressUntil) return;
    if (card) { d.finishDrawing(); select(card.dataset.frame, event); d.$('frame-list').querySelector('.frame-card.selected')?.focus({ preventScroll: true }); }
  });
  list.addEventListener('contextmenu', event => {
    const card = event.target.closest('.frame-card');
    if (!card) return;
    event.preventDefault();
    if (!sel.has(card.dataset.frame)) select(card.dataset.frame, {});
    openMenu(event.clientX, event.clientY);
  });
  list.addEventListener('keydown', event => {
    if (drag && event.key === 'Escape') { event.preventDefault(); endDrag(null, true); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && event.target.closest('.frame-card')) { event.preventDefault(); frameAction('delete'); }
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { const r = event.target.getBoundingClientRect(); event.preventDefault(); openMenu(r.left, r.bottom); }
  });
  window.addEventListener('keydown', event => { if (drag && drag.kind !== 'pending' && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); endDrag(null, true); } }, true);
  d.$('frame-ruler').addEventListener('click', event => { const cell = event.target.closest('[data-index]'); if (cell) d.selectFrameAt(Number(cell.dataset.index)); });
  d.$('timeline-view').addEventListener('click', event => {
    const button = event.target.closest('[data-view]');
    if (!button || button.dataset.view === view) return;
    view = button.dataset.view;
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* not remembered */ }
    renderFrameCards();
    d.$('frame-list').querySelector('.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  d.$('timing-menu').onclick = () => { const r = d.$('timing-menu').getBoundingClientRect(); openMenu(r.left, r.bottom + 4, true); };
  d.$('loop-badge').onclick = () => frameAction('loop', null);
}
