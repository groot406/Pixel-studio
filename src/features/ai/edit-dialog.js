import { createRefinementRequest, refinementFrames, renderRefinementPreview } from './refinement.js';
import { compareProjects } from './comparison.js';
import { compositeFrame } from '../../domain/project.js';
import { createAIRequest, prepareAIResult } from './requests.js';
import { readLocalEditResponse } from './local-client.js';
import { isCloudEdition } from '../cloud/client.js';

const drafts = new Map();
const copy = value => JSON.parse(JSON.stringify(value));
const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const plural = (count, singular, multiple = `${singular}s`) => `${Number(count || 0).toLocaleString()} ${count === 1 ? singular : multiple}`;
const isLoopback = () => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname) && ['http:', 'https:'].includes(location.protocol);
let disposeActiveDialog = null;

function rememberDraft(key, draft) {
  drafts.delete(key);
  drafts.set(key, draft);
  while (drafts.size > 8) drafts.delete(drafts.keys().next().value);
}

function layerPixels(project, frame, layerId) {
  if (!layerId) return compositeFrame(project, frame);
  return frame.cels.find(cel => cel.layerId === layerId)?.pixels || Array(project.width * project.height).fill(-1);
}

function paint(canvas, pixels, project, differences) {
  if (canvas.width !== project.width) canvas.width = project.width;
  if (canvas.height !== project.height) canvas.height = project.height;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, project.width, project.height);
  context.imageSmoothingEnabled = false;
  for (let index = 0; index < pixels.length; index++) {
    if (pixels[index] < 0) continue;
    context.fillStyle = project.palette[pixels[index]];
    context.fillRect(index % project.width, Math.floor(index / project.width), 1, 1);
  }
  if (differences) {
    context.fillStyle = 'rgba(221, 147, 31, .67)';
    for (const index of differences) context.fillRect(index % project.width, Math.floor(index / project.width), 1, 1);
  }
}

/** Review a local Codex or pasted PXA proposal before handing it to the editor. */
export function openAIEdit({ project, animationId, frameId, layerId, selection = null, documentId, openDialog, toast, onApply }) {
  disposeActiveDialog?.();
  const sourceProject = copy(project);
  const currentAnimation = sourceProject.animations.find(animation => animation.id === animationId) || sourceProject.animations[0];
  const currentFrame = currentAnimation.frames.find(frame => frame.id === frameId) || currentAnimation.frames[0];
  const currentLayer = sourceProject.layers.find(layer => layer.id === layerId);
  const canInpaint = !!selection && !!currentLayer && !currentLayer.locked;
  const key = documentId || 'current';
  const saved = drafts.get(key);
  const sameSource = saved?.request && JSON.stringify(saved.request.sourceProject) === JSON.stringify(sourceProject);
  const cloud = isCloudEdition(), local = isLoopback() || cloud;
  const initialMode = ['edit', 'compose', 'inpaint', 'recolor'].includes(saved?.mode) && (saved.mode !== 'inpaint' || canInpaint) ? saved.mode : 'edit';
  const initialScope = initialMode === 'recolor' ? 'project' : ['frame', 'animation', 'project'].includes(saved?.scope) && !(initialMode === 'inpaint' && saved.scope === 'project') ? saved.scope : 'animation';
  const sameTarget = initialScope === 'project' || (saved?.animationId === currentAnimation.id && (initialScope !== 'frame' || saved?.frameId === currentFrame.id));
  const sameSelection = saved?.layerId === layerId && JSON.stringify(saved?.selection) === JSON.stringify(selection);
  let request = sameSource && sameTarget && saved.mode === initialMode && (initialMode !== 'inpaint' || sameSelection) ? saved.request : null;
  let proposal = null;
  let method = saved?.method === 'paste' ? 'paste' : 'local';
  let connection = { local, connected: false, models: [], csrfToken: '', busy: false };
  let busy = false;
  let checking = false;
  let disposed = false;
  let applied = false;
  let editController;
  let statusController;
  let statusTimeout;
  let statusVersion = 0;
  let previewAnimationId = currentAnimation.id;
  let previewFrameIndex = 0;
  let playing = false;
  let playhead = 0;
  let lastTick = 0;
  let animationHandle;
  let highlightTimer;
  let highlightVisible = true;

  openDialog('Give your pixels a new idea', `
    <form id="ai-edit-form" class="ai-edit" novalidate>
      <div class="ai-edit-body">
        <p class="ai-edit-intro">Describe a change, review the proposal, and apply it as one undoable edit.</p>
        <div class="ai-edit-request-grid">
          <label class="field" for="ai-edit-mode"><span class="field-label">Action</span><select id="ai-edit-mode"><option value="edit">Edit artwork</option><option value="compose">Edit parts / pixels (PXA 2)</option><option value="inpaint"${canInpaint ? '' : ' disabled'}>Inpaint selection</option><option value="recolor">Recolor palette</option></select></label>
          <label class="field" for="ai-edit-scope"><span class="field-label">Edit</span><select id="ai-edit-scope"><option value="animation">Current animation · ${escapeHTML(currentAnimation.name)}</option><option value="frame">Current frame · ${currentAnimation.frames.indexOf(currentFrame) + 1}</option><option value="project">Whole project</option></select></label>
          <label id="ai-edit-model-field" class="field" for="ai-edit-model" hidden><span class="field-label">Model</span><select id="ai-edit-model"><option value="">Codex default</option></select></label>
        </div>
        <p id="ai-edit-scope-help" class="ai-edit-help"></p>
        <label class="field ai-edit-instruction-field" for="ai-edit-instruction"><span class="field-label">What would you like to change?</span><textarea id="ai-edit-instruction" rows="3" maxlength="6000" required placeholder="Make the sword swing clearer, with a little more movement in the coat…"></textarea></label>

        <div class="ai-edit-methods" role="tablist" aria-label="AI editing method">
          <button id="ai-edit-local-tab" type="button" role="tab" aria-controls="ai-edit-local-panel" aria-selected="true">${icon('spark')} ${cloud ? 'Pixel Studio AI' : 'Local Codex'}</button>
          <button id="ai-edit-paste-tab" type="button" role="tab" aria-controls="ai-edit-paste-panel" aria-selected="false" tabindex="-1">${icon('paste')} Paste AI result</button>
        </div>
        <section id="ai-edit-local-panel" class="ai-edit-method-panel" role="tabpanel" aria-labelledby="ai-edit-local-tab">
          <div id="ai-edit-connection" class="ai-edit-connection" data-state="checking">
            <span class="ai-edit-connection-dot" aria-hidden="true"></span>
            <div class="ai-edit-connection-copy"><strong id="ai-edit-connection-title">${local ? 'Checking local Codex…' : 'Use your own Codex account'}</strong><p id="ai-edit-connection-description">${local ? 'Looking for the local Pixel Studio service.' : 'Download the local edition to generate and edit with your ChatGPT plan.'}</p></div>
            <button id="ai-edit-refresh" class="button small" type="button"${local ? '' : ' hidden'}>${icon('rotate-right')} Refresh</button>
            <a id="ai-edit-download" class="button" href="./downloads/pixel-studio-local.zip" download="pixel-studio-local.zip"${local ? ' hidden' : ''}>${icon('import')} Download local edition</a>
          </div>
        </section>
        <section id="ai-edit-paste-panel" class="ai-edit-method-panel" role="tabpanel" aria-labelledby="ai-edit-paste-tab" hidden>
          <p class="ai-edit-help">Copy this edit prompt into ChatGPT, then paste its complete response below, including the final completion comment. The response must match this request and its output format.</p>
          <label class="field" for="ai-edit-response"><span class="field-label">AI response</span><textarea id="ai-edit-response" rows="7" maxlength="4194304" spellcheck="false" autocapitalize="off" placeholder="PXA 1&#10;SIZE ${sourceProject.width} ${sourceProject.height}&#10;…"></textarea></label>
        </section>

        <div id="ai-edit-progress" class="ai-edit-progress" role="status" aria-live="polite" hidden><span class="ai-edit-working" aria-hidden="true"></span><span id="ai-edit-progress-message"></span><span id="ai-edit-progress-count"></span></div>
        <p id="ai-edit-error" class="ai-edit-error" role="alert" hidden></p>
        <details id="ai-edit-prompt-details" class="ai-edit-prompt-details"><summary>View edit prompt <span id="ai-edit-prompt-size"></span>${icon('chevron')}</summary><label class="field" for="ai-edit-prompt"><span class="sr-only">Complete edit prompt</span><textarea id="ai-edit-prompt" readonly rows="8" spellcheck="false" aria-label="Complete edit prompt"></textarea></label></details>

        <section id="ai-edit-review" class="ai-edit-review" aria-labelledby="ai-edit-review-heading" hidden>
          <div class="ai-edit-review-heading"><h3 id="ai-edit-review-heading">Review your edit</h3><span id="ai-edit-review-status"></span></div>
          <p id="ai-edit-change-summary" class="ai-edit-change-summary"></p>
          <div class="ai-edit-review-options"><label id="ai-edit-preview-animation-field" class="field" for="ai-edit-preview-animation"><span class="field-label">Animation</span><select id="ai-edit-preview-animation" aria-label="Preview animation"></select></label><label class="field" for="ai-edit-preview-layer"><span class="field-label">Preview layer</span><select id="ai-edit-preview-layer" aria-label="Preview layer"><option value="">Visible artwork</option></select></label></div>
          <div class="ai-edit-comparison"><figure><figcaption>Original</figcaption><div class="ai-edit-stage"><canvas id="ai-edit-before" role="img" aria-label="Original pixel art"></canvas></div></figure><figure><figcaption>Proposed edit</figcaption><div class="ai-edit-stage"><canvas id="ai-edit-after" role="img" aria-label="Proposed pixel art"></canvas></div></figure></div>
          <div class="ai-edit-playback"><button id="ai-edit-play" class="button small" type="button" aria-label="Play both previews" aria-pressed="false">${icon('play')}<span>Play</span></button><label class="ai-edit-scrubber" for="ai-edit-frame"><span class="sr-only">Preview frame</span><input id="ai-edit-frame" type="range" min="0" max="0" value="0" step="1" aria-label="Preview frame"></label><span id="ai-edit-frame-label"></span></div>
          <div class="ai-edit-review-bottom"><label class="check-row" for="ai-edit-highlight"><input id="ai-edit-highlight" type="checkbox"><span>Highlight changed pixels</span></label><span id="ai-edit-visible-changes"></span></div>
          <div id="ai-edit-added-colors" class="ai-edit-added-colors" hidden></div>
          <div id="ai-edit-recolored-swatches" class="ai-edit-recolored-swatches" aria-label="Palette color changes" hidden></div>
          <p id="ai-edit-palette-warning" class="ai-edit-help" hidden></p>
          <button id="ai-edit-refine" class="button" type="button" hidden>Refine with visual preview</button><p id="ai-edit-refine-help" class="ai-edit-help" hidden>One optional extra generation reviews rendered before/after previews using your selected model.</p>
          <p class="ai-edit-help ai-edit-review-note">Totals include hidden layers. Choose a layer to inspect its pixels; amber highlights show changes in the selected view.</p>
        </section>
      </div>
      <div class="ai-edit-actions">
        <button id="ai-edit-close" class="button" type="button">Close</button>
        <button id="ai-edit-copy" class="button" type="button">${icon('copy')}<span>Copy prompt</span></button>
        <button id="ai-edit-stop" class="button danger" type="button" hidden>Stop generation</button>
        <button id="ai-edit-generate" class="button primary" type="submit">${icon('spark')}<span>Generate preview</span></button>
        <button id="ai-edit-apply" class="button primary" type="button" hidden disabled>${icon('check')}<span>Apply changes</span></button>
      </div>
    </form>`, 'AI EDITING');

  const modal = document.getElementById('modal');
  const form = document.getElementById('ai-edit-form');
  const $ = id => form.querySelector(`#${id}`);
  modal.classList.add('ai-edit-modal');
  $('ai-edit-mode').value = initialMode;
  $('ai-edit-scope').value = initialScope;
  $('ai-edit-instruction').value = saved?.instruction || '';
  $('ai-edit-response').value = request ? saved?.response || '' : '';
  if (request && (request.instruction !== $('ai-edit-instruction').value.trim() || request.scope !== initialScope)) request = null;

  function saveDraft() {
    if (applied) return;
    rememberDraft(key, {
      instruction: $('ai-edit-instruction').value, scope: $('ai-edit-scope').value, mode: $('ai-edit-mode').value,
      layerId, selection,
      model: $('ai-edit-model').value, method, request, response: $('ai-edit-response').value,
      animationId: currentAnimation.id, frameId: currentFrame.id,
    });
  }

  function scrollBodyTo(element, start = false) {
    const body = form.querySelector('.ai-edit-body');
    modal.scrollTop = 0;
    const viewport = body.getBoundingClientRect();
    const target = element.getBoundingClientRect();
    let top = body.scrollTop;
    if (start || target.top < viewport.top + 8 || target.height > body.clientHeight - 16) {
      top += target.top - viewport.top - 8;
    } else if (target.bottom > viewport.bottom - 8) {
      top += target.bottom - viewport.bottom + 8;
    }
    body.scrollTo({ top: Math.max(0, top), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function setError(message) {
    $('ai-edit-error').textContent = message || '';
    $('ai-edit-error').hidden = !message;
    if (message) scrollBodyTo($('ai-edit-error'));
  }

  function progress(message, count = '') {
    $('ai-edit-progress').hidden = !message;
    $('ai-edit-progress-message').textContent = message || '';
    $('ai-edit-progress-count').textContent = count;
    $('ai-edit-progress').classList.toggle('is-working', busy);
  }

  function scopeHelp() {
    const mode = $('ai-edit-mode').value;
    const scopeSelect = $('ai-edit-scope');
    scopeSelect.querySelector('[value="project"]').disabled = mode === 'inpaint';
    if (mode === 'recolor') scopeSelect.value = 'project';
    else if (mode === 'inpaint' && scopeSelect.value === 'project') scopeSelect.value = 'animation';
    const scope = scopeSelect.value;
    const frames = scope === 'frame' ? 1 : scope === 'animation' ? currentAnimation.frames.length : sourceProject.animations.reduce((sum, animation) => sum + animation.frames.length, 0);
    let details;
    if (mode === 'inpaint') {
      details = `Selection ${selection.width} × ${selection.height} at (${selection.x}, ${selection.y}) · ${currentLayer.name}. Only selected pixels on this layer can change. Palette, timing, and all other artwork stay protected.`;
    } else if (mode === 'recolor') {
      details = 'The shared palette affects every frame and animation, including locked and hidden artwork. Pixel indices, layer structure, and timing stay unchanged.';
    } else {
      details = (sourceProject.version === 3 || mode === 'compose') ? 'Edit reusable parts and individual placements. Shared edits must respect every referenced frame and locked layer. Layers, palette and timing stay protected.' : scope === 'project'
        ? 'Add or reorganize editable layers. Animation names, frame counts, timing, and locked artwork stay protected.'
        : 'Changes stay inside this selection. Layers, frame counts, timing, and locked artwork stay protected.';
      if (!canInpaint) details += ' To inpaint, first select a rectangle on an unlocked layer.';
    }
    $('ai-edit-scope-help').textContent = `${sourceProject.width} × ${sourceProject.height} · ${plural(frames, 'frame')} · ${details}`;
    $('ai-edit-response').placeholder = ['edit','compose'].includes(mode) ? (sourceProject.version === 3 || mode === 'compose' ? 'PXAPATCH 2\n…' : 'PXA 1\n…') : mode === 'inpaint' ? 'PXAINPAINT 1\n…' : 'PXAPALETTE 1\n…';
  }

  function updateControls() {
    $('ai-edit-mode').disabled = busy;
    $('ai-edit-scope').disabled = busy || $('ai-edit-mode').value === 'recolor';
    $('ai-edit-instruction').disabled = busy;
    $('ai-edit-model').disabled = busy || checking;
    $('ai-edit-response').disabled = busy || method !== 'paste';
    $('ai-edit-response').required = method === 'paste';
    $('ai-edit-local-tab').disabled = busy;
    $('ai-edit-paste-tab').disabled = busy;
    $('ai-edit-refresh').disabled = checking || busy;
    $('ai-edit-copy').disabled = busy;
    $('ai-edit-generate').hidden = busy;
    $('ai-edit-generate').disabled = method === 'local' && (!connection.connected || !connection.csrfToken || connection.busy || checking);
    $('ai-edit-generate').classList.toggle('primary', !proposal?.hasChanges);
    $('ai-edit-generate').innerHTML = `${icon(method === 'paste' ? 'eye' : 'spark')}<span>${method === 'paste' ? 'Preview edits' : proposal ? 'Generate again' : 'Generate preview'}</span>`;
    $('ai-edit-stop').hidden = !busy;
    $('ai-edit-apply').hidden = !proposal;
    $('ai-edit-apply').disabled = busy || !proposal?.hasChanges;
    const canRefine=!!proposal && request?.format==='pixel-studio-ai-composition' && !request.refinement;
    $('ai-edit-refine').hidden=!canRefine;
    $('ai-edit-refine-help').hidden=!canRefine;
    const selectedModel=connection.models?.find(m=>m.id===$('ai-edit-model').value);
    $('ai-edit-refine').disabled=busy||checking||connection.busy||!connection.connected||!connection.csrfToken||selectedModel?.supportsImages===false;
    $('ai-edit-model-field').hidden = method !== 'local' || !connection.connected || !connection.models?.length;
    form.dataset.busy = String(busy);
  }

  function setMethod(value, focus = false) {
    method = value;
    for (const option of ['local', 'paste']) {
      const active = option === method;
      const tab = $(`ai-edit-${option}-tab`);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      $(`ai-edit-${option}-panel`).hidden = !active;
    }
    updateControls();
    if (focus) $(`ai-edit-${method}-tab`).focus({ preventScroll: true });
    saveDraft();
  }

  function renderConnection() {
    const connected = connection.connected && (connection.authMode === 'chatgpt' || (cloud && connection.authMode === 'cloud'));
    connection.connected = connected;
    $('ai-edit-connection').dataset.state = checking ? 'checking' : connected ? 'ready' : local ? 'attention' : 'local-only';
    if (cloud) {
      $('ai-edit-connection-title').textContent = checking ? 'Checking Pixel Studio Cloud…' : connected ? 'Pixel Studio Cloud AI' : 'Sign in to use AI';
      $('ai-edit-connection-description').textContent = checking ? 'Checking your account.' : connected
        ? `${connection.accountLabel} · ${connection.busy ? 'Another request is running. Refresh when it finishes.' : `${connection.credits?.balance ?? 0} credits left; an edit uses about 5–40.`}`
        : connection.message || 'Sign in (Account, top right) to edit with AI.';
    } else {
    $('ai-edit-connection-title').textContent = !local ? 'Use your own Codex account' : checking ? 'Checking local Codex…' : connected ? 'Local Codex connected' : 'Connect your local Codex';
    $('ai-edit-connection-description').textContent = !local
      ? 'Download the local edition to generate and edit with your ChatGPT plan.'
      : checking ? 'Checking the local service and your ChatGPT sign-in.'
        : connected ? `${connection.accountLabel || 'Your ChatGPT account'} · ${connection.busy ? 'Another request is running. Refresh when it finishes.' : 'Uses your plan’s available allowance.'}`
          : connection.message || 'Start the local edition with npm start, then open the localhost address it prints.';
    }
    const select = $('ai-edit-model');
    const chosen = select.value || saved?.model || '';
    select.replaceChildren(new Option(cloud ? 'Default (GPT-5 mini)' : 'Codex default', ''));
    for (const model of connection.models || []) {
      if (typeof model.id === 'string') select.add(new Option(model.name || model.id, model.id));
    }
    if ([...select.options].some(option => option.value === chosen)) select.value = chosen;
    updateControls();
  }

  async function refreshStatus() {
    if (!local || disposed || busy) return;
    statusController?.abort();
    clearTimeout(statusTimeout);
    const version = ++statusVersion;
    const controller = new AbortController();
    statusController = controller;
    checking = true;
    renderConnection();
    statusTimeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/local-ai/status', { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
      const result = await response.json();
      if (!response.ok || result.local !== true) throw new Error('Start the local edition with npm start, then reopen its localhost address.');
      if (disposed || version !== statusVersion) return;
      connection = {
        ...result, connected: result.connected === true && result.authMode === 'chatgpt',
        models: Array.isArray(result.models) ? result.models : [], csrfToken: typeof result.csrfToken === 'string' ? result.csrfToken : '',
      };
    } catch (error) {
      if (disposed || version !== statusVersion) return;
      connection = {
        local: true, connected: false, models: [], csrfToken: '', busy: false,
        message: controller.signal.aborted ? 'The local service did not respond. Check the launcher terminal, then try Refresh.'
          : error instanceof SyntaxError ? 'Start the local edition with npm start, then reopen its localhost address.'
            : error instanceof TypeError ? 'The local service is unavailable. Start it with npm start, then try Refresh.'
              : error.message || 'The local service is unavailable. Check the launcher terminal, then try Refresh.',
      };
    } finally {
      if (!disposed && version === statusVersion) {
        clearTimeout(statusTimeout);
        checking = false;
        renderConnection();
      }
    }
  }

  function getRequest(showErrors = true) {
    if (showErrors && !$('ai-edit-instruction').reportValidity()) return null;
    const instruction = $('ai-edit-instruction').value.trim();
    const scope = $('ai-edit-scope').value;
    const mode = $('ai-edit-mode').value;
    try {
      if (!request || request.instruction !== instruction || request.scope !== scope || request.mode !== mode) {
        request = createAIRequest(sourceProject, { mode, scope, animationId: currentAnimation.id, frameId: currentFrame.id, layerId, selection, instruction });
      }
      $('ai-edit-prompt').value = request.prompt;
      $('ai-edit-prompt-size').textContent = `${request.prompt.length.toLocaleString()} characters`;
      saveDraft();
      return request;
    } catch (error) {
      if (showErrors) setError(error.message);
      return null;
    }
  }

  function previewFrames() {
    if (!proposal) return null;
    const beforeAnimation = sourceProject.animations.find(animation => animation.id === previewAnimationId) || currentAnimation;
    const afterAnimation = proposal.project.animations.find(animation => animation.id === beforeAnimation.id) || proposal.project.animations[sourceProject.animations.indexOf(beforeAnimation)];
    if (request.scope === 'frame') {
      const before = beforeAnimation.frames.find(frame => frame.id === currentFrame.id);
      const after = afterAnimation.frames.find(frame => frame.id === currentFrame.id);
      return { before: [before], after: [after], name: beforeAnimation.name };
    }
    return { before: beforeAnimation.frames, after: afterAnimation.frames, name: beforeAnimation.name };
  }

  function sizeCanvases() {
    if (!proposal || disposed) return;
    for (const id of ['ai-edit-before', 'ai-edit-after']) {
      const canvas = $(id);
      const stage = canvas.parentElement;
      const scale = Math.max(1, Math.floor(Math.min((stage.clientWidth - 20) / sourceProject.width, (stage.clientHeight - 20) / sourceProject.height)));
      canvas.style.width = `${sourceProject.width * scale}px`;
      canvas.style.height = `${sourceProject.height * scale}px`;
    }
  }

  function renderPreview() {
    if (!proposal || disposed) return;
    const frames = previewFrames();
    previewFrameIndex = Math.max(0, Math.min(previewFrameIndex, frames.before.length - 1));
    const layerId = $('ai-edit-preview-layer').value;
    const before = layerPixels(sourceProject, frames.before[previewFrameIndex], layerId);
    const after = layerPixels(proposal.project, frames.after[previewFrameIndex], layerId);
    const differences = [];
    for (let index = 0; index < before.length; index++) {
      const original = before[index] < 0 ? null : sourceProject.palette[before[index]];
      const proposed = after[index] < 0 ? null : proposal.project.palette[after[index]];
      if (original !== proposed) differences.push(index);
    }
    paint($('ai-edit-before'), before, sourceProject);
    paint($('ai-edit-after'), after, proposal.project, $('ai-edit-highlight').checked && highlightVisible ? differences : null);
    $('ai-edit-frame').max = frames.before.length - 1;
    $('ai-edit-frame').value = previewFrameIndex;
    $('ai-edit-frame').disabled = frames.before.length < 2;
    $('ai-edit-frame-label').textContent = `${previewFrameIndex + 1} / ${frames.before.length} · ${frames.before[previewFrameIndex].duration} ms`;
    $('ai-edit-visible-changes').textContent = `${plural(differences.length, 'changed pixel')} in this view`;
    $('ai-edit-before').setAttribute('aria-label', `Original ${frames.name}, frame ${previewFrameIndex + 1}`);
    $('ai-edit-after').setAttribute('aria-label', `Proposed ${frames.name}, frame ${previewFrameIndex + 1}`);
    $('ai-edit-play').disabled = frames.before.length < 2;
    sizeCanvases();
  }

  function setPlaying(value) {
    cancelAnimationFrame(animationHandle);
    playing = !!value && !!proposal && previewFrames().before.length > 1;
    $('ai-edit-play').setAttribute('aria-pressed', String(playing));
    $('ai-edit-play').setAttribute('aria-label', playing ? 'Pause both previews' : 'Play both previews');
    $('ai-edit-play').innerHTML = `${icon(playing ? 'pause' : 'play')}<span>${playing ? 'Pause' : 'Play'}</span>`;
    if (playing) {
      const frames = previewFrames().before;
      playhead = frames.slice(0, previewFrameIndex).reduce((sum, frame) => sum + frame.duration, 0);
      lastTick = performance.now();
      animationHandle = requestAnimationFrame(tick);
    }
  }

  function tick(time) {
    if (!playing || disposed || !proposal) return;
    const frames = previewFrames().before;
    const cycle = frames.reduce((sum, frame) => sum + frame.duration, 0);
    playhead = (playhead + Math.min(1000, time - lastTick)) % cycle;
    lastTick = time;
    let cursor = playhead;
    let index = 0;
    while (index < frames.length - 1 && cursor >= frames[index].duration) cursor -= frames[index++].duration;
    if (previewFrameIndex !== index) { previewFrameIndex = index; renderPreview(); }
    animationHandle = requestAnimationFrame(tick);
  }

  function clearProposal() {
    clearInterval(highlightTimer);
    setPlaying(false);
    proposal = null;
    $('ai-edit-review').hidden = true;
    updateControls();
  }

  function showProposal(text, currentRequest) {
    const result = prepareAIResult(currentRequest, text);
    if(currentRequest.refinement) {
      Object.assign(result,compareProjects(sourceProject,result.project));
      result.hasChanges=JSON.stringify(sourceProject)!==JSON.stringify(result.project);
    }
    request = currentRequest;
    proposal = result;
    $('ai-edit-response').value = text;
    previewAnimationId = currentAnimation.id;
    previewFrameIndex = 0;
    const change = result.changes;
    const parts = result.swatches
      ? [plural(result.swatches.length, 'recolored slot'), plural(change.frames, 'visually changed frame')]
      : [plural(change.pixels, 'pixel edit'), plural(change.frames, 'changed frame')];
    if (change.layersAdded) parts.push(plural(change.layersAdded, 'new layer'));
    else if (change.layers) parts.push(plural(change.layers, 'changed layer'));
    if (change.parts) parts.push(plural(change.parts, 'changed part'));
    if (change.compositions) parts.push(plural(change.compositions, 'changed composition'));
    if (change.colorsAdded) parts.push(plural(change.colorsAdded, 'new color'));
    $('ai-edit-change-summary').textContent = parts.join(' · ');
    $('ai-edit-review-status').textContent = result.hasChanges ? 'Ready to apply' : 'No changes to apply';
    const animationSelect = $('ai-edit-preview-animation');
    animationSelect.replaceChildren();
    const animations = request.scope === 'project' ? sourceProject.animations : [currentAnimation];
    for (const animation of animations) animationSelect.add(new Option(animation.name, animation.id));
    animationSelect.value = previewAnimationId;
    animationSelect.disabled = animations.length < 2;
    const layerSelect = $('ai-edit-preview-layer');
    layerSelect.replaceChildren(new Option('Visible artwork', ''));
    const layers = [...result.project.layers, ...sourceProject.layers.filter(layer => !result.project.layers.some(candidate => candidate.id === layer.id))];
    for (const layer of layers) {
      const suffix = !sourceProject.layers.some(candidate => candidate.id === layer.id) ? ' · new' : !result.project.layers.some(candidate => candidate.id === layer.id) ? ' · removed' : !layer.visible ? ' · hidden' : '';
      layerSelect.add(new Option(`${layer.name}${suffix}`, layer.id));
    }
    if (request.mode === 'inpaint') layerSelect.value = layerId;
    const swatches = result.swatches || [];
    $('ai-edit-recolored-swatches').hidden = !swatches.length;
    $('ai-edit-recolored-swatches').innerHTML = swatches.map(swatch => `<div class="ai-edit-swatch-change"><span>Slot ${swatch.index + 1}</span><i style="background:${escapeHTML(swatch.before)}" aria-hidden="true"></i><code>${escapeHTML(swatch.before)}</code><span>→</span><i style="background:${escapeHTML(swatch.after)}" aria-hidden="true"></i><code>${escapeHTML(swatch.after)}</code></div>`).join('');
    $('ai-edit-palette-warning').hidden = !result.warning;
    $('ai-edit-palette-warning').textContent = result.warning || '';
    const newColors = result.project.palette.slice(sourceProject.palette.length);
    $('ai-edit-added-colors').hidden = !newColors.length;
    $('ai-edit-added-colors').innerHTML = `<span>New colors</span>${newColors.map(color => `<span class="ai-edit-new-swatch" style="background:${escapeHTML(color)}" title="${escapeHTML(color.toUpperCase())}" aria-label="${escapeHTML(color.toUpperCase())}"></span>`).join('')}`;
    $('ai-edit-review').hidden = false;
    progress('Proposal validated. Review it before applying.');
    updateHighlight();
    updateControls();
    saveDraft();
    scrollBodyTo($('ai-edit-review'), true);
  }

  async function generate(refining=false) {
    setError('');
    if(!refining && request?.refinement) request=null;
    let currentRequest, previews;
    try {
      if(refining) {
        if(!proposal || busy)return;
        currentRequest=createRefinementRequest(proposal.project,request);
        const frames=refinementFrames(proposal.project,request);
        previews=[renderRefinementPreview(sourceProject,frames),renderRefinementPreview(proposal.project,frames)];
      } else currentRequest=getRequest();
    } catch(error) { setError(error.message);return; }
    if (!currentRequest) return;
    if (method === 'paste' && !refining) {
      if (!$('ai-edit-response').reportValidity()) return;
      clearProposal();
      try { showProposal($('ai-edit-response').value, currentRequest); } catch (error) { setError(error.message); }
      return;
    }
    if (!connection.connected || !connection.csrfToken || busy) return;
    if(!refining) clearProposal();
    else setPlaying(false);
    busy = true;
    updateControls();
    progress('Starting your edit…');
    const controller = new AbortController();
    editController = controller;
    let lastProgress = 0;
    try {
      const response = await fetch('/api/local-ai/edit', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Pixel-Studio-Token': connection.csrfToken },
        body: JSON.stringify({ prompt: currentRequest.prompt, ...(previews?{previews}:{}), ...($('ai-edit-model').value ? { model: $('ai-edit-model').value } : {}) }),
      });
      const text = await readLocalEditResponse(response, event => {
        if (disposed || controller.signal.aborted) return;
        if (event.type === 'status') progress(event.message || 'Codex is preparing your edit…');
        if (event.type === 'delta' && performance.now() - lastProgress > 200) {
          lastProgress = performance.now();
          progress('Receiving pixel data…', `${event.characters.toLocaleString()} characters`);
        }
      }, controller.signal);
      if (disposed || controller.signal.aborted) return;
      busy = false;
      showProposal(text, currentRequest);
    } catch (error) {
      if (disposed) return;
      busy = false;
      if (controller.signal.aborted) progress('Generation stopped. Your original artwork is still in place.');
      else { progress(''); setError(error.message || 'Codex could not finish this edit. Try again.'); }
    } finally {
      if (!disposed) {
        busy = false;
        editController = null;
        updateControls();
        saveDraft();
        refreshStatus();
      }
    }
  }

  async function copyPrompt() {
    setError('');
    const currentRequest = getRequest();
    if (!currentRequest) return;
    try {
      await navigator.clipboard.writeText(currentRequest.prompt);
      if (disposed) return;
      toast('Edit prompt copied. Paste the complete response under Paste AI result.');
    } catch {
      if (disposed) return;
      $('ai-edit-prompt-details').open = true;
      $('ai-edit-prompt').focus({ preventScroll: true });
      $('ai-edit-prompt').select();
      scrollBodyTo($('ai-edit-prompt'), true);
      toast('Prompt selected. Press Ctrl/⌘ C to copy it.');
    }
  }

  function invalidateRequest() {
    request = null;
    clearProposal();
    setError('');
    progress('');
    $('ai-edit-prompt').value = '';
    $('ai-edit-prompt-size').textContent = '';
    scopeHelp();
    saveDraft();
  }

  function updateHighlight() {
    clearInterval(highlightTimer);
    highlightVisible = true;
    renderPreview();
    if (proposal && request.mode === 'inpaint' && $('ai-edit-highlight').checked && !matchMedia('(prefers-reduced-motion: reduce)').matches && !document.hidden) {
      highlightTimer = setInterval(() => { highlightVisible = !highlightVisible; renderPreview(); }, 650);
    }
  }

  function dispose() {
    if (disposed) return;
    saveDraft();
    disposed = true;
    editController?.abort();
    statusController?.abort();
    clearTimeout(statusTimeout);
    clearInterval(highlightTimer);
    cancelAnimationFrame(animationHandle);
    resizeObserver?.disconnect();
    replacementObserver.disconnect();
    modal.removeEventListener('close', dispose);
    modal.removeEventListener('cancel', dispose);
    modal.removeEventListener('pixel-studio:dialog-replace', dispose);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    modal.classList.remove('ai-edit-modal');
    if (disposeActiveDialog === dispose) disposeActiveDialog = null;
  }

  const onVisibilityChange = () => { if (document.hidden) setPlaying(false); updateHighlight(); };
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(sizeCanvases) : null;
  form.querySelectorAll('.ai-edit-stage').forEach(stage => resizeObserver?.observe(stage));
  const replacementObserver = new MutationObserver(() => { if (!form.isConnected) dispose(); });
  replacementObserver.observe(document.getElementById('modal-content'), { childList: true });
  modal.addEventListener('close', dispose);
  modal.addEventListener('cancel', dispose);
  modal.addEventListener('pixel-studio:dialog-replace', dispose);
  document.addEventListener('visibilitychange', onVisibilityChange);
  disposeActiveDialog = dispose;
  $('ai-edit-instruction').addEventListener('input', invalidateRequest);
  $('ai-edit-scope').addEventListener('change', invalidateRequest);
  $('ai-edit-mode').addEventListener('change', () => { invalidateRequest(); updateControls(); });
  $('ai-edit-model').addEventListener('change', ()=>{saveDraft();updateControls();});
  $('ai-edit-response').addEventListener('input', () => { clearProposal(); setError(''); progress(''); saveDraft(); });
  $('ai-edit-refresh').onclick = refreshStatus;
  $('ai-edit-copy').onclick = copyPrompt;
  $('ai-edit-refine').onclick=()=>generate(true);
  $('ai-edit-close').onclick = () => modal.close();
  $('ai-edit-stop').onclick = () => { progress('Stopping generation…'); editController?.abort(); };
  $('ai-edit-local-tab').onclick = () => setMethod('local');
  $('ai-edit-paste-tab').onclick = () => setMethod('paste');
  form.querySelector('.ai-edit-methods').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy) return;
    event.preventDefault();
    setMethod(event.key === 'Home' ? 'local' : event.key === 'End' ? 'paste' : method === 'local' ? 'paste' : 'local', true);
  });
  $('ai-edit-prompt-details').addEventListener('toggle', () => { if ($('ai-edit-prompt-details').open) getRequest(false); });
  form.onsubmit = event => { event.preventDefault(); generate(); };
  $('ai-edit-play').onclick = () => setPlaying(!playing);
  $('ai-edit-frame').addEventListener('input', () => { setPlaying(false); previewFrameIndex = Number($('ai-edit-frame').value); renderPreview(); });
  $('ai-edit-highlight').onchange = updateHighlight;
  $('ai-edit-preview-layer').onchange = renderPreview;
  $('ai-edit-preview-animation').onchange = () => { setPlaying(false); previewAnimationId = $('ai-edit-preview-animation').value; previewFrameIndex = 0; renderPreview(); };
  $('ai-edit-apply').onclick = async () => {
    if (!proposal?.hasChanges || busy) return;
    setError('');
    busy = true;
    updateControls();
    $('ai-edit-stop').hidden = true;
    try {
      const accepted = await onApply(proposal.project, sourceProject, documentId);
      if (accepted === false) throw new Error('The edit could not be applied. Reopen AI editing and try again.');
      applied = true;
      drafts.delete(key);
      modal.close();
    } catch (error) {
      if (!disposed) { busy = false; updateControls(); setError(error.message || 'The edit could not be applied.'); }
    }
  };

  scopeHelp();
  setMethod(method);
  renderConnection();
  if (local) refreshStatus();
  $('ai-edit-instruction').focus({ preventScroll: true });
  return dispose;
}
