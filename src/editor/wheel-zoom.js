/**
 * Canvas zoom from the pointer: Ctrl/⌘ (or Alt) + scroll wheel, trackpad pinch (browsers report it as Ctrl + wheel,
 * Safari as gesture events). Zoom keeps the pixel under the pointer in place. Also stops the page itself from being
 * pinch-zoomed, so a pinch never scales the whole interface.
 */
const NOTCH = 50;

/** Wheel delta in pixels, whatever the device reports (lines or pages). */
export function wheelPixels(event) {
  return event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
}

/** Next zoom after `delta` accumulated wheel pixels (negative zooms in), or null until a step is due (pure, for tests). */
export function wheelZoomStep(scale, delta, max) {
  if (Math.abs(delta) < NOTCH) return null;
  const steps = Math.min(4, Math.floor(Math.abs(delta) / NOTCH));
  let next = scale;
  for (let i = 0; i < steps; i++) next = delta < 0 ? Math.max(next + 1, Math.round(next * 1.2)) : Math.min(next - 1, Math.round(next / 1.2));
  return Math.max(1, Math.min(max, next));
}

export function initWheelZoom(stage, { getScale, setZoom, maxZoom }) {
  const canvas = stage.querySelector('canvas');
  let acc = 0, accAt = 0, gesture = null, anchor = null;
  /**
   * Zoom to `scale`, then scroll so the canvas point under (x, y) stays there. The point is kept for the whole
   * gesture, so it is caught up once the canvas grows past the view (a centred canvas cannot scroll yet).
   */
  const zoomAt = (scale, x, y) => {
    if (scale === getScale()) return;
    const before = canvas.getBoundingClientRect(), now = performance.now();
    if (!anchor || now - anchor.at > 400 || Math.hypot(anchor.x - x, anchor.y - y) > 3) anchor = { x, y, fx: (x - before.left) / before.width, fy: (y - before.top) / before.height };
    anchor.at = now;
    const { fx, fy } = anchor;
    setZoom(scale);
    const after = canvas.getBoundingClientRect();
    stage.scrollLeft += after.left + fx * after.width - x;
    stage.scrollTop += after.top + fy * after.height - y;
  };
  stage.addEventListener('wheel', event => {
    if (!(event.ctrlKey || event.metaKey || event.altKey)) return;
    event.preventDefault();
    const now = performance.now();
    if (now - accAt > 250 || Math.sign(acc) !== Math.sign(event.deltaY)) acc = 0;
    accAt = now;
    // Trackpad pinches send many small deltas: amplify them so a pinch feels as quick as a wheel notch.
    const pixels = wheelPixels(event);
    acc += event.ctrlKey && !event.metaKey && Math.abs(pixels) < 20 ? pixels * 4 : pixels;
    const next = wheelZoomStep(getScale(), acc, maxZoom());
    if (next === null) return;
    acc = 0;
    zoomAt(next, event.clientX, event.clientY);
  }, { passive: false });

  // Safari (desktop trackpad and iOS) pinch.
  stage.addEventListener('gesturestart', event => { event.preventDefault(); gesture = { scale: getScale() }; });
  stage.addEventListener('gesturechange', event => {
    event.preventDefault();
    if (!gesture || matchMedia('(pointer: coarse)').matches) return; // touch pinch is handled by the mobile layout
    zoomAt(Math.max(1, Math.min(maxZoom(), Math.round(gesture.scale * event.scale))), event.clientX, event.clientY);
  });
  stage.addEventListener('gestureend', event => { event.preventDefault(); gesture = null; });

  // Never zoom the page itself on touch screens (iOS ignores user-scalable=no).
  for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, event => event.preventDefault(), { passive: false });
  document.addEventListener('touchmove', event => { if (event.touches.length > 1) event.preventDefault(); }, { passive: false });
  return { zoomAt };
}
