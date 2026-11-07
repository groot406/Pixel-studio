/**
 * Pure helpers for image exports: choosing frames, crisp nearest-neighbour rasterising,
 * sprite-sheet layout and the metadata formats (Aseprite JSON, Godot SpriteFrames,
 * TexturePacker-style JSON for Unity, and a generic JSON).
 */
import { compositeFrame, getLayerPixels } from '../domain/project.js';

export const MAX_EXPORT_EDGE = 16384;
export const MAX_EXPORT_PIXELS = 32 * 1024 * 1024;
export const SHEET_LAYOUTS = ['horizontal', 'vertical', 'grid', 'rows'];

/** '#rrggbb' → [r, g, b]. */
export function hexRgb(hex) {
  const value = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!value) throw new Error(`Invalid colour ${hex}.`);
  const n = parseInt(value[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

/** Animations and frames for a scope: 'frame' | 'animation' | 'project'. */
export function exportGroups(project, { scope = 'project', animationId, frameId } = {}) {
  const animation = project.animations.find((a) => a.id === animationId) || project.animations[0];
  if (scope === 'frame') return [{ animation, frames: [animation.frames.find((f) => f.id === frameId) || animation.frames[0]] }];
  if (scope === 'animation') return [{ animation, frames: animation.frames }];
  return project.animations.map((a) => ({ animation: a, frames: a.frames }));
}

/** Size of one exported frame. */
export const frameSize = (project, { scale = 1, padding = 0 } = {}) => ({
  width: project.width * scale + padding * 2, height: project.height * scale + padding * 2,
});

/** Palette-index pixels of a frame: all visible layers, or one layer when layerId is given. */
export function framePixels(project, frame, layerId = null) {
  return layerId ? getLayerPixels(frame, layerId) : compositeFrame(project, frame);
}

/** Paint palette indices into RGBA at an integer scale with padding; background is '#rrggbb' or null. */
export function rasterize(project, pixels, { scale = 1, padding = 0, background = null } = {}) {
  const { width, height } = frameSize(project, { scale, padding });
  const rgba = new Uint8Array(width * height * 4);
  if (background) {
    const [r, g, b] = hexRgb(background);
    for (let o = 0; o < rgba.length; o += 4) { rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255; }
  }
  const colours = project.palette.map(hexRgb);
  for (let y = 0; y < project.height; y += 1) for (let x = 0; x < project.width; x += 1) {
    const colour = colours[pixels[y * project.width + x]];
    if (!colour) continue;
    for (let dy = 0; dy < scale; dy += 1) {
      let o = ((padding + y * scale + dy) * width + padding + x * scale) * 4;
      for (let dx = 0; dx < scale; dx += 1, o += 4) { rgba[o] = colour[0]; rgba[o + 1] = colour[1]; rgba[o + 2] = colour[2]; rgba[o + 3] = 255; }
    }
  }
  return { rgba, width, height };
}

/** Check that an image of this size can be exported. */
export function checkExportSize(width, height, label = 'This export') {
  if (width > MAX_EXPORT_EDGE || height > MAX_EXPORT_EDGE || width * height > MAX_EXPORT_PIXELS) {
    throw new Error(`${label} would be ${width} × ${height} pixels, which is too large. Choose a smaller scale or fewer frames.`);
  }
}

/**
 * Place cells on a sheet. counts: frames per animation. Returns sheet size and one rect per frame
 * ({x, y, w, h, group, index}) in animation order. Layout 'rows' puts each animation on its own row.
 */
export function sheetLayout(counts, cellWidth, cellHeight, { layout = 'rows', columns = 0, spacing = 0, margin = 0 } = {}) {
  if (!SHEET_LAYOUTS.includes(layout)) throw new Error(`Unknown sheet layout ${layout}.`);
  const total = counts.reduce((n, c) => n + c, 0);
  if (!total) throw new Error('There are no frames to export.');
  const positions = [];
  let cols, rows;
  if (layout === 'rows') {
    cols = Math.max(...counts); rows = counts.length;
    counts.forEach((count, group) => { for (let index = 0; index < count; index += 1) positions.push([index, group, group, index]); });
  } else {
    cols = layout === 'horizontal' ? total : layout === 'vertical' ? 1 : Math.min(total, columns > 0 ? Math.floor(columns) : Math.ceil(Math.sqrt(total)));
    rows = Math.ceil(total / cols);
    let n = 0;
    counts.forEach((count, group) => { for (let index = 0; index < count; index += 1, n += 1) positions.push([n % cols, Math.floor(n / cols), group, index]); });
  }
  const width = margin * 2 + cols * cellWidth + (cols - 1) * spacing;
  const height = margin * 2 + rows * cellHeight + (rows - 1) * spacing;
  const rects = positions.map(([column, row, group, index]) => ({
    x: margin + column * (cellWidth + spacing), y: margin + row * (cellHeight + spacing), w: cellWidth, h: cellHeight, group, index,
  }));
  return { width, height, columns: cols, rows, rects };
}

/** Copy cell images onto a sheet; background fills the whole sheet when set. */
export function composeSheet(cells, layout, background = null) {
  const { width, height, rects } = layout, rgba = new Uint8Array(width * height * 4);
  if (background) {
    const [r, g, b] = hexRgb(background);
    for (let o = 0; o < rgba.length; o += 4) { rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255; }
  }
  rects.forEach((rect, i) => {
    const cell = cells[i];
    for (let y = 0; y < rect.h; y += 1) rgba.set(cell.rgba.subarray(y * rect.w * 4, (y + 1) * rect.w * 4), ((rect.y + y) * width + rect.x) * 4);
  });
  return rgba;
}

/** Describe a sheet for the metadata writers. */
export function describeSheet(groups, layout, { image, scale = 1, padding = 0, spacing = 0, margin = 0, title = 'sprite' } = {}) {
  let n = 0;
  const animations = groups.map(({ animation, frames }) => {
    const from = n; n += frames.length;
    return { name: animation.name, fps: animation.fps, from, to: n - 1, durations: frames.map((f) => f.duration) };
  });
  const frames = layout.rects.map((r, i) => ({
    animation: groups[r.group].animation.name, index: r.index, x: r.x, y: r.y, w: r.w, h: r.h, duration: groups[r.group].frames[r.index].duration, global: i,
  }));
  return { title, image, width: layout.width, height: layout.height, cellWidth: layout.rects[0].w, cellHeight: layout.rects[0].h, columns: layout.columns, rows: layout.rows, scale, padding, spacing, margin, frames, animations };
}

const rect = ({ x, y, w, h }) => ({ x, y, w, h });

/** Aseprite "JSON Hash" (default) or "JSON Array" sprite-sheet data. */
export function asepriteJson(sheet, { array = false, version = '1.2.0' } = {}) {
  const entries = sheet.frames.map((f) => [`${sheet.title} ${f.global}.aseprite`, {
    frame: rect(f), rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h }, sourceSize: { w: f.w, h: f.h }, duration: f.duration,
  }]);
  return {
    frames: array ? entries.map(([filename, data]) => ({ filename, ...data })) : Object.fromEntries(entries),
    meta: {
      app: 'Pixel Studio', version, image: sheet.image, format: 'RGBA8888', size: { w: sheet.width, h: sheet.height }, scale: String(sheet.scale),
      frameTags: sheet.animations.map((a) => ({ name: a.name, from: a.from, to: a.to, direction: 'forward', color: '#000000ff' })),
      layers: [{ name: 'Sprite', opacity: 255, blendMode: 'normal' }], slices: [],
    },
  };
}

/** TexturePacker-style "JSON (Hash)" with pivots and animation lists — accepted by Unity JSON sprite importers, Phaser and PixiJS. */
export function texturePackerJson(sheet, { version = '1.2.0' } = {}) {
  const key = (f) => `${sheet.animations.find((a) => f.global >= a.from && f.global <= a.to).name}_${f.index}`;
  const frames = {}, keys = [];
  for (const f of sheet.frames) {
    let name = key(f);
    while (frames[name]) name += '_';
    keys.push(name);
    frames[name] = { frame: rect(f), rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h }, sourceSize: { w: f.w, h: f.h }, pivot: { x: 0.5, y: 0.5 }, duration: f.duration };
  }
  const animations = {};
  for (const a of sheet.animations) animations[a.name in animations ? `${a.name}_${a.from}` : a.name] = keys.slice(a.from, a.to + 1);
  return { frames, animations, meta: { app: 'Pixel Studio', version, image: sheet.image, format: 'RGBA8888', size: { w: sheet.width, h: sheet.height }, scale: String(sheet.scale) } };
}

/** Plain-text Unity import steps for a uniform grid sheet. */
export function unityGuide(sheet) {
  const cellW = sheet.cellWidth, cellH = sheet.cellHeight;
  return [
    `Unity import guide for ${sheet.image}`, '',
    '1. Copy the PNG into Assets/. In the Inspector set Texture Type: Sprite (2D and UI), Sprite Mode: Multiple,',
    `   Pixels Per Unit: ${Math.round((cellH - sheet.padding * 2) / sheet.scale)}, Filter Mode: Point (no filter), Compression: None. Apply.`,
    '2. Open the Sprite Editor → Slice → Type: Grid By Cell Size.',
    `   Pixel Size: ${cellW} × ${cellH}  ·  Offset: ${sheet.margin}, ${sheet.margin}  ·  Padding: ${sheet.spacing}, ${sheet.spacing}. Slice, then Apply.`,
    '3. Frame order and timing per animation are listed below and in the JSON file (TexturePacker JSON Hash),',
    '   which JSON atlas importers for Unity can read directly. Create one Animation Clip per animation with these sprites.', '',
    ...sheet.animations.map((a) => `${a.name}: frames ${a.from}–${a.to} (left to right, top to bottom) · ${a.fps} fps · durations ${a.durations.join(', ')} ms`),
    '',
  ].join('\n');
}

const godotNumber = (n) => Number.isInteger(n) ? n.toFixed(1) : String(Number(n.toFixed(4)));
const godotString = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Godot 4 SpriteFrames resource (.tres) with one AtlasTexture per frame; durations are relative to the animation speed. */
export function godotSpriteFrames(sheet, { texturePath = `res://${sheet.image}` } = {}) {
  const lines = [`[gd_resource type="SpriteFrames" load_steps=${sheet.frames.length + 2} format=3]`, '', `[ext_resource type="Texture2D" path="${godotString(texturePath)}" id="1_sheet"]`, ''];
  for (const f of sheet.frames) lines.push(`[sub_resource type="AtlasTexture" id="AtlasTexture_${f.global}"]`, 'atlas = ExtResource("1_sheet")', `region = Rect2(${f.x}, ${f.y}, ${f.w}, ${f.h})`, '');
  const animations = sheet.animations.map((a) => {
    const frames = sheet.frames.slice(a.from, a.to + 1).map((f) => `{\n"duration": ${godotNumber(f.duration * a.fps / 1000)},\n"texture": SubResource("AtlasTexture_${f.global}")\n}`);
    return `{\n"frames": [${frames.join(', ')}],\n"loop": true,\n"name": &"${godotString(a.name)}",\n"speed": ${godotNumber(a.fps)}\n}`;
  });
  lines.push('[resource]', `animations = [${animations.join(', ')}]`, '');
  return lines.join('\n');
}

/** Generic, engine-neutral sheet description. */
export function genericJson(sheet) {
  return {
    format: 'pixel-studio-export', version: 1, image: sheet.image, size: { w: sheet.width, h: sheet.height },
    frameSize: { w: sheet.cellWidth, h: sheet.cellHeight }, scale: sheet.scale, padding: sheet.padding, spacing: sheet.spacing, margin: sheet.margin,
    columns: sheet.columns, rows: sheet.rows,
    frames: sheet.frames.map((f) => ({ animation: f.animation, index: f.index, x: f.x, y: f.y, w: f.w, h: f.h, duration: f.duration })),
    animations: sheet.animations.map((a) => ({ name: a.name, fps: a.fps, loop: true, from: a.from, to: a.to, durations: a.durations })),
  };
}
