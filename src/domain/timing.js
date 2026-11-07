/**
 * Frame timing for the timeline: eased/even holds, snapping, key-pose kinds and navigation, onion-skin plans,
 * frame reordering and playback ranges. Pure functions over plain arrays and frames; no DOM.
 */
import { easingFn } from './motion.js';
import { FRAME_KINDS } from './project.js';

export { FRAME_KINDS };
export const KIND_LABELS = Object.freeze({ key: 'Key pose', breakdown: 'Breakdown', inbetween: 'In-between' });
/** Easings that only move forward, so their inverse (time to reach a position) exists. */
export const TIMING_EASINGS = Object.freeze(['linear', 'easeIn', 'easeOut', 'easeInOut', 'cubicIn', 'cubicOut', 'cubicInOut']);
export const MIN_DURATION = 1, MAX_DURATION = 60000;

const clampMs = ms => Math.max(MIN_DURATION, Math.min(MAX_DURATION, Math.round(ms)));
/** Sum of frame durations in ms. */
export const totalDuration = durations => durations.reduce((sum, d) => sum + d, 0);

/** Split `total` into integers proportional to `weights`, each at least `min`, adding up exactly (largest remainder). */
export function apportion(weights, total, min = MIN_DURATION) {
  const n = weights.length, spare = total - n * min;
  if (!n) return [];
  if (!Number.isInteger(total) || spare < 0) throw new Error(`${n} frames need at least ${n * min} ms.`);
  const sum = totalDuration(weights), raw = weights.map(w => (sum > 0 ? w / sum : 1 / n) * spare);
  const out = raw.map(Math.floor);
  let left = spare - totalDuration(out);
  raw.map((v, i) => [v - out[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, left).forEach(([, i]) => { out[i]++; left--; });
  return out.map(v => v + min);
}

/** Time t at which a forward easing reaches progress y (bisection). */
function inverse(fn, y) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (fn(mid) < y) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/**
 * Redistribute `total` ms (default: the current sum) across frames so playback follows `easing`. The drawings are taken
 * as evenly spaced steps of the motion, so each frame holds for the time the eased motion needs to cover its step: long
 * holds where the curve is slow (the start for easeIn, the end for easeOut), short ones where it is fast. `linear`
 * evens the holds out. Durations stay whole milliseconds within 1–60,000 and add up to `total` exactly.
 */
export function easeDurations(durations, { easing = 'easeInOut', total = totalDuration(durations) } = {}) {
  if (!TIMING_EASINGS.includes(easing)) throw new Error(`Timing easing must be one of ${TIMING_EASINGS.join(', ')}.`);
  const n = durations.length;
  if (!n) return [];
  if (!Number.isInteger(total) || total < n || total > n * MAX_DURATION) throw new Error(`Total time must be ${n}–${n * MAX_DURATION} ms.`);
  const fn = easingFn(easing), times = Array.from({ length: n + 1 }, (_, i) => (i === 0 ? 0 : i === n ? 1 : easing === 'linear' ? i / n : inverse(fn, i / n)));
  const out = apportion(times.slice(1).map((t, i) => Math.round((t - times[i]) * 1e9) / 1e9), total);
  if (out.some(d => d > MAX_DURATION)) return apportion(out.map(d => Math.min(d, MAX_DURATION)), total);
  return out;
}
/** Give every frame the same hold (within a millisecond) while keeping the total. */
export const evenDurations = (durations, total) => easeDurations(durations, { easing: 'linear', total });
/** Multiply every hold by `factor` (×2 = twice as long = half speed), clamped to 1–60,000 ms. */
export function scaleDurations(durations, factor) {
  if (!(factor > 0) || !Number.isFinite(factor)) throw new Error('Speed factor must be positive.');
  return durations.map(d => clampMs(d * factor));
}

/** Snap a dragged duration to fps ticks (multiples of 1000/fps, at least one) or, without fps, to `step` ms. */
export function snapDuration(ms, { fps, step = 10 } = {}) {
  if (fps > 0) { const tick = 1000 / fps; return clampMs(Math.max(1, Math.round(ms / tick)) * tick); }
  return clampMs(Math.max(step, Math.round(ms / step) * step));
}
/** How many frames at `fps` a hold lasts: 250 ms at 8 fps → 2. */
export const framesAt = (ms, fps) => Math.round(ms * fps / 10) / 100;
/** "250 ms · 2 frames at 8 fps". */
export function formatHold(ms, fps) {
  const n = framesAt(ms, fps);
  return `${ms} ms · ${n} frame${n === 1 ? '' : 's'} at ${fps} fps`;
}

/** Next marker in the cycle none → key → breakdown → in-between → none. */
export function nextKind(kind) { return FRAME_KINDS[FRAME_KINDS.indexOf(kind) + 1]; }
/** Index of the nearest key frame before (direction −1) or after (+1) `index`, wrapping around; −1 when there is none. */
export function findKey(frames, index, direction) {
  const n = frames.length;
  for (let step = 1; step < n; step++) { const i = ((index + direction * step) % n + n) % n; if (frames[i].kind === 'key') return i; }
  return -1;
}
/** Mark frames of `animationId` in place: `key` and `inbetween` are lists of frame ids. Returns the project. */
export function markKinds(project, animationId, { key = [], breakdown = [], inbetween = [] } = {}) {
  const frames = project.animations.find(a => a.id === animationId)?.frames || [];
  for (const [kind, ids] of [['key', key], ['breakdown', breakdown], ['inbetween', inbetween]]) for (const frame of frames) if (ids.includes(frame.id)) frame.kind = kind;
  return project;
}

/**
 * Which frames the onion skin shows around `index` of `count`: up to `before` previous and `after` next frames (only
 * frames whose kind is `key` with `keysOnly`, when any are marked), wrapping around the loop with `wrap`. A frame
 * never appears twice nor as the current frame. Each ghost's alpha starts at `opacity` and is multiplied by
 * (1 − falloff) per step further away. Returned farthest first, so nearer ghosts paint on top.
 */
export function onionPlan(count, index, { before = 1, after = 1, keysOnly = false, kinds = [], wrap = true, opacity = 0.4, falloff = 0.4 } = {}) {
  const keys = keysOnly && kinds.some(k => k === 'key'), seen = new Set([index]), plan = [];
  for (const [side, direction, limit] of [['prev', -1, before], ['next', 1, after]]) {
    let found = 0;
    for (let step = 1; step < count && found < limit; step++) {
      let i = index + direction * step;
      if (i < 0 || i >= count) { if (!wrap) break; i = (i % count + count) % count; }
      if (keys && kinds[i] !== 'key') continue;
      if (seen.has(i)) break;
      seen.add(i); found++;
      plan.push({ index: i, side, distance: found, alpha: opacity * (1 - falloff) ** (found - 1) });
    }
  }
  return plan.sort((a, b) => b.distance - a.distance);
}

/** Frame order after moving the frames with `ids` (keeping their order) to sit before position `to` of the original list. */
export function moveFrames(frames, ids, to) {
  const moving = frames.filter(f => ids.includes(f.id)), before = frames.slice(0, to).filter(f => !ids.includes(f.id)).length;
  const rest = frames.filter(f => !ids.includes(f.id));
  return [...rest.slice(0, before), ...moving, ...rest.slice(before)];
}
/** Frame order with the frames in `ids` reversed among their own positions. */
export function reverseFrames(frames, ids) {
  const slots = frames.map((f, i) => (ids.includes(f.id) ? i : -1)).filter(i => i >= 0), picked = slots.map(i => frames[i]).reverse();
  const out = [...frames];
  slots.forEach((slot, k) => { out[slot] = picked[k]; });
  return out;
}
/** Frames to append for a ping-pong of a run: the run backwards without its two ends (1 2 3 4 → 3 2), so loops never stutter. */
export const pingPongFrames = run => run.slice(1, -1).reverse();

/** First/last index of the frames in `ids` when they span at least two frames, else null. */
export function playbackRange(frames, ids) {
  const at = frames.map((f, i) => (ids.includes(f.id) ? i : -1)).filter(i => i >= 0);
  return at.length && at[at.length - 1] > at[0] ? { start: at[0], end: at[at.length - 1] } : null;
}
/** The frame after `index` during playback of `count` frames, looping inside `range` ({start, end}) when given. */
export function nextPlaybackIndex(index, count, range) {
  if (!range || range.end >= count || range.start > range.end) return (index + 1) % count;
  return index < range.start || index >= range.end ? range.start : index + 1;
}
