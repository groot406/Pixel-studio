/**
 * Zoomable, pannable pixel preview (image import). The view is stored relative to the content — zoom 1 fits it,
 * (cx, cy) is the visible centre as a 0–1 fraction — so swapping in a differently sized result keeps the same region.
 */
// Fit leaves a margin around the content, taller vertically so the floating toolbar doesn't cover it.
const MIN_ZOOM = 0.5, MAX_PIXEL = 64, MARGIN_X = 32, MARGIN_Y = 56;

/** Screen placement of the content: scale (screen px per content px) and its top-left corner. */
export function viewTransform(view, contentW, contentH, boxW, boxH) {
  const fit = Math.min(Math.max(1, boxW - 2 * MARGIN_X) / contentW, Math.max(1, boxH - 2 * MARGIN_Y) / contentH), scale = fit * view.zoom;
  return { fit, scale, x: boxW / 2 - view.cx * contentW * scale, y: boxH / 2 - view.cy * contentH * scale };
}

function clampView(view, contentW, contentH, boxW, boxH) {
  const { fit } = viewTransform(view, contentW, contentH, boxW, boxH);
  const zoom = Math.max(MIN_ZOOM, Math.min(Math.max(1, MAX_PIXEL / fit), view.zoom));
  return { zoom, cx: Math.max(0, Math.min(1, view.cx)), cy: Math.max(0, Math.min(1, view.cy)) };
}

/** Zoom by `factor`, keeping the content under screen point (px, py) in place. */
export function zoomView(view, factor, px, py, contentW, contentH, boxW, boxH) {
  const before = viewTransform(view, contentW, contentH, boxW, boxH);
  const u = (px - before.x) / before.scale / contentW, v = (py - before.y) / before.scale / contentH;
  const next = clampView({ ...view, zoom: view.zoom * factor }, contentW, contentH, boxW, boxH);
  const scale = before.fit * next.zoom;
  return clampView({ zoom: next.zoom, cx: u - (px - boxW / 2) / (contentW * scale), cy: v - (py - boxH / 2) / (contentH * scale) }, contentW, contentH, boxW, boxH);
}

/** Move the content by (dx, dy) screen pixels. */
export function panView(view, dx, dy, contentW, contentH, boxW, boxH) {
  const { scale } = viewTransform(view, contentW, contentH, boxW, boxH);
  return clampView({ ...view, cx: view.cx - dx / (contentW * scale), cy: view.cy - dy / (contentH * scale) }, contentW, contentH, boxW, boxH);
}

const FIT = { zoom: 1, cx: 0.5, cy: 0.5 };

/**
 * Wire a `.zoom-preview` element: it needs a `canvas` and buttons with data-zoom="in|out|fit|grid|original".
 * setImage(source, w, h) shows the result; setOriginal(source, w, h) is what “Show original” displays.
 */
export function createZoomPreview(root) {
  const canvas = root.querySelector('canvas'), context = canvas.getContext('2d');
  const label = root.querySelector('[data-zoom-label]');
  let view = { ...FIT }, image = null, original = null, showOriginal = false, grid = false, frame = 0;
  const shown = () => (showOriginal && original) || image;
  const box = () => ({ w: canvas.clientWidth || 1, h: canvas.clientHeight || 1 });
  const draw = () => {
    frame = 0;
    const dpr = devicePixelRatio || 1, { w, h } = box();
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, w, h);
    const item = shown();
    if (!item) return;
    const t = viewTransform(view, item.width, item.height, w, h);
    context.imageSmoothingEnabled = item === original && t.scale < 1;
    context.drawImage(item.source, t.x, t.y, item.width * t.scale, item.height * t.scale);
    if (grid && item === image && t.scale >= 4) {
      context.beginPath();
      const x0 = Math.max(0, Math.floor(-t.x / t.scale)), x1 = Math.min(item.width, Math.ceil((w - t.x) / t.scale));
      const y0 = Math.max(0, Math.floor(-t.y / t.scale)), y1 = Math.min(item.height, Math.ceil((h - t.y) / t.scale));
      for (let x = x0; x <= x1; x++) { const sx = Math.round(t.x + x * t.scale) + .5; context.moveTo(sx, Math.max(0, t.y + y0 * t.scale)); context.lineTo(sx, Math.min(h, t.y + y1 * t.scale)); }
      for (let y = y0; y <= y1; y++) { const sy = Math.round(t.y + y * t.scale) + .5; context.moveTo(Math.max(0, t.x + x0 * t.scale), sy); context.lineTo(Math.min(w, t.x + x1 * t.scale), sy); }
      context.strokeStyle = '#1b2b2033'; context.lineWidth = 1; context.stroke();
    }
    if (label) { label.textContent = t.scale >= 1 ? `${+t.scale.toFixed(t.scale < 10 ? 1 : 0)}×` : `${Math.round(t.scale * 100)}%`; label.title = 'Screen pixels per image pixel'; }
  };
  const render = () => { frame ||= requestAnimationFrame(draw); };
  const apply = next => { const item = shown(); if (item) { view = next(item); render(); } };
  const zoomBy = (factor, px, py) => apply(item => { const { w, h } = box(); return zoomView(view, factor, px ?? w / 2, py ?? h / 2, item.width, item.height, w, h); });
  const panBy = (dx, dy) => apply(item => { const { w, h } = box(); return panView(view, dx, dy, item.width, item.height, w, h); });
  const local = event => { const r = canvas.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; };

  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const p = local(event), delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    zoomBy(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), p.x, p.y);
  }, { passive: false });
  const pointers = new Map();
  let pinch = null;
  canvas.addEventListener('pointerdown', event => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, local(event));
    canvas.classList.add('dragging');
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
  });
  canvas.addEventListener('pointermove', event => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    const p = local(event);
    pointers.set(event.pointerId, p);
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()], distance = Math.hypot(a.x - b.x, a.y - b.y);
      zoomBy(distance / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2); pinch = distance;
    } else if (pointers.size === 1) panBy(p.x - last.x, p.y - last.y);
  });
  const release = event => { pointers.delete(event.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) canvas.classList.remove('dragging'); };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('dblclick', event => { const p = local(event); if (view.zoom > 1.01) { view = { ...FIT }; render(); } else zoomBy(4, p.x, p.y); });
  canvas.addEventListener('keydown', event => {
    const step = event.shiftKey ? 120 : 40, keys = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (event.key === '+' || event.key === '=') zoomBy(1.5);
    else if (event.key === '-' || event.key === '_') zoomBy(1 / 1.5);
    else if (event.key === '0') { view = { ...FIT }; render(); }
    else if (keys[event.key]) panBy(...keys[event.key]);
    else return;
    event.preventDefault(); event.stopPropagation();
  });
  const buttons = Object.fromEntries([...root.querySelectorAll('[data-zoom]')].map(b => [b.dataset.zoom, b]));
  if (buttons.in) buttons.in.onclick = () => zoomBy(1.5);
  if (buttons.out) buttons.out.onclick = () => zoomBy(1 / 1.5);
  if (buttons.fit) buttons.fit.onclick = () => { view = { ...FIT }; render(); };
  if (buttons.grid) buttons.grid.onclick = () => { grid = !grid; buttons.grid.setAttribute('aria-pressed', String(grid)); render(); };
  if (buttons.original) buttons.original.onclick = () => { showOriginal = !showOriginal; buttons.original.setAttribute('aria-pressed', String(showOriginal)); root.classList.toggle('showing-original', showOriginal); render(); };
  const resize = new ResizeObserver(render);
  resize.observe(canvas);
  return {
    setImage(source, width, height) { image = { source, width, height }; render(); },
    setOriginal(source, width, height) { original = { source, width, height }; render(); },
    disconnect() { resize.disconnect(); if (frame) cancelAnimationFrame(frame); },
  };
}
