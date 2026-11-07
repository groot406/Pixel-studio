/** Version history and crash recovery rules: snapshot metadata, retention thinning, auto-snapshot timing, orphaned journals. Pure. */
import { compositeFrame } from './project.js';

export const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
/** Auto snapshots: every 5 minutes of active editing or every 100 changes; per-project storage cap for versions. */
export const AUTO_ACTIVE_MS = 5 * MINUTE, AUTO_CHANGES = 100, IDLE_GAP_MS = MINUTE, VERSION_BYTES = 24 * 1024 * 1024, MAX_VERSIONS = 300;

const isRun = value => Array.isArray(value) && value.length >= 8 && value.every(Number.isInteger);
/** Run-length string for an integer array: "v" or "v*count" runs separated by commas. */
function runs(values) {
  const out = [];
  for (let i = 0; i < values.length;) {
    let j = i + 1;
    while (j < values.length && values[j] === values[i]) j++;
    out.push(j - i > 1 ? `${values[i]}*${j - i}` : `${values[i]}`);
    i = j;
  }
  return out.join(',');
}
function pack(value) {
  if (Array.isArray(value)) return isRun(value) ? { '~r': runs(value) } : value.map(pack);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key in value) if (value[key] !== undefined) out[key] = pack(value[key]);
  return out;
}
function unpack(value) {
  if (Array.isArray(value)) return value.map(unpack);
  if (value === null || typeof value !== 'object') return value;
  if (typeof value['~r'] === 'string' && Object.keys(value).length === 1) {
    const out = [];
    for (const run of value['~r'].split(',')) { const [v, n = 1] = run.split('*').map(Number); for (let k = 0; k < n; k++) out.push(v); }
    return out;
  }
  const out = {};
  for (const key in value) out[key] = unpack(value[key]);
  return out;
}
/** Lossless compact text for versions and recovery journals: JSON with integer arrays (pixels) run-length encoded. Keeps every ID, unlike PXA 1. */
export const packProject = project => JSON.stringify(pack(project));
export const unpackProject = text => unpack(JSON.parse(text));

/** Listing metadata for a version of `project`: counts plus a first-frame thumbnail ({width,height,pixels,palette}). */
export function versionMeta(project, { id, documentId, name = '', kind = 'auto', reason = '', createdAt = Date.now(), bytes = 0 } = {}) {
  const first = project.animations[0];
  return {
    id, documentId, kind, name: String(name).trim().slice(0, 80), reason: String(reason).slice(0, 120), createdAt, bytes,
    projectName: project.name, width: project.width, height: project.height,
    animationCount: project.animations.length, frameCount: project.animations.reduce((n, a) => n + a.frames.length, 0),
    thumbnail: { width: project.width, height: project.height, palette: [...project.palette], pixels: compositeFrame(project, first.frames[0]) },
  };
}

/**
 * Ids of versions to delete. Named versions stay forever. Automatic ones are all kept for the last hour, then the newest
 * per clock hour for a day and per day for a month; older ones go. Beyond `maxBytes` or `maxCount` (named ones count too)
 * the oldest automatic versions are dropped first.
 */
export function thinVersions(versions, now = Date.now(), { maxBytes = VERSION_BYTES, maxCount = MAX_VERSIONS } = {}) {
  const drop = new Set(), buckets = new Set();
  const autos = versions.filter(v => v.kind !== 'named').sort((a, b) => b.createdAt - a.createdAt);
  for (const v of autos) {
    const age = now - v.createdAt;
    if (age < HOUR) continue;
    const bucket = age < DAY ? `h${Math.floor(v.createdAt / HOUR)}` : age < 30 * DAY ? `d${Math.floor(v.createdAt / DAY)}` : null;
    if (bucket && !buckets.has(bucket)) buckets.add(bucket); else drop.add(v.id);
  }
  let bytes = 0, count = 0;
  for (const v of versions) if (!drop.has(v.id)) { bytes += v.bytes || 0; count++; }
  for (const v of [...autos].reverse()) {
    if (bytes <= maxBytes && count <= maxCount) break;
    if (drop.has(v.id)) continue;
    drop.add(v.id); bytes -= v.bytes || 0; count--;
  }
  return [...drop];
}

/** Count one project change into an activity tracker; pauses longer than IDLE_GAP_MS do not count as editing time. */
export function trackActivity(tracker = {}, now = Date.now()) {
  const gap = tracker.lastAt ? Math.min(Math.max(0, now - tracker.lastAt), IDLE_GAP_MS) : 0;
  return { activeMs: (tracker.activeMs || 0) + gap, changes: (tracker.changes || 0) + 1, lastAt: now };
}
/** Whether enough editing happened since the last snapshot to take an automatic one. */
export const snapshotDue = tracker => !!tracker && ((tracker.activeMs || 0) >= AUTO_ACTIVE_MS || (tracker.changes || 0) >= AUTO_CHANGES);

/** Journal entries left behind by sessions whose heartbeat stopped (closed or crashed): `beats` maps session id → last beat. */
export function orphanedJournals(entries, beats, now = Date.now(), { staleMs = 15_000, sessionId } = {}) {
  return entries.filter(e => e && e.sessionId !== sessionId && !(now - (beats[e.sessionId] || 0) < staleMs));
}

/** Human time for version lists: "just now", "12 min ago", "Today 14:05", "3 Jan 09:30". */
export function versionTime(at, now = Date.now()) {
  const age = now - at, date = new Date(at), pad = n => String(n).padStart(2, '0'), clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (age < MINUTE) return 'just now';
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (new Date(now).toDateString() === date.toDateString()) return `Today ${clock}`;
  return `${date.getDate()} ${date.toLocaleString('en', { month: 'short' })} ${clock}`;
}
