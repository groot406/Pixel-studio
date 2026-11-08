/**
 * Workspace views: which panels show, where (left / right sidebar, floating or hidden), in what order and how the
 * sidebars and timeline are sized. Pure data so presets can be tested and stored; the editor applies them in
 * src/editor/workspace-views.js.
 */
export const PANEL_IDS = ['tools', 'palette', 'transforms', 'preview', 'layers', 'parts', 'animate', 'effects', 'animations'];
export const DEFAULT_SIDE = { tools: 'left', palette: 'left', transforms: 'left', preview: 'right', layers: 'right', parts: 'right', animate: 'right', effects: 'right', animations: 'right' };
export const SIZE_LIMITS = { tools: [180, 440], details: [200, 480], timeline: [120, 520] };
export const TIMELINE_MODES = ['open', 'min', 'hidden'];
const FLOAT_MIN = { width: 200, height: 120 };

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const known = id => PANEL_IDS.includes(id);
const finite = value => typeof value === 'number' && Number.isFinite(value);

/**
 * Every panel ends up exactly once in `left`, `right` or `hidden` (unknown ids dropped, missing ones appended to their
 * default side), so stored views keep working when panels are added. Floating rects may use a negative x / y to
 * count from the right / bottom edge, or be `null` for an automatic spot.
 */
export function normalizeView(raw = {}) {
  const seen = new Set();
  const take = list => (Array.isArray(list) ? list : []).filter(id => known(id) && !seen.has(id) && seen.add(id));
  const left = take(raw.left), right = take(raw.right), hidden = take(raw.hidden);
  for (const id of PANEL_IDS) if (!seen.has(id)) (DEFAULT_SIDE[id] === 'left' ? left : right).push(id);
  const docked = new Set([...left, ...right]);
  const closed = [...new Set((Array.isArray(raw.closed) ? raw.closed : []).filter(id => known(id)))];
  const floating = {};
  for (const [id, rect] of Object.entries(raw.floating && typeof raw.floating === 'object' ? raw.floating : {})) {
    if (!docked.has(id)) continue;
    floating[id] = rect && ['x', 'y', 'width', 'height'].every(k => finite(rect[k]))
      ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(FLOAT_MIN.width, Math.round(rect.width)), height: Math.max(FLOAT_MIN.height, Math.round(rect.height)) }
      : null;
  }
  const sizes = {};
  for (const [name, [min, max]] of Object.entries(SIZE_LIMITS)) if (finite(raw.sizes?.[name])) sizes[name] = clamp(Math.round(raw.sizes[name]), min, max);
  return {
    left, right, hidden, closed, floating, sizes,
    sidebars: { left: raw.sidebars?.left !== false, right: raw.sidebars?.right !== false },
    timeline: TIMELINE_MODES.includes(raw.timeline) ? raw.timeline : 'open',
    compact: raw.compact === true,
  };
}

/** Whether two views arrange the workspace the same way (sizes and exact floating positions aside). */
export function sameArrangement(a, b) {
  const x = normalizeView(a), y = normalizeView(b), same = (p, q) => JSON.stringify(p) === JSON.stringify(q);
  return same(x.left, y.left) && same(x.right, y.right) && same(x.hidden, y.hidden) && same(Object.keys(x.floating).sort(), Object.keys(y.floating).sort())
    && same(x.sidebars, y.sidebars) && x.timeline === y.timeline && x.compact === y.compact;
}

/** Move a panel to `side` ('left' | 'right' | 'hidden') at `index` (end when omitted). Returns a new view. */
export function movePanel(view, id, side, index) {
  const next = normalizeView(view);
  if (!known(id) || !['left', 'right', 'hidden'].includes(side)) return next;
  for (const key of ['left', 'right', 'hidden']) next[key] = next[key].filter(x => x !== id);
  const list = next[side];
  list.splice(Number.isInteger(index) ? clamp(index, 0, list.length) : list.length, 0, id);
  if (side === 'hidden') delete next.floating[id];
  return normalizeView(next);
}

/** The side a panel is on in a view: 'left', 'right' or 'hidden'. */
export const sideOf = (view, id) => (view.left.includes(id) ? 'left' : view.right.includes(id) ? 'right' : 'hidden');

const preset = (id, name, description, view) => ({ id, name, description, view: normalizeView(view) });

/** Built-in layouts tuned for common workflows. Shortcuts ⌘/Ctrl + Alt + 1…9 follow this order. */
export const BUILTIN_VIEWS = [
  preset('standard', 'Standard', 'Every panel, docked in its usual place.', {}),
  preset('draw', 'Draw', 'Tools and colours up front, a big canvas, frames tucked away.', {
    left: ['tools', 'palette', 'transforms'], right: ['preview', 'layers'], hidden: ['parts', 'animate', 'effects', 'animations'],
    timeline: 'min',
  }),
  preset('animate', 'Animate', 'A tall timeline with the animation list and motion tools next to the preview.', {
    left: ['tools', 'palette', 'transforms'], right: ['preview', 'animations', 'animate', 'layers', 'effects'], hidden: ['parts'],
    closed: ['transforms', 'effects'], sizes: { details: 300, timeline: 300 },
  }),
  preset('rig', 'Rig & pose', 'Parts and layers beside the canvas for building and posing a skeleton.', {
    left: ['tools', 'parts', 'palette'], right: ['preview', 'layers', 'animate', 'animations'], hidden: ['transforms', 'effects'],
    closed: ['palette', 'animations'], sizes: { tools: 280, details: 300 },
  }),
  preset('colour', 'Colour & shading', 'A wide palette, effects and the preview for recolouring and polishing.', {
    left: ['palette', 'tools'], right: ['preview', 'effects', 'layers'], hidden: ['transforms', 'parts', 'animate', 'animations'],
    sizes: { tools: 320 }, timeline: 'min',
  }),
  preset('review', 'Review', 'A large preview with the animation list, the toolbox out of the way.', {
    left: ['tools', 'palette', 'transforms'], right: ['preview', 'animations', 'layers'], hidden: ['parts', 'animate', 'effects'],
    closed: ['layers'], sidebars: { left: false }, sizes: { details: 440 },
  }),
  preset('focus', 'Focus', 'Just the canvas, with the toolbox and palette floating.', {
    left: ['tools', 'palette', 'transforms'], right: ['preview', 'layers', 'parts', 'animate', 'effects', 'animations'],
    floating: { tools: { x: 16, y: 136, width: 268, height: 470 }, palette: { x: -300, y: 136, width: 284, height: 300 } },
    sidebars: { left: false, right: false }, timeline: 'hidden',
  }),
];

export const MAX_CUSTOM_VIEWS = 12;

/** Sanitize the stored preset list `{ active, custom: [{ id, name, view }] }`. */
export function normalizeViewStore(raw) {
  const custom = [];
  for (const item of Array.isArray(raw?.custom) ? raw.custom : []) {
    const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 40) : '';
    if (!name || typeof item.id !== 'string' || !/^custom-[a-z0-9-]{1,40}$/.test(item.id) || custom.some(c => c.id === item.id)) continue;
    custom.push({ id: item.id, name, view: normalizeView(item.view) });
    if (custom.length >= MAX_CUSTOM_VIEWS) break;
  }
  const ids = [...BUILTIN_VIEWS, ...custom].map(v => v.id);
  return {
    active: ids.includes(raw?.active) ? raw.active : null,
    placement: raw?.placement ? normalizeView(raw.placement) : null,
    custom,
  };
}
