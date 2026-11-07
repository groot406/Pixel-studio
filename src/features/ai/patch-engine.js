/** Masked edits and palette proposals, adapted from the supplied integration patch. */
import { MAX_SIZE, getAnimationLayers, getLayerPixels, validateProject } from '../../domain/project.js';
import { validateDescription } from './response-contract.js';
import { AI_PIXEL_ALPHABET } from '../../formats/pxa.js';
import { hasLockedInstances } from '../../domain/artwork.js';

const HEX = /^#[0-9a-fA-F]{6}$/;
const COLOR_CODES = AI_PIXEL_ALPHABET;
const HEX16 = /^[a-f0-9]{16}$/;

function requireInt(n, min, max, name) {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
}
function normalizeHex(hex) {
  if (!HEX.test(hex)) throw new Error(`Invalid palette color: ${String(hex)}`);
  return hex.toUpperCase();
}
function assertProject(project) {
  validateProject(project);
  return project;
}

/** Non-cryptographic 64-bit state fingerprint, useful for stale proposal checks. */
export function projectFingerprint(p) {
  assertProject(p);
  let a = 0x811c9dc5, b = 0x9e3779b9;
  const feed = n => {
    a = Math.imul(a ^ (n & 255), 0x01000193) >>> 0;
    b = Math.imul((b + (n & 255)) >>> 0, 0x85ebca6b) >>> 0;
  };
  const string = s => { for (const cp of new TextEncoder().encode(s)) feed(cp); feed(0); };
  string(JSON.stringify([p.name, p.width, p.height, p.palette.length, p.layers.length, p.animations.length]));
  if (p.version === 3) string(JSON.stringify(p.parts));
  for (const c of p.palette) string(c.toUpperCase());
  for (const l of p.layers) { string(l.id); string(l.name); feed(l.visible ? 1 : 0); feed(l.locked ? 1 : 0); }
  for (const l of p.layers) if (l.group !== undefined) string(JSON.stringify([l.id,l.group]));
  for (const anim of p.animations) {
    string(JSON.stringify([anim.id, anim.name, anim.fps, anim.frames.length]));
    string(JSON.stringify(getAnimationLayers(p,anim).map(layer => layer.id)));
    for (const frame of anim.frames) {
      if (p.version === 3) for (const cel of frame.cels) string(JSON.stringify(cel.source || null));
      string(frame.id); feed(frame.duration); feed(frame.duration >>> 8);
      if(frame.layerOrder)string(JSON.stringify(frame.layerOrder));
      for (const layer of p.layers) for (const x of getLayerPixels(frame, layer.id)) feed(x + 1);
    }
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

export function selectionRect(p, selection) {
  if (!selection) throw new Error('Select a rectangle before inpainting.');
  requireInt(selection.x, 0, p.width - 1, 'Selection x');
  requireInt(selection.y, 0, p.height - 1, 'Selection y');
  requireInt(selection.width, 1, p.width, 'Selection width');
  requireInt(selection.height, 1, p.height, 'Selection height');
  if (selection.x + selection.width > p.width || selection.y + selection.height > p.height) throw new Error('Selection extends beyond canvas');
  return { x: selection.x, y: selection.y, width: selection.width, height: selection.height };
}

export function allowedTargets(p, {scope, animationIndex, frameIndex, layerIndex}) {
  requireInt(animationIndex, 0, p.animations.length - 1, 'Animation index');
  requireInt(frameIndex, 0, p.animations[animationIndex].frames.length - 1, 'Frame index');
  requireInt(layerIndex, 0, p.layers.length - 1, 'Layer index');
  if (p.layers[layerIndex].locked) throw new Error('Cannot inpaint a locked layer');
  if (!['frame', 'animation'].includes(scope)) throw new Error('Scope must be frame or animation');
  const frames = scope === 'frame' ? [frameIndex] : p.animations[animationIndex].frames.map((_, i) => i);
  if(frames.some(fi=>hasLockedInstances(p.animations[animationIndex].frames[fi].cels.find(c=>c.layerId===p.layers[layerIndex].id)))) throw new Error('Unlock objects in this group before inpainting its pixels.');
  return frames.map(fi => ({ animationIndex, frameIndex: fi, layerIndex }));
}

const targetKey = ({animationIndex, frameIndex, layerIndex}) => `${animationIndex}/${frameIndex}/${layerIndex}`;
const allLines = text => {
  if (typeof text !== 'string' || text.length > 2_000_000) throw new Error('Invalid or oversized AI output');
  return text.replace(/\r\n?/g, '\n').split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#'));
};
function parts(line, verb) {
  const p = line.split(/\s+/);
  if (p[0] !== verb) throw new Error(`Expected ${verb}, got ${p[0]}`);
  return p;
}
const asInt = (s, label) => {
  if (!/^(0|[1-9]\d*)$/.test(s ?? '')) throw new Error(`Invalid ${label}: ${s}`);
  return Number(s);
};

/** Expand the PXA palette alphabet; '.' means clear, e.g. A{3}.0{2}. */
export function expandPixelRun(src, maxLength = MAX_SIZE) {
  if (typeof src !== 'string' || !src.length) throw new Error('SPAN needs pixels');
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i++];
    if (!COLOR_CODES.includes(ch) && ch !== '.') throw new Error(`Unsupported pixel symbol: ${ch}`);
    let repeat = 1;
    if (src[i] === '{') {
      const end = src.indexOf('}', i);
      if (end < 0) throw new Error('Unclosed pixel repeat');
      repeat = asInt(src.slice(i + 1, end), 'pixel repeat');
      if (repeat < 2) throw new Error('Repeat must be at least 2');
      i = end + 1;
    }
    if (out.length + repeat > maxLength) throw new Error('Expanded SPAN exceeds selection/canvas bounds');
    const value = ch === '.' ? -1 : COLOR_CODES.indexOf(ch);
    for (let k = 0; k < repeat; k++) out.push(value);
  }
  return out;
}

/**
 * AI returns a *small patch*, never the entire project. Selection and targets are
 * strict: no out-of-bounds, locked layers, palette mutation, or unselected frames.
 */
export function parseInpaintPatch(text) {
  const lines = allLines(text);
  let idx = 0;
  if (lines[idx++] !== 'PXAINPAINT 1') throw new Error('Expected PXAINPAINT 1');
  const size = parts(lines[idx++] ?? '', 'SIZE');
  if (size.length !== 3) throw new Error('SIZE needs width and height');
  const rect = parts(lines[idx++] ?? '', 'RECT');
  if (rect.length !== 5) throw new Error('RECT needs x y width height');
  const base = parts(lines[idx++] ?? '', 'BASE');
  if (base.length !== 2 || !HEX16.test(base[1])) throw new Error('Invalid BASE fingerprint');
  const targets = [];
  let current = null;
  while (idx < lines.length) {
    const line = lines[idx++];
    const p = line.split(/\s+/);
    if (p[0] === 'TARGET') {
      if (p.length !== 4) throw new Error('TARGET needs animation frame layer indexes');
      current = {
        animationIndex: asInt(p[1], 'animation index'),
        frameIndex: asInt(p[2], 'frame index'),
        layerIndex: asInt(p[3], 'layer index'),
        spans: []
      };
      targets.push(current);
    } else if (p[0] === 'SPAN') {
      if (!current) throw new Error('SPAN must follow TARGET');
      if (p.length !== 4) throw new Error('SPAN needs y x pixels');
      current.spans.push({y: asInt(p[1], 'span y'), x: asInt(p[2], 'span x'), pixels: p[3]});
    } else throw new Error(`Unsupported command: ${p[0]}`);
  }
  if (!targets.length) throw new Error('No TARGET in AI response');
  return {
    width: asInt(size[1], 'width'), height: asInt(size[2], 'height'),
    rect: {x: asInt(rect[1], 'x'), y: asInt(rect[2], 'y'), width: asInt(rect[3], 'width'), height: asInt(rect[4], 'height')},
    base: base[1], targets
  };
}

export function previewInpaint(project, text, request) {
  assertProject(project);
  const rect = selectionRect(project, request.selection);
  const allowed = new Set(allowedTargets(project, request).map(targetKey));
  const patch = parseInpaintPatch(text);
  if (patch.width !== project.width || patch.height !== project.height) throw new Error('AI response canvas size differs');
  if (JSON.stringify(patch.rect) !== JSON.stringify(rect)) throw new Error('AI response selection differs');
  const fingerprint = projectFingerprint(project);
  if (patch.base !== fingerprint || (request.baseFingerprint && request.baseFingerprint !== fingerprint)) {
    throw new Error('Project changed since the AI request; create a new preview');
  }
  const animations = project.animations.slice();
  const modifiedAnim = new Map(), modifiedFrame = new Map(), modifiedCel = new Map();
  let changes = 0;
  const altered = new Map();
  for (const target of patch.targets) {
    const key = targetKey(target);
    if (!allowed.has(key)) throw new Error(`AI tried to modify an out-of-scope target ${key}`);
    const {animationIndex: a, frameIndex: f, layerIndex: l} = target;
    if (!modifiedAnim.has(a)) {
      animations[a] = {...animations[a], frames: animations[a].frames.slice()};
      modifiedAnim.set(a, animations[a]);
    }
    const fk = `${a}/${f}`;
    if (!modifiedFrame.has(fk)) {
      const frame = animations[a].frames[f];
      animations[a].frames[f] = {...frame, cels: frame.cels.slice()};
      modifiedFrame.set(fk, animations[a].frames[f]);
    }
    if (!modifiedCel.has(key)) {
      const layerId = project.layers[l].id;
      const source = getLayerPixels(project.animations[a].frames[f], layerId);
      const clone = Array.from(source);
      const celIndex = animations[a].frames[f].cels.findIndex(cel => cel.layerId === layerId);
      animations[a].frames[f].cels[celIndex] = { ...animations[a].frames[f].cels[celIndex], layerId, pixels: clone };
      modifiedCel.set(key, clone);
    }
    const dest = modifiedCel.get(key);
    for (const span of target.spans) {
      if (span.y < rect.y || span.y >= rect.y + rect.height || span.x < rect.x || span.x >= rect.x + rect.width) throw new Error('SPAN begins outside the selected area');
      const len = rect.x + rect.width - span.x;
      const expanded = expandPixelRun(span.pixels, len);
      for (let i = 0; i < expanded.length; i++) {
        const color = expanded[i];
        if (color >= project.palette.length) throw new Error(`Pixel uses unavailable palette slot ${color}`);
        dest[span.y * project.width + span.x + i] = color;
      }
    }
    altered.set(key, {animationIndex:a, frameIndex:f, layerIndex:l});
  }
  // Count actual changed pixels, rather than written SPAN entries.
  const perTarget = [];
  for (const [key, {animationIndex:a, frameIndex:f, layerIndex:l}] of altered) {
    const old = getLayerPixels(project.animations[a].frames[f], project.layers[l].id);
    const updated = modifiedCel.get(key);
    let count = 0;
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const k = y * project.width + x;
        if (old[k] !== updated[k]) count++;
      }
    }
    changes += count;
    perTarget.push({key, changedPixels: count});
  }
  if (!changes) throw new Error('AI proposal does not change any pixels');
  return {
    project: {...project, animations},
    changedPixels: changes, perTarget,
    selection: rect,
    baseFingerprint: fingerprint
  };
}

export function buildInpaintPrompt({project, request, description, originalPxa}) {
  assertProject(project);
  const rect = selectionRect(project, request.selection);
  const targets = allowedTargets(project, request);
  validateDescription(description);
  if (typeof originalPxa !== 'string' || !originalPxa.startsWith('PXA 1\n')) throw new Error('Export current project to PXA 1 before AI editing');
  return `Edit only selected pixels in this indexed Pixel Studio project.\nArtwork request: ${description}\n\n` +
    `RULES: Output ONLY PXAINPAINT 1 text, no Markdown fences. Do not change palette, pixel size, animations, frame timing, layer structure, or any outside pixels. ` +
    `Use a sparse list of SPAN rows. Each SPAN overwrites the specified pixels; omitted pixels keep their prior values. ` +
    `Allowed palette codes: ${COLOR_CODES.slice(0,project.palette.length)}. Dot (.) clears to transparency. ` +
    `Use X{n} to repeat a palette code or dot n times. The selection is inclusive at left/top, exclusive at right/bottom.\n\n` +
    `REQUIRED HEADER:\nPXAINPAINT 1\nSIZE ${project.width} ${project.height}\nRECT ${rect.x} ${rect.y} ${rect.width} ${rect.height}\nBASE ${projectFingerprint(project)}\n` +
    `ALLOWED TARGETS (zero-based animation, frame, layer indexes; no others):\n${targets.map(t=>`TARGET ${t.animationIndex} ${t.frameIndex} ${t.layerIndex}`).join('\n')}\n` +
    `Each TARGET may contain SPAN y x pixel-string lines, e.g. SPAN ${rect.y} ${rect.x} 0{3}1. ` +
    `At least one changed pixel must be present. Keep all edits inside the RECT.\n\n` +
    `PROJECT PXA CONTEXT (READ-ONLY):\n${originalPxa}`;
}

export function parsePalettePatch(text) {
  const lines = allLines(text);
  if (lines[0] !== 'PXAPALETTE 1') throw new Error('Expected PXAPALETTE 1');
  const base = parts(lines[1] ?? '', 'BASE');
  if (base.length !== 2 || !HEX16.test(base[1])) throw new Error('Invalid BASE fingerprint');
  const changes = new Map();
  for (const line of lines.slice(2)) {
    const p = parts(line, 'SET');
    if (p.length !== 3) throw new Error('SET needs palette index and hex color');
    const idx = asInt(p[1], 'palette index');
    if (changes.has(idx)) throw new Error('Duplicate palette index');
    changes.set(idx, normalizeHex(p[2]));
  }
  if (!changes.size) throw new Error('No palette colors proposed');
  return {base: base[1], changes};
}
export function previewRecolor(project, text, {baseFingerprint} = {}) {
  assertProject(project);
  const patch = parsePalettePatch(text);
  const expected = projectFingerprint(project);
  if (patch.base !== expected || (baseFingerprint && baseFingerprint !== expected)) throw new Error('Project changed since AI request; create a new preview');
  const palette = project.palette.slice();
  const swatches = [];
  for (const [idx, next] of patch.changes) {
    if (idx >= palette.length) throw new Error(`Palette slot ${idx} does not exist`);
    const prev = palette[idx].toUpperCase();
    if (prev === next) continue;
    palette[idx] = next;
    swatches.push({index: idx, before: prev, after: next});
  }
  if (!swatches.length) throw new Error('No actual palette changes');
  return {project: {...project, palette}, swatches, baseFingerprint: expected,
    warning: 'This indexed palette is shared: recoloring affects every frame and animation that uses these color slots.'};
}
export function buildRecolorPrompt({project, description}) {
  assertProject(project);
  validateDescription(description);
  return `Recolor the existing indexed palette of Pixel Studio. Request: ${description}\n` +
    `Return ONLY PXAPALETTE 1, BASE, and SET lines. Do not change pixel coordinates, indices, layers, frame counts, timing, or colors not explicitly selected with SET.\n` +
    `Existing slots:\n${project.palette.map((c,i)=>`${i} ${COLOR_CODES[i]} ${c}`).join('\n')}\n` +
    `Use color hex #RRGGBB; sample output:\nPXAPALETTE 1\nBASE ${projectFingerprint(project)}\nSET 0 #112233\n` +
    `The palette is shared across the entire project, so keep semantic relationships between shadows, midtones and highlights.\n` +
    `Return appropriate SET lines for the request.`;
}

