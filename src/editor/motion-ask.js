/**
 * "Describe a motion" dialog: type "make him wave twice" or "bounce 3 times"; the offline phrase parser (or an AI reply)
 * becomes a motion plan that runs on a copy of the project (motion-intent.js), previews live in the dialog and the Live
 * Preview, and applies as one undo step: a new animation, appended to, or replacing the current one.
 */
import { runMotionPlan, normalizePlan, describeStep, motionTargets } from '../domain/motion-intent.js';
import { parseMotionText } from '../domain/motion-phrases.js';
import { buildMotionPrompt, parseMotionResponse } from '../features/ai/motion-prompt.js';
import { readLocalEditResponse } from '../features/ai/local-client.js';
import { compositeFrame } from '../domain/project.js';

let d, last = '';
const SPEEDS = [[.6, 'Slow'], [1, 'Normal'], [1.6, 'Fast']];
const NO_FRAMES = new Set(['repeat', 'newAnimation', 'squash', 'follow']);

export function initMotionAsk(deps) { d = deps; }

/** Example requests that suit the project: rig phrases for a character, object phrases otherwise. */
function examples(t) {
  if (t.characters.length) return ['make him wave twice', 'jump', 'walk cycle', 'nod', 'shake head', 'run fast', 'bounce 3 times', 'turn around', 'wave, then jump'];
  const name = t.objects[0]?.name ? `the ${t.objects[0].name.toLowerCase()}` : 'it';
  return ['bounce 3 times', `spin ${name}`, `move ${name} to the right`, 'squash and stretch', 'flip around', 'shake', 'bounce, then spin'];
}

/** Open the dialog, optionally with a request already typed in. */
export function motionAskDialog(initial = last) {
  const { state, $, escapeHTML: esc, icon } = d;
  if (state.inPlaceEdit) { d.toast('Finish editing the object on the canvas first.'); return; }
  const ctx = () => ({ animationId: state.animationId, frameId: state.frameId });
  const t = motionTargets(state.project, ctx());
  if (!t.objects.length) { d.toast('Place a part on the canvas first, then describe how it moves.'); return; }
  const s = { plan: null, result: null, mode: 'new', name: '', nameEdited: false, connection: null, busy: false, started: 0 };
  d.openDialog('Describe a motion', `<form id="ma-form" class="maths-form motion-ask" autocomplete="off">
    <p class="modal-body-text">Say what should happen in plain words. Pixel Studio turns it into rig poses, templates and maths steps, and shows a preview before anything changes.</p>
    <div class="ma-ask"><input id="ma-text" type="text" maxlength="300" aria-label="Describe a motion" placeholder="e.g. ${esc(examples(t)[0])}, then jump" value="${esc(initial)}"><button type="submit" class="button primary">${icon('spark')} Interpret</button></div>
    <div class="motion-chips ma-examples" aria-label="Examples">${examples(t).map(x => `<button type="button" class="motion-chip" data-example="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    <p id="ma-error" class="maths-error" role="alert"></p>
    <section id="ma-result" class="ma-result" hidden>
      <div class="ma-grid"><div class="ma-preview-box"><canvas id="ma-preview" class="wave-preview ma-preview" role="img" aria-label="Preview of the motion"></canvas><span id="ma-frame" class="ma-frame"></span></div>
        <div class="ma-plan"><ol id="ma-steps" class="ma-steps" aria-label="Interpreted steps"></ol><ul id="ma-warnings" class="ma-warnings"></ul><p id="ma-info" class="maths-info" aria-live="polite"></p></div></div>
      <div class="form-grid"><label class="field"><span class="field-label">Result</span><select id="ma-mode"><option value="new">New animation</option><option value="append">Add to “${esc(t.animation.name)}”</option><option value="replace">Replace “${esc(t.animation.name)}”</option></select></label>
        <label class="field"><span class="field-label">Name</span><input id="ma-name" type="text" maxlength="60"></label></div>
      <details class="ma-json"><summary>Motion plan (JSON)</summary><textarea id="ma-json" rows="6" spellcheck="false" aria-label="Motion plan JSON"></textarea><button type="button" id="ma-json-use" class="button small">Use edited plan</button></details>
    </section>
    <section id="ma-ai" class="ma-ai" hidden>
      <h3 class="object-action-heading">Ask AI</h3>
      <p id="ma-ai-status" class="maths-info">Copy this prompt into any AI chat, then paste its JSON reply below.</p>
      <textarea id="ma-ai-prompt" rows="5" readonly aria-label="Prompt for the AI"></textarea>
      <div class="ma-ai-actions"><button type="button" id="ma-ai-copy" class="button small">${icon('copy')} Copy prompt</button><button type="button" id="ma-ai-send" class="button small" hidden>${icon('spark')} Ask Codex</button></div>
      <textarea id="ma-ai-reply" rows="4" spellcheck="false" placeholder='Paste the reply: {"steps":[{"op":"bounce","times":2}]}' aria-label="AI reply"></textarea>
      <button type="button" id="ma-ai-use" class="button small">Use this plan</button>
    </section>
    <div class="modal-actions"><button type="button" id="ma-ai-open" class="button">${icon('spark')} Ask AI instead</button><span class="ma-spacer"></span><button type="button" id="ma-cancel" class="button">Cancel</button><button type="button" id="ma-apply" class="button primary" disabled>Apply</button></div>
  </form>`, 'ANIMATE');
  $('modal').classList.add('wide');
  const form = $('ma-form'), error = msg => { $('ma-error').textContent = msg || ''; };

  const options = () => ({ ...ctx(), selection: state.objectSelection ? { layerId: state.objectSelection.layerId, key: state.objectSelection.key } : undefined, mode: s.mode, name: s.name || undefined });
  function preview() {
    s.result = null; state.previewOverride = null;
    try {
      s.result = runMotionPlan(state.project, s.plan, options());
      const shown = s.result.project.animations.find(a => a.id === s.result.animationId);
      // The Live Preview plays state.animationId, so show the result under that id.
      state.previewOverride = { ...s.result.project, animations: s.result.project.animations.map(a => a.id === state.animationId ? { ...shown, id: a.id } : a) };
      state.previewIndex = 0; state.previewTime = 0; s.started = performance.now();
      error('');
    } catch (e) { error(e.message); }
    d.renderPreview();
    renderResult();
  }
  function renderResult() {
    $('ma-result').hidden = !s.plan;
    $('ma-apply').disabled = !s.result;
    if (!s.plan) return;
    const counts = s.result?.summary || [];
    $('ma-steps').innerHTML = s.plan.steps.map((step, i) => {
      const frames = NO_FRAMES.has(step.op) ? '' : `<label title="Frames">Frames <input type="number" min="1" max="64" data-i="${i}" data-k="frames" value="${step.frames ?? ''}" placeholder="auto"></label>`;
      const times = ['hold', 'newAnimation'].includes(step.op) ? '' : `<label title="Times">× <input type="number" min="${step.op === 'repeat' ? 2 : 1}" max="16" data-i="${i}" data-k="times" value="${step.times ?? 1}"></label>`;
      const speed = NO_FRAMES.has(step.op) || step.op === 'hold' ? '' : `<select data-i="${i}" data-k="speed" aria-label="Speed">${SPEEDS.map(([v, l]) => `<option value="${v}"${Math.abs((step.speed ?? 1) - v) < .01 ? ' selected' : ''}>${l}</option>`).join('')}${SPEEDS.some(([v]) => Math.abs((step.speed ?? 1) - v) < .01) ? '' : `<option selected value="${step.speed}">×${step.speed}</option>`}</select>`;
      return `<li class="ma-step"><span class="motion-chip active" title="${esc(describeStep(step))}">${esc(describeStep(step))}</span><span class="ma-step-meta">${counts[i] ? `${counts[i].frames} fr` : ''}</span><span class="ma-params">${frames}${times}${speed}<button type="button" class="icon-button ma-remove" data-remove="${i}" aria-label="Remove step ${i + 1}" title="Remove step">${icon('trash')}</button></span></li>`;
    }).join('');
    $('ma-warnings').innerHTML = (s.result?.warnings || []).map(w => `<li>${esc(w)}</li>`).join('');
    const shown = s.result?.project.animations.find(a => a.id === s.result.animationId);
    $('ma-info').textContent = shown ? `“${shown.name}”: ${shown.frames.length} frames at ${shown.fps} fps. Check the preview, then Apply (one undo step).` : '';
    if (!s.nameEdited) $('ma-name').value = s.mode === 'new' ? shown?.name || '' : '';
    $('ma-name').disabled = s.mode !== 'new';
    $('ma-json').value = JSON.stringify({ name: s.plan.name, steps: s.plan.steps }, null, 1);
  }
  function setPlan(plan, note) {
    try { s.plan = normalizePlan(plan); } catch (e) { s.plan = null; renderResult(); error(e.message); return; }
    preview();
    if (note && s.result) $('ma-info').textContent = `${note} ${$('ma-info').textContent}`;
  }
  function interpret() {
    const text = $('ma-text').value.trim();
    last = text;
    if (!text) { error('Describe a motion first, or pick an example.'); return; }
    const scene = motionTargets(state.project, ctx());
    const { plan, unknown } = parseMotionText(text, { poses: scene.poses.map(p => p.name), width: scene.width, height: scene.height, rigged: scene.characters.length > 0 });
    if (!plan.steps.length) { s.plan = null; s.result = null; state.previewOverride = null; d.renderPreview(); renderResult(); error(`I couldn’t read “${text}” offline. Try one of the examples, or Ask AI.`); openAI(); return; }
    s.nameEdited = false;
    setPlan(plan, unknown.length ? `Skipped “${unknown.join('”, “')}” (not understood; try Ask AI).` : '');
  }

  // ---- AI path ------------------------------------------------------------------------------------------------
  async function openAI() {
    $('ma-ai').hidden = false;
    $('ma-ai-prompt').value = buildMotionPrompt(state.project, ctx(), $('ma-text').value.trim() || '(describe the motion here)');
    if (s.connection) return;
    s.connection = { connected: false };
    try {
      const response = await fetch('/api/local-ai/status', { cache: 'no-store', credentials: 'same-origin' }), result = await response.json();
      if (response.ok && result.local === true && result.connected === true && (result.authMode === 'chatgpt' || (result.cloud === true && result.authMode === 'cloud')) && typeof result.csrfToken === 'string') s.connection = { connected: true, csrfToken: result.csrfToken, label: result.cloud ? 'the AI' : 'Codex' };
    } catch { /* hosted edition: copy and paste only */ }
    if (!form.isConnected) return;
    $('ma-ai-send').hidden = !s.connection.connected;
    if (s.connection.connected) $('ma-ai-status').textContent = `Ask ${s.connection.label} directly, or copy the prompt into any AI chat and paste its JSON reply below.`;
  }
  async function askCodex() {
    if (s.busy || !s.connection?.connected) return;
    s.busy = true; $('ma-ai-send').disabled = true; $('ma-ai-status').textContent = `Asking ${s.connection.label} for a motion plan…`;
    try {
      const response = await fetch('/api/local-ai/edit', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Pixel-Studio-Token': s.connection.csrfToken }, body: JSON.stringify({ prompt: $('ma-ai-prompt').value }) });
      const text = await readLocalEditResponse(response, event => { if (event.type === 'status' && form.isConnected) $('ma-ai-status').textContent = event.message || 'Codex is thinking…'; });
      if (!form.isConnected) return;
      $('ma-ai-reply').value = text;
      $('ma-ai-status').textContent = `${s.connection.label === 'Codex' ? 'Codex' : 'The AI'} replied. Check the plan and preview.`;
      useReply();
    } catch (e) { if (form.isConnected) { $('ma-ai-status').textContent = ''; error(e.message || 'Codex could not answer. Copy the prompt instead.'); } }
    finally { s.busy = false; if (form.isConnected) $('ma-ai-send').disabled = false; }
  }
  function useReply() {
    let plan;
    try { plan = parseMotionResponse($('ma-ai-reply').value); } catch (e) { error(e.message); return; }
    s.nameEdited = false;
    setPlan(plan, 'AI plan:');
  }
  async function copyPrompt() {
    const text = $('ma-ai-prompt').value;
    try { await navigator.clipboard.writeText(text); d.toast('Prompt copied. Paste the AI’s JSON reply below.'); }
    catch { $('ma-ai-prompt').select(); document.execCommand?.('copy'); d.toast('Prompt selected: copy it with ⌘/Ctrl + C.'); }
  }

  function apply() {
    let result;
    try { result = runMotionPlan(state.project, s.plan, options()); } catch (e) { error(e.message); return; }
    const shown = result.project.animations.find(a => a.id === result.animationId), first = result.frameIds.find(id => shown.frames.some(f => f.id === id)) || shown.frames[0].id;
    state.previewOverride = null;
    d.versionBefore(`Before motion “${shown.name}”`);
    try { d.mutate(() => { state.project = result.project; Object.assign(state, { animationId: shown.id, frameId: first, previewIndex: 0, previewTime: 0 }); }); }
    catch (e) { error(e.message); return; }
    $('modal').close(); d.renderAll();
    d.toast(`${s.mode === 'new' ? `“${shown.name}” created` : s.mode === 'append' ? `Added to “${shown.name}”` : `“${shown.name}” replaced`}: ${result.frameIds.length} frames. Undo with ⌘/Ctrl + Z.`);
  }

  // ---- Events -------------------------------------------------------------------------------------------------
  form.onsubmit = event => { event.preventDefault(); interpret(); };
  form.addEventListener('click', event => {
    const el = event.target.closest('button');
    if (!el) return;
    if (el.dataset.example) { $('ma-text').value = el.dataset.example; interpret(); }
    else if (el.dataset.remove) { const steps = s.plan.steps.filter((_, i) => i !== Number(el.dataset.remove)); if (steps.length) setPlan({ ...s.plan, steps }); else { s.plan = null; s.result = null; state.previewOverride = null; d.renderPreview(); renderResult(); } }
    else if (el.id === 'ma-json-use') { try { setPlan(JSON.parse($('ma-json').value)); } catch (e) { error(e instanceof SyntaxError ? `The JSON has a typo: ${e.message}` : e.message); } }
    else if (el.id === 'ma-ai-open') { openAI(); $('ma-ai').scrollIntoView({ block: 'nearest' }); }
    else if (el.id === 'ma-ai-copy') copyPrompt();
    else if (el.id === 'ma-ai-send') askCodex();
    else if (el.id === 'ma-ai-use') useReply();
    else if (el.id === 'ma-cancel') $('modal').close();
    else if (el.id === 'ma-apply') apply();
  });
  form.addEventListener('change', event => {
    const el = event.target;
    if (el.dataset.k && s.plan) {
      const step = { ...s.plan.steps[el.dataset.i] }, v = el.value === '' ? undefined : Number(el.value);
      if (v === undefined) delete step[el.dataset.k]; else step[el.dataset.k] = v;
      setPlan({ ...s.plan, steps: s.plan.steps.map((x, i) => (i === Number(el.dataset.i) ? step : x)) });
    } else if (el.id === 'ma-mode') { s.mode = el.value; if (s.plan) preview(); }
    else if (el.id === 'ma-name') { s.name = el.value.trim(); s.nameEdited = Boolean(s.name); if (s.plan) preview(); }
  });
  $('ma-text').addEventListener('input', () => { if (!$('ma-ai').hidden) $('ma-ai-prompt').value = buildMotionPrompt(state.project, ctx(), $('ma-text').value.trim()); });

  const tick = time => {
    if (!$('modal').open || !form.isConnected) { state.previewOverride = null; d.renderPreview(); return; }
    const project = s.result?.project, animation = project?.animations.find(a => a.id === s.result.animationId);
    if (animation?.frames.length) {
      const total = animation.frames.reduce((n, f) => n + (f.duration || 1000 / animation.fps), 0);
      let at = (time - s.started) % total, index = 0;
      while (at >= (animation.frames[index].duration || 1000 / animation.fps)) at -= animation.frames[index++].duration || 1000 / animation.fps;
      d.paintSprite($('ma-preview'), compositeFrame(project, animation.frames[index]), project.palette, true, project.width, project.height);
      $('ma-frame').textContent = `${index + 1} / ${animation.frames.length}`;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  $('ma-text').focus();
  if (initial) interpret();
}
