/**
 * Live bridge between the open editor and external AI agents (MCP server → Pixel Studio Local → this tab).
 * Only active when served by Pixel Studio Local: subscribes to /api/bridge/events (SSE) and answers tool requests.
 */
import { decodeAIProject, encodeAIProject } from '../formats/pxa.js';
import { openConnectDialog } from './connect-dialog.js';

const CONSENT_MS = 25000;
let deps, connection = null, allowed = false, consent = null, chip = null, source = null, retry = 0;

/**
 * deps: { getProject() → {project, animationId, frameId}, applyProject(project, {mode, message}) → string,
 *         toast(msg), openDialog(title, html, eyebrow), escapeHTML }
 */
export function initEditorBridge(options) {
  deps = options;
  document.addEventListener('click', event => {
    if (event.target.closest?.('[data-connect-agent]')) { event.preventDefault(); openConnectDialog({ ...deps, status: connection }); }
  });
  if (location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname)) connect();
}

async function connect() {
  try {
    const response = await fetch('./api/local-ai/status', { cache: 'no-store', credentials: 'same-origin' });
    const status = response.ok ? await response.json() : null;
    if (!status?.local || !status.bridge || !status.csrfToken) return;
    connection = status;
  } catch { return; }
  subscribe();
}

function subscribe() {
  source?.close();
  source = new EventSource(`./api/bridge/events?token=${encodeURIComponent(connection.csrfToken)}`);
  source.addEventListener('hello', event => { retry = 0; showChip(JSON.parse(event.data).agent); });
  source.addEventListener('agent', event => showChip(JSON.parse(event.data).active));
  source.addEventListener('request', event => handle(JSON.parse(event.data)));
  source.onerror = () => {
    if (source.readyState !== EventSource.CLOSED) return; // the browser retries by itself
    showChip(false);
    // Closed for good (server restarted with a new token): fetch a fresh token after a backoff.
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 1000 * 2 ** retry);
  };
}

async function reply(id, payload) {
  try {
    await fetch('./api/bridge/reply', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-pixel-studio-token': connection.csrfToken },
      body: JSON.stringify({ id, ...payload }),
    });
  } catch { /* the agent sees a timeout */ }
}

async function handle({ id, tool, args = {} }) {
  try {
    if (tool === 'get_project') {
      const { project, animationId, frameId } = deps.getProject();
      await reply(id, { result: { pxa: encodeAIProject(project, { version: 2 }), name: project.name, animationId, frameId } });
    } else if (tool === 'apply_project') {
      if (typeof args.pxa !== 'string') throw Object.assign(new Error('apply_project needs PXA text.'), { code: 'INVALID_ARGS' });
      const project = decodeAIProject(args.pxa);
      if (!(await askPermission(args.message))) throw Object.assign(new Error('The user did not allow agent edits in Pixel Studio. Ask them to click Allow in the editor, then retry.'), { code: 'DENIED' });
      const message = deps.applyProject(project, { mode: args.mode === 'new-tab' ? 'new-tab' : 'replace', message: String(args.message || '').slice(0, 200) });
      await reply(id, { result: { message } });
    } else throw Object.assign(new Error(`The editor does not support "${tool}".`), { code: 'UNKNOWN_TOOL' });
  } catch (error) {
    await reply(id, { error: error.message || 'The editor could not handle this request.', code: error.code || 'EDITOR_ERROR' });
  }
}

/** Ask once per page session before an agent changes the artwork (non-blocking card with Allow/Deny). */
function askPermission(message) {
  if (allowed) return Promise.resolve(true);
  if (consent) return consent;
  consent = new Promise(resolve => {
    const card = document.createElement('div');
    card.className = 'bridge-consent';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-label', 'AI agent wants to edit');
    card.innerHTML = `<p><strong>An AI agent wants to change your artwork.</strong>${message ? `<br><span>${deps.escapeHTML(String(message).slice(0, 200))}</span>` : ''}<br><small>Each change is one undo step. Allow agent edits for this session?</small></p><div class="bridge-consent-actions"><button type="button" class="button small" data-deny>Deny</button><button type="button" class="button small primary" data-allow>Allow</button></div>`;
    const done = ok => { clearTimeout(timer); card.remove(); consent = null; if (ok) allowed = true; resolve(ok); };
    const timer = setTimeout(() => done(false), CONSENT_MS);
    card.querySelector('[data-allow]').onclick = () => done(true);
    card.querySelector('[data-deny]').onclick = () => done(false);
    document.body.append(card);
    card.querySelector('[data-allow]').focus({ preventScroll: true });
  });
  return consent;
}

function showChip(active) {
  if (!chip) {
    chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'bridge-chip';
    chip.dataset.connectAgent = '';
    document.querySelector('.header-actions')?.prepend(chip);
  }
  chip.hidden = !active;
  chip.innerHTML = '<span class="bridge-dot" aria-hidden="true"></span><span>AI agent connected</span>';
  chip.title = 'An AI agent (MCP) is using this editor. Click for connection details.';
}
