/**
 * Plugin validation — pure, no DOM. Everything a plugin hands back to the editor (its manifest, its registrations and the
 * result of every run) passes through here before it touches a project. Plugins are untrusted: treat each value as
 * hostile input, copy it into fresh plain data, and reject anything outside the editor's limits (src/domain/limits.js).
 */
import { MAX_SIZE, MAX_COLORS, MAX_TOTAL_PIXELS } from '../domain/limits.js';
import { MAX_AI_FILE_BYTES } from '../formats/pxa.js';

export const PLUGIN_API_VERSION = 1;
export const MAX_PLUGIN_BYTES = 256 * 1024;
export const MAX_REGISTRATIONS = 32;
export const MAX_PARAMS = 12;
export const MAX_RESULT_FRAMES = 256;
export const SCOPES = Object.freeze(['frame', 'selection', 'animation', 'project']);
export const PARAM_TYPES = Object.freeze(['number', 'select', 'color', 'boolean']);
/** What each permission lets a plugin do; the manager shows these before install. */
export const PERMISSIONS = Object.freeze({
  pixels: 'Change pixels of the active container (effects, frame and selection commands)',
  animation: 'Rewrite the active container across the animation and add frames',
  palette: 'Append colours to the palette and offer palette presets',
  project: 'Read the whole project and replace it (one undo step)',
  prompt: 'Add prompt skills (presets) to the AI prompt builder',
});
const HEADER = /^\uFEFF?\s*\/\*\s*pixelstudio-plugin\b([\s\S]*?)\*\//;
const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PARAM_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value);
function text(value, label, max, { required = true } = {}) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`${label} must be text of ${required ? 1 : 0}–${max} characters.`);
  return value.trim();
}
function identifier(value, label, pattern = ID) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} must be a short id of letters, digits, dots, dashes or underscores.`);
  return value;
}

/**
 * Split plugin source into { manifest, code }. The file starts with a JSON manifest in a comment —
 * `/* pixelstudio-plugin {"id":"drop-shadow","name":"Drop shadow","version":"1.0.0","permissions":["pixels"]} *\/` —
 * followed by classic-script code that calls the global `pixelStudio` API.
 */
export function parsePluginSource(source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('A plugin must be a JavaScript text file.');
  if (source.length > MAX_PLUGIN_BYTES) throw new Error(`A plugin may be at most ${MAX_PLUGIN_BYTES / 1024} KB.`);
  const match = HEADER.exec(source);
  if (!match) throw new Error('This file has no Pixel Studio plugin header. It must start with /* pixelstudio-plugin {…manifest…} */.');
  let raw;
  try { raw = JSON.parse(match[1]); } catch (error) { throw new Error(`The plugin manifest is not valid JSON: ${error.message}`); }
  return { manifest: validateManifest(raw), code: source };
}

export function validateManifest(raw) {
  if (!isObject(raw)) throw new Error('The plugin manifest must be a JSON object.');
  const permissions = raw.permissions === undefined ? [] : raw.permissions;
  if (!Array.isArray(permissions) || permissions.length > 8) throw new Error('Manifest permissions must be a list.');
  for (const p of permissions) if (!Object.hasOwn(PERMISSIONS, p)) throw new Error(`Unknown permission “${String(p).slice(0, 40)}”. Use: ${Object.keys(PERMISSIONS).join(', ')}.`);
  if (raw.api !== undefined && raw.api !== PLUGIN_API_VERSION) throw new Error(`This plugin needs plugin API ${raw.api}; Pixel Studio provides ${PLUGIN_API_VERSION}.`);
  if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) throw new Error('Manifest version must look like 1.0.0.');
  return {
    id: identifier(raw.id, 'Manifest id'),
    name: text(raw.name, 'Manifest name', 80),
    version: raw.version,
    description: text(raw.description, 'Manifest description', 300, { required: false }),
    author: text(raw.author, 'Manifest author', 80, { required: false }),
    permissions: [...new Set(permissions)],
  };
}

/** Compare dotted versions: negative when a < b. A pre-release sorts before its release. */
export function compareVersions(a, b) {
  const [ma, pa = ''] = a.split('-'), [mb, pb = ''] = b.split('-');
  const x = ma.split('.').map(Number), y = mb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  if (pa === pb) return 0;
  return !pa ? 1 : !pb ? -1 : pa < pb ? -1 : 1;
}

function validateParam(raw, index, label) {
  if (!isObject(raw)) throw new Error(`${label}: parameter ${index + 1} must be an object.`);
  const id = identifier(raw.id, `${label}: parameter id`, PARAM_ID), type = raw.type;
  if (!PARAM_TYPES.includes(type)) throw new Error(`${label}: parameter “${id}” type must be ${PARAM_TYPES.join(', ')}.`);
  const param = { id, type, label: text(raw.label ?? id, `${label}: parameter label`, 60) };
  if (type === 'number') {
    const min = raw.min ?? 0, max = raw.max ?? 100, step = raw.step ?? 1;
    if (![min, max, step].every(Number.isFinite) || min >= max || step <= 0) throw new Error(`${label}: parameter “${id}” needs min < max and a positive step.`);
    const value = raw.default ?? min;
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label}: parameter “${id}” default must lie between min and max.`);
    Object.assign(param, { min, max, step, default: value });
  } else if (type === 'select') {
    if (!Array.isArray(raw.options) || raw.options.length < 1 || raw.options.length > 32) throw new Error(`${label}: parameter “${id}” needs 1–32 options.`);
    param.options = raw.options.map(o => {
      const option = isObject(o) ? o : { value: o, label: o };
      if (typeof option.value !== 'string' || !option.value || option.value.length > 60) throw new Error(`${label}: options of “${id}” must be short text values.`);
      return { value: option.value, label: text(String(option.label ?? option.value), 'Option label', 60) };
    });
    const value = raw.default ?? param.options[0].value;
    if (!param.options.some(o => o.value === value)) throw new Error(`${label}: parameter “${id}” default must be one of its options.`);
    param.default = value;
  } else if (type === 'color') {
    const value = raw.default ?? 'active';
    if (!(['active', 'darkest', 'lightest'].includes(value) || (Number.isInteger(value) && value >= 0 && value < MAX_COLORS))) throw new Error(`${label}: colour parameter “${id}” default must be a palette index, "active", "darkest" or "lightest".`);
    param.default = value;
  } else {
    if (raw.default !== undefined && typeof raw.default !== 'boolean') throw new Error(`${label}: parameter “${id}” default must be true or false.`);
    param.default = raw.default ?? false;
  }
  return param;
}

function validateAction(raw, kind, manifest) {
  if (!isObject(raw)) throw new Error(`Each ${kind} must be an object.`);
  const id = identifier(raw.id, `${kind} id`), label = `${kind} “${id}”`, scope = raw.scope ?? 'frame';
  if (!SCOPES.includes(scope) || (kind === 'effect' && !['frame', 'selection'].includes(scope))) throw new Error(`${label}: scope must be ${kind === 'effect' ? 'frame or selection' : SCOPES.join(', ')}.`);
  const needs = { frame: 'pixels', selection: 'pixels', animation: 'animation', project: 'project' }[scope];
  if (!manifest.permissions.includes(needs)) throw new Error(`${label} needs the “${needs}” permission in the manifest.`);
  const params = raw.params ?? [];
  if (!Array.isArray(params) || params.length > MAX_PARAMS) throw new Error(`${label}: params must be a list of at most ${MAX_PARAMS}.`);
  const list = params.map((p, i) => validateParam(p, i, label));
  if (new Set(list.map(p => p.id)).size !== list.length) throw new Error(`${label}: parameter ids must be unique.`);
  return { id, kind, scope, title: text(raw.title, `${label} title`, 60), description: text(raw.description, `${label} description`, 200, { required: false }), params: list };
}

function validateSkill(raw, manifest) {
  if (!manifest.permissions.includes('prompt')) throw new Error('Prompt skills need the “prompt” permission in the manifest.');
  if (!isObject(raw)) throw new Error('Each prompt skill must be an object.');
  const id = identifier(raw.id, 'Prompt skill id'), skill = {
    id, title: text(raw.title, `Prompt skill “${id}” title`, 60), description: text(raw.description, `Prompt skill “${id}” description`, 200, { required: false }),
    instructions: text(raw.instructions, `Prompt skill “${id}” instructions`, 4000),
  };
  if (raw.animations !== undefined) {
    if (!Array.isArray(raw.animations) || raw.animations.length < 1 || raw.animations.length > 24) throw new Error(`Prompt skill “${id}”: animations must list 1–24 entries.`);
    skill.animations = raw.animations.map(a => {
      if (!isObject(a) || !Number.isInteger(a.frameCount) || a.frameCount < 1 || a.frameCount > 256 || !Number.isFinite(a.fps) || a.fps < 1 || a.fps > 60) throw new Error(`Prompt skill “${id}”: each animation needs a name, frameCount 1–256 and fps 1–60.`);
      return { name: text(a.name, 'Animation name', 80), frameCount: a.frameCount, fps: a.fps };
    });
  }
  for (const key of ['width', 'height']) if (raw[key] !== undefined) {
    if (!Number.isInteger(raw[key]) || raw[key] < 1 || raw[key] > MAX_SIZE) throw new Error(`Prompt skill “${id}”: ${key} must be 1–${MAX_SIZE}.`);
    skill[key] = raw[key];
  }
  return skill;
}

export function validatePaletteColors(colors, label = 'Palette') {
  if (!Array.isArray(colors) || colors.length < 1 || colors.length > MAX_COLORS) throw new Error(`${label} must list 1–${MAX_COLORS} colours.`);
  return colors.map(c => { if (typeof c !== 'string' || !HEX.test(c)) throw new Error(`${label} colours must be six-digit hex, such as #ffcc66.`); return c.toLowerCase(); });
}

/** Normalise what a plugin registered while loading: { commands, effects, promptSkills, palettes } (fresh copies). */
export function validateRegistrations(raw, manifest) {
  if (!isObject(raw)) throw new Error('The plugin registered nothing readable.');
  const list = (key, fn) => {
    const items = raw[key] ?? [];
    if (!Array.isArray(items) || items.length > MAX_REGISTRATIONS) throw new Error(`A plugin may register at most ${MAX_REGISTRATIONS} ${key}.`);
    return items.map(fn);
  };
  const out = {
    commands: list('commands', r => validateAction(r, 'command', manifest)),
    effects: list('effects', r => validateAction(r, 'effect', manifest)),
    promptSkills: list('promptSkills', r => validateSkill(r, manifest)),
    palettes: list('palettes', r => {
      if (!manifest.permissions.includes('palette')) throw new Error('Palettes need the “palette” permission in the manifest.');
      if (!isObject(r)) throw new Error('Each palette must be an object.');
      const name = text(r.name, 'Palette name', 60);
      return { name, colors: validatePaletteColors(r.colors, `Palette “${name}”`) };
    }),
  };
  const ids = [...out.commands, ...out.effects].map(c => c.id);
  if (new Set(ids).size !== ids.length) throw new Error('Command and effect ids must be unique within a plugin.');
  if (new Set(out.promptSkills.map(s => s.id)).size !== out.promptSkills.length) throw new Error('Prompt skill ids must be unique within a plugin.');
  if (!ids.length && !out.promptSkills.length && !out.palettes.length) throw new Error('The plugin registered no commands, effects, prompt skills or palettes.');
  return out;
}

/** Resolve chosen parameter values (or their defaults); colour values are palette indices, checked against `paletteLength`. */
export function resolveParams(params, values = {}, { paletteLength, active = 0, darkest = 0, lightest = 0 } = {}) {
  const out = {};
  for (const p of params) {
    let v = values[p.id];
    if (p.type === 'number') { v = v === undefined || v === '' ? p.default : Number(v); if (!Number.isFinite(v)) v = p.default; v = Math.min(p.max, Math.max(p.min, v)); }
    else if (p.type === 'select') { if (!p.options.some(o => o.value === v)) v = p.default; }
    else if (p.type === 'boolean') v = v === undefined ? p.default : v === true || v === 'true';
    else {
      if (v === undefined) v = { active, darkest, lightest }[p.default] ?? p.default;
      v = Number(v);
      if (!Number.isInteger(v) || v < 0 || v >= paletteLength) v = Math.min(Math.max(0, active), paletteLength - 1);
    }
    out[p.id] = v;
  }
  return out;
}

function readPixels(value, count, paletteLength, label) {
  const ok = Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView));
  if (!ok || value.length !== count) throw new Error(`${label} must be exactly ${count.toLocaleString('en-US')} palette indices (width × height).`);
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const v = value[i];
    if (!Number.isInteger(v) || v < -1 || v >= paletteLength) throw new Error(`${label}: pixel ${i} is ${String(v).slice(0, 20)}; use -1 (transparent) or a palette index 0–${paletteLength - 1}.`);
    out[i] = v;
  }
  return out;
}

/**
 * Validate a plugin's run result for `scope` against the editor context `ctx` = { width, height, palette, frameCount,
 * permissions? (manifest permissions; when given, appending colours needs 'palette') }.
 * Returns fresh plain data: { pixels } (frame/selection), { frames: [{pixels, duration?}] } (animation) or
 * { project } (PXA text, decoded by the caller), plus { palette } when the plugin appended colours. A palette must keep
 * the current colours in order and may only append (project scope changes colours inside its project instead).
 */
export function validateResult(scope, result, ctx) {
  if (!SCOPES.includes(scope)) throw new Error(`Unknown scope ${scope}.`);
  if (!isObject(result)) throw new Error('The plugin returned nothing usable. Return an object such as { pixels }.');
  const { width, height } = ctx, count = width * height, out = {};
  let paletteLength = ctx.palette.length;
  if (result.palette !== undefined) {
    if (scope === 'project') throw new Error('Project commands change the palette inside the returned project.');
    if (ctx.permissions && !ctx.permissions.includes('palette')) throw new Error('Appending palette colours needs the “palette” permission in the manifest.');
    const palette = validatePaletteColors(result.palette, 'The returned palette');
    if (palette.length < ctx.palette.length || ctx.palette.some((c, i) => palette[i] !== c.toLowerCase())) throw new Error('The returned palette must keep the current colours in order; plugins may only append colours.');
    if (palette.length !== ctx.palette.length) out.palette = palette;
    paletteLength = palette.length;
  }
  if (scope === 'frame' || scope === 'selection') out.pixels = readPixels(result.pixels, count, paletteLength, 'The returned pixels');
  else if (scope === 'animation') {
    const frames = result.frames;
    if (!Array.isArray(frames) || frames.length < ctx.frameCount || frames.length > MAX_RESULT_FRAMES) throw new Error(`Return ${ctx.frameCount}–${MAX_RESULT_FRAMES} frames: an animation command may add frames, not remove them.`);
    if (frames.length * count > MAX_TOTAL_PIXELS) throw new Error('The returned frames exceed the project pixel limit.');
    out.frames = frames.map((f, i) => {
      const entry = isObject(f) ? f : { pixels: f };
      const frame = { pixels: readPixels(entry.pixels, count, paletteLength, `Frame ${i + 1}`) };
      if (entry.duration !== undefined) {
        if (!Number.isInteger(entry.duration) || entry.duration < 1 || entry.duration > 60000) throw new Error(`Frame ${i + 1} duration must be 1–60000 ms.`);
        frame.duration = entry.duration;
      }
      return frame;
    });
  } else {
    if (typeof result.project !== 'string' || !result.project.trim()) throw new Error('A project command must return { project: "PXA text" }.');
    if (result.project.length > MAX_AI_FILE_BYTES) throw new Error('The returned project exceeds the 4 MiB text limit.');
    out.project = result.project;
  }
  return out;
}
