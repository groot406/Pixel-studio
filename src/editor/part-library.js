/** Visual part browser: a sidebar strip (drag onto the canvas) and a full library window. */
import { renderParts } from '../domain/artwork.js';
import { partUsage, frameRanges, renamePart, removePart, flattenCel } from '../domain/parts.js';

export const PART_DRAG_TYPE = 'application/x-pixel-studio-part';
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $ = id => document.getElementById(id);

function usageText(usage) {
  if(!usage?.instances) return 'Not placed yet';
  const where = usage.animations.length===1 ? usage.animations[0].name : `${usage.animations.length} animations`;
  return `Used ${usage.instances}× · ${where}`;
}
function makeDraggable(element, partId) {
  element.draggable = true;
  element.addEventListener('dragstart', event => {
    event.dataTransfer.setData(PART_DRAG_TYPE, partId);
    event.dataTransfer.setData('text/plain', partId);
    event.dataTransfer.effectAllowed = 'copy';
    document.body.classList.add('is-dragging-part');
  });
  element.addEventListener('dragend', () => document.body.classList.remove('is-dragging-part'));
}

/** Sidebar "Parts" section: thumbnails to drag onto the canvas or open in the library. */
export function renderPartsStrip({ project, paint, onOpen, onPlace }) {
  const parts = project.parts || [], images = renderParts(parts), usage = partUsage(project);
  $('part-count').textContent = parts.length;
  const grid = $('part-strip');
  grid.innerHTML = parts.length
    ? parts.map(part => `<button type="button" class="part-thumb${usage.get(part.id)?.instances ? '' : ' unused'}" data-part="${escape(part.id)}" title="${escape(part.id)} · ${part.width}×${part.height} · ${usageText(usage.get(part.id))}\nDrag onto the canvas to place · click for details"><canvas></canvas><span>${escape(part.id)}</span></button>`).join('')
    : '<p class="part-empty">No parts yet. Select pixels and press <kbd>Ctrl/⌘ G</kbd> to make a reusable part.</p>';
  grid.querySelectorAll('[data-part]').forEach(button => {
    const part = images.get(button.dataset.part);
    paint(button.querySelector('canvas'), part.pixels, project.palette, false, part.width, part.height);
    makeDraggable(button, part.id);
    button.onclick = () => onOpen(part.id);
    button.ondblclick = () => onPlace(part.id);
  });
}

/**
 * The library window. `actions` comes from the editor: place(partId) → message, editArtwork(partId),
 * change(project) for renames/deletes/new parts, and placeLabel() describing where Place puts it.
 */
export function openPartLibrary({ getProject, openDialog, paint, actions, initialPart = '', selection = false, target }) {
  let selected = initialPart, query = '', sort = 'name';
  function fail(error) { const box = $('part-lib-error'); if(box){ box.textContent = error.message; box.hidden = false; } }
  function show() {
    const project = getProject(), parts = project.parts || [], images = renderParts(parts), usage = partUsage(project);
    if(!parts.some(p => p.id === selected)) selected = parts[0]?.id || '';
    const shown = parts.filter(p => p.id.toLowerCase().includes(query.toLowerCase())).sort((a, b) =>
      sort === 'used' ? (usage.get(b.id).instances - usage.get(a.id).instances) || a.id.localeCompare(b.id)
      : sort === 'size' ? (b.width * b.height - a.width * a.height) || a.id.localeCompare(b.id)
      : a.id.localeCompare(b.id));
    const part = images.get(selected), use = usage.get(selected);
    const colours = part ? new Set(part.pixels.filter(c => c >= 0)).size : 0;
    const layer = project.layers.find(l => l.id === target().layerId);
    const canPlace = Boolean(part && layer?.visible && !layer?.locked);
    openDialog('Part library', `
      <ol class="part-howto" aria-label="How parts work">
        <li><strong>Make</strong><span>Select pixels, press <kbd>Ctrl/⌘ G</kbd> (or use “New part from selection”).</span></li>
        <li><strong>Place</strong><span>Drag a part from the sidebar onto the canvas, or pick one here and press Place.</span></li>
        <li><strong>Reuse</strong><span>Every copy shares the artwork: edit it once and all copies update.</span></li>
      </ol>
      <p id="part-lib-error" role="alert" class="helper-text parts-error" hidden></p>
      <div class="part-lib">
        <section class="part-lib-browser" aria-label="Parts">
          <div class="part-lib-toolbar">
            <input id="part-search" type="search" placeholder="Search ${parts.length} part${parts.length === 1 ? '' : 's'}" value="${escape(query)}" aria-label="Search parts" autocomplete="off">
            <select id="part-sort" aria-label="Sort parts"><option value="name">A–Z</option><option value="used">Most used</option><option value="size">Largest</option></select>
          </div>
          <div class="part-lib-grid" role="listbox" aria-label="Parts">${shown.map(p => `<button type="button" role="option" class="part-card${p.id === selected ? ' selected' : ''}${usage.get(p.id).instances ? '' : ' unused'}" data-part="${escape(p.id)}" aria-selected="${p.id === selected}"><span class="part-card-art"><canvas></canvas></span><strong>${escape(p.id)}</strong><small>${p.width}×${p.height} · ${usage.get(p.id).instances ? `${usage.get(p.id).instances}×` : 'unused'}</small></button>`).join('')
            || `<p class="part-empty">${parts.length ? 'No parts match.' : 'No parts yet. Make one from a selection to start your library.'}</p>`}</div>
          <button type="button" id="part-new" class="button small part-new" ${selection ? '' : 'disabled'} title="${selection ? 'Turn the selected pixels into a new part' : 'Select pixels on the canvas first (Select S or Wand W)'}">+ New part from selection</button>
        </section>
        <section class="part-lib-detail" aria-live="polite">${part ? `
          <div class="part-lib-preview"><canvas id="part-big"></canvas></div>
          <label class="field part-name-field"><span class="field-label">Name</span><input id="part-rename" value="${escape(part.id)}" maxlength="100" pattern="[a-zA-Z0-9_\\-]+" title="Letters, numbers, - and _"></label>
          <dl class="part-facts"><div><dt>Size</dt><dd>${part.width} × ${part.height} px</dd></div><div><dt>Colours</dt><dd>${colours}</dd></div><div><dt>Copies</dt><dd>${use.instances}</dd></div></dl>
          <div class="part-where"><span class="field-label">Used in</span>${use.instances ? `<ul>${use.animations.map(a => `<li><strong>${escape(a.name)}</strong> · frame${a.frames.length === 1 ? '' : 's'} ${frameRanges(a.frames)}</li>`).join('')}</ul>` : '<p class="helper-text">Not placed anywhere yet.</p>'}</div>
          <div class="part-lib-actions">
            <button type="button" id="part-place" class="button primary" ${canPlace ? '' : 'disabled'}>${escape(actions.placeLabel())}</button>
            <p class="helper-text">${canPlace ? 'Placed in the middle of the canvas and selected, ready to drag into position.' : 'Show and unlock the current object first.'}</p>
            <button type="button" id="part-edit" class="button">Edit artwork${use.instances > 1 ? ` (updates ${use.instances} copies)` : ''}</button>
            <button type="button" id="part-delete" class="button danger-text" ${use.instances ? 'disabled title="Delete its objects first"' : ''}>Delete part</button>
          </div>` : '<p class="part-empty">Select a part to see where it is used.</p>'}
        </section>
      </div>
      <details class="part-advanced"><summary>Advanced</summary><p class="helper-text">Flattening bakes this frame's objects on the current layer into plain pixels; they stop updating with their parts. Undo restores them.</p><button type="button" id="part-flatten" class="button small">Flatten this frame's objects</button></details>
      <div class="modal-actions"><button type="button" id="part-lib-close" class="button">Close</button></div>`, 'PARTS');
    $('modal').classList.add('part-library-modal');
    $('part-sort').value = sort;
    $('part-lib-close').onclick = () => $('modal').close();
    $('part-search').oninput = event => { query = event.target.value; const pos = event.target.selectionStart; show(); const input = $('part-search'); input.focus(); input.setSelectionRange(pos, pos); };
    $('part-sort').onchange = event => { sort = event.target.value; show(); };
    document.querySelectorAll('.part-card').forEach(card => {
      const p = images.get(card.dataset.part);
      paint(card.querySelector('canvas'), p.pixels, project.palette, false, p.width, p.height);
      card.onclick = () => { selected = p.id; show(); document.querySelector(`.part-card[data-part="${CSS.escape(p.id)}"]`)?.focus(); };
      card.ondblclick = () => { if(canPlace) place(); };
    });
    $('part-new').onclick = () => { $('modal').close(); actions.makeFromSelection(); };
    $('part-flatten').onclick = () => { try { actions.change(flattenCel(getProject(), target())); show(); } catch(error) { fail(error); } };
    if(!part) return;
    paint($('part-big'), part.pixels, project.palette, true, part.width, part.height);
    $('part-place').onclick = place;
    $('part-edit').onclick = () => actions.editArtwork(part.id);
    $('part-delete').onclick = () => { try { actions.change(removePart(getProject(), part.id)); selected = ''; show(); } catch(error) { fail(error); } };
    $('part-rename').onchange = event => {
      const next = event.target.value.trim();
      try { actions.change(renamePart(getProject(), part.id, next)); selected = next; show(); } catch(error) { fail(error); event.target.value = part.id; }
    };
  }
  function place() {
    try { actions.place(selected); $('modal').close(); } catch(error) { fail(error); }
  }
  show();
}
