/** "Connect an AI agent" dialog: MCP config snippets per client, skills install, and how to run the local edition. */
import { mcpSnippets, skillsCommand } from './mcp-config.js';

const REPO_URL = 'https://github.com/groot406/Pixel-studio';
const CODEX_PLUGIN_COMMANDS = 'codex plugin marketplace add groot406/Pixel-studio\ncodex plugin add pixel-studio@pixel-studio';
const CLAUDE_PLUGIN_COMMANDS = '/plugin marketplace add groot406/Pixel-studio\n/plugin install pixel-studio@pixel-studio';

/** status: the /api/local-ai/status response when served by Pixel Studio Local, else null. */
export async function openConnectDialog({ openDialog, escapeHTML, toast, status }) {
  if (status === undefined || status === null) {
    try {
      const response = await fetch('./api/local-ai/status', { cache: 'no-store', credentials: 'same-origin' });
      const body = response.ok ? await response.json() : null;
      status = body?.local ? body : null;
    } catch { status = null; }
  }
  const local = Boolean(status?.mcpCommand);
  const command = status?.mcpCommand?.command || 'node', cli = status?.mcpCommand?.args?.[0] || '/path/to/Pixel-studio/local/cli.mjs';
  const snippets = mcpSnippets({ command, cli });
  const block = (text, label) => `<div class="connect-code"><pre><code>${escapeHTML(text)}</code></pre><button type="button" class="button small" data-copy="${escapeHTML(text)}" aria-label="Copy ${escapeHTML(label)}">Copy</button></div>`;
  const intro = local
    ? `<p class="modal-body-text">Let Claude, GitHub Copilot, Cursor, Codex and other MCP clients draw, animate and export sprites with Pixel Studio. While this editor is open, agents can also read the current tab and propose changes here (you approve the first edit; each one is an undo step).</p>`
    : `<p class="modal-body-text">AI agents connect through <strong>Pixel Studio Local</strong>, which runs on your computer. Download or clone <a href="${REPO_URL}" target="_blank" rel="noopener">the repository ↗</a> (Node.js 20+), then run:</p>${block('npm start', 'start command')}<p class="modal-body-text">The commands below use your checkout's path in place of <code>/path/to/Pixel-studio</code>.</p>`;
  const html = `<div class="connect-agent">${intro}
    <h3 class="connect-heading">Quickest · Install the plugin</h3>
    <p class="modal-body-text">The Pixel Studio plugin bundles the skills and the MCP server, so there are no paths to set up. <strong>Codex</strong> (CLI, or the ChatGPT desktop app's Plugins directory after adding the marketplace):</p>
    ${block(CODEX_PLUGIN_COMMANDS, 'Codex plugin commands')}
    <p class="modal-body-text"><strong>Claude Code</strong>:</p>
    ${block(CLAUDE_PLUGIN_COMMANDS, 'Claude Code plugin commands')}
    <p class="connect-note">In Codex the plugin starts outside your project, so the agent first calls <code>set_workspace</code> with its working folder. From a checkout, <code>node local/cli.mjs plugin install</code> adds it to your personal Codex marketplace instead.</p>
    <h3 class="connect-heading">Or connect manually · 1 · Add the MCP server</h3>
    <div class="connect-tabs" role="tablist">${snippets.map((s, i) => `<button type="button" role="tab" class="button small${i ? '' : ' primary'}" aria-selected="${!i}" data-client="${s.id}">${escapeHTML(s.client)}</button>`).join('')}</div>
    ${snippets.map((s, i) => `<section class="connect-client" data-client-pane="${s.id}" ${i ? 'hidden' : ''}><p class="connect-where">${escapeHTML(s.where)}</p>${block(s.text, `${s.client} configuration`)}<p class="connect-note">${escapeHTML(s.note)}</p></section>`).join('')}
    <h3 class="connect-heading">2 · Install the skills (optional)</h3>
    <p class="modal-body-text">Skills teach agents the PXA 2 format, a draw → render → look → fix workflow and pixel-art and animation rules. They install for Claude Code, Copilot, Codex and Cursor (add <code>--project</code> for the current folder only):</p>
    ${block(skillsCommand({ command, cli }), 'skills command')}
    <p class="connect-note">Without MCP, agents can use the same features through the CLI: <code>pixelstudio render sprite.pxa -o sprite.png</code>. See <a href="${REPO_URL}/blob/main/docs/mcp.md" target="_blank" rel="noopener">docs/mcp.md ↗</a>.</p>
    <div class="modal-actions"><button type="button" class="button primary" data-connect-close>Done</button></div></div>`;
  openDialog('Connect an AI agent', html, 'AI AGENTS · MCP');
  const root = document.querySelector('.connect-agent');
  root.onclick = async event => {
    const tab = event.target.closest('[data-client]');
    if (tab) {
      for (const b of root.querySelectorAll('[data-client]')) { const on = b === tab; b.classList.toggle('primary', on); b.setAttribute('aria-selected', String(on)); }
      for (const pane of root.querySelectorAll('[data-client-pane]')) pane.hidden = pane.dataset.clientPane !== tab.dataset.client;
      return;
    }
    const copy = event.target.closest('[data-copy]');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); toast('Copied.'); }
      catch { toast('Copy failed: select the text and copy it manually.'); }
      return;
    }
    if (event.target.closest('[data-connect-close]')) document.getElementById('modal')?.close();
  };
}
