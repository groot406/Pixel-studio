/** Turn a project and export settings into downloadable files (PNG, PNG ZIP, sprite sheets, GIF, APNG). */
import { exportGroups, framePixels, rasterize, frameSize, checkExportSize, sheetLayout, composeSheet, describeSheet, asepriteJson, texturePackerJson, unityGuide, godotSpriteFrames, genericJson } from './image-export.js';
import { createSheetMetadata } from './spritesheet.js';
import { encodePng, encodeApng } from './png.js';
import { encodeGif, indexRgbaFrames } from './gif.js';
import { createZip } from './zip.js';

export const METADATA_FORMATS = {
  none: 'No metadata',
  'aseprite-hash': 'Aseprite JSON · hash',
  'aseprite-array': 'Aseprite JSON · array',
  godot: 'Godot 4 SpriteFrames · .tres',
  unity: 'Unity · TexturePacker JSON + guide',
  generic: 'Generic JSON',
  'pixel-studio': 'Pixel Studio · re-import',
};
export const EXPORT_DEFAULTS = Object.freeze({
  kind: 'png', scope: 'animation', layers: 'visible', scale: 1, padding: 0, background: null,
  layout: 'rows', columns: 0, spacing: 0, margin: 0, metadata: 'aseprite-hash', loop: true,
});

/** Lower-case, file-safe name. */
export function slug(name, fallback = 'pixel-sprite') {
  return String(name).normalize('NFKD').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 80) || fallback;
}

/** Clamp untrusted (e.g. remembered) settings to valid values. */
export function cleanSettings(input = {}) {
  const s = { ...EXPORT_DEFAULTS, ...input };
  const int = (v, min, max, d) => Number.isInteger(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : d;
  return {
    ...s,
    kind: ['png', 'sequence', 'webp', 'sheet', 'gif', 'apng'].includes(s.kind) ? s.kind : 'png',
    scope: ['frame', 'animation', 'project'].includes(s.scope) ? s.scope : 'animation',
    layers: s.layers === 'layer' ? 'layer' : 'visible',
    scale: int(s.scale, 1, 64, 1), padding: int(s.padding, 0, 256, 0), spacing: int(s.spacing, 0, 256, 0), margin: int(s.margin, 0, 256, 0), columns: int(s.columns, 0, 1024, 0),
    background: /^#[0-9a-f]{6}$/i.test(s.background || '') ? s.background : null,
    layout: ['horizontal', 'vertical', 'grid', 'rows'].includes(s.layout) ? s.layout : 'rows',
    metadata: s.metadata in METADATA_FORMATS ? s.metadata : 'aseprite-hash',
    loop: s.loop !== false,
  };
}

/** Why Pixel Studio's own re-import metadata cannot describe this sheet, or ''. */
export function pixelStudioMetadataProblem(s) {
  if (s.layout !== 'rows') return 'Re-import metadata needs the “One row per animation” layout.';
  if (s.padding || s.spacing || s.margin) return 'Re-import metadata needs padding, spacing and margin at 0.';
  return '';
}

/** Which scope a kind uses: single images are one frame; sequences and animations at least one animation. */
export const effectiveScope = (s) => s.kind === 'png' || s.kind === 'webp' ? 'frame' : s.kind !== 'sheet' && s.scope === 'frame' ? 'animation' : s.scope;

/**
 * Plan an export without encoding: frames, sizes and sheet layout. ctx: {animationId, frameId, layerId, name}.
 * Returns {settings, groups, cell, frames, layout?, width, height, base}.
 */
export function planExport(project, settings, ctx) {
  const s = cleanSettings(settings), scope = effectiveScope(s);
  const groups = exportGroups(project, { scope, animationId: ctx.animationId, frameId: ctx.frameId });
  const cell = frameSize(project, s), count = groups.reduce((n, g) => n + g.frames.length, 0);
  const anim = groups[0].animation, base = slug(ctx.name || project.name);
  const scopeName = scope === 'project' ? 'all-animations' : slug(anim.name, 'animation');
  const suffix = s.scale > 1 ? `-${s.scale}x` : '';
  checkExportSize(cell.width, cell.height, 'One frame');
  if (count * cell.width * cell.height > 4 * 32 * 1024 * 1024) throw new Error('These frames are too large together. Choose a smaller scale or fewer frames.');
  const plan = { settings: { ...s, scope }, groups, cell, frames: count, width: cell.width, height: cell.height, base, scopeName, suffix };
  if (s.kind === 'sheet') {
    plan.layout = sheetLayout(groups.map((g) => g.frames.length), cell.width, cell.height, s);
    checkExportSize(plan.layout.width, plan.layout.height, 'This sprite sheet');
    plan.width = plan.layout.width; plan.height = plan.layout.height;
  }
  return plan;
}

/** Render every planned frame as RGBA cells, grouped per animation. */
export function renderPlan(project, plan, layerId = null) {
  const layer = plan.settings.layers === 'layer' ? layerId : null;
  return plan.groups.map((g) => g.frames.map((frame) => rasterize(project, framePixels(project, frame, layer), plan.settings)));
}

const file = (name, data, type) => ({ name, data, type });

/**
 * Encode the files for a plan. Returns {files, download: {name, data, type}} where several files are zipped.
 * WebP is encoded by the browser and is not handled here.
 */
export async function encodeExport(project, plan, cells, { version = '1.2.0' } = {}) {
  const s = plan.settings, files = [], flat = cells.flat(), { base, scopeName, suffix } = plan;
  const frameNumber = (g, i) => String(i + 1).padStart(Math.max(3, String(plan.groups[g].frames.length).length), '0');
  if (s.kind === 'png') {
    const g = plan.groups[0], index = g.animation.frames.indexOf(g.frames[0]);
    files.push(file(`${base}-${slug(g.animation.name, 'animation')}-frame-${index + 1}${suffix}.png`, await encodePng(flat[0].rgba, plan.width, plan.height), 'image/png'));
  } else if (s.kind === 'sequence') {
    for (const [g, row] of cells.entries()) for (const [i, cell] of row.entries()) {
      files.push(file(`${slug(plan.groups[g].animation.name, 'animation')}-${frameNumber(g, i)}${suffix}.png`, await encodePng(cell.rgba, plan.width, plan.height), 'image/png'));
    }
    const unique = dedupe(files);
    return { files: unique, download: file(`${base}-${scopeName}${suffix}-png-sequence.zip`, createZip(unique), 'application/zip') };
  } else if (s.kind === 'sheet') {
    const image = `${base}-${scopeName}-sheet${suffix}.png`;
    files.push(file(image, await encodePng(composeSheet(flat, plan.layout, s.background), plan.width, plan.height), 'image/png'));
    const sheet = describeSheet(plan.groups, plan.layout, { image, scale: s.scale, padding: s.padding, spacing: s.spacing, margin: s.margin, title: base });
    const stem = image.replace(/\.png$/, ''), json = (value) => JSON.stringify(value, null, 2);
    if (s.metadata === 'aseprite-hash' || s.metadata === 'aseprite-array') files.push(file(`${stem}.json`, json(asepriteJson(sheet, { array: s.metadata === 'aseprite-array', version })), 'application/json'));
    else if (s.metadata === 'godot') files.push(file(`${stem}.tres`, godotSpriteFrames(sheet), 'text/plain'));
    else if (s.metadata === 'unity') files.push(file(`${stem}.json`, json(texturePackerJson(sheet, { version })), 'application/json'), file(`${stem}-unity.txt`, unityGuide(sheet), 'text/plain'));
    else if (s.metadata === 'generic') files.push(file(`${stem}.json`, json(genericJson(sheet)), 'application/json'));
    else if (s.metadata === 'pixel-studio') {
      const problem = pixelStudioMetadataProblem(s);
      if (problem) throw new Error(problem);
      const subset = { ...project, animations: plan.groups.map((g) => ({ ...g.animation, frames: g.frames })) };
      files.push(file(`${stem}.sheet.json`, json(createSheetMetadata(subset, s.scale)), 'application/json'));
    }
  } else if (s.kind === 'gif' || s.kind === 'apng') {
    for (const [g, row] of cells.entries()) {
      const delays = plan.groups[g].frames.map((f) => f.duration), name = `${base}-${slug(plan.groups[g].animation.name, 'animation')}${suffix}`;
      if (s.kind === 'gif') {
        const { palette, frames, transparentIndex } = indexRgbaFrames(row.map((c) => c.rgba));
        files.push(file(`${name}.gif`, encodeGif({ width: plan.width, height: plan.height, palette, transparentIndex, loops: s.loop ? 0 : 1, frames: frames.map((indices, i) => ({ indices, delay: delays[i] })) }), 'image/gif'));
      } else {
        files.push(file(`${name}.png`, await encodeApng(row.map((c) => c.rgba), plan.width, plan.height, delays, { loops: s.loop ? 0 : 1 }), 'image/apng'));
      }
    }
  }
  const unique = dedupe(files);
  if (unique.length === 1) return { files: unique, download: unique[0] };
  const label = s.kind === 'sheet' ? `-sheet${suffix}` : `${suffix}-${s.kind}`;
  return { files: unique, download: file(`${base}-${scopeName}${label}.zip`, createZip(unique), 'application/zip') };
}

/** Make names unique by appending -2, -3… before the extension. */
function dedupe(files) {
  const seen = new Set();
  return files.map((f) => {
    let name = f.name, n = 1;
    while (seen.has(name)) name = f.name.replace(/(\.[^.]+)?$/, (ext) => `-${++n}${ext}`);
    seen.add(name);
    return name === f.name ? f : { ...f, name };
  });
}

/** Plan, render and encode in one step. */
export async function buildExport(project, settings, ctx) {
  const plan = planExport(project, settings, ctx);
  return { plan, ...(await encodeExport(project, plan, renderPlan(project, plan, ctx.layerId), { version: ctx.version })) };
}
