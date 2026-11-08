/**
 * Canvas cursors per tool: a precise crosshair (the hotspot is the pixel that changes) with the tool's own toolbar
 * icon as a badge, so it is always clear what a click will do — including temporary tools such as the Alt or
 * ⌘/Ctrl colour picker. Icons come from the toolbar's SVG symbols; each cursor is built once.
 */
const cache = new Map();
const CROSS = 'M8 1v5M8 10v5M1 8h5M10 8h5';

/** CSS cursor value for a tool, falling back to `fallback` when its icon is missing. */
export function toolCursor(tool, fallback = 'crosshair') {
  const key = `${tool}|${fallback}`;
  if (cache.has(key)) return cache.get(key);
  const id = document.querySelector(`[data-tool="${tool}"] use`)?.getAttribute('href')?.slice(1);
  const art = id && document.getElementById(id)?.innerHTML;
  let value = fallback;
  if (art) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none" stroke-linecap="round" stroke-linejoin="round">`
      + `<path d="${CROSS}" stroke="#fff" stroke-width="3.5"/><path d="${CROSS}" stroke="#17231b" stroke-width="1.5"/>`
      + `<g transform="translate(14 14) scale(.72)" color="#17231b"><g stroke="#fff" stroke-width="5">${art}</g><g stroke="#17231b" stroke-width="2">${art}</g></g></svg>`;
    value = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 8 8, ${fallback}`;
  }
  cache.set(key, value);
  return value;
}
