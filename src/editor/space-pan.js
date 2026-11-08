/**
 * Hold Space (or drag with the middle mouse button) to grab and move the canvas view, like a temporary
 * hand tool. A quick Space tap without dragging is passed on unchanged, so it still plays / pauses.
 */
const TYPING = 'input,textarea,select,[contenteditable=""],[contenteditable="true"]';

/** New scroll position for a grab that started at `start` (pure, for tests). */
export function panScroll(start, from, to) {
  return {x: start.x - (to.x - from.x), y: start.y - (to.y - from.y)};
}

export function initSpacePan(stage) {
  let held = null, drag = null, over = false, replaying = false;
  stage.addEventListener('pointerenter', () => { over = true; });
  stage.addEventListener('pointerleave', () => { over = false; });
  const mode = () => {
    stage.classList.toggle('space-pan', !!held || !!drag);
    stage.classList.toggle('space-panning', !!drag);
  };
  const release = () => { held = null; drag = null; mode(); };

  const blocked = event => event.target.closest?.(TYPING) || document.querySelector('dialog[open]')
    || (event.target.closest?.('button,a,[role="tab"]') && !over);
  window.addEventListener('keydown', event => {
    if (replaying || event.key !== ' ' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!held && blocked(event)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!held) { held = {target: event.target, moved: false}; mode(); }
  }, true);
  window.addEventListener('keyup', event => {
    if (event.key !== ' ' || !held) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const {target, moved} = held;
    held = null; if (!drag) mode();
    if (moved || !target.isConnected) return;
    replaying = true;
    try { target.dispatchEvent(new KeyboardEvent('keydown', {key: ' ', code: 'Space', bubbles: true, cancelable: true})); }
    finally { replaying = false; }
  }, true);
  window.addEventListener('blur', release);

  window.addEventListener('pointerdown', event => {
    if (!stage.contains(event.target) || !(held && event.button === 0 || event.button === 1)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (held) held.moved = true;
    drag = {id: event.pointerId, from: {x: event.clientX, y: event.clientY}, start: {x: stage.scrollLeft, y: stage.scrollTop}};
    try { stage.setPointerCapture(event.pointerId); } catch {}
    mode();
  }, true);
  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const to = panScroll(drag.start, drag.from, {x: event.clientX, y: event.clientY});
    stage.scrollLeft = to.x; stage.scrollTop = to.y;
  }, true);
  const end = event => {
    if (!drag || event.pointerId !== drag.id) return;
    event.stopImmediatePropagation();
    drag = null; mode();
  };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
  // Middle-click autoscroll would fight the grab.
  stage.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); });
  return {active: () => !!held || !!drag};
}
