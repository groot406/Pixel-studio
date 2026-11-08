/**
 * Headless Pixel Studio for Node (CLI, MCP server, tests): load/save .pxa/.pxs/.pixel.json, summarise, lint PXA,
 * render frames to PNG, export sheets/GIFs, turn images into pixel projects and apply palettes and rig templates.
 * Uses only the browser-independent domain and format modules.
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, extname, basename, join } from 'node:path';
import { blankProject, validateProject, paletteFromRgba, mapRgbaToPalette, compositeFrame, MAX_COLORS } from '../src/domain/project.js';
import { pixelize, detectGrid } from '../src/domain/pixelize.js';
import { encodeAIProject, decodeAIProject } from '../src/formats/pxa.js';
import { encodePixelProject, decodePixelProject } from '../src/formats/pxs.js';
import { buildExport } from '../src/formats/export-bundle.js';
import { decodePng } from './png-decode.mjs';
import { findAnimation, findFrame, readPalette, renderPngBytes } from '../src/domain/project-ops.js';

export { findAnimation, findFrame, projectSummary, formatSummary, projectToPxa, lintPxa, setOutline, makeParts, listPalettePresets, setPalette, TEMPLATE_IDS, applyTemplate, createProject } from '../src/domain/project-ops.js';

export const PROJECT_EXTENSIONS = ['.pxa', '.pxs', '.json'];

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

/** Render one frame or an animation strip to PNG bytes (a Buffer); see renderPngBytes. */
export async function renderPng(project, options) {
  const result = await renderPngBytes(project, options);
  return { ...result, png: Buffer.from(result.png) };
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
