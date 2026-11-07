/**
 * Pixel cleanup checker (Effects panel): finds stray pixels, doubled corners on 1px lines, jagged line steps and
 * banding on the active container's current cel (src/domain/cleanup.js), marks them on the canvas and lists them
 * with a Fix for each stray or corner and a "Fix all safe" button. Jaggies and banding are only highlighted.
 */
import { findIssues, safeFixes } from '../domain/cleanup.js';
import { applyPixelEffect } from '../domain/effects.js';

let d, result = null, key = '', focus = -1;
const LIMIT = 60;
const LABELS = { stray: ['stray pixel', 'stray pixels'], corner: ['corner', 'corners'], jaggy: ['jaggy', 'jaggies'], banding: ['banding', 'banding'] };
const TIPS = {
  stray: 'A lone pixel unlike all 8 neighbours. Fix paints it like its surroundings.',
  corner: 'A doubled pixel making an L-corner on a 1-pixel line. Fix removes it.',
  jaggy: 'Uneven steps along a line (like 2-1-2-3). Even them out by hand.',
  banding: 'Two colours stepping in parallel with the same lengths, so the edge looks thick. Offset or merge the steps.',
};

/** Wire the Pixel cleanup button and the results list. */
export function initCleanupPanel(deps) {
  d = deps;
  d.state.cleanup = { active: false };
  d.$('effect-check').onclick = () => { d.state.cleanup.active = !d.state.cleanup.active; focus = -1; key = ''; d.renderAll(); };
  d.$('cleanup-results').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.action === 'close') { d.state.cleanup.active = false; d.renderAll(); return; }
    if (button.dataset.action === 'fix-all') { fix(safeFixes(result.issues)); return; }
    const issue = result?.issues[Number(button.dataset.issue)];
    if (!issue) return;
    if (button.dataset.action === 'fix') fix(issue.fix);
    else { focus = Number(button.dataset.issue); render(); d.renderCanvas(); }
  });
  d.$('cleanup-results').addEventListener('pointerover', event => {
    const row = event.target.closest('[data-row]'), next = row ? Number(row.dataset.row) : focus;
    if (next !== focus) { focus = next; d.renderCanvas(); }
  });
}

function cel() { return d.currentFrame().cels.find(c => c.layerId === d.currentLayer().id); }

/** Re-check when the pixels change; returns the current result. */
function analyse() {
  const { state } = d, pixels = cel()?.pixels || [], next = `${state.project.width}x${state.project.height}|${d.currentFrame().id}|${d.currentLayer().id}|${pixels.join()}`;
  if (next !== key) { key = next; result = findIssues(pixels, state.project.width, state.project.height); if (focus >= result.issues.length) focus = -1; }
  return result;
}

/** Paint the fixes as one undo step. */
function fix(fixes) {
  if (!fixes?.length) return;
  try {
    d.mutate(() => { d.state.project = applyPixelEffect(d.state.project, { ...d.objectTarget(), scope: 'frame' }, 'pixelFix', { fixes }).project; });
    focus = -1; d.renderAll();
  } catch (error) { d.toast(error.message); }
}

const plural = (n, type) => `${n} ${LABELS[type][n === 1 ? 0 : 1]}`;

/** Results summary and list; `reason` disables the checker (hidden or locked container). Called from renderEffectsPanel. */
export function renderCleanupPanel(reason = '') {
  const { state, $ } = d, button = $('effect-check');
  button.disabled = Boolean(reason); button.title = reason;
  button.classList.toggle('active', state.cleanup.active); button.setAttribute('aria-pressed', String(state.cleanup.active));
  if (reason || state.inPlaceEdit) state.cleanup.active = false;
  $('cleanup-results').hidden = !state.cleanup.active;
  if (state.cleanup.active) render();
}

function render() {
  const { issues, counts } = analyse(), safe = safeFixes(issues).length;
  const parts = Object.keys(LABELS).filter(type => counts[type]).map(type => plural(counts[type], type));
  const summary = issues.length ? `${issues.length} issue${issues.length === 1 ? '' : 's'}: ${parts.join(', ')}` : 'No issues found. Clean pixels!';
  d.$('cleanup-results').innerHTML = `<div class="cleanup-head"><strong role="status">${summary}</strong><span class="cleanup-actions">${safe ? `<button type="button" class="button small primary" data-action="fix-all" title="Fix every stray pixel and doubled corner (one undo step)">Fix all safe</button>` : ''}<button type="button" class="button small" data-action="close">Close</button></span></div>
    ${issues.length ? `<ol class="cleanup-list">${issues.slice(0, LIMIT).map((issue, i) => `<li data-row="${i}" class="${i === focus ? 'focused' : ''}"><button type="button" class="cleanup-go" data-issue="${i}" data-action="show" title="${TIPS[issue.type]}"><i class="cleanup-mark ${issue.type}"></i>${LABELS[issue.type][0]} <small>${issue.x}, ${issue.y}</small></button>${issue.fix ? `<button type="button" class="button small" data-issue="${i}" data-action="fix">Fix</button>` : ''}</li>`).join('')}</ol>${issues.length > LIMIT ? `<p class="part-hint">Showing the first ${LIMIT}.</p>` : ''}` : ''}`;
}

const COLOURS = { stray: '#e0344a', corner: '#e8892c', jaggy: '#2f7de1', banding: '#8a4fd6' };

/** Issue markers on the canvas while the checker is open. */
export function drawCleanupOverlay(context) {
  const { state } = d;
  if (!state.cleanup?.active || state.inPlaceEdit) return;
  if (!state.drawing || !result) analyse();
  const s = state.scale, { width } = state.project;
  context.save();
  result.issues.forEach((issue, i) => {
    const on = i === focus, colour = COLOURS[issue.type];
    context.globalAlpha = focus < 0 || on ? 1 : .45;
    context.lineWidth = on ? 3 : 2;
    for (const index of issue.indices) {
      const x = (index % width) * s, y = Math.floor(index / width) * s;
      if (issue.type === 'stray') {
        context.beginPath(); context.arc(x + s / 2, y + s / 2, Math.max(s * .75, 7), 0, Math.PI * 2);
        context.strokeStyle = '#fff'; context.lineWidth = on ? 5 : 4; context.stroke();
        context.strokeStyle = colour; context.lineWidth = on ? 3 : 2; context.stroke();
      } else {
        context.setLineDash(issue.type === 'banding' ? [3, 3] : []);
        context.strokeStyle = colour; context.fillStyle = `${colour}33`;
        context.fillRect(x, y, s, s); context.strokeRect(x + 1, y + 1, s - 2, s - 2);
        context.setLineDash([]);
      }
    }
  });
  context.restore();
}
