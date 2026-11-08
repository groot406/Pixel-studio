/**
 * Headless Pixel Studio for Node (CLI, MCP server, tests): load/save .pxa/.pxs/.pixel.json, summarise, lint PXA,
 * render frames to PNG, export sheets/GIFs, turn images into pixel projects and apply palettes and rig templates.
 * Uses only the browser-independent domain and format modules.
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, extname, basename, join } from 'node:path';
import { blankProject, validateProject, paletteFromRgba, mapRgbaToPalette, compositeFrame, MAX_COLORS } from '../src/domain/project.js';
import { pixelize, detectGrid } from '../src/domain/pixelize.js';
import { PALETTE_PRESETS } from '../src/domain/palette-presets.js';
import { replacePalette, usedPaletteIndices } from '../src/domain/palette-theory.js';
import { TEMPLATES, generateTemplate } from '../src/domain/templates.js';
import { partsAndRig } from '../src/domain/auto-rig.js';
import { encodeAIProject, decodeAIProject } from '../src/formats/pxa.js';
import { encodePixelProject, decodePixelProject } from '../src/formats/pxs.js';
import { encodePng } from '../src/formats/png.js';
import { rasterize, sheetLayout, composeSheet, checkExportSize } from '../src/formats/image-export.js';
import { buildExport } from '../src/formats/export-bundle.js';
import { decodePng } from './png-decode.mjs';

export const PROJECT_EXTENSIONS = ['.pxa', '.pxs', '.json'];
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_PREVIEW_EDGE = 4096;

/** 'pxa' | 'pxs' | 'json' from a file name (`.pixel.json` and `.json` are JSON). */
export function formatOf(path) {
  const ext = extname(String(path)).toLowerCase();
  if (ext === '.pxa' || ext === '.txt') return 'pxa';
  if (ext === '.pxs') return 'pxs';
  if (ext === '.json') return 'json';
  if (ext === '.png') return 'png';
  throw new Error(`Unsupported project file type "${ext || basename(String(path))}". Use .pxa (PXA text), .pxs (binary) or .pixel.json.`);
}

/** Decode project bytes of any supported format; the format is sniffed from the content. */
export async function decodeProjectBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if ([80, 88, 83, 84].every((v, i) => data[i] === v)) return { project: await decodePixelProject(data), format: 'pxs' };
  const text = new TextDecoder().decode(data);
  const first = text.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#')) || '';
  if (/^PXA\s/.test(first)) return { project: decodeAIProject(text), format: 'pxa' };
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('This file is not a Pixel Studio project (.pxa text, .pxs binary or .pixel.json).'); }
  return { project: validateProject(json), format: 'json' };
}

export async function loadProject(path) {
  if (formatOf(path) === 'png') return { project: (await imageToProject(await readFile(path), { name: basename(path, '.png') })).project, format: 'png' };
  return decodeProjectBytes(await readFile(path));
}

/** Encode a project for `format` ('pxa' writes PXA 2 unless pxaVersion 1 is requested). */
export async function encodeProject(project, format, { pxaVersion = 2 } = {}) {
  const clean = validateProject(project);
  if (format === 'pxa') return Buffer.from(encodeAIProject(clean, { version: pxaVersion }), 'utf8');
  if (format === 'pxs') return Buffer.from(await encodePixelProject(clean));
  if (format === 'json') return Buffer.from(`${JSON.stringify(clean)}\n`, 'utf8');
  throw new Error(`Cannot save a project as ${format}.`);
}

export async function saveProject(path, project, options) {
  const bytes = await encodeProject(project, formatOf(path), options);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return bytes.length;
}

export async function writeBytes(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return bytes.length;
}

/** Find an animation by id, case-insensitive name or 0-based index; default the first. */
export function findAnimation(project, ref) {
  const list = project.animations;
  if (ref === undefined || ref === null || ref === '') return list[0];
  const found = list.find(a => a.id === ref) || list.find(a => a.name.toLowerCase() === String(ref).toLowerCase())
    || (/^\d+$/.test(String(ref)) ? list[Number(ref)] : undefined);
  if (!found) throw new Error(`No animation "${ref}". Animations: ${list.map((a, i) => `${i}: ${a.id} "${a.name}"`).join(', ')}.`);
  return found;
}

/** Find a frame by id or 0-based index; default the first. */
export function findFrame(animation, ref) {
  if (ref === undefined || ref === null || ref === '') return animation.frames[0];
  const found = animation.frames.find(f => f.id === ref) || (/^\d+$/.test(String(ref)) ? animation.frames[Number(ref)] : undefined);
  if (!found) throw new Error(`No frame "${ref}" in animation "${animation.name}" (it has ${animation.frames.length} frame${animation.frames.length === 1 ? '' : 's'}, indices 0–${animation.frames.length - 1}).`);
  return found;
}

/** A compact, JSON-friendly description of a project. */
export function projectSummary(project) {
  const p = validateProject(project), used = usedPaletteIndices(p);
  const objects = new Set();
  for (const a of p.animations) for (const f of a.frames) for (const cel of f.cels) for (const op of cel.source?.ops || []) if (op.type === 'use') objects.add(`${cel.layerId}/${op.id}`);
  return {
    name: p.name, width: p.width, height: p.height, formatVersion: p.version,
    palette: p.palette, usedColors: used.size,
    layers: p.layers.map(l => ({ id: l.id, name: l.name, visible: l.visible, locked: l.locked })),
    parts: (p.parts || []).map(part => ({ id: part.id, width: part.width, height: part.height })),
    objects: objects.size,
    animations: p.animations.map((a, index) => ({
      index, id: a.id, name: a.name, fps: a.fps, frames: a.frames.length, durationMs: a.frames.reduce((n, f) => n + f.duration, 0),
      frameDurations: a.frames.map(f => f.duration), ...(a.frames.some(f => f.kind) ? { frameKinds: a.frames.map(f => f.kind || null) } : {}),
    })),
    totalFrames: p.animations.reduce((n, a) => n + a.frames.length, 0),
    bones: (p.bones || []).map(b => ({ id: b.id, name: b.name ?? b.id, parent: b.parent || null, layerId: b.layerId, instanceId: b.instanceId })),
    poses: (p.poses || []).map(pose => ({ id: pose.id, name: pose.name })),
  };
}

/** Human-readable multi-line summary for the CLI. */
export function formatSummary(s) {
  const lines = [`${s.name}  ${s.width}×${s.height}  ${s.formatVersion === 3 ? "object project (parts, PXA 2)" : "raster project"}`,
    `Palette: ${s.palette.length} colours (${s.usedColors} used) ${s.palette.join(' ')}`,
    `Layers: ${s.layers.map(l => `${l.id} "${l.name}"${l.visible ? '' : ' (hidden)'}${l.locked ? ' (locked)' : ''}`).join(', ')}`];
  if (s.parts.length) lines.push(`Parts: ${s.parts.length}, placed objects: ${s.objects}`);
  lines.push(`Animations (${s.totalFrames} frames):`);
  for (const a of s.animations) lines.push(`  ${a.index}: ${a.id} "${a.name}" ${a.frames} frame${a.frames === 1 ? '' : 's'} @ ${a.fps} fps, ${a.durationMs} ms`);
  if (s.bones.length) lines.push(`Skeleton: ${s.bones.length} bones (${s.bones.map(b => b.name).join(', ')})`);
  if (s.poses.length) lines.push(`Poses: ${s.poses.map(p => p.name).join(', ')}`);
  return lines.join('\n');
}

/** Encode as PXA 2 text, optionally only one animation. */
export function projectToPxa(project, { animation } = {}) {
  const p = validateProject(project);
  if (animation === undefined || animation === null || animation === '') return encodeAIProject(p, { version: 2 });
  const only = findAnimation(p, animation);
  return encodeAIProject({ ...p, animations: [only] }, { version: 2 });
}

function decodeError(text) {
  try { decodeAIProject(text); return null; } catch (error) { return error.message || String(error); }
}

/**
 * Validate PXA text. Returns { ok, project?, summary?, errors: [{line?, message, source?}], warnings: [] }.
 * Errors found only after parsing (shape bounds, palette indices…) are traced back to a line by bisection.
 */
export function lintPxa(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: [{ message: 'The PXA text is empty. Start with "PXA 2" and finish with END.' }], warnings: [] };
  const lines = text.split(/\r?\n/);
  let project;
  try { project = decodeAIProject(text); }
  catch (error) {
    const message = error.message || String(error), match = /^Line (\d+): (.*)$/s.exec(message);
    let line = match ? Number(match[1]) : undefined, detail = match ? match[2] : message, approximate = false;
    if (!line && lines.length < 20000 && /^PXA\s+2\b/.test(lines.find(l => l.trim() && !l.trim().startsWith('#'))?.trim() || '')) {
      const body = lines.findIndex(l => /^\s*END\s*$/.test(l));
      const last = body < 0 ? lines.length : body;
      const fails = n => decodeError([...lines.slice(0, n), 'END', ''].join('\n')) === message;
      if (fails(last)) {
        let lo = 1, hi = last;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (fails(mid)) hi = mid; else lo = mid + 1; }
        line = lo; approximate = true;
      }
    }
    const error1 = { message: detail, ...(line ? { line, source: lines[line - 1]?.slice(0, 200) } : {}), ...(approximate ? { located: 'by bisection' } : {}) };
    return { ok: false, errors: [error1], warnings: [], hint: hintFor(detail) };
  }
  const summary = projectSummary(project), warnings = [];
  const used = usedPaletteIndices(project);
  const unused = project.palette.map((c, i) => used.has(i) ? null : `${i} (${c})`).filter(Boolean);
  if (unused.length) warnings.push(`Unused palette colours: ${unused.join(', ')}.`);
  for (const a of project.animations) {
    const empty = a.frames.map((f, i) => compositeFrame(project, f).every(v => v < 0) ? i : -1).filter(i => i >= 0);
    if (empty.length) warnings.push(`Animation "${a.name}" has blank frame${empty.length === 1 ? '' : 's'} at ${empty.join(', ')} (0-based).`);
  }
  warnings.push(...rigWarnings(project));
  return { ok: true, project, summary, errors: [], warnings };
}

/** Nudges toward animatable structure: drawn-only sprites and unrigged parts cannot be posed. */
function rigWarnings(project) {
  const frames = project.animations.flatMap(a => a.frames), uses = f => f.cels.flatMap(c => (c.source?.ops || []).filter(op => op.type === 'use'));
  if (Math.max(project.width, project.height) < 16) return [];
  if (!frames.some(f => uses(f).length)) return ['No parts: everything is drawn as raster pixels, so nothing can be posed, rigged or reused. For characters, creatures and anything that should move, draw each moving piece (head, torso, arms, legs, weapon…) as a PART placed with USE, or call make_parts to turn layers into parts and auto-rig them.'];
  if (!project.bones?.length && frames.some(f => uses(f).length > 1)) return ['The parts are not rigged: add BONE lines (see the guide), or call make_parts to auto-rig them, so the character can be posed and animated with apply_template.'];
  return [];
}

/**
 * Turn drawn pixel layers into reusable parts (one placed part per layer, shared between identical frames) and,
 * unless rig is false, join the parts into a skeleton where they touch. Returns { project, converted, attached, rootBoneId }.
 */
export function makeParts(project, { animation, frame, layers, rig = true } = {}) {
  const p = validateProject(project), anim = findAnimation(p, animation), base = findFrame(anim, frame);
  const layerIds = layers?.length ? layers.map(ref => {
    const layer = p.layers.find(l => l.id === ref || l.name === ref);
    if (!layer) throw new Error(`No layer "${ref}". Layers: ${p.layers.map(l => `${l.id} ("${l.name}")`).join(', ')}.`);
    return layer.id;
  }) : undefined;
  return partsAndRig(p, { animationId: anim.id, frameId: base.id, layerIds, rig });
}

function hintFor(message) {
  if (/expected END/i.test(message)) return 'Finish the document with a line containing only END.';
  if (/SIZE, NAME, PAL/.test(message)) return 'The header must be: PXA 2, SIZE w h, NAME "name", PAL #rrggbb ... in that order.';
  if (/palette|colou?r/i.test(message)) return 'Colour arguments are 0-based palette indices (decimal for shapes, base-64 symbols for SPAN); -1 or "." is transparent.';
  if (/width|height|fit|outside|canvas/i.test(message)) return 'Every drawing command must stay inside the canvas or part bounds (x + width <= canvas width).';
  return 'Call pixel_guide for the full PXA 2 grammar.';
}

function checker(rgba, width, height, cell, padding = 0) {
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const o = (y * width + x) * 4;
    if (rgba[o + 3]) continue;
    const light = (Math.floor((x - padding) / cell) + Math.floor((y - padding) / cell)) % 2 === 0;
    rgba[o] = rgba[o + 1] = rgba[o + 2] = light ? 0xe9 : 0xcf; rgba[o + 3] = 255;
  }
}

function previewOptions(project, { scale, background }) {
  const s = scale === undefined || scale === null ? Math.max(1, Math.min(16, Math.floor(512 / Math.max(project.width, project.height)))) : Number(scale);
  if (!Number.isInteger(s) || s < 1 || s > 64) throw new Error('Scale must be a whole number from 1 to 64.');
  if (Math.max(project.width, project.height) * s > MAX_PREVIEW_EDGE) throw new Error(`Scale ${s} would make an image wider than ${MAX_PREVIEW_EDGE} pixels.`);
  const bg = background === undefined || background === null || background === 'transparent' ? null : background;
  if (bg && bg !== 'checker' && !HEX.test(bg)) throw new Error('Background must be "transparent", "checker" or a #rrggbb colour.');
  return { scale: s, background: bg };
}

/**
 * Render one frame (default) or a whole animation as a horizontal strip (`strip: true`) to PNG bytes.
 * Returns { png, width, height, scale, animation: {id,name}, frames: [{index,id,duration}] }.
 */
export async function renderPng(project, { animation, frame, scale, background, strip = false, layer } = {}) {
  const p = validateProject(project), anim = findAnimation(p, animation), { scale: s, background: bg } = previewOptions(p, { scale, background });
  const fill = bg === 'checker' ? null : bg;
  const pixelsOf = f => layer ? f.cels.find(c => c.layerId === layer)?.pixels ?? (() => { throw new Error(`No layer "${layer}".`); })() : compositeFrame(p, f);
  const frames = strip ? anim.frames : [findFrame(anim, frame)];
  const cells = frames.map(f => rasterize(p, pixelsOf(f), { scale: s, background: fill }));
  let image = cells[0];
  if (strip && cells.length > 1) {
    const gap = Math.max(1, s);
    const layout = sheetLayout([cells.length], cells[0].width, cells[0].height, { layout: 'horizontal', spacing: gap });
    checkExportSize(layout.width, layout.height, 'This preview strip');
    image = { rgba: composeSheet(cells, layout, fill), width: layout.width, height: layout.height };
  }
  if (bg === 'checker') {
    if (strip && cells.length > 1) {
      // Checker per cell so the grid lines up with logical pixels; gaps stay a neutral grey.
      const cellW = cells[0].width, gap = Math.max(1, s);
      for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
        const o = (y * image.width + x) * 4;
        if (image.rgba[o + 3]) continue;
        const local = x % (cellW + gap);
        if (local >= cellW) { image.rgba[o] = image.rgba[o + 1] = image.rgba[o + 2] = 0x80; image.rgba[o + 3] = 255; continue; }
        const light = (Math.floor(local / s) + Math.floor(y / s)) % 2 === 0;
        image.rgba[o] = image.rgba[o + 1] = image.rgba[o + 2] = light ? 0xe9 : 0xcf; image.rgba[o + 3] = 255;
      }
    } else checker(image.rgba, image.width, image.height, s);
  }
  return {
    png: Buffer.from(await encodePng(image.rgba, image.width, image.height)), width: image.width, height: image.height, scale: s,
    animation: { id: anim.id, name: anim.name }, frames: frames.map(f => ({ index: anim.frames.indexOf(f), id: f.id, duration: f.duration })),
  };
}

/**
 * Export with the editor's export pipeline. kind: 'png' | 'sequence' | 'sheet' | 'gif' | 'apng'. scope: 'animation'
 * (default for gif/apng/png) or 'project' (default for sheets). Returns { files: [{name, data}], download }.
 */
export async function exportProject(project, { kind = 'sheet', scope, animation, frame, scale = 1, layout = 'rows', columns = 0, spacing = 0, padding = 0, background = null, metadata = 'aseprite-hash', loop = true } = {}) {
  const p = validateProject(project), anim = findAnimation(p, animation), f = findFrame(anim, frame);
  const settings = { kind, scope: scope || (kind === 'sheet' ? 'project' : 'animation'), scale, layout, columns, spacing, padding, background, metadata, loop };
  const { files, download } = await buildExport(p, settings, { animationId: anim.id, frameId: f.id, name: p.name, version: '1.2.0' });
  const bytes = data => typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return { files: files.map(file => ({ name: file.name, data: bytes(file.data) })), download: { name: download.name, data: bytes(download.data) } };
}

/** Write an export: `.zip` gets the bundle, a directory gets every file, a file path gets the main file plus siblings. */
export async function writeExport(result, out) {
  const written = [];
  let isDirectory = /[\\/]$/.test(out);
  try { isDirectory ||= (await stat(out)).isDirectory(); } catch { /* new path */ }
  if (extname(out).toLowerCase() === '.zip' && !isDirectory) {
    await writeBytes(out, result.download.data); return [out];
  }
  if (isDirectory) {
    for (const file of result.files) { const path = join(out, file.name); await writeBytes(path, file.data); written.push(path); }
    return written;
  }
  const ext = extname(out), stem = out.slice(0, out.length - ext.length), used = new Set();
  for (const [index, file] of result.files.entries()) {
    const fileExt = file.name.endsWith('-unity.txt') ? '-unity.txt' : file.name.endsWith('.sheet.json') ? '.sheet.json' : extname(file.name);
    let path = index === 0 ? out : `${stem}${fileExt}`;
    for (let n = 2; used.has(path); n += 1) path = `${stem}-${n}${fileExt}`;
    used.add(path);
    await writeBytes(path, file.data); written.push(path);
  }
  return written;
}

/**
 * Turn a PNG (bytes) into a single-frame pixel project: detect an upscaled pixel grid (or use `pixelSize`), downscale
 * large images to `maxSize`, optionally remove the border background, and quantize to `colors` palette colours
 * (or map onto an explicit `palette`). Returns { project, grid, removed, source: {width, height} }.
 */
export async function imageToProject(bytes, { colors = 16, palette, pixelSize, maxSize = 128, background = true, trim = true, merge = 28, mode = 'detect', name = 'Pixelized image' } = {}) {
  const image = decodePng(bytes);
  if (!Number.isInteger(colors) || colors < 1 || colors > MAX_COLORS) throw new Error(`colors must be a whole number from 1 to ${MAX_COLORS}.`);
  if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > 256) throw new Error('maxSize must be a whole number from 1 to 256.');
  const grid = pixelSize ? detectGrid(image.rgba, image.width, image.height, { scale: Number(pixelSize) }) : undefined;
  const out = pixelize(image.rgba, image.width, image.height, { mode, grid, background, trim, maxSize, merge });
  const pal = palette ? readPalette(palette) : paletteFromRgba(out.rgba, colors);
  const project = blankProject(String(name).slice(0, 80) || 'Pixelized image', out.width, out.height);
  project.palette = pal;
  project.animations[0].frames[0].cels[0].pixels = mapRgbaToPalette(out.rgba, pal, out.width, out.height);
  return { project: validateProject(project), grid: out.grid, removed: out.removed, source: { width: image.width, height: image.height } };
}

function readPalette(list) {
  const colours = (Array.isArray(list) ? list : String(list).split(/[\s,]+/)).filter(Boolean).map(c => (String(c).startsWith('#') ? String(c) : `#${c}`).toLowerCase());
  if (!colours.length || colours.length > MAX_COLORS || colours.some(c => !HEX.test(c))) throw new Error(`A palette needs 1–${MAX_COLORS} #rrggbb colours.`);
  return colours;
}

export function listPalettePresets() {
  return PALETTE_PRESETS.map(p => ({ id: p.id, name: p.name, author: p.author, tags: [...p.tags], colors: [...p.colours] }));
}

/**
 * Replace the palette with a preset (`preset`: id or name) or explicit `colors`. remap (default true) moves every
 * pixel to the perceptually nearest new colour; remap false keeps indices (the new palette must cover every used index).
 */
export function setPalette(project, { preset, colors, remap = true }) {
  const p = validateProject(project);
  let next;
  if (preset) {
    const found = PALETTE_PRESETS.find(item => item.id === preset || item.name.toLowerCase() === String(preset).toLowerCase());
    if (!found) throw new Error(`Unknown palette preset "${preset}". Presets: ${PALETTE_PRESETS.map(item => item.id).join(', ')}.`);
    next = [...found.colours];
  } else if (colors) next = readPalette(colors);
  else throw new Error('Give a palette preset or a list of colours.');
  if (remap) return replacePalette(p, next);
  const used = [...usedPaletteIndices(p)], highest = used.length ? Math.max(...used) : -1;
  if (highest >= next.length) throw new Error(`Without remapping, the new palette needs at least ${highest + 1} colours (index ${highest} is used).`);
  return replacePalette(p, next, p.palette.map((_, i) => Math.min(i, next.length - 1)));
}

export const TEMPLATE_IDS = Object.keys(TEMPLATES);

/**
 * Generate a rig animation template (walk, run, jump, idle, wave, hover) for a skeleton (BONE lines) character.
 * Returns { project, animationId, frameIds, roles, facing }.
 */
export function applyTemplate(project, { template, animation, frame, rootBone, frames, frameMs, amplitude, bounce, exaggeration, facing = 'auto', mode = 'new', name } = {}) {
  const p = validateProject(project);
  if (!TEMPLATES[template]) throw new Error(`Unknown template "${template}". Use one of: ${TEMPLATE_IDS.join(', ')}.`);
  if (!p.bones?.length) throw new Error('This project has no skeleton. Templates animate rigged characters: add BONE lines (see the PXA 2 guide) that join placed parts, then try again.');
  const roots = p.bones.filter(b => !b.parent);
  const root = rootBone ? p.bones.find(b => b.id === rootBone || b.name === rootBone) : roots[0];
  if (!root) throw new Error(`No bone "${rootBone}". Root bones: ${roots.map(b => b.id).join(', ')}.`);
  const anim = findAnimation(p, animation), base = findFrame(anim, frame);
  if (!['new', 'replace', 'merge'].includes(mode)) throw new Error('mode must be new, replace or merge.');
  return generateTemplate(p, { animationId: anim.id, frameId: base.id, rootBoneId: root.id, template, frames, frameMs, amplitude, bounce, exaggeration, facing, mode, name });
}

/** A new blank project (single transparent frame). `palette`: preset id or colour list. */
export function createProject({ name = 'Untitled sprite', width = 32, height = 32, palette, fps = 8, frames = 1, animation = 'Idle' } = {}) {
  for (const [label, v] of [['width', width], ['height', height]]) if (!Number.isInteger(v) || v < 1 || v > 256) throw new Error(`${label} must be a whole number from 1 to 256.`);
  if (!Number.isInteger(frames) || frames < 1 || frames > 256) throw new Error('frames must be 1–256.');
  let p = blankProject(String(name).slice(0, 120), width, height);
  if (palette) {
    const preset = typeof palette === 'string' && PALETTE_PRESETS.find(item => item.id === palette || item.name.toLowerCase() === palette.toLowerCase());
    p.palette = preset ? [...preset.colours] : readPalette(palette);
  }
  // Short readable IDs are easier for agents to reference in PXA edits than UUIDs.
  const anim = p.animations[0], layer = p.layers[0];
  layer.id = 'art'; layer.name = 'Artwork';
  anim.name = String(animation).slice(0, 80) || 'Idle';
  anim.id = anim.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'anim';
  if (anim.id === 'art') anim.id = 'anim';
  anim.fps = Math.max(1, Math.min(60, Math.round(fps)));
  const duration = Math.round(1000 / anim.fps), pixels = anim.frames[0].cels[0].pixels;
  anim.frames = Array.from({ length: frames }, (_, i) => ({ id: `${anim.id}-${i + 1}`, duration, cels: [{ layerId: 'art', pixels: [...pixels] }] }));
  p = validateProject(p);
  return p;
}
