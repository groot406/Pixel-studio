/**
 * Outline dialog (#magic-outline): the live outline (project.outline, drawn at composite time so it always follows
 * the art and every animation tool), removing baked-in outlines so the live one can take over, and the older
 * "bake onto its own layer" outline.
 */
import { compositeFrame } from '../domain/project.js';
import { readOutline, stripOutlines, edgeColours, suggestOutlineColours } from '../domain/live-outline.js';

let d, bakeDialog;

export function initOutlineDialog(deps, { bake }) {
  d = deps; bakeDialog = bake;
  d.$('magic-outline').onclick = () => outlineDialog();
  renderOutlineButton();
}

/** The toolbox button shows whether the live outline is on. */
export function renderOutlineButton() {
  if (!d) return;
  const button = d.$('magic-outline'), on = Boolean(d.state.project.outline);
  button.classList.toggle('on', on);
  button.setAttribute('aria-pressed', String(on));
  button.querySelector('span').textContent = on ? 'Live outline: on' : 'Outline…';
  button.title = on ? 'The outline is redrawn around the artwork in every frame. Click to change or turn off.' : 'Live outline that follows every change, remove baked-in outlines, or bake one onto a layer';
}

const lum = hex => parseInt(hex.slice(1, 3), 16) * .299 + parseInt(hex.slice(3, 5), 16) * .587 + parseInt(hex.slice(5, 7), 16) * .114;
const select = (id, label, options, value) => `<label class="field"><span class="field-label">${label}</span><select id="${id}">${options.map(([v, text]) => `<option value="${v}"${String(v) === String(value) ? ' selected' : ''}>${text}</option>`).join('')}</select></label>`;
const check = (id, label, on, extra = '') => `<label class="check-row"><input id="${id}" type="checkbox"${on ? ' checked' : ''}${extra}> ${label}</label>`;

function swatches(id, selected, { multi = false, list } = {}) {
  const palette = d.state.project.palette, chosen = new Set([].concat(selected));
  const items = (list || palette.map((_, i) => ({ color: i }))).map(({ color, share }) => {
    const on = chosen.has(color), label = `Colour ${color + 1} · ${palette[color].toUpperCase()}${share ? ` · ${Math.round(share * 100)}% of edges` : ''}`;
    return `<button type="button" class="swatch${share ? ' with-share' : ''}" style="--swatch:${palette[color]}" data-value="${color}" role="${multi ? 'checkbox' : 'radio'}" aria-checked="${on}" aria-pressed="${on}" title="${label}" aria-label="${label}">${share ? `<small>${Math.round(share * 100)}%</small>` : ''}</button>`;
  }).join('');
  return `<div id="${id}" class="swatch-pick${multi ? ' multi' : ''}" role="${multi ? 'group' : 'radiogroup'}" data-value="${[...chosen].join(',')}">${items}</div>`;
}
const picked = id => d.$(id).dataset.value.split(',').filter(Boolean).map(Number);

function layerChecks(prefix, layers, isOn) {
  return `<fieldset class="outline-layers"><legend class="field-label">Layers</legend>${layers.map(l => `<label class="check-row"><input type="checkbox" data-${prefix}-layer="${d.escapeHTML(l.id)}"${isOn(l) ? ' checked' : ''}${l.locked && prefix === 'strip' ? ' disabled' : ''}> ${d.escapeHTML(l.name)}${l.visible ? '' : ' <small>(hidden)</small>'}${l.locked ? ' <small>(locked)</small>' : ''}</label>`).join('')}</fieldset>`;
}

export function outlineDialog(tab) {
  const { $, state } = d, project = state.project, o = project.outline;
  if (state.inPlaceEdit) { d.toast('Finish editing the object on the canvas first.'); return; }
  const darkest = project.palette.reduce((best, c, i, all) => lum(c) < lum(all[best]) ? i : best, 0);
  const edges = edgeColours(project).slice(0, 8), suggested = suggestOutlineColours(project);
  const layers = [...project.layers].reverse();
  d.openDialog('Outline', `<form id="ol-form" class="maths-form outline-form">
    <div class="seg-control outline-tabs" role="tablist">
      <button type="button" class="button small" role="tab" data-tab="live">Live outline</button>
      <button type="button" class="button small" role="tab" data-tab="strip">Remove baked outline</button>
    </div>
    <div class="maths-preview"><figure><figcaption>Now</figcaption><canvas id="ol-before" aria-label="Current frame"></canvas></figure><figure><figcaption>After</figcaption><canvas id="ol-after" aria-label="Preview"></canvas></figure></div>
    <section data-panel="live">
      <p class="modal-body-text">A live outline is drawn around the artwork whenever a frame is shown or exported, but never stored in the pixels — so it stays correct when parts move, rotate, squash or get redrawn.</p>
      ${check('ol-on', '<b>Live outline on</b>', o || !tab, '')}
      <div class="form-grid">${select('ol-style', 'Colour', [['single', 'One colour'], ['selective', 'Auto · darker shade of each edge']], o?.style || 'single')}${select('ol-mode', 'Where', [['outside', 'Around the art'], ['inside', 'On the art’s edge']], o?.mode || 'outside')}</div>
      <div class="field" id="ol-colour-field"><span class="field-label">Outline colour</span>${swatches('ol-colour', o?.style === 'single' ? o.color : suggested[0] ?? darkest)}</div>
      <div class="form-grid">${select('ol-corners', 'Corners', [['0', 'Crisp · 4 neighbours'], ['1', 'Full · 8 neighbours']], o?.corners ? 1 : 0)}${select('ol-thickness', 'Thickness', [[1, '1 pixel'], [2, '2 pixels'], [3, '3 pixels']], o?.thickness || 1)}</div>
      ${check('ol-separate', 'Outline each layer separately <small>(lines where layers overlap)</small>', o?.separate)}
      ${layers.length > 1 ? layerChecks('live', layers, l => !o?.skip?.includes(l.id)) : ''}
    </section>
    <section data-panel="strip">
      <p class="modal-body-text">Removes outline-coloured pixels from the edges of each layer’s drawing and of every part, in every frame — then the live outline takes over and stays correct while animating. Interior details are kept.</p>
      <div class="field"><span class="field-label">Outline colours found on edges</span>${edges.length ? swatches('ol-strip', suggested, { multi: true, list: edges }) : '<p class="helper-text">No artwork on the chosen layers.</p>'}</div>
      <div class="form-grid">${select('ol-passes', 'Outline thickness', [[1, '1 pixel'], [2, '2 pixels'], [3, '3 pixels']], 1)}<div class="field">${check('ol-parts', 'Clean parts too', true)}${check('ol-then', 'Then turn on the live outline', true)}</div></div>
      ${layerChecks('strip', layers, l => l.visible && !l.locked)}
    </section>
    <p id="ol-info" class="maths-info" aria-live="polite"></p><p id="ol-error" class="maths-error" role="alert"></p>
    <div class="modal-actions"><button type="button" id="ol-bake" class="button subtle" title="The old way: trace every frame once onto a separate editable layer">Bake onto a layer…</button><button type="button" id="ol-cancel" class="button">Cancel</button><button type="submit" id="ol-submit" class="button primary">Apply</button></div>
  </form>`, 'OUTLINE');
  const form = $('ol-form'), frame = d.currentFrame();
  let tabNow = tab || 'live';
  const liveSetting = () => {
    if (!$('ol-on').checked) return undefined;
    const style = $('ol-style').value;
    const skip = [...form.querySelectorAll('[data-live-layer]')].filter(i => !i.checked).map(i => i.dataset.liveLayer);
    return readOutline({ style, color: style === 'single' ? picked('ol-colour')[0] ?? darkest : undefined, mode: $('ol-mode').value, corners: $('ol-corners').value === '1', thickness: Number($('ol-thickness').value), separate: $('ol-separate').checked, skip }, project.palette.length);
  };
  const stripOptions = () => ({ colors: edges.length ? picked('ol-strip') : [], passes: Number($('ol-passes').value), parts: $('ol-parts').checked, layerIds: [...form.querySelectorAll('[data-strip-layer]')].filter(i => i.checked).map(i => i.dataset.stripLayer) });
  const candidate = () => {
    if (tabNow === 'live') { const outline = liveSetting(), p = { ...project }; if (outline) p.outline = outline; else delete p.outline; return { project: p, info: outline ? 'Applies to every frame and every export. Turn it off any time.' : 'No live outline.' }; }
    const opts = stripOptions();
    if (!opts.colors.length) throw new Error('Pick the outline colour to remove.');
    if (!opts.layerIds.length) throw new Error('Choose at least one layer.');
    const r = stripOutlines(project, opts), p = { ...r.project };
    if ($('ol-then').checked) p.outline = readOutline({ ...(project.outline || {}), style: project.outline?.style || 'single', color: project.outline?.style === 'selective' ? undefined : project.outline?.color ?? opts.colors.reduce((a, b) => lum(project.palette[a]) <= lum(project.palette[b]) ? a : b) }, project.palette.length);
    else delete p.outline;
    return { project: p, info: r.removed ? `Removes ${r.removed} outline pixel${r.removed === 1 ? '' : 's'}${r.parts ? ` (${r.parts} part${r.parts === 1 ? '' : 's'} cleaned)` : ''} across all frames.` : 'No outline pixels found with these colours.', removed: r.removed };
  };
  let queued = false;
  const preview = () => {
    queued = false;
    try {
      const { project: p, info } = candidate();
      const after = p.animations.flatMap(a => a.frames).find(f => f.id === frame.id);
      d.paintSprite($('ol-after'), compositeFrame(p, after), p.palette, true);
      $('ol-info').textContent = info; $('ol-error').textContent = '';
    } catch (error) { $('ol-error').textContent = error.message; $('ol-info').textContent = ''; }
  };
  const refresh = () => {
    for (const panel of form.querySelectorAll('section[data-panel]')) panel.hidden = panel.dataset.panel !== tabNow;
    for (const button of form.querySelectorAll('[data-tab]')) { const on = button.dataset.tab === tabNow; button.classList.toggle('active', on); button.setAttribute('aria-selected', String(on)); }
    const on = $('ol-on').checked;
    for (const el of form.querySelectorAll('section[data-panel="live"] :is(select, input:not(#ol-on), .swatch)')) el.disabled = !on;
    $('ol-colour-field').hidden = $('ol-style').value !== 'single';
    $('ol-thickness').disabled = !on || $('ol-mode').value === 'inside';
    $('ol-submit').textContent = tabNow === 'live' ? (on ? (project.outline ? 'Update live outline' : 'Turn on live outline') : project.outline ? 'Turn off live outline' : 'Apply') : 'Remove outline';
    if (!queued) { queued = true; requestAnimationFrame(preview); }
  };
  d.paintSprite($('ol-before'), compositeFrame(project, frame), project.palette, true);
  form.addEventListener('input', refresh); form.addEventListener('change', refresh);
  form.addEventListener('click', event => {
    const tabButton = event.target.closest('[data-tab]');
    if (tabButton) { tabNow = tabButton.dataset.tab; refresh(); return; }
    const option = event.target.closest('.swatch-pick [data-value]');
    if (!option || option.disabled) return;
    const group = option.parentElement, multi = group.classList.contains('multi');
    const values = new Set(group.dataset.value.split(',').filter(Boolean));
    if (multi) { if (values.has(option.dataset.value)) values.delete(option.dataset.value); else values.add(option.dataset.value); }
    else { values.clear(); values.add(option.dataset.value); }
    group.dataset.value = [...values].join(',');
    for (const el of group.querySelectorAll('[data-value]')) { const on = values.has(el.dataset.value); el.setAttribute('aria-pressed', String(on)); el.setAttribute('aria-checked', String(on)); }
    refresh();
  });
  $('ol-cancel').onclick = () => $('modal').close();
  $('ol-bake').onclick = () => { $('modal').close(); bakeDialog(); };
  form.onsubmit = event => {
    event.preventDefault();
    let result;
    try { result = candidate(); } catch (error) { $('ol-error').textContent = error.message; return; }
    if (tabNow === 'strip' && !result.removed) { $('ol-error').textContent = 'Nothing to remove with these colours.'; return; }
    d.mutate(() => { state.project = result.project; });
    $('modal').close(); d.renderAll(); renderOutlineButton();
    d.toast(tabNow === 'strip' ? `${result.info.replace(/^Removes/, 'Removed')}${result.project.outline ? ' Live outline is on.' : ''}` : result.project.outline ? 'Live outline on: it follows every edit and animation. Undo is available.' : 'Live outline off.');
  };
  refresh();
}
