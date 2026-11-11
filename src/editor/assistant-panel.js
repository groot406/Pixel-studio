/**
 * The assistant panel: a floating chat that answers questions about the open project and edits it with the editor's
 * tools (src/features/assistant/agent.js). Every change it makes is a normal undo step; a reply's changes can be
 * undone together from its bubble.
 */
import { runTurn } from '../features/assistant/agent.js';
import { localStatus, codexProvider, openaiProvider, OPENAI_DEFAULT_MODEL } from '../features/assistant/providers.js';
import { renderPngBytes } from '../domain/project-ops.js';
import { commandItems } from '../plugins/command-palette.js';
import { keyFor, rememberKey, hasStoredKey } from './ai-image-dialog.js';

let d, panel, busy = null, connection;
const PREFS_KEY = 'pixel-studio.assistant';
const chats = new Map();
const prefs = Object.assign({ model: '', openaiModel: OPENAI_DEFAULT_MODEL, picture: true, open: false, x: null, y: null, w: 400, h: 600 }, readPrefs());
const SUGGESTIONS = [
  'What is in this project?',
  'Rig this character so I can animate it',
  'Add a walk cycle',
  'Remove the baked outline and use a live outline',
  'Give it a warmer palette',
  'Draw a small treasure chest in a new tab',
];
const TOOL_LABELS = { read_pxa: 'Read the project', write_pxa: 'Edited the artwork', new_tab: 'Opened a new project', make_parts: 'Made parts & rig', animate: 'Animated', edit_animation: 'Changed an animation', outline: 'Outline', set_palette: 'Palette', palette_presets: 'Palette presets', select: 'Selected', run_command: 'Ran a command', undo: 'Undo', look: 'Looked at the artwork' };

function readPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; } }
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } }
const chat = () => { const id = d.state.documentId || 'none'; if (!chats.has(id)) chats.set(id, []); return chats.get(id); };
const esc = value => d.escapeHTML(String(value ?? ''));

function bytesToDataUrl(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}

/** PNG data URL of a render, scaled down to fit 1024 px (the local service's preview limit). */
async function render(options) {
  const r = await renderPngBytes(d.state.project, options);
  let url = bytesToDataUrl(r.png);
  if (r.width <= 1024 && r.height <= 1024 && r.png.length < 900_000) return url;
  const img = new Image();
  img.src = url;
  await img.decode();
  const k = Math.min(1024 / r.width, 1024 / r.height, 1), canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(r.width * k)); canvas.height = Math.max(1, Math.floor(r.height * k));
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  url = canvas.toDataURL('image/png');
  return url;
}

/** The editor seen through the agent's ctx interface. */
function editorContext() {
  const s = d.state;
  return {
    project: () => s.project,
    view: () => {
      const o = s.objectSelection;
      return { animationId: d.currentAnimation().id, frameId: d.currentFrame().id, layerId: d.currentLayer().id, tool: s.tool, color: s.color, ...(o ? { selectedObject: { layer: o.layerId, key: o.key } } : {}) };
    },
    commit: project => {
      const top = s.undo.at(-1);
      d.mutate(() => { s.project = project; });
      // Counted by the history top (not its length, which is capped) so "Undo these changes" stays exact.
      if (busy && s.undo.at(-1) !== top) { busy.reply.changes += 1; busy.reply.top = s.undo.at(-1); }
    },
    select: ({ animationId, frameId, layerId, color, tool }) => {
      if (animationId) { s.animationId = animationId; s.frameId = frameId || null; s.previewIndex = 0; }
      else if (frameId) s.frameId = frameId;
      if (layerId) s.layerId = layerId;
      if (color !== undefined) s.color = color;
      if (tool) {
        const button = document.querySelector(`[data-tool="${CSS.escape(tool)}"]`);
        if (!button) throw new Error(`No tool "${tool}". Tools: ${[...document.querySelectorAll('[data-tool]')].map(b => b.dataset.tool).join(', ')}.`);
        button.click();
      }
      d.normalizeSelection();
      d.renderAll();
    },
    openProject: project => {
      // The conversation (and a running turn) follows the assistant into its new tab.
      const items = chat();
      d.replaceProject(project, `Opened “${project.name}”`);
      chats.set(d.state.documentId, items);
      if (busy) { busy.documentId = d.state.documentId; busy.reply.changes = 0; busy.reply.top = d.state.undo.at(-1); }
    },
    commands: () => commandItems().filter(c => c.key !== 'assistant-button'),
    runCommand: key => {
      const item = commandItems().find(c => c.key === key);
      item.run();
      const modal = d.$('modal');
      return modal?.open ? `Opened the "${(modal.querySelector('h2')?.textContent || item.title).trim()}" dialog for the user; they finish it themselves.` : `Ran "${item.title}".`;
    },
    undo: () => { d.undo(); if (busy?.reply.changes) { busy.reply.changes -= 1; busy.reply.top = s.undo.at(-1); } },
    render,
  };
}

async function connect(force = false) {
  if (connection && !force) return connection;
  connection = { kind: 'checking' };
  renderHeader();
  const local = await localStatus();
  if (local) connection = local.connected ? { kind: 'codex', ...local } : { kind: 'codex-offline', ...local, message: local.message || 'Sign in to Codex (codex login) and refresh.' };
  else connection = keyFor('openai') ? { kind: 'openai' } : { kind: 'needs-key' };
  renderHeader();
  return connection;
}

function provider() {
  if (connection?.kind === 'codex') {
    const model = connection.models.find(m => m.id === prefs.model) || connection.models[0];
    return codexProvider({ csrfToken: connection.csrfToken, model: model?.id, supportsImages: model?.supportsImages !== false, label: connection.cloud ? 'Pixel Studio Cloud' : 'Codex' });
  }
  if (connection?.kind === 'openai' || keyFor('openai')) return openaiProvider({ key: keyFor('openai'), model: prefs.openaiModel || OPENAI_DEFAULT_MODEL });
  throw new Error(connection?.kind === 'codex-offline' ? connection.message : 'Connect a model first: open the settings (gear) and add an OpenAI API key, or run Pixel Studio Local with Codex.');
}

// ---- rendering --------------------------------------------------------------------------------------------------
function formatText(text) {
  const lines = esc(text).split('\n');
  let html = '', list = false;
  for (const line of lines) {
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
    if (bullet) { if (!list) { html += '<ul>'; list = true; } html += `<li>${bullet[1]}</li>`; continue; }
    if (list) { html += '</ul>'; list = false; }
    if (line.trim()) html += `<p>${line}</p>`;
  }
  if (list) html += '</ul>';
  return html.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function stepHTML(step) {
  const label = TOOL_LABELS[step.tool] || step.tool;
  const detail = step.tool === 'read_pxa' && step.ok ? `${step.text.split('\n').length} lines of PXA` : step.text;
  return `<li class="assistant-step ${step.ok ? 'ok' : 'failed'}"><details><summary><span class="assistant-step-mark" aria-hidden="true">${step.ok ? '✓' : '!'}</span>${esc(label)}</summary><pre>${esc(detail.slice(0, 2000))}</pre></details>${step.image ? `<img src="${esc(step.image)}" alt="What the assistant saw" loading="lazy">` : ''}</li>`;
}

function messageHTML(m, index) {
  if (m.role === 'user') return `<div class="assistant-msg user"><div class="assistant-bubble">${formatText(m.text)}</div></div>`;
  const undo = m.changes && !m.undone ? `<button type="button" class="assistant-undo" data-undo="${index}">${d.icon('undo')}<span>Undo ${m.changes === 1 ? 'this change' : `these ${m.changes} changes`}</span></button>` : m.undone ? '<span class="assistant-undone">Changes undone</span>' : '';
  return `<div class="assistant-msg bot${m.error ? ' error' : ''}"><div class="assistant-bubble">${m.messages?.length > 1 ? m.messages.slice(0, -1).map(t => `<div class="assistant-interim">${formatText(t)}</div>`).join('') : ''}${formatText(m.text)}${m.steps?.length ? `<ul class="assistant-steps">${m.steps.map(stepHTML).join('')}</ul>` : ''}${m.pending ? `<p class="assistant-thinking"><span class="assistant-dots" aria-hidden="true"><i></i><i></i><i></i></span>${esc(m.status || 'Thinking…')}</p>` : ''}${undo}</div></div>`;
}

function renderMessages({ scroll = true } = {}) {
  if (!panel || panel.hidden) return;
  const list = panel.querySelector('.assistant-messages'), items = chat(), focused = list.contains(document.activeElement);
  list.innerHTML = items.length ? items.map(messageHTML).join('') : `<div class="assistant-empty"><p><strong>Ask me about this project, or tell me what to change.</strong> I can rig and animate characters, edit artwork, fix outlines, change palettes, run any editor command and draw new sprites. Every change is undoable.</p><div class="assistant-suggestions">${SUGGESTIONS.map(s => `<button type="button" class="assistant-chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;
  if (scroll) list.scrollTop = list.scrollHeight;
  if (focused) panel.querySelector('.assistant-composer textarea').focus({ preventScroll: true });
}

function renderHeader() {
  if (!panel) return;
  const status = panel.querySelector('.assistant-status'), c = connection || {};
  status.textContent = c.kind === 'codex' ? (c.cloud ? c.accountLabel || 'Pixel Studio Cloud' : 'Codex · ChatGPT') : c.kind === 'codex-offline' && c.cloud ? (c.accountLabel ? 'AI unavailable' : 'Not signed in') : c.kind === 'openai' ? `OpenAI · ${prefs.openaiModel}` : c.kind === 'checking' ? 'Connecting…' : c.kind === 'codex-offline' ? 'Codex not signed in' : 'Not connected';
  status.dataset.state = ['codex', 'openai'].includes(c.kind) ? 'on' : 'off';
  const settings = panel.querySelector('.assistant-settings');
  if (!settings.hidden) renderSettings();
  if (['needs-key', 'codex-offline'].includes(c.kind) && settings.hidden) { settings.hidden = false; renderSettings(); }
}

function renderSettings() {
  const box = panel.querySelector('.assistant-settings'), c = connection || {};
  const codex = c.kind === 'codex' ? `<label class="field"><span class="field-label">${c.cloud ? 'Model' : 'Codex model'}</span><select id="assistant-model">${c.models.map(m => `<option value="${esc(m.id)}"${m.id === prefs.model ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>` : '';
  const offline = c.kind === 'codex-offline' ? `<p class="assistant-note">${esc(c.message)} <button type="button" class="link-button" id="assistant-retry">Check again</button></p>` : '';
  const openai = c.kind === 'codex' || c.kind === 'codex-offline' ? '' : `
    <p class="assistant-note">The assistant uses your OpenAI API key from this browser (or run <code>npm start</code> for Pixel Studio Local with your Codex / ChatGPT sign-in, no key needed).</p>
    <label class="field"><span class="field-label">OpenAI API key</span><input id="assistant-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" value="${esc(keyFor('openai'))}"></label>
    <label class="field"><span class="field-label">Model</span><input id="assistant-openai-model" autocomplete="off" spellcheck="false" value="${esc(prefs.openaiModel)}"></label>
    <label class="check-row"><input type="checkbox" id="assistant-remember"${hasStoredKey('openai') ? ' checked' : ''}> Remember the key on this device</label>
    <button type="button" class="button primary" id="assistant-save-key">Save</button>`;
  box.innerHTML = `${offline}${codex}${openai}<label class="check-row"><input type="checkbox" id="assistant-picture"${prefs.picture ? ' checked' : ''}> Show the assistant the current frame with each message</label>`;
  box.querySelector('#assistant-model')?.addEventListener('change', e => { prefs.model = e.target.value; savePrefs(); });
  box.querySelector('#assistant-picture').onchange = e => { prefs.picture = e.target.checked; savePrefs(); };
  box.querySelector('#assistant-retry')?.addEventListener('click', () => connect(true));
  const save = box.querySelector('#assistant-save-key');
  if (save) save.onclick = () => {
    const key = box.querySelector('#assistant-key').value.trim(), model = box.querySelector('#assistant-openai-model').value.trim() || OPENAI_DEFAULT_MODEL;
    rememberKey('openai', key, box.querySelector('#assistant-remember').checked);
    prefs.openaiModel = model; savePrefs();
    connection = key ? { kind: 'openai' } : { kind: 'needs-key' };
    box.hidden = !!key;
    renderHeader();
    if (key) d.toast('Assistant connected to OpenAI.');
  };
}

function setBusy(on) {
  panel.querySelector('.assistant-send').hidden = on;
  panel.querySelector('.assistant-stop').hidden = !on;
  panel.querySelector('textarea').placeholder = on ? 'Working… you can keep editing' : 'Ask or tell the assistant…';
}

// ---- conversation -----------------------------------------------------------------------------------------------
async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  if (d.state.inPlaceEdit) { d.toast('Apply or cancel the canvas object edit first.'); return; }
  await connect();
  const items = chat();
  const history = items.filter(m => !m.pending && !m.error).map(m => ({ role: m.role, text: m.role === 'user' ? m.text : `${m.text}${m.steps?.length ? ` [tools used: ${m.steps.map(s => `${s.tool}${s.ok ? '' : ' (failed)'}`).join(', ')}]` : ''}` }));
  history.push({ role: 'user', text });
  items.push({ role: 'user', text });
  const reply = { role: 'bot', text: '', steps: [], messages: [], pending: true, changes: 0 };
  items.push(reply);
  renderMessages();
  const controller = new AbortController();
  busy = { controller, documentId: d.state.documentId, reply };
  setBusy(true);
  try {
    const p = provider(), ctx = editorContext();
    const initialImage = prefs.picture && p.supportsImages ? await render({ animation: ctx.view().animationId, frame: ctx.view().frameId, background: 'checker', scale: Math.max(1, Math.min(16, Math.floor(512 / Math.max(d.state.project.width, d.state.project.height)))) }).catch(() => null) : null;
    const ask = (prompt, images, signal) => p.ask(prompt, images, signal, status => { reply.status = status; renderMessages(); });
    d.versionBefore?.('Before assistant');
    const result = await runTurn({
      ctx, ask, history, signal: controller.signal, initialImage,
      onEvent: event => {
        if (d.state.documentId !== busy?.documentId) controller.abort();
        if (event.type === 'thinking') reply.status = event.step ? 'Checking the result…' : 'Thinking…';
        if (event.type === 'reply' && event.reply.message) { reply.messages.push(event.reply.message); reply.text = event.reply.message; }
        if (event.type === 'tool') { reply.steps.push({ ...event.result }); reply.status = `${TOOL_LABELS[event.action.tool] || event.action.tool}…`; }
        renderMessages();
      },
    });
    reply.text = result.message;
    reply.messages = result.messages;
  } catch (error) {
    reply.error = error?.name !== 'AbortError';
    reply.text = error?.name === 'AbortError' ? `${reply.text ? `${reply.text}\n` : ''}Stopped.` : (error?.message || 'The assistant could not answer.');
  } finally {
    reply.pending = false;
    busy = null;
    if (panel) { setBusy(false); renderMessages(); }
  }
}

function undoReply(index) {
  const m = chat()[index];
  if (!m?.changes || m.undone) return;
  const later = chat().slice(index + 1).some(x => x.changes && !x.undone);
  if (later || d.state.undo.at(-1) !== m.top || d.state.undo.length < m.changes) {
    d.toast('Other changes came after this reply. Use Undo (⌘/Ctrl Z) step by step instead.');
    return;
  }
  for (let i = 0; i < m.changes; i += 1) d.undo();
  m.undone = true;
  renderMessages({ scroll: false });
}

// ---- panel ------------------------------------------------------------------------------------------------------
function place() {
  const w = Math.min(prefs.w, innerWidth - 16), h = Math.min(prefs.h, innerHeight - 70);
  panel.style.width = `${w}px`; panel.style.height = `${h}px`;
  const x = prefs.x === null ? innerWidth - w - 16 : Math.max(8, Math.min(prefs.x, innerWidth - w - 8));
  const y = prefs.y === null ? innerHeight - h - 16 : Math.max(8, Math.min(prefs.y, innerHeight - h - 8));
  panel.style.left = `${x}px`; panel.style.top = `${y}px`;
}

function build() {
  panel = document.createElement('aside');
  panel.className = 'assistant-panel';
  panel.id = 'assistant-panel';
  panel.setAttribute('aria-label', 'Assistant');
  panel.hidden = true;
  panel.innerHTML = `
    <header class="assistant-head">
      <span class="assistant-title">${d.icon('spark')}<strong>Assistant</strong><span class="assistant-status" data-state="off"></span></span>
      <button type="button" class="icon-button" data-act="clear" title="New conversation" aria-label="New conversation">${d.icon('trash')}</button>
      <button type="button" class="icon-button" data-act="settings" title="Model and settings" aria-label="Model and settings">${d.icon('plugin')}</button>
      <button type="button" class="icon-button" data-act="close" title="Close (Esc)" aria-label="Close assistant">${d.icon('close')}</button>
    </header>
    <div class="assistant-settings" hidden></div>
    <div class="assistant-messages" role="log" aria-live="polite"></div>
    <form class="assistant-composer">
      <textarea rows="2" maxlength="8000" placeholder="Ask or tell the assistant…" aria-label="Message to the assistant"></textarea>
      <button type="submit" class="button primary assistant-send" title="Send (Enter)" aria-label="Send">${d.icon('up')}</button>
      <button type="button" class="button assistant-stop" title="Stop" aria-label="Stop" hidden>${d.icon('pause')}</button>
    </form>`;
  document.body.append(panel);
  const input = panel.querySelector('textarea');
  panel.querySelector('form').onsubmit = event => { event.preventDefault(); const text = input.value; input.value = ''; send(text); };
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); panel.querySelector('form').requestSubmit(); }
    if (event.key === 'Escape') toggle(false);
  });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape' && !busy) toggle(false); });
  // Safari doesn't focus clicked buttons; keep focus in the panel so Esc and typing keep working.
  panel.addEventListener('click', () => {
    if (!panel.hidden && !panel.contains(document.activeElement) && getSelection()?.isCollapsed !== false) input.focus({ preventScroll: true });
  });
  panel.querySelector('.assistant-stop').onclick = () => busy?.controller.abort();
  panel.addEventListener('click', event => {
    const act = event.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') toggle(false);
    if (act === 'clear' && !busy) { chat().length = 0; renderMessages(); }
    if (act === 'settings') { const box = panel.querySelector('.assistant-settings'); box.hidden = !box.hidden; if (!box.hidden) renderSettings(); }
    const chip = event.target.closest('[data-suggest]');
    if (chip) send(chip.dataset.suggest);
    const undo = event.target.closest('[data-undo]');
    if (undo) undoReply(Number(undo.dataset.undo));
  });
  // Drag by the header; resize from the corner (CSS resize) is saved too.
  const head = panel.querySelector('.assistant-head');
  head.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) return;
    const start = { x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
    head.setPointerCapture(event.pointerId);
    const move = e => { prefs.x = start.left + e.clientX - start.x; prefs.y = start.top + e.clientY - start.y; place(); };
    const up = () => { head.removeEventListener('pointermove', move); savePrefs(); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up, { once: true });
  });
  new ResizeObserver(() => {
    if (panel.hidden) return;
    prefs.w = panel.offsetWidth; prefs.h = panel.offsetHeight; savePrefs();
  }).observe(panel);
  addEventListener('resize', () => { if (!panel.hidden) place(); });
}

export function toggle(open = panel?.hidden ?? true) {
  if (!panel) build();
  panel.hidden = !open;
  prefs.open = open; savePrefs();
  d.$('assistant-button')?.setAttribute('aria-pressed', String(open));
  if (open) {
    place();
    renderMessages();
    connect();
    panel.querySelector('textarea').focus();
  }
}

/** Called after switching project tabs so the panel shows that tab's conversation. */
export function renderAssistant() {
  if (!panel || panel.hidden) return;
  if (!busy) setBusy(false);
  renderMessages({ scroll: false });
}

/** deps: state, $, icon, escapeHTML, toast, mutate, undo, renderAll, normalizeSelection, replaceProject, versionBefore,
 * currentAnimation, currentFrame, currentLayer. */
export function initAssistant(deps) {
  d = deps;
  d.$('assistant-button')?.addEventListener('click', () => toggle());
  addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'j') { event.preventDefault(); toggle(); }
  });
  if (prefs.open) toggle(true);
}
