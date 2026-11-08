/** Pure helpers for project tab management (closing groups of tabs, reordering, the reopen stack). */
export const CLOSE_MODES = ['this', 'others', 'right', 'left', 'all', 'saved'];

/**
 * The tab ids a close command affects, in tab order. `saved` closes every tab without unsaved changes
 * (`isSaved(id)` decides).
 */
export function tabsToClose(openIds, id, mode, isSaved = () => true) {
  const at = openIds.indexOf(id);
  if (mode === 'all') return [...openIds];
  if (mode === 'saved') return openIds.filter(x => isSaved(x));
  if (at < 0) return [];
  if (mode === 'this') return [id];
  if (mode === 'others') return openIds.filter(x => x !== id);
  if (mode === 'right') return openIds.slice(at + 1);
  if (mode === 'left') return openIds.slice(0, at);
  return [];
}

/** After closing `closed`, the tab to activate: the active one if it stays, else the nearest survivor (right first). */
export function nextActiveTab(openIds, activeId, closed) {
  const gone = new Set(closed);
  if (!gone.has(activeId)) return activeId;
  const at = openIds.indexOf(activeId);
  for (let step = 1; step < openIds.length; step += 1) {
    for (const index of [at + step, at - step]) if (openIds[index] && !gone.has(openIds[index])) return openIds[index];
  }
  return null;
}

/** Move `id` to `index` (in the list without it). */
export function moveTab(openIds, id, index) {
  if (!openIds.includes(id)) return [...openIds];
  const rest = openIds.filter(x => x !== id);
  rest.splice(Math.max(0, Math.min(rest.length, index)), 0, id);
  return rest;
}

export const MAX_CLOSED_TABS = 20;
/** Remember closed tabs for "Reopen closed tab" (newest last, no duplicates, bounded). */
export function pushClosed(stack, ids) {
  const next = stack.filter(x => !ids.includes(x)).concat(ids);
  return next.slice(-MAX_CLOSED_TABS);
}
