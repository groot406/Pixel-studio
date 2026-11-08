/**
 * “Plugins & skills” dialog: Installed (enable, disable, update, uninstall, install from a file, pasted code or a URL),
 * Gallery (bundled examples in public/plugins/), Prompt skills, and Write your own (the API reference and a ready-made
 * prompt so any chatbot can write a plugin). Every install from outside the gallery shows the manifest, the requested
 * permissions and the code first, with a trust warning.
 */
import { PLUGIN_API_DOC, pluginAuthorPrompt } from './api-doc.js';
import { MAX_PLUGIN_BYTES, PERMISSIONS, parsePluginSource, compareVersions } from './validate.js';
import { pluginRegistry, onPluginsChange } from './editor.js';

const TABS = [['installed', 'Installed'], ['gallery', 'Gallery'], ['skills', 'Prompt skills'], ['write', 'Write your own']];
let d, tab = 'installed', pending = null, gallery = null;

export function initPluginManager(deps) { d = deps; }

async function fetchText(url) {
  let response;
  try { response = await fetch(url, { credentials: 'omit', cache: 'no-cache' }); }
  catch { throw new Error('Could not download that file. This edition may only connect to its own server (its security policy blocks other sites), or you are offline. Download the .js file and install it from your computer, or paste its code instead.'); }
  if (!response.ok) throw new Error(`The server answered ${response.status} for that file.`);
  const text = await response.text();
  if (text.length > MAX_PLUGIN_BYTES) throw new Error('That file is larger than the 256 KB plugin limit.');
  return text;
}

async function loadGallery() {
  if (gallery) return gallery;
  const index = JSON.parse(await fetchText('./plugins/index.json'));
  gallery = await Promise.all(index.plugins.map(async item => {
    const source = await fetchText(`./plugins/${item.file}`);
    return { ...item, source, manifest: parsePluginSource(source).manifest };
  }));
  return gallery;
}

export function openPluginManager(startTab = tab) {
  tab = startTab; pending = null;
  d.openDialog('Plugins & skills', `<div class="plugins-manager"><div class="export-tabs plugins-tabs" role="tablist" aria-label="Plugin sections">${TABS.map(([id, label]) => `<button type="button" class="export-tab" role="tab" id="plugins-tab-${id}" data-tab="${id}" aria-controls="plugins-pane" aria-selected="${id === tab}">${label}</button>`).join('')}</div><div id="plugins-pane" class="plugins-pane" role="tabpanel"></div></div>`, 'EXTEND PIXEL STUDIO');
  const modal = d.$('modal');
  modal.classList.add('plugins-modal');
  const unsubscribe = onPluginsChange(() => { if (d.$('plugins-pane') && !pending) render(); });
  const cleanup = () => { unsubscribe(); modal.classList.remove('plugins-modal'); modal.removeEventListener('close', cleanup); modal.removeEventListener('pixel-studio:dialog-replace', cleanup); };
  modal.addEventListener('close', cleanup); modal.addEventListener('pixel-studio:dialog-replace', cleanup);
  const tabs = modal.querySelector('.plugins-tabs');
  tabs.onclick = event => { const button = event.target.closest('[data-tab]'); if (button) select(button.dataset.tab); };
  tabs.onkeydown = event => {
    const dir = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!dir) return;
    const ids = TABS.map(t => t[0]), next = ids[(ids.indexOf(tab) + dir + ids.length) % ids.length];
    select(next); d.$(`plugins-tab-${next}`).focus();
  };
  d.$('plugins-pane').addEventListener('click', onClick);
  d.$('plugins-pane').addEventListener('change', onChange);
  d.$('plugins-pane').addEventListener('dragover', event => { if (event.target.closest('.plugin-drop')) { event.preventDefault(); event.target.closest('.plugin-drop').classList.add('dragging'); } });
  d.$('plugins-pane').addEventListener('dragleave', event => event.target.closest('.plugin-drop')?.classList.remove('dragging'));
  d.$('plugins-pane').addEventListener('drop', event => {
    if (!event.target.closest('.plugin-drop')) return;
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) readFile(file);
  });
  render();
}

function select(id) {
  tab = id; pending = null;
  for (const button of d.$('modal').querySelectorAll('.plugins-tabs [role="tab"]')) { const on = button.dataset.tab === id; button.setAttribute('aria-selected', on); button.tabIndex = on ? 0 : -1; }
  render();
}

const esc = value => d.escapeHTML(String(value ?? ''));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function summary(registrations) {
  const parts = [];
  if (registrations.effects.length) parts.push(plural(registrations.effects.length, 'effect'));
  if (registrations.commands.length) parts.push(plural(registrations.commands.length, 'command'));
  if (registrations.promptSkills.length) parts.push(plural(registrations.promptSkills.length, 'prompt skill'));
  if (registrations.palettes.length) parts.push(plural(registrations.palettes.length, 'palette'));
  return parts.join(' · ');
}
const permissionList = permissions => permissions.length ? `<ul class="plugin-permissions">${permissions.map(p => `<li><strong>${esc(p)}</strong> ${esc(PERMISSIONS[p] || '')}</li>`).join('')}</ul>` : '<p class="plugin-muted">No permissions requested.</p>';

function render() {
  const pane = d.$('plugins-pane');
  if (!pane) return;
  if (pending) { pane.innerHTML = previewMarkup(); return; }
  if (tab === 'installed') pane.innerHTML = installedMarkup();
  else if (tab === 'gallery') { pane.innerHTML = '<p class="plugin-muted">Loading the gallery…</p>'; loadGallery().then(() => { if (tab === 'gallery' && !pending && d.$('plugins-pane')) d.$('plugins-pane').innerHTML = galleryMarkup(); }, error => { if (d.$('plugins-pane')) d.$('plugins-pane').innerHTML = `<p class="plugin-error">${esc(error.message)}</p>`; }); }
  else if (tab === 'skills') pane.innerHTML = skillsMarkup();
  else pane.innerHTML = writeMarkup();
}

function installedMarkup() {
  const list = pluginRegistry().list();
  const cards = list.map(p => `<li class="plugin-card${p.status === 'error' ? ' has-error' : ''}" data-plugin="${esc(p.id)}">
    <div class="plugin-card-head"><strong>${esc(p.manifest.name)}</strong><span class="plugin-version">v${esc(p.manifest.version)}</span><span class="plugin-status plugin-status-${p.status}">${{ ready: 'On', disabled: 'Off', loading: 'Starting…', error: 'Error' }[p.status]}</span></div>
    <p>${esc(p.manifest.description)}${p.manifest.author ? ` <span class="plugin-muted">· ${esc(p.manifest.author)}</span>` : ''}</p>
    ${p.status === 'ready' ? `<p class="plugin-muted">${esc(summary(p.registrations))} · permissions: ${esc(p.manifest.permissions.join(', ') || 'none')}</p>` : ''}
    ${p.error ? `<p class="plugin-error" role="alert">${esc(p.error)}</p>` : ''}
    <div class="plugin-card-actions">
      <label class="check-row"><input type="checkbox" data-plugin-toggle${p.enabled ? ' checked' : ''}${p.manifest.version === '?' ? ' disabled' : ''}><span>Enabled</span></label>
      ${/^(gallery|url):/.test(p.origin || '') ? '<button type="button" class="button" data-plugin-update>Check for update</button>' : ''}
      <button type="button" class="button danger-text" data-plugin-uninstall>Uninstall</button>
    </div></li>`).join('');
  return `${list.length ? `<ul class="plugin-list">${cards}</ul>` : '<p class="plugin-empty">No plugins installed yet. Try the <button type="button" class="text-button" data-go="gallery">gallery</button>, or install one below.</p>'}
    <section class="plugin-install" aria-labelledby="plugin-install-heading"><h3 id="plugin-install-heading">Install a plugin</h3>
      <div class="plugin-drop" tabindex="-1"><p>Drop a plugin <code>.js</code> file here, or</p><label class="button"><input type="file" id="plugin-file" accept=".js,text/javascript" class="sr-only">Choose file…</label></div>
      <details class="plugin-paste"><summary>Paste plugin code</summary><textarea id="plugin-code" rows="6" spellcheck="false" placeholder="/* pixelstudio-plugin { … } */"></textarea><button type="button" class="button" data-plugin-paste>Review code</button></details>
      <div class="plugin-url"><label class="field"><span class="field-label">Or from a URL</span><input id="plugin-url" type="url" placeholder="https://example.com/my-plugin.js" autocomplete="off"></label><button type="button" class="button" data-plugin-fetch>Download</button></div>
      <p class="plugin-muted">Plugins run in a sandboxed worker: no page, no network, only a copy of the pixels they change, and every result is checked before it is applied.</p>
      <p id="plugin-install-error" class="plugin-error" role="alert"></p>
    </section>`;
}

function galleryMarkup() {
  const installed = new Map(pluginRegistry().list().map(p => [p.id, p.manifest.version]));
  return `<p class="modal-body-text">Example plugins bundled with Pixel Studio. Each is a single, commented file — a good start for your own.</p><ul class="plugin-list">${gallery.map((item, i) => {
    const have = installed.get(item.manifest.id), newer = have && have !== '?' && compareVersions(item.manifest.version, have) > 0;
    return `<li class="plugin-card"><div class="plugin-card-head"><strong>${esc(item.name)}</strong><span class="plugin-version">v${esc(item.manifest.version)}</span><span class="plugin-kind">${esc(item.kind)}</span></div><p>${esc(item.description)}</p>
      <div class="plugin-card-actions">${have && !newer ? `<span class="plugin-muted">Installed · v${esc(have)}</span>` : `<button type="button" class="button primary" data-gallery-install="${i}" data-gallery-name="${esc(item.name)}">${newer ? `Update to v${esc(item.manifest.version)}` : 'Install'}</button>`}<button type="button" class="text-button" data-gallery-view="${i}">View code</button></div></li>`;
  }).join('')}</ul>`;
}

function skillsMarkup() {
  const skills = pluginRegistry().promptSkills();
  if (!skills.length) return '<p class="plugin-empty">No prompt skills yet. Install “Prompt skills” from the <button type="button" class="text-button" data-go="gallery">gallery</button> — skills add expert instructions, sizes and animation lists to the AI prompt builder.</p>';
  return `<p class="modal-body-text">Prompt skills appear in the AI prompt builder under “Prompt skill”. They add expert instructions to the prompt, and can fill in the size and animations.</p><ul class="plugin-list">${skills.map(s => `<li class="plugin-card"><div class="plugin-card-head"><strong>${esc(s.title)}</strong><span class="plugin-kind">${esc(s.pluginName)}</span></div><p>${esc(s.description)}</p>${s.animations ? `<p class="plugin-muted">${esc(s.animations.map(a => `${a.name} (${a.frameCount})`).join(', '))}${s.width ? ` · ${s.width} × ${s.height || s.width} px` : ''}</p>` : ''}<div class="plugin-card-actions"><button type="button" class="button" data-skill-use="${esc(s.key)}">Use in AI prompt</button></div></li>`).join('')}</ul>`;
}

function writeMarkup() {
  return `<p class="modal-body-text">Describe the plugin you want and copy a prompt for ChatGPT, Claude or any chatbot: it includes this complete API reference. Save the answer as a <code>.js</code> file and install it on the Installed tab.</p>
    <label class="field"><span class="field-label">Your plugin idea</span><textarea id="plugin-idea" rows="3" maxlength="2000" placeholder="An effect that adds a 1-pixel highlight on the top edge of every shape, in a colour I choose."></textarea></label>
    <div class="modal-actions plugin-write-actions"><button type="button" class="button primary" data-copy-author-prompt>Copy AI prompt to write a plugin</button></div>
    <details class="plugin-api" open><summary>API reference</summary><pre class="plugin-doc" tabindex="0">${esc(PLUGIN_API_DOC)}</pre></details>`;
}

function previewMarkup() {
  const { manifest, change, existing } = pending.info, source = pending.source;
  const verb = { install: 'Install', update: `Update from v${existing}`, downgrade: `Replace v${existing} with older`, reinstall: 'Reinstall' }[change];
  return `<div class="plugin-review"><div class="plugin-warning" role="note"><strong>Only install plugins you trust.</strong> A plugin runs its own code. Pixel Studio keeps it in a sandboxed worker without the page or the network, and checks everything it returns — but read the code below if you are unsure where it came from.</div>
    <div class="plugin-card-head"><strong>${esc(manifest.name)}</strong><span class="plugin-version">v${esc(manifest.version)}</span></div>
    <p>${esc(manifest.description)}${manifest.author ? ` <span class="plugin-muted">· ${esc(manifest.author)}</span>` : ''}</p>
    <p class="plugin-muted">From ${esc(pending.label)} · ${Math.ceil(source.length / 1024)} KB</p>
    <h3>Permissions</h3>${permissionList(manifest.permissions)}
    <details class="plugin-code-preview" open><summary>Code</summary><pre tabindex="0">${esc(source.length > 20000 ? `${source.slice(0, 20000)}\n…` : source)}</pre></details>
    <p id="plugin-install-error" class="plugin-error" role="alert"></p>
    <div class="modal-actions"><button type="button" class="button" data-review-cancel>Cancel</button><button type="button" class="button primary" data-review-install>${esc(verb)}</button></div></div>`;
}

function review(source, origin, label) {
  const error = d.$('plugin-install-error');
  try {
    if (source.length > MAX_PLUGIN_BYTES) throw new Error('That file is larger than the 256 KB plugin limit.');
    pending = { source, origin, label, info: pluginRegistry().inspect(source) };
    render();
  } catch (e) { if (error) error.textContent = e.message; else d.toast(e.message); }
}
function readFile(file) {
  if (!/\.(m?js|txt)$/i.test(file.name) && !/javascript/.test(file.type)) { d.$('plugin-install-error').textContent = 'Choose a plugin .js file.'; return; }
  if (file.size > MAX_PLUGIN_BYTES) { d.$('plugin-install-error').textContent = 'That file is larger than the 256 KB plugin limit.'; return; }
  file.text().then(text => review(text, 'file', `the file “${file.name}”`), () => { d.$('plugin-install-error').textContent = 'Could not read that file.'; });
}

async function install(source, origin, button) {
  if (button) { button.disabled = true; button.textContent = 'Installing…'; }
  try {
    const { manifest, change } = await pluginRegistry().install(source, origin);
    d.toast(`${manifest.name} ${change === 'update' ? 'updated' : 'installed'} (v${manifest.version}).`);
    return true;
  } catch (error) {
    d.toast(`Not installed: ${error.message}`);
    const box = d.$('plugin-install-error');
    if (box) box.textContent = `Not installed: ${error.message}`;
    if (button?.isConnected) { button.disabled = false; button.textContent = 'Try again'; }
    return false;
  }
}

async function onClick(event) {
  const t = event.target, card = t.closest('[data-plugin]'), id = card?.dataset.plugin, registry = pluginRegistry();
  if (t.closest('[data-go]')) { select(t.closest('[data-go]').dataset.go); return; }
  if (t.closest('[data-plugin-uninstall]')) {
    const name = registry.list().find(p => p.id === id)?.manifest.name || id;
    if (!confirm(`Uninstall “${name}”? Art you made with it stays as it is.`)) return;
    await registry.uninstall(id).catch(error => d.toast(error.message));
    d.toast(`${name} uninstalled.`);
    return;
  }
  if (t.closest('[data-plugin-update]')) {
    const entry = registry.list().find(p => p.id === id), button = t.closest('button');
    button.disabled = true; button.textContent = 'Checking…';
    try {
      const [kind, ...rest] = entry.origin.split(':'), where = rest.join(':');
      const source = kind === 'gallery' ? await fetchText(`./plugins/${where}`) : await fetchText(where);
      const { manifest } = parsePluginSource(source);
      if (manifest.id !== entry.id) throw new Error('The downloaded file is a different plugin.');
      if (compareVersions(manifest.version, entry.manifest.version) <= 0) { d.toast(`${entry.manifest.name} is up to date (v${entry.manifest.version}).`); render(); return; }
      if (kind === 'gallery') await install(source, entry.origin);
      else review(source, entry.origin, where);
    } catch (error) { d.toast(error.message); render(); }
    return;
  }
  if (t.closest('[data-plugin-paste]')) { const code = d.$('plugin-code').value.trim(); if (code) review(code, 'paste', 'pasted code'); return; }
  if (t.closest('[data-plugin-fetch]')) {
    const input = d.$('plugin-url'), url = input.value.trim(), box = d.$('plugin-install-error');
    let parsed;
    try { parsed = new URL(url, location.href); if (!/^https?:$/.test(parsed.protocol)) throw new Error(); } catch { box.textContent = 'Enter a web address starting with https://'; return; }
    box.textContent = 'Downloading…';
    try { review(await fetchText(parsed.href), `url:${parsed.href}`, parsed.href); } catch (error) { box.textContent = error.message; }
    return;
  }
  if (t.closest('[data-review-cancel]')) { pending = null; render(); return; }
  if (t.closest('[data-review-install]')) {
    const ok = await install(pending.source, pending.origin, t.closest('button'));
    if (ok) { pending = null; tab = 'installed'; select('installed'); }
    return;
  }
  const galleryInstall = t.closest('[data-gallery-install]');
  if (galleryInstall) {
    const item = gallery[Number(galleryInstall.dataset.galleryInstall)];
    if (await install(item.source, `gallery:${item.file}`, galleryInstall) && d.$('plugins-pane')) render();
    return;
  }
  const galleryView = t.closest('[data-gallery-view]');
  if (galleryView) { const item = gallery[Number(galleryView.dataset.galleryView)]; pending = { source: item.source, origin: `gallery:${item.file}`, label: 'the Pixel Studio gallery', info: registry.inspect(item.source) }; render(); return; }
  const skill = t.closest('[data-skill-use]');
  if (skill) { d.openPromptBuilder({ skill: skill.dataset.skillUse }); return; }
  if (t.closest('[data-copy-author-prompt]')) {
    const text = pluginAuthorPrompt(d.$('plugin-idea').value.trim()), button = t.closest('button');
    try { await navigator.clipboard.writeText(text); button.textContent = 'Copied — paste it into your chatbot'; d.toast('Prompt copied, including the full plugin API.'); }
    catch {
      d.$('plugin-idea').value = text; d.$('plugin-idea').focus(); d.$('plugin-idea').select();
      d.toast('Prompt placed in the box and selected. Press Ctrl/⌘ C to copy it.');
    }
  }
}

async function onChange(event) {
  if (event.target.id === 'plugin-file' && event.target.files[0]) { readFile(event.target.files[0]); return; }
  if (event.target.matches('[data-plugin-toggle]')) {
    const id = event.target.closest('[data-plugin]').dataset.plugin;
    await pluginRegistry().setEnabled(id, event.target.checked).catch(error => d.toast(error.message));
    const entry = pluginRegistry().list().find(p => p.id === id);
    if (entry?.status === 'error') d.toast(`${entry.manifest.name}: ${entry.error}`);
  }
}
