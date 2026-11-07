/** Help center (tours, searchable shortcut sheet, what's new, docs, settings) and rich tooltips. */
import { TOURS, TIPS, WHATS_NEW, DOCS, DOCS_URL, groupShortcuts, placeCard } from './onboarding.js';
import { startTour, progress, saveProgress, dismissHint } from './tour.js';
import { playDemo } from './demos.js';

let d, tip = null, tipTimer = 0, tipFor = null, hover = null;
const TABS = [['tours', 'Tours'], ['shortcuts', 'Shortcuts'], ['new', 'What’s new'], ['docs', 'Docs']];
/** "⌘/Ctrl + Z" → keycaps; a lone + or / between keys is a separator and "(Mode)" a note. */
const keycaps = keys => keys.split(' ').map((k, i) => i % 2 && (k === '+' || k === '/') ? `<span>${k}</span>` : k.startsWith('(') ? `<small>${d.escapeHTML(k)}</small>` : `<kbd>${d.escapeHTML(k)}</kbd>`).join('');

/** Open the help center on `tab` ('tours' | 'shortcuts' | 'new' | 'docs'). */
export function openHelpCenter(tab = 'tours') {
  dismissHint(); hideTip();
  d.openDialog('Help & tours', `<div class="help-center"><div class="export-tabs help-tabs" role="tablist" aria-label="Help sections">${TABS.map(([id, label]) => `<button type="button" class="export-tab" role="tab" id="help-tab-${id}" data-tab="${id}" aria-controls="help-pane-${id}" aria-selected="false">${label}</button>`).join('')}</div>${TABS.map(([id]) => `<div class="help-pane" id="help-pane-${id}" role="tabpanel" aria-labelledby="help-tab-${id}" hidden></div>`).join('')}
    <div class="help-settings"><label class="check-row"><input type="checkbox" id="help-rich-tips"${progress().tooltips ? ' checked' : ''}> Rich tooltips with demos</label><button type="button" class="text-button" id="help-reset">Reset tips &amp; tours</button></div></div>`, 'HELP');
  const modal = d.$('modal'), root = modal.querySelector('.help-center');
  modal.classList.add('help-modal');
  renderTours(); renderNew(); renderDocs();
  d.$('help-pane-shortcuts').innerHTML = `<input type="search" class="help-search" id="help-search" placeholder="Search: a key (b, ?) or an action (frame, zoom…)" aria-label="Search shortcuts" autocomplete="off"><div class="help-shortcuts" aria-live="polite"></div>`;
  const search = d.$('help-search');
  search.oninput = () => renderShortcuts(search.value);
  renderShortcuts('');
  const select = id => {
    for (const button of root.querySelectorAll('[role="tab"]')) { const on = button.dataset.tab === id; button.setAttribute('aria-selected', on); button.tabIndex = on ? 0 : -1; }
    for (const pane of root.querySelectorAll('.help-pane')) pane.hidden = pane.id !== `help-pane-${id}`;
  };
  root.querySelector('.help-tabs').onclick = event => { const button = event.target.closest('[data-tab]'); if (button) select(button.dataset.tab); };
  root.querySelector('.help-tabs').onkeydown = event => {
    const dir = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!dir) return;
    const ids = TABS.map(t => t[0]), next = ids[(ids.indexOf(event.target.dataset.tab) + dir + ids.length) % ids.length];
    select(next); d.$(`help-tab-${next}`).focus();
  };
  root.onclick = event => {
    const tour = event.target.closest('[data-tour]')?.dataset.tour;
    if (tour) startTour(tour);
  };
  d.$('help-rich-tips').onchange = event => setRichTips(event.target.checked);
  d.$('help-reset').onclick = () => {
    saveProgress(p => { p.tours = {}; p.hints = {}; p.offered = false; });
    renderTours(); d.toast('Tips and tours reset: first-use hints will show again.');
  };
  select(tab);
  (tab === 'shortcuts' ? search : d.$(`help-tab-${tab}`)).focus();
}
function renderTours() {
  const done = progress().tours;
  d.$('help-pane-tours').innerHTML = `<p class="modal-body-text">Short spotlight tours of the real interface. Use ← → to step, Esc to stop.</p><ul class="help-tours">${TOURS.map(t => `<li class="${done[t.id] ? 'done' : ''}"><span class="help-tick" aria-hidden="true">${done[t.id] ? '✓' : ''}</span><span class="help-tour-text"><strong>${d.escapeHTML(t.title)}</strong><small>${d.escapeHTML(t.summary)} · ${t.steps.length} steps${done[t.id] ? ' · done' : ''}</small></span><button type="button" class="button small${done[t.id] ? '' : ' primary'}" data-tour="${t.id}">${done[t.id] ? 'Replay' : 'Start'}</button></li>`).join('')}</ul>
    <div class="notice"><strong>Quick guide</strong><p>Right-click erases. Each project tab has its own artwork and Undo history and autosaves on this device. Collapse panel headings, hide either sidebar with the buttons above the canvas, or pop a panel out with ⇱.</p></div>`;
}
function renderShortcuts(query) {
  const groups = groupShortcuts(query);
  document.querySelector('#modal .help-shortcuts').innerHTML = groups.length ? groups.map(g => `<section class="help-group"><h3>${g.label}</h3><div class="shortcut-grid">${g.items.map(s => `<span>${d.escapeHTML(s.action)}</span><span class="help-keys">${keycaps(s.keys)}</span>`).join('')}</div></section>`).join('') : `<p class="helper-text">No shortcut matches “${d.escapeHTML(query)}”.</p>`;
}
function renderNew() {
  d.$('help-pane-new').innerHTML = `<ul class="help-news">${WHATS_NEW.map(n => `<li><strong>${d.escapeHTML(n.title)}</strong><p>${d.escapeHTML(n.text)}</p>${n.tour ? `<button type="button" class="text-button" data-tour="${n.tour}">Show me →</button>` : ''}</li>`).join('')}</ul>`;
}
function renderDocs() {
  d.$('help-pane-docs').innerHTML = `<p class="modal-body-text">The README covers every feature in depth.</p><ul class="help-docs">${DOCS.map(([label, anchor]) => `<li><a href="${DOCS_URL}${anchor}" target="_blank" rel="noopener">${d.escapeHTML(label)} ↗</a></li>`).join('')}<li><a href="${DOCS_URL}/blob/main/docs/architecture.md" target="_blank" rel="noopener">Architecture (for developers) ↗</a></li></ul>`;
}

/* Rich tooltips: one shared bubble; each tipped element's title moves to data-native-title so only one tooltip shows. */
const tipOf = el => { for (const [i, t] of TIPS.entries()) { const hit = el?.closest?.(t.sel); if (hit) return { hit, t, i }; } return null; };
const describe = (t, el) => `${t.name}${t.keys ? ` (${t.keys})` : ''}. ${t.text ?? el.dataset.nativeTitle ?? ''}`;
/** Move `el`'s native title aside and link it to its hidden description. */
function adopt(el, t, i) {
  if (el.title) { el.dataset.nativeTitle = el.title; el.removeAttribute('title'); }
  let desc = document.getElementById(`tip-desc-${i}`);
  if (!desc) { desc = document.createElement('span'); desc.id = `tip-desc-${i}`; desc.hidden = true; document.body.append(desc); }
  desc.textContent = describe(t, el);
  const ids = (el.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
  if (!ids.includes(desc.id)) el.setAttribute('aria-describedby', [...ids, desc.id].join(' '));
}
function release(el, t, i) {
  if (el.dataset.nativeTitle !== undefined) { el.title = el.dataset.nativeTitle; delete el.dataset.nativeTitle; }
  const ids = (el.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== `tip-desc-${i}`);
  ids.length ? el.setAttribute('aria-describedby', ids.join(' ')) : el.removeAttribute('aria-describedby');
}
const each = fn => TIPS.forEach((t, i) => document.querySelectorAll(t.sel).forEach(el => fn(el, t, i)));
const tipsOn = () => document.body.dataset.richTips !== 'off';
/** Turn rich tooltips on or off (stored). */
export function setRichTips(on) {
  saveProgress(p => { p.tooltips = on; });
  document.body.dataset.richTips = on ? 'on' : 'off';
  hideTip();
  each(on ? adopt : release);
}
function showTip(el, t, i) {
  if (!tipsOn() || document.body.classList.contains('tour-running')) return;
  adopt(el, t, i);
  tipFor = el;
  tip.innerHTML = `<div class="onb-demo-box" hidden></div><div class="rich-tip-head"><strong>${d.escapeHTML(t.name)}</strong>${t.keys ? `<span class="help-keys">${keycaps(t.keys)}</span>` : ''}</div><p>${d.escapeHTML(t.text ?? el.dataset.nativeTitle ?? '')}</p>`;
  playDemo(tip.querySelector('.onb-demo-box'), t.demo);
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const at = placeCard(r, { width: tip.offsetWidth, height: tip.offsetHeight }, { width: innerWidth, height: innerHeight }, { gap: 8, margin: 8, order: el.closest('#tools-panel') ? ['right', 'bottom', 'top', 'left'] : ['bottom', 'top', 'right', 'left'] });
  tip.style.transform = `translate(${at.x}px, ${at.y}px)`;
  tip.dataset.side = at.side;
  tip.style.setProperty('--arrow', `${at.arrow}px`);
  requestAnimationFrame(() => tip.classList.add('on'));
}
function hideTip() {
  clearTimeout(tipTimer); tipFor = null;
  if (tip) { tip.classList.remove('on'); tip.hidden = true; tip.innerHTML = ''; }
}

/** Wire the help center and rich tooltips to the editor. */
export function initHelpCenter(deps) {
  d = deps;
  tip = document.createElement('div');
  tip.className = 'rich-tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
  document.body.append(tip);
  const on = progress().tooltips;
  document.body.dataset.richTips = on ? 'on' : 'off';
  if (on) each(adopt);
  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch' || !tipsOn()) return;
    const found = tipOf(event.target), el = found?.hit || null;
    if (el === hover) return;
    hideTip(); hover = el;
    if (found) { adopt(el, found.t, found.i); tipTimer = setTimeout(() => el.isConnected && showTip(el, found.t, found.i), 400); }
  });
  document.addEventListener('pointerout', event => { if (hover && !hover.contains(event.relatedTarget)) { hover = null; hideTip(); } });
  document.addEventListener('focusin', event => { const found = tipOf(event.target); hideTip(); if (found && found.hit === event.target && event.target.matches(':focus-visible')) showTip(found.hit, found.t, found.i); });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && tipFor) hideTip(); }, true);
  addEventListener('scroll', () => tipFor && hideTip(), true);
  // Some titles change with state (Edit switch, panel toggles); keep moving them aside.
  new MutationObserver(records => {
    if (!tipsOn()) return;
    for (const { target } of records) if (target.title) { const found = tipOf(target); if (found?.hit === target) adopt(target, found.t, found.i); }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['title'] });
}
