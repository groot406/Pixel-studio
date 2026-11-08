/**
 * Palette studio: colour-theory harmonies on an OKLCH hue wheel, shades & tints, a library of popular palettes and an
 * analysis of the project palette. Results are added to the palette or replace it (pixels remapped to the nearest new
 * colour, one undo step). Also the right-click menu of palette swatches. Domain: palette-theory.js, palette-presets.js.
 */
import { MAX_COLORS } from '../domain/limits.js';
import { compositeFrame } from '../domain/project.js';
import { hexToOklch, oklchToHex, shadingRamp, nearestIndexMap } from '../domain/colour.js';
import { HARMONIES, harmonyHues, harmonyPalette, complementColour, neutralColour, tintsShadesTones, sortPaletteIndices, similarColours,
  lightnessGaps, mergeColours, usedPaletteIndices, replacePalette, removePaletteColour, removeUnusedColours, reorderPalette } from '../domain/palette-theory.js';
import { allPalettePresets } from '../domain/palette-presets.js';

let d, menu = null;
const C_MAX = 0.32, HEX = /^#?[0-9a-f]{6}$/i;
const TABS = [['harmony', 'Harmonies', 'spark'], ['shades', 'Shades & tints', 'ramp'], ['presets', 'Popular palettes', 'grid'], ['analyse', 'Analyse', 'shade']];
const SIZES = [['all', 'All'], ['8', '≤ 8'], ['16', '9–16'], ['32', '17–32'], ['64', '33–64']];
const TAGS = [['', 'Any style'], ['gameboy', 'Game Boy'], ['retro', 'Retro hardware'], ['general', 'Artist palettes'], ['plugin', 'From plugins']];
const ui = { tab: 'harmony', lch: [0.62, 0.15, 35], kind: 'complementary', spread: 0, steps: 5, hueShift: 20, span: 0.6,
  shade: null, shSteps: 7, shHue: 24, shSpan: 0.7, shDrop: 0.35, query: '', size: 'all', tag: '', preset: 'pico-8', similar: 0.04, rowOn: {} };
const FORMAT = { steps: v => v, hueShift: v => `${v}°`, span: v => `${Math.round(v * 100)}%`, spread: v => `${v}°`, shSteps: v => v, shHue: v => `${v}°`,
  shSpan: v => `${Math.round(v * 100)}%`, shDrop: v => `${Math.round(v * 100)}%`, similar: v => `ΔE ${(v * 100).toFixed(0)}` };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const wrap = h => ((h % 360) + 360) % 360;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const palette = () => d.state.project.palette;
const baseHex = () => oklchToHex(ui.lch);
const swatch = (c, extra = '') => `<button type="button" class="ps-swatch${palette().includes(c) ? ' in-palette' : ''}" style="--swatch:${c}" data-add="${c}" title="${c.toUpperCase()} · click to add" aria-label="Add ${c.toUpperCase()}"${extra}></button>`;
const slider = (k, label, min, max, step) => `<label class="field ps-slider"><span class="field-label">${label}</span><span class="field-row"><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${ui[k]}"><output data-out="${k}">${FORMAT[k](ui[k])}</output></span></label>`;
const miniPalette = (attr, selected) => `<div class="ps-mini-palette">${palette().map((c, i) => `<button type="button" class="swatch${c === selected ? ' selected' : ''}" style="--swatch:${c}" data-${attr}="${c}" title="${c.toUpperCase()}" aria-label="Use colour ${i + 1} ${c.toUpperCase()}"></button>`).join('')}</div>`;

export function initPaletteStudio(deps) {
  d = deps;
  d.$('palette-studio').onclick = () => openPaletteStudio();
  d.$('palette-grid').addEventListener('contextmenu', event => {
    const button = event.target.closest('[data-color]');
    if (!button || button.dataset.color === '-1') return;
    event.preventDefault();
    openSwatchMenu(Number(button.dataset.color), event, button);
  });
}

/** Open the studio on `tab`, optionally seeding the base colour of the harmony and shades tabs. */
export function openPaletteStudio(tab = ui.tab, hex) {
  ui.tab = tab;
  if (hex) { ui.lch = hexToOklch(hex); ui.shade = hex; }
  if (!ui.shade || !palette().includes(ui.shade)) ui.shade = hex || palette()[Math.max(0, d.state.color)] || palette()[0];
  d.openDialog('Palette studio', `<div class="ps maths-form"><div class="export-tabs ps-tabs" role="tablist" aria-label="Palette studio sections">${TABS.map(([id, label, icon]) => `<button type="button" class="export-tab" role="tab" data-tab="${id}" aria-selected="false">${d.icon(icon)} ${label}</button>`).join('')}</div>
    <div id="ps-main" class="ps-main" role="tabpanel"></div>
    <div class="ps-footer"><div id="ps-confirm" class="ps-confirm" hidden></div><div class="ps-footer-row"><p id="ps-summary" class="ps-summary" aria-live="polite"></p><p id="ps-error" class="maths-error" role="alert"></p>
    <button type="button" id="ps-add" class="button">${d.icon('plus')} Add to palette</button><button type="button" id="ps-replace" class="button primary">${d.icon('swap')} Replace palette…</button></div></div></div>`, 'COLOR PALETTE');
  d.$('modal').classList.add('palette-studio-modal');
  const root = d.$('modal-content').querySelector('.ps');
  root.querySelector('.ps-tabs').onclick = event => { const tab = event.target.closest('[data-tab]'); if (tab) { ui.tab = tab.dataset.tab; renderTab(); } };
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);
  root.addEventListener('click', onClick);
  d.$('ps-add').onclick = () => addColours(resultColours());
  d.$('ps-replace').onclick = confirmReplace;
  renderTab();
}

function renderTab() {
  const main = d.$('ps-main');
  if (!main) return;
  for (const tab of d.$('modal-content').querySelectorAll('[data-tab]')) { const on = tab.dataset.tab === ui.tab; tab.classList.toggle('active', on); tab.setAttribute('aria-selected', on); tab.tabIndex = on ? 0 : -1; }
  main.setAttribute('aria-label', TABS.find(t => t[0] === ui.tab)[1]);
  main.innerHTML = ({ harmony: harmonyTab, shades: shadesTab, presets: presetsTab, analyse: analyseTab })[ui.tab]();
  d.$('ps-confirm').hidden = true;
  if (ui.tab === 'harmony') bindWheel();
  main.querySelector('.ps-card[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  refresh();
}

function refresh() {
  const rows = currentRows(), box = d.$('ps-rows');
  if (box) box.innerHTML = rows.length ? rows.map(row => `<div class="ps-row${row.on ? '' : ' off'}"><label class="ps-row-head" title="Include this row in Add / Replace"><input type="checkbox" data-row="${row.key}"${row.on ? ' checked' : ''}><span>${row.label}</span></label><div class="ps-swatches">${row.colours.map(c => swatch(c)).join('')}</div></div>`).join('') : '<p class="maths-info">Nothing to suggest here.</p>';
  if (ui.tab === 'harmony') { drawWheel(); syncBase(); }
  if (ui.tab === 'analyse') drawChart();
  const colours = resultColours(), fresh = colours.filter(c => !palette().includes(c)).length;
  d.$('ps-summary').innerHTML = colours.length ? `<strong>${plural(colours.length, 'colour')}</strong> selected · ${fresh} new · palette ${palette().length}/${MAX_COLORS}` : 'Tick a row to choose colours.';
  d.$('ps-add').disabled = !fresh;
  d.$('ps-replace').disabled = !colours.length;
  d.$('ps-error').textContent = '';
  d.$('ps-confirm').hidden = true;
}

/** Rows of the active tab: { key, label, colours, on }. */
function currentRows() {
  const row = (key, label, colours, on = true) => ({ key, label, colours, on: ui.rowOn[`${ui.tab}:${key}`] ?? on });
  if (ui.tab === 'harmony') {
    const base = baseHex(), rows = harmonyPalette(base, ui.kind, { spread: ui.spread, steps: ui.steps, hueShift: ui.hueShift, lightnessSpan: ui.span });
    if (ui.kind === 'monochromatic') return [row('0', 'Base ramp', rows[0]), row('1', 'Muted ramp', rows[1])];
    const offsets = HARMONIES[ui.kind].offsets(ui.spread), hues = harmonyHues(ui.lch[2], ui.kind, ui.spread);
    return rows.map((colours, i) => row(String(i), i ? `${offsets[i] > 0 ? '+' : '−'}${Math.abs(offsets[i])}° <small>${Math.round(hues[i])}°</small>` : `Base <small>${Math.round(hues[0])}°</small>`, colours));
  }
  if (ui.tab === 'shades') {
    const base = ui.shade, n = clamp(ui.shSteps - 2, 2, 8), { tints, shades, tones } = tintsShadesTones(base, n), opts = { steps: ui.shSteps, hueShift: ui.shHue, lightnessSpan: ui.shSpan, chromaDrop: ui.shDrop };
    return [row('ramp', 'Hue-shifted ramp', shadingRamp(base, opts)), row('tints', 'Tints <small>+ white</small>', tints, false), row('shades', 'Shades <small>+ black</small>', [...shades].reverse(), false),
      row('tones', 'Tones <small>+ grey</small>', tones, false), row('opposite', 'Opposite ramp', shadingRamp(complementColour(base), opts), false),
      row('neutral', 'Neutrals', [0.25, 0.5, 0.75, 1].map(a => neutralColour(base, a)), false)];
  }
  if (ui.tab === 'presets') {
    const preset = allPalettePresets().find(p => p.id === ui.preset);
    if (!preset) return [];
    const width = Math.min(8, preset.colours.length);
    return Array.from({ length: Math.ceil(preset.colours.length / width) }, (_, i) => row(`${preset.id}-${i}`, preset.colours.length > width ? `${i * width + 1}–${Math.min(preset.colours.length, i * width + width)}` : `${preset.colours.length} colours`, preset.colours.slice(i * width, i * width + width)));
  }
  const gaps = lightnessGaps(palette());
  return gaps.length ? [row('gaps', 'Missing values', gaps.map(g => g.hex))] : [];
}
const resultColours = () => [...new Set(currentRows().filter(r => r.on).flatMap(r => r.colours))];

function harmonyTab() {
  return `<div class="ps-split"><section class="ps-side" aria-label="Base colour">
    <canvas id="ps-wheel" class="ps-wheel" tabindex="0" role="slider" aria-label="Base colour: drag the ring for hue, the square for chroma and lightness. Arrow keys adjust." aria-valuemin="0" aria-valuemax="359"></canvas>
    <div class="ps-base"><i id="ps-base-chip" class="ps-chip"></i><label class="sr-only" for="ps-base-hex">Base colour hex</label><input id="ps-base-hex" class="ps-hex" maxlength="7" spellcheck="false"><span id="ps-base-lch" class="ps-meta"></span></div>
    <span class="field-label">Start from a palette colour</span>${miniPalette('base', baseHex())}</section>
    <section class="ps-content"><div class="ps-chips" role="radiogroup" aria-label="Harmony">${Object.entries(HARMONIES).map(([k, h]) => `<button type="button" class="ps-chip-button" role="radio" data-kind="${k}" aria-checked="${k === ui.kind}">${h.label}</button>`).join('')}</div>
    <p class="ps-hint">${hint(ui.kind)}</p>
    <div class="ps-sliders">${slider('steps', 'Shades per colour', 1, 9, 1)}${slider('hueShift', 'Hue shift', 0, 60, 1)}${slider('span', 'Contrast', 0.2, 0.9, 0.05)}${HARMONIES[ui.kind].spread ? slider('spread', 'Spread', 10, 90, 5) : ''}</div>
    <div id="ps-rows" class="ps-rows"></div></section></div>`;
}
function hint(kind) {
  return { complementary: 'Opposites on the wheel: maximum contrast. Use one as the main colour and the other for accents.', split: 'The base plus the two neighbours of its opposite: strong contrast with less tension.',
    analogous: 'Neighbours on the wheel: calm, natural schemes (foliage, sunsets). Add one accent from elsewhere.', triadic: 'Three hues evenly spaced: lively and balanced. Let one dominate.',
    tetradic: 'Two complementary pairs: rich, works best with one dominant hue.', square: 'Four evenly spaced hues: colourful; keep most of them muted.',
    monochromatic: 'One hue in many values, plus a muted version: cohesive and easy to read.' }[kind] + ' Shades shift cooler in shadow and warmer in light.';
}

function shadesTab() {
  return `<div class="ps-split"><section class="ps-side" aria-label="Colour to shade"><div class="ps-base"><i class="ps-chip" style="--swatch:${ui.shade}"></i><label class="sr-only" for="ps-shade-hex">Colour hex</label><input id="ps-shade-hex" class="ps-hex" maxlength="7" spellcheck="false" value="${ui.shade.toUpperCase()}"></div>
    <span class="field-label">Pick a palette colour</span>${miniPalette('shade', ui.shade)}
    <div class="ps-sliders single">${slider('shSteps', 'Ramp steps', 2, 16, 1)}${slider('shHue', 'Hue shift', 0, 60, 1)}${slider('shSpan', 'Light range', 0.2, 0.95, 0.05)}${slider('shDrop', 'Saturation fade', 0, 1, 0.05)}</div></section>
    <section class="ps-content"><p class="ps-hint">Tick the rows you want. <strong>Tints</strong> mix in white, <strong>shades</strong> black, <strong>tones</strong> grey; the hue-shifted ramp is how pixel artists shade. The opposite (complement) makes the strongest accent; neutrals are the colour mixed toward its opposite.</p><div id="ps-rows" class="ps-rows"></div></section></div>`;
}

function presetsTab() {
  const q = ui.query.trim().toLowerCase(), limit = ui.size === 'all' ? null : Number(ui.size), lower = { 8: 0, 16: 8, 32: 16, 64: 32 }[ui.size] ?? 0;
  const list = allPalettePresets().filter(p => (!q || `${p.name} ${p.author}`.toLowerCase().includes(q)) && (!limit || (p.colours.length <= limit && p.colours.length > lower)) && (!ui.tag || p.tags.includes(ui.tag)));
  const preset = allPalettePresets().find(p => p.id === ui.preset);
  return `<div class="ps-preset-tools"><label class="sr-only" for="ps-search">Search palettes</label><input id="ps-search" type="search" class="ps-search" placeholder="Search palettes or authors" value="${d.escapeHTML(ui.query)}">
    <div class="ps-chips" role="radiogroup" aria-label="Palette size">${SIZES.map(([v, l]) => `<button type="button" class="ps-chip-button" role="radio" data-size="${v}" aria-checked="${ui.size === v}">${l}</button>`).join('')}</div>
    <label class="sr-only" for="ps-tag">Style</label><select id="ps-tag" class="ps-select">${TAGS.map(([v, l]) => `<option value="${v}"${ui.tag === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="ps-split presets"><div class="ps-cards" role="listbox" aria-label="Popular palettes">${list.map(p => `<button type="button" class="ps-card" role="option" data-preset="${p.id}" aria-selected="${p.id === ui.preset}"><span class="ps-card-head"><strong>${d.escapeHTML(p.name)}</strong><span class="count-badge">${p.colours.length}</span></span><span class="ps-card-strip">${p.colours.map(c => `<i style="--swatch:${c}"></i>`).join('')}</span><small>${p.author ? `by ${d.escapeHTML(p.author)}` : 'Lospec palette list'}</small></button>`).join('') || '<p class="maths-info">No palette matches.</p>'}</div>
    <section class="ps-content ps-preset-detail">${preset ? `<h3 class="ps-title">${d.escapeHTML(preset.name)}</h3><p class="ps-hint">${preset.author ? `By ${d.escapeHTML(preset.author)} · ` : ''}via lospec.com. Click a swatch to add just that colour; <strong>Replace palette</strong> recolours your artwork with its nearest colours.</p>` : ''}<div id="ps-rows" class="ps-rows"></div></section></div>`;
}

function analyseTab() {
  const p = palette(), used = usedPaletteIndices(d.state.project), unused = p.length - p.filter((_, i) => used.has(i)).length;
  const strip = order => order.map(i => `<i style="--swatch:${p[i]}" title="${i + 1}: ${p[i].toUpperCase()}"></i>`).join('');
  const pairs = similarColours(p, ui.similar);
  return `<div class="ps-split"><section class="ps-side" aria-label="Palette overview"><p class="ps-stat"><strong>${plural(p.length, 'colour')}</strong> · ${used.size} used in artwork · ${unused} unused</p>
    <span class="field-label">By lightness</span><div class="ramp-strip ps-strip">${strip(sortPaletteIndices(p))}</div><button type="button" class="button small" data-order="lightness">${d.icon('ramp')} Sort palette by lightness</button>
    <span class="field-label">By hue</span><div class="ramp-strip ps-strip">${strip(sortPaletteIndices(p, 'hue'))}</div><button type="button" class="button small" data-order="hue">${d.icon('spark')} Sort palette by hue</button>
    <button type="button" class="button small" data-unused${unused && p.length > 1 ? '' : ' disabled'}>${d.icon('trash')} Remove ${plural(unused, 'unused colour')}</button>
    <p class="ps-hint">Sorting only reorders swatches; your artwork looks the same.</p></section>
    <section class="ps-content"><span class="field-label">Value ramp · dark to light <small class="ps-meta">dashed = suggested missing values</small></span><canvas id="ps-chart" class="ps-chart" role="img" aria-label="Palette lightness chart"></canvas>
    <div class="ps-similar-head"><span class="field-label">Too similar to tell apart</span><label class="field-row ps-inline-slider"><span>Threshold</span><input type="range" data-k="similar" min="0.01" max="0.1" step="0.01" value="${ui.similar}" aria-label="Similarity threshold"><output>${FORMAT.similar(ui.similar)}</output></label></div>
    <div class="ps-pairs">${pairs.length ? pairs.slice(0, 12).map(({ a, b, distance }) => `<div class="ps-pair"><i class="ps-chip" style="--swatch:${p[a]}" title="${p[a].toUpperCase()}"></i><i class="ps-chip" style="--swatch:${p[b]}" title="${p[b].toUpperCase()}"></i><span>${a + 1} &amp; ${b + 1} <small class="ps-meta">ΔE ${(distance * 100).toFixed(1)}</small></span><button type="button" class="button small" data-merge="${a},${b}" title="Pixels of colour ${b + 1} take colour ${a + 1}">Merge</button></div>`).join('') : '<p class="maths-info">Every colour is distinct at this threshold.</p>'}</div>
    <div id="ps-rows" class="ps-rows"></div></section></div>`;
}

function onInput(event) {
  const t = event.target;
  if (t.dataset.k) {
    ui[t.dataset.k] = Number(t.value);
    t.closest('.field-row').querySelector('output').textContent = FORMAT[t.dataset.k](ui[t.dataset.k]);
    if (t.dataset.k === 'similar') { if (event.type === 'change') renderTab(); return; }
    refresh();
  } else if (t.dataset.row && event.type === 'change') { ui.rowOn[`${ui.tab}:${t.dataset.row}`] = t.checked; refresh(); }
  else if (t.id === 'ps-search') { ui.query = t.value; renderTab(); const s = d.$('ps-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  else if (t.id === 'ps-tag' && event.type === 'change') { ui.tag = t.value; renderTab(); d.$('ps-tag').focus(); }
  else if ((t.id === 'ps-base-hex' || t.id === 'ps-shade-hex') && event.type === 'change') {
    if (!HEX.test(t.value.trim())) { d.$('ps-error').textContent = 'Use a six-digit hex colour, like #285B47.'; return; }
    const hex = `#${t.value.trim().replace('#', '').toLowerCase()}`;
    if (t.id === 'ps-base-hex') { ui.lch = hexToOklch(hex); refresh(); } else { ui.shade = hex; renderTab(); }
  }
}

function onClick(event) {
  const el = event.target.closest('button');
  if (!el) return;
  const { dataset: ds } = el;
  if (ds.add) addColours([ds.add], true);
  else if (ds.kind) { ui.kind = ds.kind; ui.spread = HARMONIES[ds.kind].spread; renderTab(); focusAgain(`[data-kind="${ds.kind}"]`); }
  else if (ds.base) { ui.lch = hexToOklch(ds.base); renderTab(); }
  else if (ds.shade) { ui.shade = ds.shade; renderTab(); focusAgain(`[data-shade="${ds.shade}"]`); }
  else if (ds.size) { ui.size = ds.size; renderTab(); focusAgain(`[data-size="${ds.size}"]`); }
  else if (ds.preset) { ui.preset = ds.preset; for (const card of d.$('ps-main').querySelectorAll('[data-preset]')) card.setAttribute('aria-selected', card.dataset.preset === ui.preset); renderDetail(); }
  else if (ds.order) apply(() => { d.state.project = reorderPalette(d.state.project, sortPaletteIndices(palette(), ds.order)).project; d.state.color = -1; return `Palette sorted by ${ds.order}. Artwork unchanged.`; });
  else if ('unused' in ds) apply(() => { const r = removeUnusedColours(d.state.project); d.state.project = r.project; return `Removed ${plural(r.removed.length, 'unused colour')}.`; });
  else if (ds.merge) { const [a, b] = ds.merge.split(',').map(Number); apply(() => { d.state.project = removePaletteColour(d.state.project, b, a).project; d.state.color = a; return `Merged colour ${b + 1} into ${a + 1}.`; }); }
}
const focusAgain = selector => d.$('ps-main').querySelector(selector)?.focus();
function renderDetail() {
  const preset = allPalettePresets().find(p => p.id === ui.preset), detail = d.$('ps-main').querySelector('.ps-preset-detail');
  detail.querySelector('.ps-title').textContent = preset.name;
  detail.querySelector('.ps-hint').innerHTML = `${preset.author ? `By ${d.escapeHTML(preset.author)} · ` : ''}via lospec.com. Click a swatch to add just that colour; <strong>Replace palette</strong> recolours your artwork with its nearest colours.`;
  refresh();
}

/** Run a project change as one undo step; report errors in the studio (or as a toast when it is closed). */
function apply(run) {
  let message;
  try { d.mutate(() => { message = run(); }); }
  catch (error) { if (d.$('ps-error') && d.$('modal').open) d.$('ps-error').textContent = error.message; else d.toast(error.message); return false; }
  d.toast(message);
  if (d.$('ps-main') && d.$('modal').open) renderTab();
  return true;
}

function addColours(colours, single = false) {
  apply(() => {
    const r = mergeColours(palette(), colours);
    d.state.project.palette = r.palette;
    if (single) d.state.color = r.added.length ? r.palette.indexOf(r.added[0]) : nearestIndexMap(colours, r.palette)[0];
    if (!r.added.length) return r.overflow.length ? `The palette is full (${MAX_COLORS} colours).` : 'Already in the palette.';
    return `Added ${plural(r.added.length, 'colour')}${r.duplicates.length ? ` · ${r.duplicates.length} already there` : ''}${r.overflow.length ? ` · ${r.overflow.length} didn’t fit (${MAX_COLORS} max)` : ''}.`;
  });
}

function confirmReplace() {
  const colours = resultColours(), box = d.$('ps-confirm'), p = palette();
  if (colours.length > MAX_COLORS) { d.$('ps-error').textContent = `That is ${colours.length} colours; a palette holds ${MAX_COLORS}. Untick some rows.`; return; }
  const map = nearestIndexMap(p, colours), used = usedPaletteIndices(d.state.project), changed = [...used].filter(i => colours[map[i]] !== p[i]).length;
  box.innerHTML = `<div class="ps-compare"><figure><canvas id="ps-before"></canvas><figcaption>Now</figcaption></figure><span aria-hidden="true">→</span><figure><canvas id="ps-after"></canvas><figcaption>After</figcaption></figure></div>
    <p class="ps-confirm-text"><strong>Replace ${plural(p.length, 'colour')} with ${colours.length}?</strong> ${changed ? `${plural(changed, 'colour')} used in your artwork will change: every pixel takes its nearest new colour, in all frames.` : 'Your artwork keeps its look.'} One Undo restores it.</p>
    <div class="ps-confirm-actions"><button type="button" class="button" id="ps-cancel">Cancel</button><button type="button" class="button primary" id="ps-do-replace">${d.icon('check')} Replace palette</button></div>`;
  box.hidden = false;
  const pixels = compositeFrame(d.state.project, d.currentFrame());
  d.paintSprite(d.$('ps-before'), pixels, p, true);
  d.paintSprite(d.$('ps-after'), pixels.map(v => (v < 0 ? v : map[v])), colours, true);
  d.$('ps-cancel').onclick = () => { box.hidden = true; };
  d.$('ps-do-replace').onclick = () => apply(() => {
    d.versionBefore('Before replacing the palette'); d.state.project = replacePalette(d.state.project, colours, map).project; return `Palette replaced (${plural(colours.length, 'colour')}). Undo restores the old one.`; });
  d.$('ps-do-replace').focus();
}

// ── Hue wheel: hue ring with harmony markers around a chroma × lightness square (OKLCH). ──
let drag = null;
const ringCache = new Map(), squareCache = new Map();
function geometry(size) {
  const c = size / 2, R = c - 3, ring = Math.round(size * 0.085), r1 = R - ring, side = Math.floor((r1 - 7) * Math.SQRT2);
  return { c, R, ring, r1, rm: R - ring / 2, side, s: c - side / 2 };
}
function ringImage(size, dpr) {
  const key = `${size}@${dpr}`;
  if (!ringCache.has(key)) {
    const canvas = document.createElement('canvas'), g = canvas.getContext('2d'), { c, R, r1 } = geometry(size);
    canvas.width = canvas.height = Math.round(size * dpr); g.scale(dpr, dpr);
    for (let h = 0; h < 360; h += 2) {
      g.beginPath(); g.fillStyle = oklchToHex([0.74, 0.14, h]);
      const a0 = (-h - 1.6) * Math.PI / 180, a1 = (-h + 1.6) * Math.PI / 180;
      g.arc(c, c, R, a0, a1); g.arc(c, c, r1, a1, a0, true); g.fill();
    }
    ringCache.set(key, canvas);
  }
  return ringCache.get(key);
}
function squareImage(hue) {
  const key = Math.round(hue);
  if (!squareCache.has(key)) {
    const n = 40, canvas = document.createElement('canvas'), g = canvas.getContext('2d'), img = g.createImageData(n, n);
    canvas.width = canvas.height = n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const L = 1 - (y + 0.5) / n, C = ((x + 0.5) / n) * C_MAX, hex = oklchToHex([L, C, key]), inside = hexToOklch(hex)[1] >= C - 0.012, o = (y * n + x) * 4;
      const v = parseInt(hex.slice(1), 16), paper = [255, 254, 251], k = inside ? 1 : 0.28;
      [(v >> 16) & 255, (v >> 8) & 255, v & 255].forEach((ch, i) => { img.data[o + i] = Math.round(ch * k + paper[i] * (1 - k)); });
      img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    if (squareCache.size > 400) squareCache.clear();
    squareCache.set(key, canvas);
  }
  return squareCache.get(key);
}
function drawWheel() {
  const canvas = d.$('ps-wheel');
  if (!canvas) return;
  const size = canvas.clientWidth || 220, dpr = window.devicePixelRatio || 1, g = canvas.getContext('2d'), geo = geometry(size);
  if (canvas.width !== Math.round(size * dpr)) canvas.width = canvas.height = Math.round(size * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, size, size);
  g.drawImage(ringImage(size, dpr), 0, 0, size, size);
  g.imageSmoothingEnabled = true; g.drawImage(squareImage(ui.lch[2]), geo.s, geo.s, geo.side, geo.side);
  g.strokeStyle = '#d8e1d0'; g.lineWidth = 1; g.strokeRect(geo.s - 0.5, geo.s - 0.5, geo.side + 1, geo.side + 1);
  const hues = harmonyHues(ui.lch[2], ui.kind, ui.spread), points = hues.map(h => [geo.c + geo.rm * Math.cos(h * Math.PI / 180), geo.c - geo.rm * Math.sin(h * Math.PI / 180)]);
  if (points.length > 1) {
    g.beginPath(); points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (points.length > 2) g.closePath();
    g.strokeStyle = '#fffefbcc'; g.lineWidth = 3; g.stroke(); g.strokeStyle = '#283b2e99'; g.lineWidth = 1.2; g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]);
  }
  const L = ui.lch[0], C = ui.lch[1];
  points.forEach(([x, y], i) => dot(g, x, y, i ? 6.5 : 9, oklchToHex([L, C, hues[i]]), i === 0));
  dot(g, geo.s + clamp(C / C_MAX, 0, 1) * geo.side, geo.s + (1 - L) * geo.side, 7, baseHex(), true);
  canvas.setAttribute('aria-valuenow', Math.round(ui.lch[2]));
  canvas.setAttribute('aria-valuetext', `Hue ${Math.round(ui.lch[2])}°, lightness ${Math.round(L * 100)}%, chroma ${C.toFixed(2)} · ${baseHex().toUpperCase()}`);
}
function dot(g, x, y, r, fill, strong) {
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = fill; g.fill();
  g.lineWidth = strong ? 3 : 2; g.strokeStyle = '#fff'; g.stroke();
  g.beginPath(); g.arc(x, y, r + (strong ? 1.5 : 1), 0, Math.PI * 2); g.lineWidth = 1; g.strokeStyle = strong ? '#283b2e' : '#283b2e88'; g.stroke();
}
function syncBase() {
  const hex = baseHex(), input = d.$('ps-base-hex');
  d.$('ps-base-chip').style.setProperty('--swatch', hex);
  if (input && document.activeElement !== input) input.value = hex.toUpperCase();
  const [L, C, h] = hexToOklch(hex);
  d.$('ps-base-lch').textContent = `L ${Math.round(L * 100)} · C ${C.toFixed(2)} · ${Math.round(C < 0.005 ? ui.lch[2] : h)}°`;
}
function bindWheel() {
  const canvas = d.$('ps-wheel');
  const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top, r.width]; };
  const set = (x, y, size) => {
    const geo = geometry(size);
    if (drag.mode === 'hue') ui.lch[2] = wrap(Math.round(Math.atan2(geo.c - y, x - geo.c) * 180 / Math.PI - drag.offset));
    else { ui.lch[1] = clamp((x - geo.s) / geo.side, 0, 1) * C_MAX; ui.lch[0] = clamp(1 - (y - geo.s) / geo.side, 0.02, 0.99); }
    refresh();
  };
  canvas.onpointerdown = e => {
    const [x, y, size] = local(e), geo = geometry(size), r = Math.hypot(x - geo.c, y - geo.c);
    if (r >= geo.r1 - 6 && r <= geo.R + 6) {
      const hues = harmonyHues(ui.lch[2], ui.kind, ui.spread), angle = Math.atan2(geo.c - y, x - geo.c) * 180 / Math.PI;
      const near = hues.map((h, i) => [Math.abs(((angle - h + 540) % 360) - 180), i]).sort((a, b) => a[0] - b[0])[0];
      drag = { mode: 'hue', offset: near[0] < 10 ? HARMONIES[ui.kind].offsets(ui.spread)[near[1]] : 0 };
    } else if (x >= geo.s - 4 && x <= geo.s + geo.side + 4 && y >= geo.s - 4 && y <= geo.s + geo.side + 4) drag = { mode: 'square' };
    else return;
    canvas.setPointerCapture(e.pointerId); canvas.focus(); set(x, y, size);
  };
  canvas.onpointermove = e => { if (drag) set(...local(e)); };
  canvas.onpointerup = canvas.onpointercancel = () => { drag = null; };
  canvas.onkeydown = e => {
    const step = e.shiftKey ? 15 : 3, moves = { ArrowLeft: [2, -step], ArrowRight: [2, step], ArrowUp: [0, 0.02], ArrowDown: [0, -0.02], PageUp: [1, 0.01], PageDown: [1, -0.01] }[e.key];
    if (!moves) return;
    e.preventDefault();
    const [i, delta] = moves;
    ui.lch[i] = i === 2 ? wrap(ui.lch[2] + delta) : clamp(ui.lch[i] + delta, i ? 0 : 0.02, i ? C_MAX : 0.99);
    refresh();
  };
}

function drawChart() {
  const canvas = d.$('ps-chart');
  if (!canvas) return;
  const p = palette(), order = sortPaletteIndices(p), gaps = lightnessGaps(p);
  const bars = [...order.map(i => ({ hex: p[i], L: hexToOklch(p[i])[0] })), ...gaps.map(g => ({ hex: g.hex, L: g.L, ghost: true }))].sort((a, b) => a.L - b.L);
  const width = canvas.clientWidth || 400, height = canvas.clientHeight || 120, dpr = window.devicePixelRatio || 1, g = canvas.getContext('2d');
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);
  g.strokeStyle = '#e3e8df'; g.lineWidth = 1;
  for (const v of [0.25, 0.5, 0.75]) { const y = Math.round(height - 4 - v * (height - 8)) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(width, y); g.stroke(); }
  const w = width / bars.length, gap = Math.min(3, w * 0.15);
  bars.forEach((b, i) => {
    const h = Math.max(3, b.L * (height - 8)), x = i * w + gap / 2, y = height - 4 - h;
    if (b.ghost) { g.fillStyle = b.hex; g.fillRect(x + 3, y + 3, w - gap - 6, h - 6); g.setLineDash([4, 3]); g.strokeStyle = '#536e43'; g.lineWidth = 1.5; g.strokeRect(x + 0.75, y + 0.75, w - gap - 1.5, h - 1.5); g.setLineDash([]); }
    else { g.fillStyle = b.hex; g.fillRect(x, y, w - gap, h); g.strokeStyle = '#0000001a'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - gap - 1, h - 1); }
  });
}

// ── Palette swatch right-click menu ──
function closeMenu() { menu?.remove(); menu = null; }
function openSwatchMenu(index, event, button) {
  closeMenu();
  const p = palette(), hex = p[index];
  const entries = [['ramp', 'Make ramp from this', 'ramp', true], ['complement', 'Add complement', 'swap', p.length < MAX_COLORS], ['harmony', 'Harmonies from this…', 'spark', true],
    ['shades', 'Shades & tints…', 'shade', true], null, ['remove', 'Remove colour', 'trash', p.length > 1]];
  menu = document.createElement('div'); menu.className = 'object-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', `Colour ${index + 1} ${hex.toUpperCase()}`);
  menu.innerHTML = `<div class="ps-menu-head"><i class="ps-chip" style="--swatch:${hex}"></i>${hex.toUpperCase()}</div>` + entries.map(e => (e ? `<button role="menuitem" data-menu="${e[0]}"${e[3] ? '' : ' disabled'}>${d.icon(e[2])}<span>${e[1]}</span></button>` : '<hr>')).join('');
  document.body.append(menu);
  const box = menu.getBoundingClientRect(), anchor = button.getBoundingClientRect(), x = event.clientX || anchor.right, y = event.clientY || anchor.top;
  menu.style.left = `${Math.min(x, innerWidth - box.width - 8)}px`; menu.style.top = `${Math.min(y, innerHeight - box.height - 8)}px`;
  menu.onclick = e => { const item = e.target.closest('[data-menu]'); if (item) { closeMenu(); swatchAction(item.dataset.menu, index); } };
  menu.onkeydown = e => {
    const items = [...menu.querySelectorAll('button:not([disabled])')], i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); button.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
  };
  menu.querySelector('button:not([disabled])')?.focus();
  setTimeout(() => { const away = e => { if (!menu?.contains(e.target)) { closeMenu(); document.removeEventListener('pointerdown', away, true); } }; document.addEventListener('pointerdown', away, true); });
}
function swatchAction(action, index) {
  const hex = palette()[index];
  if (action === 'ramp') { d.state.color = index; d.renderAll(); d.$('shading-ramp').click(); }
  else if (action === 'complement') addColours([complementColour(hex)], true);
  else if (action === 'harmony' || action === 'shades') openPaletteStudio(action, hex);
  else if (action === 'remove') apply(() => {
    const used = usedPaletteIndices(d.state.project).has(index);
    d.state.project = removePaletteColour(d.state.project, index).project;
    if (d.state.color > index) d.state.color -= 1;
    return used ? `Removed ${hex.toUpperCase()}; its pixels now use the nearest colour.` : `Removed unused colour ${hex.toUpperCase()}.`;
  });
}
