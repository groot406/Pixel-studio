/**
 * Pixel cleanup checker: finds stray (orphan) pixels, doubled L-corners on 1px lines, jaggies (uneven step lengths
 * along a line, such as 2-1-2-3) and banding (a band of one colour stepping exactly parallel to its neighbours).
 * Strays and corners come with a safe fix; jaggies and banding are only reported. Pure; pixels are row-major palette
 * indices, -1 transparent.
 */
import { cleanupDoubles } from './pixel-fx.js';

export const ISSUE_TYPES = ['stray', 'corner', 'jaggy', 'banding'];
const RING = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

function read(pixels, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('Width and height must be positive whole numbers.');
  if (!Array.isArray(pixels) || pixels.length !== width * height) throw new Error(`Expected exactly ${width * height} pixels.`);
}
/** The most common value among `values` (lowest wins ties); -1 when empty. */
function majority(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = -1, most = 0;
  for (const [v, n] of counts) if (n > most || (n === most && v < best)) { best = v; most = n; }
  return best;
}
const neighbours = (pixels, width, height, x, y) => RING.filter(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height).map(([dx, dy]) => pixels[(y + dy) * width + x + dx]);
const issue = (type, indices, width, fix = null) => ({ type, indices, x: indices[0] % width, y: Math.floor(indices[0] / width), fix });

/** Opaque pixels unlike all 8 neighbours (and 1-pixel transparent pinholes inside the art); fix: the neighbours' colour. */
export function findStrays(pixels, width, height) {
  read(pixels, width, height);
  const out = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, v = pixels[i], ring = neighbours(pixels, width, height, x, y);
    if (ring.some(n => n === v) || (v < 0 && (ring.length < 8 || ring.some(n => n < 0)))) continue;
    out.push(issue('stray', [i], width, [{ index: i, value: majority(ring) }]));
  }
  return out;
}

/** Doubled corner pixels on 1px lines of one colour (as the Clean up lines effect removes); fix: the colour behind. */
export function findCorners(pixels, width, height) {
  read(pixels, width, height);
  const out = [];
  for (const colour of new Set(pixels.filter(v => v >= 0))) {
    const cleaned = cleanupDoubles(pixels, width, height, colour);
    cleaned.forEach((v, i) => {
      if (v === pixels[i]) return;
      const x = i % width, y = Math.floor(i / width);
      out.push(issue('corner', [i], width, [{ index: i, value: majority(neighbours(pixels, width, height, x, y).filter(n => n !== colour)) }]));
    });
  }
  return out.sort((a, b) => a.indices[0] - b.indices[0]);
}

/** 1px line chains of one colour (after removing doubled corners): pixel lists in drawing order. */
function lineChains(on, width, height) {
  const isOn = (x, y) => x >= 0 && y >= 0 && x < width && y < height && on[y * width + x];
  const links = i => { const x = i % width, y = Math.floor(i / width); return RING.filter(([dx, dy]) => isOn(x + dx, y + dy)).map(([dx, dy]) => (y + dy) * width + x + dx); };
  const line = new Set();
  on.forEach((v, i) => { if (v && links(i).length <= 2) line.add(i); });
  const degree = i => links(i).filter(j => line.has(j)).length, seen = new Set(), chains = [];
  const walk = start => {
    const chain = [start]; seen.add(start);
    for (let at = start; ;) {
      const next = links(at).find(j => line.has(j) && !seen.has(j));
      if (next === undefined) break;
      seen.add(next); chain.push(next); at = next;
    }
    return chain;
  };
  for (const i of line) if (!seen.has(i) && degree(i) <= 1) chains.push(walk(i));
  for (const i of line) if (!seen.has(i)) chains.push(walk(i));
  return chains;
}

/** Split a chain where it turns back (x or y reverses) or passes 45° (from mostly flat to mostly steep); keep runs. */
function runsOf(chain, width) {
  const xy = i => [i % width, Math.floor(i / width)], segments = [];
  let current = { pixels: [chain[0]], sx: 0, sy: 0, kind: null };
  for (let k = 1; k < chain.length; k++) {
    const [ax, ay] = xy(chain[k - 1]), [bx, by] = xy(chain[k]), dx = Math.sign(bx - ax), dy = Math.sign(by - ay);
    const kind = !dy ? 'h' : !dx ? 'v' : null;
    const turns = (dx && current.sx && dx !== current.sx) || (dy && current.sy && dy !== current.sy) || (kind && current.kind && kind !== current.kind);
    if (turns) { segments.push(current); current = { pixels: [chain[k - 1]], sx: 0, sy: 0, kind: null }; }
    current.pixels.push(chain[k]); current.sx ||= dx; current.sy ||= dy; current.kind ||= kind;
  }
  segments.push(current);
  return segments.filter(s => s.kind).map(s => {
    const runs = [];
    for (const i of s.pixels) {
      const minor = s.kind === 'h' ? Math.floor(i / width) : i % width, last = runs.at(-1);
      if (last && last.minor === minor) last.indices.push(i); else runs.push({ minor, indices: [i] });
    }
    return runs;
  });
}

/** Runs that break a line's rhythm: a longer or shorter step between neighbours that is not part of a regular 1:n pattern. */
export function findJaggies(pixels, width, height) {
  read(pixels, width, height);
  const out = [];
  for (const colour of new Set(pixels.filter(v => v >= 0))) {
    const cleaned = cleanupDoubles(pixels, width, height, colour), on = cleaned.map(v => v === colour);
    for (const chain of lineChains(on, width, height)) for (const runs of runsOf(chain, width)) {
      const len = runs.map(r => r.indices.length);
      for (let k = 1; k < len.length - 1; k++) {
        const a = len[k - 1], b = len[k], c = len[k + 1];
        if (!((b < a && b < c) || (b > a && b > c))) continue;
        if (a === c) {
          const context = [len[k - 2], len[k + 2]].filter(v => v !== undefined);
          if (!context.length || context.includes(b)) continue;
        }
        out.push(issue('jaggy', runs[k].indices, width));
      }
    }
  }
  return out;
}

/** Bands of one colour, 1–3 px wide, between two other colours, whose edges step in parallel for 3+ rows or columns. */
export function findBanding(pixels, width, height) {
  read(pixels, width, height);
  const out = [], found = new Set();
  for (const vertical of [false, true]) {
    const lines = vertical ? width : height, span = vertical ? height : width, at = (line, k) => pixels[vertical ? k * width + line : line * width + k];
    const bands = [];
    for (let line = 0; line < lines; line++) {
      const row = [];
      for (let k = 0; k < span;) { let e = k; while (e + 1 < span && at(line, e + 1) === at(line, k)) e++; row.push({ v: at(line, k), start: k, len: e - k + 1 }); k = e + 1; }
      bands.push(row.flatMap((r, n) => (n > 0 && n < row.length - 1 && r.v >= 0 && r.len <= 3 && row[n - 1].v >= 0 && row[n + 1].v >= 0 && row[n - 1].v !== row[n + 1].v ? [{ ...r, before: row[n - 1].v, after: row[n + 1].v }] : [])));
    }
    const same = (p, q) => p.v === q.v && p.len === q.len && p.before === q.before && p.after === q.after;
    for (let line = 0; line + 2 < lines; line++) for (const first of bands[line]) {
      const second = bands[line + 1].find(r => same(first, r) && r.start !== first.start && Math.abs(r.start - first.start) <= first.len);
      if (!second) continue;
      const shift = second.start - first.start, chain = [first, second];
      for (let next = line + 2; next < lines; next++) {
        const r = bands[next].find(q => same(first, q) && q.start === chain.at(-1).start + shift);
        if (!r) break;
        chain.push(r);
      }
      if (chain.length < 3) continue;
      const indices = chain.flatMap((r, n) => Array.from({ length: r.len }, (_, k) => (vertical ? (r.start + k) * width + line + n : (line + n) * width + r.start + k)));
      if (indices.every(i => found.has(i))) continue;
      indices.forEach(i => found.add(i));
      out.push(issue('banding', indices.sort((p, q) => p - q), width));
    }
  }
  return out;
}

/** Every issue, strays and corners first, with counts per type. */
export function findIssues(pixels, width, height) {
  const issues = [...findStrays(pixels, width, height), ...findCorners(pixels, width, height), ...findJaggies(pixels, width, height), ...findBanding(pixels, width, height)];
  const counts = Object.fromEntries(ISSUE_TYPES.map(type => [type, issues.filter(i => i.type === type).length]));
  return { issues, counts };
}

/** The fixes of every safely fixable issue (strays and corners). */
export function safeFixes(issues) { return issues.filter(i => i.fix).flatMap(i => i.fix); }

/** New pixels with fixes [{index, value}] applied. */
export function applyFixes(pixels, fixes) {
  const next = pixels.slice();
  for (const { index, value } of fixes) {
    if (!Number.isInteger(index) || index < 0 || index >= next.length || !Number.isInteger(value) || value < -1) throw new Error('Each fix needs a pixel index and a colour.');
    next[index] = value;
  }
  return next;
}
