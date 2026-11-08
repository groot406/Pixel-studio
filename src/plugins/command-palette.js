/**
 * Quick command palette (Ctrl/⌘ + K): searches the editor's own buttons (header, tools, effects, animate, frames) and
 * plugin effects and commands. Built-in entries are read from the page, so they always match what the buttons do.
 */
import { pluginPaletteCommands } from './editor.js';

let d, dialog = null;
const extraSources = [];

/** Let editor modules add commands (e.g. workspace views); `source()` returns palette items. */
export function registerCommandSource(source) { extraSources.push(source); }
const SOURCES = [
  ['.header-actions button, .project-tabs-bar > button', 'App'],
  ['[data-tool]', 'Tool'],
  ['.effects-section .object-action-list:not([aria-label="Plugin effects and commands"]) .object-action', 'Effect'],
  ['.animate-section .object-action, [data-panel="animate"] .object-action', 'Animate'],
  ['#add-frame, #duplicate-frame, #delete-frame, #play-toggle, #add-animation', 'Frames'],
];

const labelOf = el => (el.querySelector('strong')?.textContent || el.getAttribute('aria-label') || el.title || el.textContent).trim().replace(/\s+/g, ' ');
const hintOf = el => (el.querySelector('small')?.textContent || (el.title !== labelOf(el) ? el.title : '') || '').trim();

function builtIns() {
  const seen = new Set(), out = [];
  for (const [selector, group] of SOURCES) for (const el of document.querySelectorAll(selector)) {
    if (seen.has(el) || el.closest('#modal') || !el.isConnected) continue;
    seen.add(el);
    const title = labelOf(el);
    if (!title) continue;
    out.push({ key: el.id || `${group}:${title}`, title, description: hintOf(el) || group, group, disabled: el.disabled ? (el.title || 'Not available right now') : '', run: () => el.click() });
  }
  return out;
}

/** Every command the palette offers: the editor's own buttons plus plugin effects and commands. Also used by the assistant. */
export function commandItems() {
  return [
    ...builtIns(),
    { key: 'plugins-manager', title: 'Plugins & skills', description: 'Install, enable and write plugins', group: 'App', disabled: '', run: () => d.openPluginManager() },
    ...pluginPaletteCommands().map(c => ({ ...c, group: 'Plugin' })),
    ...extraSources.flatMap(source => source()),
  ];
}

export function initCommandPalette(deps) {
  d = deps;
  window.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return;
    if (d.$('modal').open && !dialog?.open) return;
    event.preventDefault(); event.stopPropagation();
    if (dialog?.open) dialog.close(); else openCommandPalette();
  }, true);
}

export function openCommandPalette() {
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.className = 'command-palette';
    dialog.setAttribute('aria-label', 'Command palette');
    dialog.innerHTML = '<input id="command-palette-input" type="search" placeholder="Type a command or plugin…" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="command-palette-list" aria-autocomplete="list"><ul id="command-palette-list" role="listbox" aria-label="Commands"></ul><p class="command-palette-foot"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Enter</kbd> run · <kbd>Esc</kbd> close</p>';
    document.body.append(dialog);
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  }
  const input = dialog.querySelector('input'), list = dialog.querySelector('ul');
  const items = commandItems();
  let shown = [], active = 0;
  const draw = () => {
    const q = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    shown = items.filter(item => q.every(word => `${item.title} ${item.description} ${item.group}`.toLowerCase().includes(word))).slice(0, 60);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.innerHTML = shown.length ? shown.map((item, i) => `<li id="cmd-${i}" role="option" data-index="${i}" aria-selected="${i === active}" aria-disabled="${Boolean(item.disabled)}"${item.disabled ? ` title="${d.escapeHTML(item.disabled)}"` : ''}><span class="command-group">${d.escapeHTML(item.group)}</span><strong>${d.escapeHTML(item.title)}</strong><small>${d.escapeHTML(item.disabled || item.description)}</small></li>`).join('') : '<li class="command-empty" role="presentation">No matching commands.</li>';
    input.setAttribute('aria-activedescendant', shown.length ? `cmd-${active}` : '');
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  const run = index => {
    const item = shown[index];
    if (!item) return;
    if (item.disabled) { d.toast(item.disabled); return; }
    dialog.close();
    item.run();
  };
  input.value = ''; active = 0;
  input.oninput = () => { active = 0; draw(); };
  input.onkeydown = event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); active = (active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length); draw(); }
    else if (event.key === 'Enter') { event.preventDefault(); run(active); }
  };
  list.onclick = event => { const li = event.target.closest('[data-index]'); if (li) run(Number(li.dataset.index)); };
  draw();
  dialog.showModal();
  input.focus();
}
