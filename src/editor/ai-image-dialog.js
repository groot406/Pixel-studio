/**
 * "Generate image" dialog: describe a sprite, let a general image model (OpenAI gpt-image-1, Google Gemini
 * "Nano Banana", or any chatbot via copy/paste) draw something that looks like pixel art, then clean it
 * into real pixels (grid detection, key-colour removal, palette mapping) and place it as a new project,
 * layer, frame, object or animation in one undo step.
 * Keys: Pixel Studio Local proxies through /api/image/* with keys from its environment; the web build
 * calls the provider directly with a key the user pastes (kept in memory unless they choose to remember it).
 */
import { buildImagePrompt, IMAGE_SIZES, IMAGE_VIEWS, IMAGE_STYLES, IMAGE_BACKGROUNDS } from '../features/ai/image-prompt.js';
import { IMAGE_PROVIDERS, IMAGE_ERROR_MESSAGES, ImageApiError, requestImages } from '../features/ai/image-api.js';
import { cleanImage, sliceSheet, placeRgba } from '../domain/image-pipeline.js';
import { edgeProfiles, detectGrid } from '../domain/pixelize.js';
import { indicesToRgba, mapRgbaPerceptual } from '../domain/palette-map.js';
import { blankProject, makeLayeredFrame, compositeFrame, uid, paletteFromRgba, mapRgbaToPalette, MAX_SIZE, MAX_COLORS } from '../domain/project.js';
import { createObjectFromPixels } from '../domain/object-create.js';
import { encodePng } from '../formats/png.js';
import { isCloudEdition } from '../features/cloud/client.js';
import { imageCredits } from '../features/cloud/plans.js';

let d;
const KEY_STORE = 'pixel-studio.image-keys';
const memoryKeys = {};
export const hasStoredKey = provider => !!storedKeys()[provider];
const prefs = {
  subject: '', size: 32, view: 'side', style: 'snes', outline: true, usePalette: false, background: 'magenta', frames: 1,
  reference: false, provider: '', models: {}, n: 2, quality: 'low', sizing: 'auto', colors: '16', dither: false, removeBg: true, destination: 'project',
};
const isLoopback = () => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname) && ['http:', 'https:'].includes(location.protocol);

/** deps: state, $, icon, escapeHTML, openDialog, toast, mutate, versionBefore, replaceProject, currentAnimation, currentFrame,
 * currentLayer, insertLayer, canAddFrame, canAddLayer, canEditPixels, objectTarget, decodeImage, imageRgba. */
export function initAiImage(deps) { d = deps; }

function storedKeys() {
  try { const value = JSON.parse(localStorage.getItem(KEY_STORE) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
/** API keys are shared with the assistant (OpenAI). */
export function keyFor(provider) { return memoryKeys[provider] || storedKeys()[provider] || ''; }
export function rememberKey(provider, key, remember) {
  memoryKeys[provider] = key;
  const stored = storedKeys();
  if (remember && key) stored[provider] = key; else delete stored[provider];
  try { if (Object.keys(stored).length) localStorage.setItem(KEY_STORE, JSON.stringify(stored)); else localStorage.removeItem(KEY_STORE); } catch { /* private mode */ }
}

function base64Blob(base64) {
  const binary = atob(base64), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const type = base64.startsWith('/9j/') ? 'image/jpeg' : base64.startsWith('UklGR') ? 'image/webp' : 'image/png';
  return new File([bytes], `generated.${type.split('/')[1]}`, { type });
}
async function blobBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The current frame, flattened and upscaled with nearest-neighbour so each pixel is a clear block. */
async function referencePng() {
  const { state } = d, p = state.project;
  const pixels = compositeFrame(p, d.currentFrame());
  if (pixels.every(v => v < 0)) throw new Error('The current frame is empty. Draw something first, or turn off “Redraw the current frame”.');
  const scale = Math.max(1, Math.floor(1024 / Math.max(p.width, p.height)));
  const small = indicesToRgba(pixels, p.palette), W = p.width * scale, H = p.height * scale, big = new Uint8ClampedArray(W * H * 4);
  // A flat key colour behind the sprite matches what the prompt asks the model to keep.
  for (let i = 0; i < W * H; i += 1) big.set([255, 0, 255, 255], i * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const s = (((y / scale) | 0) * p.width + ((x / scale) | 0)) * 4;
    if (small[s + 3]) big.set(small.subarray(s, s + 4), (y * W + x) * 4);
  }
  return blobBase64(await encodePng(big, W, H));
}

const capitalise = text => text ? text[0].toUpperCase() + text.slice(1) : text;
const nameFrom = subject => capitalise(String(subject || '').replace(/^(an?|the)\s+/i, '').trim().slice(0, 60)) || 'Generated sprite';

export function openAiImageDialog() {
  const { state, $, icon, escapeHTML: esc } = d;
  if (state.inPlaceEdit) { d.toast('Finish editing the object on the canvas first.'); return; }
  const s = { local: null, variations: [], selected: null, busy: false, controller: null, disposed: false, statusText: '' };
  const option = (value, label, current) => `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(label)}</option>`;
  const swatches = state.project.palette.slice(0, 32).map(c => `<span style="--c:${esc(c)}"></span>`).join('');
  d.openDialog('Generate an image', `<form id="aii-form" class="ai-image" autocomplete="off" novalidate>
    <p class="modal-body-text">An image model draws something that <em>looks</em> like pixel art; Pixel Studio finds its hidden pixel grid and turns it into real, editable pixels.</p>
    <div class="aii-columns">
      <section class="aii-brief" aria-label="Describe the image">
        <label class="field"><span class="field-label">What should it draw?</span><textarea id="aii-subject" rows="3" maxlength="1000" placeholder="a small knight with a blue cape and a round shield">${esc(prefs.subject)}</textarea></label>
        <div class="form-grid aii-grid">
          <label class="field"><span class="field-label">Size</span><select id="aii-size">${IMAGE_SIZES.map(n => option(n, `${n} × ${n} pixels`, prefs.size)).join('')}</select></label>
          <label class="field"><span class="field-label">View</span><select id="aii-view">${Object.entries(IMAGE_VIEWS).map(([k, v]) => option(k, capitalise(v.split(/[,(]/)[0].trim()), prefs.view)).join('')}</select></label>
          <label class="field"><span class="field-label">Style</span><select id="aii-style">${Object.entries(IMAGE_STYLES).map(([k, v]) => option(k, v.label, prefs.style)).join('')}</select></label>
          <label class="field"><span class="field-label">Background</span><select id="aii-background">${Object.entries(IMAGE_BACKGROUNDS).map(([k, v]) => option(k, v.label, prefs.background)).join('')}</select></label>
          <label class="field"><span class="field-label">Frames</span><select id="aii-frames">${[1, 2, 3, 4, 6, 8].map(n => option(n, n === 1 ? 'Single image' : `Sprite sheet · ${n} frames in a row`, prefs.frames)).join('')}</select></label>
          <label class="field"><span class="field-label">Variations</span><select id="aii-n">${[1, 2, 3, 4].map(n => option(n, `${n} image${n > 1 ? 's' : ''}`, prefs.n)).join('')}</select></label>
        </div>
        <label class="check-row"><input id="aii-outline" type="checkbox"${prefs.outline ? ' checked' : ''}><span>Dark 1-pixel outline</span></label>
        <label class="check-row"><input id="aii-palette" type="checkbox"${prefs.usePalette ? ' checked' : ''}><span>Ask for the current palette colours</span><span class="aii-swatches" aria-hidden="true">${swatches}</span></label>
        <label class="check-row"><input id="aii-reference" type="checkbox"${prefs.reference ? ' checked' : ''}><span>Redraw the current frame (sent as a reference image)</span></label>
        <div class="form-grid aii-provider">
          <label class="field"><span class="field-label">Image model</span><select id="aii-provider"></select></label>
          <label class="field" id="aii-model-field"><span class="field-label">Model</span><select id="aii-model"></select></label>
          <label class="field" id="aii-quality-field"><span class="field-label">Quality</span><select id="aii-quality">${[['low', 'Low · cheapest'], ['medium', 'Medium'], ['high', 'High']].map(([v, l]) => option(v, l, prefs.quality)).join('')}</select></label>
        </div>
        <div id="aii-key" class="aii-key" hidden>
          <label class="field"><span class="field-label" id="aii-key-label">API key</span><input id="aii-key-input" type="password" autocomplete="off" spellcheck="false"></label>
          <label class="check-row"><input id="aii-key-remember" type="checkbox"><span>Remember on this device</span></label>
          <p class="helper-text aii-warning">Your key goes straight from this browser to the provider and is billed to your account. Remembered keys are stored unencrypted in this browser’s local storage; anyone using this browser profile can read them. Use a key with a spending limit.</p>
        </div>
        <p id="aii-status" class="helper-text" aria-live="polite"></p>
        <details class="aii-prompt"><summary>Prompt</summary><textarea id="aii-prompt" rows="7" readonly aria-label="Image prompt"></textarea></details>
        <div class="modal-actions aii-actions">
          <button type="button" id="aii-copy" class="button">${icon('copy')} Copy prompt</button>
          <button type="button" id="aii-upload" class="button">${icon('image')} Upload image</button>
          <button type="submit" id="aii-generate" class="button primary">${icon('spark')} Generate</button>
        </div>
        <input id="aii-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
      </section>
      <section class="aii-results" aria-label="Results">
        <div id="aii-drop" class="aii-drop"><strong>Paste (⌘V), drop or upload an image</strong><span>Using ChatGPT, Gemini or another chatbot? Copy the prompt, paste it there, then paste the image it makes here.</span></div>
        <div id="aii-variations" class="aii-variations" role="listbox" aria-label="Variations"></div>
        <div id="aii-clean" class="aii-clean" hidden>
          <div class="png-import-preview aii-preview"><canvas id="aii-preview"></canvas><span id="aii-note" class="png-detect-note"></span></div>
          <div class="form-grid">
            <label class="field"><span class="field-label">Pixel grid</span><select id="aii-sizing">${[['auto', 'Auto · detect, else downscale'], ['detect', 'Detect the pixel grid'], ['average', 'Downscale to the chosen size']].map(([v, l]) => option(v, l, prefs.sizing)).join('')}</select></label>
            <label class="field" id="aii-colors-field"><span class="field-label">Colors</span><select id="aii-colors">${option('palette', 'Use current palette', prefs.colors)}${[8, 16, 32, 64].map(n => option(n, `${n} colors`, prefs.colors)).join('')}</select></label>
            <label class="field aii-destination"><span class="field-label">Add as</span><select id="aii-destination"></select></label>
          </div>
          <label class="check-row"><input id="aii-remove-bg" type="checkbox"${prefs.removeBg ? ' checked' : ''}><span>Remove background</span></label>
          <label class="check-row"><input id="aii-dither" type="checkbox"${prefs.dither ? ' checked' : ''}><span>Dither when mapping colours</span></label>
        </div>
      </section>
    </div>
    <p id="aii-error" class="sheet-error" role="alert" hidden></p>
    <div class="modal-actions"><button type="button" id="aii-cancel" class="button">Cancel</button><button type="button" id="aii-apply" class="button primary" disabled>${icon('check')} Add to project</button></div>
  </form>`, 'IMAGE MODEL');
  const modal = $('modal');
  modal.classList.add('wide', 'ai-image-modal');
  const error = message => { $('aii-error').textContent = message || ''; $('aii-error').hidden = !message; };
  const status = text => { $('aii-status').textContent = text || ''; };

  // ----- provider and prompt -----
  function providerOptions() {
    const list = [];
    if (s.local?.cloud) { for (const [id, p] of Object.entries(IMAGE_PROVIDERS)) if (s.local.providers?.[id]?.available || !s.local.signedIn) list.push([`local:${id}`, `${p.label} · Pixel Studio Cloud credits`]); }
    else if (s.local) for (const [id, p] of Object.entries(IMAGE_PROVIDERS)) list.push([`local:${id}`, `${p.label} · via Pixel Studio Local${s.local.providers?.[id]?.available ? '' : ' (no key)'}`]);
    else if (s.local === false) for (const [id, p] of Object.entries(IMAGE_PROVIDERS)) list.push([`key:${id}`, `${p.label} · your API key`]);
    list.push(['chat', 'Any chatbot · copy the prompt, paste the image']);
    return list;
  }
  function renderProviders() {
    const list = providerOptions();
    if (!list.some(([v]) => v === prefs.provider)) {
      const ready = s.local ? list.find(([v]) => v.startsWith('local:') && s.local.providers?.[v.slice(6)]?.available) : list.find(([v]) => v.startsWith('key:') && keyFor(v.slice(4)));
      prefs.provider = (ready || list[0])[0];
    }
    $('aii-provider').innerHTML = list.map(([v, l]) => option(v, l, prefs.provider)).join('');
    renderProvider();
  }
  const providerId = () => prefs.provider.split(':')[1] || '';
  function renderProvider() {
    const kind = prefs.provider.split(':')[0], id = providerId(), meta = IMAGE_PROVIDERS[id];
    $('aii-model-field').hidden = !meta;
    $('aii-quality-field').hidden = id !== 'openai';
    if (meta) $('aii-model').innerHTML = meta.models.map(m => option(m, m, prefs.models[id] || meta.defaultModel)).join('');
    $('aii-key').hidden = kind !== 'key';
    if (kind === 'key') {
      $('aii-key-label').textContent = `${meta.label} API key`;
      $('aii-key-input').placeholder = meta.keyHint;
      $('aii-key-input').value = keyFor(id);
      $('aii-key-remember').checked = !!storedKeys()[id];
    }
    $('aii-generate').hidden = kind === 'chat';
    $('aii-n').disabled = kind === 'chat';
    let text = '';
    if (kind === 'chat') text = 'Copy the prompt into ChatGPT, Gemini, Copilot or any image-capable chatbot, then paste (⌘V) or drop the image it makes here. Free with your existing chat plan.';
    else if (kind === 'local' && s.local.cloud && !s.local.signedIn) text = 'Sign in (Account, top right) to generate images with your AI credits.';
    else if (kind === 'local' && s.local.cloud) { const cost = imageCredits(id, { n: prefs.n, quality: id === 'openai' ? prefs.quality : 'medium' }); text = `Uses ${cost} credit${cost === 1 ? '' : 's'} (${s.local.credits?.balance ?? 0} left).`; }
    else if (kind === 'local' && !s.local.providers?.[id]?.available) text = `No ${meta.label} key found. Start Pixel Studio Local with ${id === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'} set, or add "${id}" to ~/.pixelstudio/keys.json, then reopen this dialog.`;
    else if (kind === 'local') text = `${meta.label} key found on this computer. It stays there; Pixel Studio Local sends the request for you.`;
    else if (kind === 'key') text = `Get a key at ${meta.keyUrl}. Each image is billed to your ${meta.label} account.`;
    if (s.local === null) text = isCloudEdition() ? 'Checking your account…' : 'Checking for Pixel Studio Local…';
    status(s.busy ? s.statusText : text);
    updateButtons();
  }
  function promptOptions() {
    const id = providerId();
    const background = prefs.background === 'transparent' && id !== 'openai' ? 'magenta' : prefs.background;
    return { subject: prefs.subject, size: prefs.size, view: prefs.view, style: prefs.style, outline: prefs.outline, usePalette: prefs.usePalette, palette: state.project.palette, background, frames: prefs.frames, reference: prefs.reference };
  }
  function prompt() { try { return buildImagePrompt(promptOptions()); } catch { return ''; } }
  function renderPrompt() { $('aii-prompt').value = prompt() || 'Describe what to draw first.'; updateButtons(); }
  function updateButtons() {
    const kind = prefs.provider.split(':')[0], id = providerId();
    const ready = kind === 'local' ? !!s.local?.providers?.[id]?.available && !!s.local.csrfToken : kind === 'key' ? !!$('aii-key-input').value.trim() : false;
    $('aii-generate').disabled = s.busy || !prefs.subject.trim() || !ready;
    $('aii-generate').innerHTML = s.busy ? `${icon('spark')} Generating…` : `${icon('spark')} Generate`;
    $('aii-copy').disabled = !prefs.subject.trim();
    $('aii-apply').disabled = s.busy || !s.selected;
  }

  // ----- variations and clean-up -----
  async function addImage(file, label) {
    const image = await d.decodeImage(file);
    const rgba = d.imageRgba(image), width = image.naturalWidth, height = image.naturalHeight;
    const profiles = edgeProfiles(rgba, width, height);
    const variation = { id: uid(), url: URL.createObjectURL(file), rgba, width, height, profiles, detected: detectGrid(rgba, width, height, { profiles }), label, cache: null };
    s.variations.push(variation);
    while (s.variations.length > 8) URL.revokeObjectURL(s.variations.shift().url);
    s.selected = variation;
    renderVariations();
  }
  const inProject = () => prefs.destination !== 'project';
  function processed(v) {
    const key = JSON.stringify([prefs.size, prefs.frames, prefs.sizing, prefs.removeBg, prefs.background, inProject() ? 'palette' : prefs.colors, prefs.dither, state.project.palette]);
    if (v.cache?.key === key) return v.cache.value;
    const sheet = prefs.frames > 1, expected = Math.min(MAX_SIZE, prefs.size * (sheet ? prefs.frames : 1));
    let mode = prefs.sizing;
    if (mode === 'auto') mode = v.detected.scale > 1 && Math.max(v.width, v.height) / v.detected.scale <= expected * 3 ? 'detect' : 'average';
    const keyColor = prefs.removeBg && prefs.background === 'magenta' ? [255, 0, 255] : null;
    const clean = cleanImage(v.rgba, v.width, v.height, { mode, profiles: v.profiles, detected: v.detected, target: expected, background: prefs.removeBg, keyColor, trim: !sheet, maxSize: MAX_SIZE });
    const cut = sheet ? sliceSheet(clean.rgba, clean.width, clean.height, prefs.frames) : { frames: [clean.rgba], width: clean.width, height: clean.height };
    const { width, height, frames } = cut, size = width * height;
    const stacked = new Uint8ClampedArray(size * 4 * frames.length);
    frames.forEach((f, i) => stacked.set(f, i * size * 4));
    const colors = inProject() ? 'palette' : prefs.colors;
    // Sheets share one palette built from every frame, so colours stay consistent through the animation.
    const palette = colors === 'palette' ? state.project.palette : paletteFromRgba(stacked, Math.min(MAX_COLORS, Number(colors) || 16));
    const pixels = frames.map(f => colors === 'palette' || prefs.dither ? mapRgbaPerceptual(f, palette, width, height, { dither: prefs.dither }) : mapRgbaToPalette(f, palette, width, height));
    const used = new Set(pixels.flat().filter(i => i >= 0)).size;
    const grid = mode === 'detect' && clean.grid?.scale > 1 ? `Grid ${+clean.grid.scale.toFixed(2)} px` : 'Downscaled';
    const value = { width, height, palette, pixels, note: `${grid} · ${width} × ${height}${sheet ? ` × ${frames.length} frames` : ''} · ${used} colours` };
    v.cache = { key, value };
    return value;
  }
  function draw(canvas, result) {
    const n = result.pixels.length, gap = n > 1 ? 1 : 0, W = result.width * n + gap * (n - 1);
    canvas.width = Math.max(1, W); canvas.height = result.height;
    const context = canvas.getContext('2d');
    result.pixels.forEach((px, i) => context.putImageData(new ImageData(indicesToRgba(px, result.palette), result.width, result.height), i * (result.width + gap), 0));
  }
  function renderVariations() {
    $('aii-drop').classList.toggle('compact', s.variations.length > 0);
    $('aii-variations').innerHTML = s.variations.map((v, i) => `<button type="button" class="aii-variation${v === s.selected ? ' selected' : ''}" role="option" aria-selected="${v === s.selected}" data-id="${v.id}" title="${esc(v.label)}"><img src="${v.url}" alt="Raw image ${i + 1}"><canvas aria-label="Cleaned pixels ${i + 1}"></canvas></button>`).join('');
    for (const button of $('aii-variations').querySelectorAll('.aii-variation')) {
      const v = s.variations.find(x => x.id === button.dataset.id);
      try { draw(button.querySelector('canvas'), processed(v)); } catch { /* shown on select */ }
      button.onclick = () => { s.selected = v; renderVariations(); };
    }
    renderClean();
  }
  function renderDestinations() {
    const sheet = prefs.frames > 1;
    const list = [['project', sheet ? 'New project · animation from the frames' : 'New project · use the image colours'], ['layer', 'New layer · current frame'], ['object', 'New object · centred on the canvas'], ['frame', sheet ? 'New frames · after the current frame' : 'New frame · on the selected layer']];
    if (sheet) list.push(['animation', 'New animation · in this project']);
    if (!list.some(([v]) => v === prefs.destination)) prefs.destination = 'project';
    $('aii-destination').innerHTML = list.map(([v, l]) => option(v, l, prefs.destination)).join('');
  }
  function renderClean() {
    $('aii-clean').hidden = !s.selected;
    renderDestinations();
    $('aii-colors-field').hidden = inProject();
    error('');
    if (s.selected) {
      try {
        const result = processed(s.selected);
        draw($('aii-preview'), result);
        const canvas = $('aii-preview'), zoom = Math.max(1, Math.floor(Math.min(380 / canvas.width, 220 / canvas.height)));
        canvas.style.width = `${canvas.width * zoom}px`; canvas.style.height = `${canvas.height * zoom}px`;
        $('aii-note').textContent = inProject() ? `${result.note} · mapped to the current palette` : result.note;
      } catch (e) { error(e.message); }
    }
    updateButtons();
  }

  // ----- generation -----
  async function generate() {
    const text = prompt();
    if (!text || s.busy) return;
    const [kind, id] = prefs.provider.split(':'), model = $('aii-model').value;
    prefs.models[id] = model;
    // Read the typed key before renderProvider() refreshes the field from storage.
    const key = kind === 'key' ? $('aii-key-input').value.trim() : '';
    if (kind === 'key') rememberKey(id, key, $('aii-key-remember').checked);
    error('');
    s.busy = true; s.controller = new AbortController();
    s.statusText = `Asking ${IMAGE_PROVIDERS[id].label} for ${prefs.n} image${prefs.n > 1 ? 's' : ''}… this can take up to a minute.`;
    renderProvider();
    try {
      const reference = prefs.reference ? await referencePng() : undefined;
      const background = promptOptions().background;
      const quality = id === 'openai' ? prefs.quality : undefined;
      let images;
      if (kind === 'local') {
        const response = await fetch('/api/image/generate', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: s.controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-Pixel-Studio-Token': s.local.csrfToken },
          body: JSON.stringify({ provider: id, model, prompt: text, n: prefs.n, size: '1024x1024', background, ...(quality ? { quality } : {}), ...(reference ? { reference } : {}) }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'The image could not be generated.');
        images = body.images;
        if (body.credits) { s.local.credits = { ...s.local.credits, balance: body.credits.balance }; window.dispatchEvent(new CustomEvent('pixel-studio:credits', { detail: body.credits })); }
      } else {
        try { images = await requestImages({ provider: id, model, prompt: text, n: prefs.n, reference, background, quality, key }, { signal: s.controller.signal }); }
        catch (e) { throw new Error(e instanceof ImageApiError ? IMAGE_ERROR_MESSAGES[e.kind] : e.message); }
      }
      if (s.disposed) return;
      if (!Array.isArray(images) || !images.length) throw new Error(IMAGE_ERROR_MESSAGES['no-image']);
      let n = s.variations.length;
      for (const base64 of images) await addImage(base64Blob(base64), `${IMAGE_PROVIDERS[id].label} · ${model} · #${++n}`);
    } catch (e) {
      if (!s.disposed && e.name !== 'AbortError') error(e.message);
    } finally {
      s.busy = false; s.controller = null;
      if (!s.disposed) renderProvider();
    }
  }

  async function useFile(file, label) {
    if (!file) return;
    error('');
    try { await addImage(file, label || file.name || 'Pasted image'); } catch (e) { error(e.message || 'This image could not be read.'); }
  }

  // ----- apply -----
  function apply() {
    const v = s.selected;
    if (!v) return;
    const result = processed(v), name = nameFrom(prefs.subject), p = state.project;
    const toCanvas = px => mapRgbaPerceptual(placeRgba(indicesToRgba(px, result.palette), result.width, result.height, p.width, p.height, true), p.palette, p.width, p.height);
    if (result.pixels.every(px => px.every(i => i < 0))) throw new Error('The cleaned image is empty. Turn off “Remove background” or try another variation.');
    const destination = prefs.destination;
    if (destination === 'project') {
      const project = blankProject(name, result.width, result.height);
      project.palette = result.palette;
      const animation = project.animations[0], layerId = project.layers[0].id;
      if (result.pixels.length > 1) animation.name = 'Animation';
      animation.frames = result.pixels.map((pixels, i) => ({ id: i ? uid() : animation.frames[0].id, duration: 125, cels: [{ layerId, pixels }] }));
      modal.close();
      d.replaceProject(project, `“${name}” opened as a new project. Every pixel is ready to edit.`);
      return;
    }
    const layer = d.currentLayer();
    if ((destination === 'frame' || destination === 'animation') && (!layer.visible || layer.locked)) throw new Error('Select a visible, unlocked layer first.');
    if ((destination === 'layer' || destination === 'object') && !d.canAddLayer()) throw new Error('This project has reached its layer or pixel limit.');
    if (destination === 'frame' && !d.canAddFrame()) throw new Error('This project has reached its frame or pixel limit.');
    if (destination === 'frame' && !d.canEditPixels()) throw new Error('Select visible pixel artwork and unlock its objects before adding a frame.');
    d.versionBefore('Before generated image');
    let message;
    d.mutate(() => {
      if (destination === 'layer' || destination === 'object') {
        const added = d.insertLayer(name);
        d.currentFrame().cels.find(cel => cel.layerId === added.id).pixels = toCanvas(result.pixels[0]);
        if (destination === 'object') {
          const made = createObjectFromPixels(state.project, d.objectTarget(added.id), { name, scope: 'frame' });
          state.project = made.project; state.layerId = made.layerId; state.objectSelection = { layerId: made.layerId, key: made.key };
          state.selection = null; state.tool = 'object';
          message = `“${name}” added as an object. Drag to move it; double-click to edit.`;
        } else message = `“${name}” added on a new layer.`;
      } else if (destination === 'frame') {
        const animation = d.currentAnimation(), index = animation.frames.findIndex(f => f.id === state.frameId);
        const frames = result.pixels.map(px => {
          const frame = makeLayeredFrame(state.project);
          frame.cels.find(cel => cel.layerId === layer.id).pixels = toCanvas(px);
          frame.duration = Math.round(1000 / animation.fps);
          return frame;
        });
        animation.frames.splice(index + 1, 0, ...frames);
        state.frameId = frames[0].id; state.previewIndex = index + 1;
        message = frames.length > 1 ? `${frames.length} frames added after the current frame.` : 'Image added as a new frame.';
      } else {
        const frames = result.pixels.map(px => {
          const frame = makeLayeredFrame(state.project);
          frame.cels.find(cel => cel.layerId === layer.id).pixels = toCanvas(px);
          return frame;
        });
        const names = new Set(state.project.animations.map(a => a.name.toLowerCase()));
        let animationName = name.slice(0, 70), n = 2;
        while (names.has(animationName.toLowerCase())) animationName = `${name.slice(0, 70)} ${n++}`;
        const animation = { id: uid(), name: animationName, fps: 8, frames };
        state.project.animations.push(animation);
        state.animationId = animation.id; state.frameId = frames[0].id; state.previewIndex = 0;
        message = `New animation “${animationName}” with ${frames.length} frames.`;
      }
    });
    modal.close();
    d.toast(message);
  }

  // ----- events -----
  const form = $('aii-form');
  const read = () => {
    prefs.subject = $('aii-subject').value; prefs.size = Number($('aii-size').value); prefs.view = $('aii-view').value; prefs.style = $('aii-style').value;
    prefs.background = $('aii-background').value; prefs.frames = Number($('aii-frames').value); prefs.n = Number($('aii-n').value);
    prefs.outline = $('aii-outline').checked; prefs.usePalette = $('aii-palette').checked; prefs.reference = $('aii-reference').checked;
    prefs.quality = $('aii-quality').value;
  };
  for (const id of ['aii-subject', 'aii-size', 'aii-view', 'aii-style', 'aii-background', 'aii-frames', 'aii-n', 'aii-outline', 'aii-palette', 'aii-reference', 'aii-quality']) {
    $(id).addEventListener(id === 'aii-subject' ? 'input' : 'change', () => {
      read(); renderPrompt();
      if (['aii-size', 'aii-frames', 'aii-background'].includes(id) && s.variations.length) renderVariations();
      if (['aii-n', 'aii-quality'].includes(id) && s.local?.cloud && !s.busy) renderProvider();
    });
  }
  $('aii-provider').onchange = () => { prefs.provider = $('aii-provider').value; renderProvider(); renderPrompt(); };
  $('aii-model').onchange = () => { prefs.models[providerId()] = $('aii-model').value; };
  $('aii-key-input').oninput = updateButtons;
  $('aii-key-remember').onchange = () => { if (!$('aii-key-remember').checked) rememberKey(providerId(), $('aii-key-input').value.trim(), false); };
  for (const id of ['aii-sizing', 'aii-colors', 'aii-destination', 'aii-remove-bg', 'aii-dither']) $(id).onchange = () => {
    prefs.sizing = $('aii-sizing').value; prefs.colors = $('aii-colors').value; prefs.destination = $('aii-destination').value;
    prefs.removeBg = $('aii-remove-bg').checked; prefs.dither = $('aii-dither').checked;
    renderVariations();
  };
  $('aii-copy').onclick = async () => {
    const text = prompt();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); d.toast('Prompt copied. Paste it into your chatbot, then paste the image here.'); }
    catch { $('aii-prompt').closest('details').open = true; $('aii-prompt').select(); d.toast('Select the prompt and copy it.'); }
  };
  $('aii-upload').onclick = () => $('aii-file').click();
  $('aii-file').onchange = event => { const file = event.target.files[0]; event.target.value = ''; useFile(file); };
  form.onsubmit = event => { event.preventDefault(); generate(); };
  $('aii-cancel').onclick = () => modal.close();
  $('aii-apply').onclick = () => { try { apply(); } catch (e) { error(e.message); } };
  const drop = $('aii-drop');
  drop.ondragover = event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); drop.classList.add('over'); } };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = event => { event.preventDefault(); drop.classList.remove('over'); useFile([...event.dataTransfer.files].find(f => /^image\//.test(f.type))); };
  const onPaste = event => {
    const file = [...(event.clipboardData?.files || [])].find(f => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
    if (!file) return;
    event.preventDefault();
    useFile(file, 'Pasted image');
  };
  document.addEventListener('paste', onPaste);
  const dispose = () => {
    if (s.disposed) return;
    s.disposed = true;
    s.controller?.abort();
    document.removeEventListener('paste', onPaste);
    modal.classList.remove('ai-image-modal');
    modal.removeEventListener('close', dispose);
    modal.removeEventListener('pixel-studio:dialog-replace', dispose);
    for (const v of s.variations) URL.revokeObjectURL(v.url);
  };
  modal.addEventListener('close', dispose);
  modal.addEventListener('pixel-studio:dialog-replace', dispose);

  renderProviders();
  renderPrompt();
  $('aii-subject').focus();
  // Pixel Studio Local proxies requests (its CSP blocks direct calls); everywhere else the browser calls the provider.
  (async () => {
    let local = false;
    if (isLoopback() || isCloudEdition()) {
      try {
        const response = await fetch('/api/image/status', { cache: 'no-store', credentials: 'same-origin' }), body = await response.json();
        if (response.ok && body.local === true && typeof body.csrfToken === 'string') local = { providers: body.providers || {}, csrfToken: body.csrfToken, cloud: body.cloud === true, signedIn: body.signedIn === true, credits: body.credits };
      } catch { /* static server */ }
    }
    if (s.disposed) return;
    s.local = local;
    renderProviders();
  })();
}
