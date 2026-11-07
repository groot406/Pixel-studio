/** Guided tours (spotlight + card), the one-time tour offer and first-use hint bubbles. Content lives in onboarding.js. */
import { TOURS, HINTS, resolveStep, readOnboarding, updateOnboarding, placeCard } from './onboarding.js';
import { playDemo } from './demos.js';
import { alertToast } from './safety.js';

let d, run = null, hint = null;
const storage = () => { try { return globalThis.localStorage; } catch { return null; } };
/** Stored tour/hint progress. */
export const progress = () => readOnboarding(storage());
export const saveProgress = change => updateOnboarding(storage(), change);
export const tourActive = () => !!run;

const visible = el => {
  if (!el?.isConnected || el.closest('[hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
};
const clipRect = (r, pad) => {
  const left = Math.max(4, r.left - pad), top = Math.max(4, r.top - pad);
  const right = Math.min(innerWidth - 4, r.right + pad), bottom = Math.min(innerHeight - 4, r.bottom + pad);
  return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
};

/** Open collapsed sidebars, the timeline and closed <details> around `el`; `undo` collects how to put them back. */
function reveal(el, undo) {
  const bench = document.querySelector('.workbench'), click = id => d.$(id)?.click();
  for (const [panel, cls, button] of [['#tools-panel', 'tools-collapsed', 'toggle-tools-panel'], ['#details-panel', 'details-collapsed', 'toggle-details-panel'], ['.timeline', 'timeline-collapsed', 'toggle-timeline']]) {
    if (!el.closest(panel) || !bench?.classList.contains(cls)) continue;
    click(button); undo.push(() => { if (!bench.classList.contains(cls)) click(button); });
  }
  for (let details; (details = el.closest('details:not([open])'));) { details.open = true; undo.push(() => { details.open = false; }); }
}
/** Scroll the panels around `el` (and, last, the page) so it is in view; undo restores the scroll positions. */
function scrollIntoPanels(el, undo) {
  const remember = box => { if (!box.dataset.tourScroll) { const top = box.scrollTop; box.dataset.tourScroll = '1'; undo.unshift(() => { box.scrollTop = top; delete box.dataset.tourScroll; }); } };
  for (let box = el.parentElement; box && box !== document.body; box = box.parentElement) {
    if (!/(auto|scroll)/.test(getComputedStyle(box).overflowY) || box.scrollHeight <= box.clientHeight) continue;
    remember(box);
    const r = el.getBoundingClientRect(), b = box.getBoundingClientRect(), top = Math.max(b.top, 0) + 8, bottom = Math.min(b.bottom, innerHeight) - 8;
    if (r.top < top || r.height > bottom - top) box.scrollTop -= top - r.top;
    else if (r.bottom > bottom) box.scrollTop += r.bottom - bottom;
  }
  const page = document.scrollingElement, r = el.getBoundingClientRect();
  if (page && (r.bottom > innerHeight - 4 || r.top < 8)) { remember(page); page.scrollTop += r.top < 8 || r.height > innerHeight ? r.top - 8 : r.bottom - innerHeight + 8; }
}

function buildTour() {
  const root = document.createElement('div');
  root.className = 'tour-root';
  root.innerHTML = `<div class="tour-block"></div><div class="tour-spot" aria-hidden="true"></div>
    <section class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text" tabindex="-1">
      <div class="tour-demo onb-demo-box" hidden></div><p class="tour-eyebrow"></p><h2 id="tour-title"></h2><p id="tour-text"></p>
      <div class="tour-actions"><button type="button" class="text-button tour-skip">Skip tour</button><span class="tour-dots" aria-hidden="true"></span>
      <button type="button" class="button small tour-back">Back</button><button type="button" class="button small primary tour-next">Next</button></div>
    </section><p class="sr-only" aria-live="polite"></p>`;
  root.querySelector('.tour-skip').onclick = () => endTour(false);
  root.querySelector('.tour-back').onclick = () => go(-1);
  root.querySelector('.tour-next').onclick = () => go(1);
  root.querySelector('.tour-block').onclick = () => { const card = root.querySelector('.tour-card'); card.classList.remove('nudge'); void card.offsetWidth; card.classList.add('nudge'); };
  return root;
}

/** Start tour `id` (ends any running tour, closes dialogs, hides hints). */
export function startTour(id) {
  const tour = TOURS.find(t => t.id === id);
  if (!tour) return;
  if (d.state.inPlaceEdit) { d.toast('Apply or cancel the edit on the canvas first, then start the tour.'); return; }
  if (run) endTour(false);
  if (d.$('modal').open) d.$('modal').close();
  dismissHint();
  run = { tour, index: -1, el: null, undo: [], opener: document.activeElement, root: buildTour(), frame: 0, pageTop: document.scrollingElement?.scrollTop || 0 };
  const first = resolveStep(tour.steps, 0, 1, find);
  if (!first) { run = null; d.toast('That tour needs panels that are not available right now.'); return; }
  document.body.append(run.root);
  document.body.classList.add('tour-running');
  addEventListener('keydown', onKey, true);
  addEventListener('resize', schedule);
  addEventListener('scroll', schedule, true);
  run.observer = new ResizeObserver(schedule);
  run.observer.observe(document.body);
  show(first);
  requestAnimationFrame(() => run?.root.classList.add('on'));
}
/** End the running tour; `completed` records it as done. */
export function endTour(completed = false) {
  if (!run) return;
  const { tour, root, undo, opener, observer } = run;
  run = null;
  removeEventListener('keydown', onKey, true);
  removeEventListener('resize', schedule);
  removeEventListener('scroll', schedule, true);
  observer.disconnect();
  root.remove();
  document.body.classList.remove('tour-running');
  undo.reverse().forEach(fn => fn());
  if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
  if (completed) {
    saveProgress(p => { p.tours[tour.id] = Date.now(); });
    d.toast(tour.id === 'basics' ? 'That’s the basics! Press ? for more tours and every shortcut.' : `${tour.title} tour complete.`);
  }
}

const find = selector => {
  const el = document.querySelector(selector);
  if (!el || el.closest('[hidden]')) return null;
  reveal(el, run.undo);
  return visible(el) ? el : null;
};
const exists = selector => { const el = document.querySelector(selector); return el && !el.closest('[hidden]'); };
function go(dir) {
  const next = resolveStep(run.tour.steps, run.index + dir, dir, find);
  if (next) show(next); else if (dir > 0) endTour(true);
}
function show({ index, selector }) {
  const { tour, root } = run, step = tour.steps[index], card = root.querySelector('.tour-card');
  run.index = index;
  run.el = selector && document.querySelector(selector);
  if (document.scrollingElement) document.scrollingElement.scrollTop = run.pageTop;
  if (run.el) scrollIntoPanels(run.el, run.undo);
  const last = !resolveStep(tour.steps, index + 1, 1, exists);
  root.querySelector('.tour-eyebrow').textContent = `${tour.title} · ${index + 1} of ${tour.steps.length}`;
  root.querySelector('#tour-title').textContent = step.title;
  root.querySelector('#tour-text').textContent = step.text;
  root.querySelector('.tour-dots').innerHTML = tour.steps.map((_, i) => `<i class="${i === index ? 'on' : i < index ? 'done' : ''}"></i>`).join('');
  root.querySelector('.tour-back').disabled = !resolveStep(tour.steps, index - 1, -1, exists);
  root.querySelector('.tour-next').textContent = last ? 'Done' : 'Next';
  playDemo(root.querySelector('.tour-demo'), step.demo);
  root.querySelector('[aria-live]').textContent = `Step ${index + 1} of ${tour.steps.length}: ${step.title}.`;
  card.classList.toggle('centered', !run.el);
  position();
  run.frame = 24; settle();
  root.querySelector('.tour-next').focus({ preventScroll: true });
}
/** Keep re-measuring for a few frames while panels expand or scroll smoothly. */
function settle() { if (run && run.frame-- > 0) { position(); requestAnimationFrame(settle); } }
let queued = false;
function schedule() { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; if (run) position(); }); } }
function position() {
  const { root, el } = run, spot = root.querySelector('.tour-spot'), card = root.querySelector('.tour-card');
  const rect = el && visible(el) ? clipRect(el.getBoundingClientRect(), 6) : null;
  if (rect) Object.assign(spot.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px` });
  else Object.assign(spot.style, { left: `${innerWidth / 2}px`, top: `${innerHeight / 2}px`, width: '0px', height: '0px' });
  const at = placeCard(rect, { width: card.offsetWidth, height: card.offsetHeight }, { width: innerWidth, height: innerHeight }, { gap: 16 });
  card.style.transform = `translate(${at.x}px, ${at.y}px)`;
  card.dataset.side = at.side;
  card.style.setProperty('--arrow', `${at.arrow}px`);
}
function onKey(event) {
  const card = run.root.querySelector('.tour-card');
  if (event.key === 'Escape') endTour(false);
  else if (event.key === 'ArrowRight') go(1);
  else if (event.key === 'ArrowLeft') go(-1);
  else if (event.key === 'Tab') {
    const items = [...card.querySelectorAll('button:not(:disabled)')], at = items.indexOf(document.activeElement);
    items.at(at < 0 ? 0 : (at + (event.shiftKey ? -1 : 1)) % items.length).focus();
  } else if ((event.key === 'Enter' || event.key === ' ') && card.contains(event.target)) { event.stopImmediatePropagation(); return; }
  event.preventDefault(); event.stopImmediatePropagation();
}

/** Show the one-time "Take the tour" offer (after the first project opens from the Welcome screen). */
export function offerTour() {
  const p = progress();
  if (p.offered || p.tours.basics || run) return;
  saveProgress(next => { next.offered = true; });
  setTimeout(() => alertToast('New here? A one-minute tour shows the essentials.', [['Take the tour', () => startTour('basics')], ['Not now', () => d.toast('Press ? any time for tours and shortcuts.')]], 25000), 700);
}

/** Show hint `id` next to `anchor` once ever; never during a tour or while another hint is open. */
export function showHint(id, anchor, order = ['bottom', 'top', 'right', 'left']) {
  if (!HINTS[id] || run || hint || d.state.inPlaceEdit || !visible(anchor) || progress().hints[id] || document.body.dataset.hints === 'off') return;
  saveProgress(p => { p.hints[id] = Date.now(); });
  const box = document.createElement('div');
  box.className = 'onb-hint';
  box.setAttribute('role', 'status');
  box.innerHTML = `<strong>${d.escapeHTML(HINTS[id].title)}</strong><p>${d.escapeHTML(HINTS[id].text)}</p><button type="button" class="button small primary">Got it</button>`;
  box.querySelector('button').onclick = dismissHint;
  (anchor.closest('dialog[open]') || document.body).append(box);
  const place = () => {
    if (!visible(anchor)) { dismissHint(); return; }
    box.style.left = box.style.top = '0px';
    const origin = box.getBoundingClientRect(), r = anchor.getBoundingClientRect();
    const at = placeCard(r, { width: box.offsetWidth, height: box.offsetHeight }, { width: innerWidth, height: innerHeight }, { gap: 10, order });
    Object.assign(box.style, { left: `${at.x - origin.left}px`, top: `${at.y - origin.top}px` });
    box.dataset.side = at.side; box.style.setProperty('--arrow', `${at.arrow}px`);
  };
  hint = { box, timer: setInterval(place, 400) };
  place();
}
export function dismissHint() {
  if (!hint) return;
  clearInterval(hint.timer); hint.box.remove(); hint = null;
}

/** Watch for the first use of complex features and wire the tour runner to the editor. */
export function initOnboarding(deps) {
  d = deps;
  const $ = d.$, later = fn => setTimeout(fn, 350);
  const watch = (el, attributeFilter, fn) => el && new MutationObserver(fn).observe(el, { attributes: true, attributeFilter });
  watch($('motion-bar'), ['hidden'], () => { if (!$('motion-bar').hidden) later(() => showHint('motion', $('motion-bar'))); });
  watch($('rig-bar'), ['hidden'], () => { if (!$('rig-bar').hidden) later(() => showHint('skeleton', $('rig-bar'))); });
  watch($('curve-options'), ['hidden'], () => { if (!$('curve-options').hidden) later(() => showHint('curve', $('curve-options'))); });
  watch($('modal'), ['class'], () => { if ($('modal').classList.contains('palette-studio-modal')) later(() => showHint('palette-studio', $('modal').querySelector('.ps-tabs'))); });
  new MutationObserver(records => {
    const panel = records.flatMap(r => [...r.addedNodes]).find(n => n.classList?.contains('floating-panel'));
    if (panel) later(() => showHint('floating', panel, ['left', 'right', 'bottom', 'top']));
  }).observe(document.body, { childList: true });
  $('edit-scope')?.addEventListener('click', () => later(() => showHint('edit-scope', $('edit-scope'))));
}
