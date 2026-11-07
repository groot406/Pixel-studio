/** Image export panels for the Export dialog: PNG / PNG sequence / WebP, sprite sheets, and GIF / APNG. */
import { METADATA_FORMATS, cleanSettings, planExport, renderPlan, encodeExport, pixelStudioMetadataProblem, effectiveScope } from '../formats/export-bundle.js';

const STORE_KEY = 'pixel-studio.export.v1';
const KINDS = { png: ['png', 'sequence', 'webp'], sheet: ['sheet'], anim: ['gif', 'apng'] };
const KIND_LABELS = { png: 'PNG · one frame', sequence: 'PNG sequence · ZIP', webp: 'WebP · one frame', gif: 'Animated GIF', apng: 'Animated PNG (APNG)', sheet: 'Sprite sheet PNG' };
const LAYOUTS = { rows: 'One row per animation', horizontal: 'Horizontal strip', vertical: 'Vertical strip', grid: 'Grid' };
const NOTES = {
  png: 'A crisp single frame. Scaling repeats each pixel, so edges never blur.',
  sequence: 'Every frame as its own PNG, numbered per animation, in one ZIP file.',
  webp: 'A still WebP of the current frame, encoded by your browser. Animated WebP is not available; use GIF or APNG for motion.',
  sheet: 'All frames packed into one PNG. Metadata files ride along in a ZIP. Aseprite JSON suits Phaser, PixiJS, Defold and Aseprite importers; Godot gets a ready SpriteFrames resource; Unity gets TexturePacker-style JSON plus slicing steps.',
  gif: 'GIF89a with your frame timings, rounded to 1/100 s, and on/off transparency. Each animation becomes its own GIF.',
  apng: 'Animated PNG keeps exact millisecond timings and full colour. Supported by all modern browsers. Each animation becomes its own file.',
};

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function saveSettings(value) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(value)); } catch { /* storage may be unavailable */ }
}
const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;

/** Paint RGBA into a canvas at its natural size. */
function rgbaCanvas(rgba, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), width, height), 0, 0);
  return canvas;
}

/**
 * Render one image export panel into `container`. tab: 'png' | 'sheet' | 'anim'.
 * ctx: {project, animationId, frameId, layerId, layerName, name, version, download(blob, name), toast, icon, escapeHTML}.
 */
export function renderImageExport(container, tab, ctx) {
  const { project, icon, escapeHTML: esc } = ctx;
  const stored = loadSettings();
  let settings = cleanSettings({ ...stored, kind: stored.kinds?.[tab] || KINDS[tab][0] });
  if (!KINDS[tab].includes(settings.kind)) settings.kind = KINDS[tab][0];
  const animation = project.animations.find((a) => a.id === ctx.animationId) || project.animations[0];
  const frameNumber = Math.max(1, animation.frames.findIndex((f) => f.id === ctx.frameId) + 1);
  const option = (value, label, selected) => `<option value="${value}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`;
  const scales = [1, 2, 4, 8];
  const field = (label, control, extra = '') => `<label class="field"${extra}><span class="field-label">${label}</span>${control}</label>`;
  const number = (id, value, max = 256) => `<input id="${id}" type="number" min="0" max="${max}" step="1" value="${value}" inputmode="numeric">`;
  container.innerHTML = `<div class="img-export">
    <div class="img-export-options">
      ${KINDS[tab].length > 1 ? field('Format', `<select id="xp-kind">${KINDS[tab].map((k) => option(k, KIND_LABELS[k], settings.kind)).join('')}</select>`) : ''}
      <div class="form-grid">
        ${field('Frames', `<select id="xp-scope"></select>`)}
        ${field('Layers', `<select id="xp-layers">${option('visible', 'All visible layers', settings.layers)}${option('layer', `Only “${ctx.layerName}”`, settings.layers)}</select>`)}
        ${field('Scale', `<span class="xp-inline"><select id="xp-scale">${scales.map((s) => option(s, `${s}×`, scales.includes(settings.scale) ? settings.scale : 'custom')).join('')}${option('custom', 'Custom', scales.includes(settings.scale) ? '' : 'custom')}</select><input id="xp-scale-custom" type="number" min="1" max="64" step="1" value="${settings.scale}" aria-label="Custom scale"${scales.includes(settings.scale) ? ' hidden' : ''}></span>`)}
        ${field('Padding around each frame', number('xp-padding', settings.padding))}
      </div>
      ${tab === 'sheet' ? `<div class="form-grid">
        ${field('Layout', `<select id="xp-layout">${Object.entries(LAYOUTS).map(([k, l]) => option(k, l, settings.layout)).join('')}</select>`)}
        ${field('Columns', `<input id="xp-columns" type="number" min="0" max="1024" step="1" value="${settings.columns}" placeholder="Auto">`, ' id="xp-columns-field"')}
        ${field('Spacing between frames', number('xp-spacing', settings.spacing))}
        ${field('Sheet margin', number('xp-margin', settings.margin))}
      </div>
      ${field('Metadata', `<select id="xp-metadata">${Object.entries(METADATA_FORMATS).map(([k, l]) => option(k, l, settings.metadata)).join('')}</select>`)}` : ''}
      <div class="xp-row">
        <label class="check-row"><input id="xp-transparent" type="checkbox"${settings.background ? '' : ' checked'}> Transparent background</label>
        <input id="xp-background" type="color" value="${settings.background || '#ffffff'}" aria-label="Background colour"${settings.background ? '' : ' hidden'}>
        ${tab === 'anim' ? `<label class="check-row"><input id="xp-loop" type="checkbox"${settings.loop ? ' checked' : ''}> Loop forever</label>` : ''}
      </div>
      <div class="notice" id="xp-note"></div>
    </div>
    <div class="img-export-side">
      <div class="img-export-preview" id="xp-preview"><canvas id="xp-canvas" aria-label="Export preview"></canvas></div>
      <div class="sheet-summary" id="xp-summary" aria-live="polite"></div>
      <div class="modal-actions"><button id="xp-download" class="button primary">${icon('import')} Download</button></div>
    </div>
  </div>`;
  const $ = (id) => container.querySelector(`#${id}`);
  let plan = null, cells = null, encoded = null, token = 0, timer = 0, frameTimer = 0;

  const fillScope = () => {
    const kind = settings.kind, choices = kind === 'png' || kind === 'webp' ? ['frame'] : kind === 'sheet' ? ['frame', 'animation', 'project'] : ['animation', 'project'];
    const labels = { frame: `Current frame · ${animation.name} ${frameNumber}`, animation: `Current animation · ${animation.name}`, project: `All animations · ${project.animations.length}` };
    const scope = effectiveScope(settings);
    $('xp-scope').innerHTML = choices.map((c) => option(c, labels[c], scope)).join('');
    $('xp-scope').disabled = choices.length === 1;
    if (choices.length > 1) settings.scope = $('xp-scope').value;
  };
  const read = () => {
    const scaleChoice = $('xp-scale').value, num = (id) => Number($(id)?.value || 0);
    $('xp-scale-custom').hidden = scaleChoice !== 'custom';
    $('xp-background').hidden = $('xp-transparent').checked;
    const next = {
      ...settings, kind: $('xp-kind')?.value || settings.kind, layers: $('xp-layers').value,
      scale: scaleChoice === 'custom' ? num('xp-scale-custom') : Number(scaleChoice), padding: num('xp-padding'),
      background: $('xp-transparent').checked ? null : $('xp-background').value,
    };
    if (!$('xp-scope').disabled) next.scope = $('xp-scope').value;
    if (tab === 'sheet') Object.assign(next, { layout: $('xp-layout').value, columns: num('xp-columns'), spacing: num('xp-spacing'), margin: num('xp-margin'), metadata: $('xp-metadata').value });
    if (tab === 'anim') next.loop = $('xp-loop').checked;
    const kindChanged = next.kind !== settings.kind;
    settings = cleanSettings(next);
    if (kindChanged) fillScope();
    saveSettings({ ...loadSettings(), ...settings, kind: undefined, kinds: { ...loadSettings().kinds, [tab]: settings.kind } });
  };

  const drawPreview = () => {
    clearTimeout(frameTimer);
    const canvas = $('xp-canvas'), box = $('xp-preview');
    if (!plan) { canvas.width = canvas.height = 0; return; }
    const maxW = Math.max(120, box.clientWidth - 24), maxH = 300;
    const zoomFor = (w, h) => { const z = Math.min(maxW / w, maxH / h); return z >= 1 ? Math.floor(z) : z; };
    const ctx2d = canvas.getContext('2d');
    if (settings.kind === 'sheet') {
      const { layout } = plan, zoom = zoomFor(layout.width, layout.height);
      canvas.width = Math.max(1, Math.round(layout.width * zoom)); canvas.height = Math.max(1, Math.round(layout.height * zoom));
      ctx2d.imageSmoothingEnabled = false;
      const flat = cells.flat();
      layout.rects.forEach((r, i) => ctx2d.drawImage(rgbaCanvas(flat[i].rgba, r.w, r.h), r.x * zoom, r.y * zoom, r.w * zoom, r.h * zoom));
      ctx2d.strokeStyle = '#285b47aa'; ctx2d.lineWidth = 1;
      for (const r of layout.rects) ctx2d.strokeRect(Math.round(r.x * zoom) + 0.5, Math.round(r.y * zoom) + 0.5, Math.max(1, Math.round(r.w * zoom) - 1), Math.max(1, Math.round(r.h * zoom) - 1));
      return;
    }
    const zoom = zoomFor(plan.width, plan.height), sequence = plan.groups.flatMap((g, gi) => g.frames.map((f, fi) => ({ cell: cells[gi][fi], duration: f.duration })));
    canvas.width = Math.max(1, Math.round(plan.width * zoom)); canvas.height = Math.max(1, Math.round(plan.height * zoom));
    const frames = sequence.map((s) => rgbaCanvas(s.cell.rgba, plan.width, plan.height));
    let index = 0;
    const tick = () => {
      if (!container.isConnected) return;
      ctx2d.clearRect(0, 0, canvas.width, canvas.height); ctx2d.imageSmoothingEnabled = false;
      ctx2d.drawImage(frames[index], 0, 0, canvas.width, canvas.height);
      if (frames.length > 1) { frameTimer = setTimeout(tick, sequence[index].duration); index = (index + 1) % frames.length; }
    };
    tick();
  };

  const summary = (text) => { $('xp-summary').innerHTML = text; };
  const describe = () => {
    const kind = settings.kind, n = plan.frames;
    const size = `<strong>${plan.width} × ${plan.height}</strong> px`;
    if (kind === 'sheet') return `${size} sheet · ${plan.layout.columns} × ${plan.layout.rows} cells of ${plan.cell.width} × ${plan.cell.height} · ${n} frame${n === 1 ? '' : 's'}`;
    return `${size} per frame${n > 1 ? ` · ${n} frames` : ''}${plan.groups.length > 1 && kind !== 'sequence' ? ` · ${plan.groups.length} files` : ''}`;
  };
  const encode = async () => {
    const mine = ++token;
    encoded = null;
    try {
      if (settings.kind === 'webp') { encoded = await webp(); }
      else encoded = (await encodeExport(project, plan, cells, { version: ctx.version })).download;
      if (mine !== token) return;
      summary(`${describe()}<br>${esc(encoded.name)} · <strong>${bytes(encoded.data.size ?? encoded.data.length)}</strong>`);
      $('xp-download').disabled = false;
    } catch (error) {
      if (mine !== token) return;
      summary(`${describe()}<br><span class="xp-error">${esc(error.message)}</span>`);
      $('xp-download').disabled = true;
    }
  };
  const webp = async () => {
    const canvas = rgbaCanvas(cells[0][0].rgba, plan.width, plan.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 1));
    if (!blob || blob.type !== 'image/webp') throw new Error('This browser cannot encode WebP images. Choose PNG instead.');
    return { name: `${plan.base}-${plan.scopeName}-frame-${frameNumber}${plan.suffix}.webp`, data: blob, type: 'image/webp' };
  };

  const update = () => {
    read();
    $('xp-note').textContent = NOTES[settings.kind];
    if (tab === 'sheet') {
      $('xp-columns-field').hidden = settings.layout !== 'grid';
      const problem = pixelStudioMetadataProblem(settings);
      $('xp-metadata').querySelector('[value="pixel-studio"]').disabled = Boolean(problem);
      if (problem && settings.metadata === 'pixel-studio') { $('xp-metadata').value = 'aseprite-hash'; settings.metadata = 'aseprite-hash'; }
    }
    try {
      plan = planExport(project, settings, ctx);
      cells = renderPlan(project, plan, ctx.layerId);
      summary(`${describe()}<br>Encoding…`);
      $('xp-download').disabled = true;
      drawPreview();
      clearTimeout(timer); timer = setTimeout(encode, 120);
    } catch (error) {
      plan = cells = encoded = null; token += 1;
      drawPreview();
      summary(`<span class="xp-error">${esc(error.message)}</span>`);
      $('xp-download').disabled = true;
    }
  };
  $('xp-download').onclick = async () => {
    if (!encoded) await encode();
    if (!encoded) return;
    ctx.download(encoded.data instanceof Blob ? encoded.data : new Blob([encoded.data], { type: encoded.type }), encoded.name);
    ctx.toast(`Exported ${encoded.name}.`);
  };
  fillScope();
  for (const element of container.querySelectorAll('select, input')) element.addEventListener(element.type === 'number' ? 'input' : 'change', update);
  update();
}
