/** Undo history helpers: fast project copies, allocation-free deep equality, and structural sharing between undo entries with a memory cap. */

const numeric = value => value.length > 0 && typeof value[0] === 'number';

/** Deep copy of JSON-like data; numeric arrays (pixels, span values) copy with one slice. */
export function cloneProject(value) {
  if (Array.isArray(value)) return numeric(value) && value.every(v => typeof v === 'number') ? value.slice() : value.map(cloneProject);
  if (value === null || typeof value !== 'object') return value;
  const copy = {};
  for (const key in value) if (value[key] !== undefined) copy[key] = cloneProject(value[key]);
  return copy;
}

/** Deep equality of JSON-like data without serialising (undefined properties count as absent, as in JSON). */
export function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  let count = 0;
  for (const key in a) {
    if (a[key] === undefined) continue;
    count++;
    if (!sameValue(a[key], b[key])) return false;
  }
  for (const key in b) if (b[key] !== undefined) count--;
  return count === 0;
}

const keyOf = item => item && typeof item === 'object' && !Array.isArray(item) ? item.id ?? item.layerId : undefined;
/**
 * `next` with every subtree that deep-equals the matching subtree of `previous` replaced by that subtree, so
 * consecutive undo entries share unchanged frames, cels and pixel arrays. Array items with an `id` (or a cel's
 * `layerId`) match by key, so reordered frames still share. `owned.count` grows by the stored values kept from `next`.
 */
export function shareUnchanged(next, previous, owned = { count: 0 }) {
  if (next === previous) return next;
  if (next === null || typeof next !== 'object') { owned.count++; return next; }
  if (previous === null || typeof previous !== 'object' || Array.isArray(next) !== Array.isArray(previous)) {
    owned.count += size(next);
    return next;
  }
  if (Array.isArray(next)) {
    if (numeric(next)) {
      if (sameValue(next, previous)) return previous;
      owned.count += next.length;
      return next;
    }
    const byKey = new Map();
    for (const item of previous) { const key = keyOf(item); if (key !== undefined) byKey.set(key, item); }
    let same = next.length === previous.length;
    const out = next.map((item, i) => {
      const key = keyOf(item), match = key !== undefined && byKey.has(key) ? byKey.get(key) : previous[i];
      const shared = shareUnchanged(item, match, owned);
      if (shared !== previous[i]) same = false;
      return shared;
    });
    return same ? previous : out;
  }
  let same = true, count = 0;
  const out = {};
  for (const key in next) {
    if (next[key] === undefined) continue;
    count++;
    out[key] = shareUnchanged(next[key], previous[key], owned);
    if (out[key] !== previous[key]) same = false;
  }
  for (const key in previous) if (previous[key] !== undefined) count--;
  return same && count === 0 ? previous : out;
}

/** Stored values (numbers, strings, …) in a JSON-like tree: the unit of the undo memory cap. */
export function size(value) {
  if (Array.isArray(value)) return numeric(value) ? value.length : value.reduce((sum, item) => sum + size(item), 0);
  if (value === null || typeof value !== 'object') return 1;
  let sum = 0;
  for (const key in value) sum += size(value[key]);
  return sum;
}

export const HISTORY_LIMIT = 40, HISTORY_VALUES = 12_000_000;
/**
 * Push an undo `entry` ({project, …}; the project is an independent copy). The entry that stops being the top is
 * replaced by a frozen-in-place copy whose unchanged parts are shared with the entry below it (callers must clone
 * `shared` entries before editing them, see `historyProject`). Oldest entries are dropped beyond `limit` entries or
 * `maxValues` stored values in total, always keeping the newest. The pushed entry object itself becomes the top.
 */
export function pushHistory(stack, entry, { limit = HISTORY_LIMIT, maxValues = HISTORY_VALUES } = {}) {
  const top = stack.at(-1);
  if (top && !top.shared) {
    const below = stack.at(-2), owned = { count: 0 };
    const project = below ? shareUnchanged(top.project, below.project, owned) : top.project;
    stack[stack.length - 1] = { ...top, project, shared: true, cost: below ? owned.count : size(top.project) };
  }
  entry.cost = size(entry.project);
  stack.push(entry);
  const total = () => stack.reduce((sum, item) => sum + item.cost, 0);
  // The oldest entry owns everything it shares upwards, so dropping it moves that cost to its successor.
  while (stack.length > 1 && (stack.length > limit || total() > maxValues)) {
    stack.shift();
    if (stack[0].shared) stack[0] = { ...stack[0], cost: size(stack[0].project) };
  }
  return stack;
}

/** The project of a history entry, safe to edit in place. */
export function historyProject(entry) { return entry.shared ? cloneProject(entry.project) : entry.project; }
