import { encodePXA2, decodePXA2 } from './pxa-v2.js';

/** PXA 1: readable, editable indexed pixel data with explicit frame deltas. */
import {
  MAX_SIZE, MAX_COLORS, MAX_LAYERS, MAX_TOTAL_PIXELS,
  getLayerPixels, validateProject,
} from '../domain/project.js';

export const AI_PIXEL_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz@$';
export const MAX_AI_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ANIMATIONS = 100;
const MAX_FRAMES_PER_ANIMATION = 256;
const MAX_TOTAL_FRAMES = 1024;
const MAX_LINE_CHARACTERS = 2048;
const utf8 = new TextEncoder();

export const AI_FORMAT_GUIDE = `Write or edit Pixel Studio AI pixel data using PXA version 1. Return the complete file, without Markdown fences. Commands are uppercase, one per line. Blank lines and full-line # comments are allowed. There is no END marker.

Begin with these four lines, in order:
PXA 1
SIZE width height
NAME "project name"
PAL #rrggbb #rrggbb ...

Declare every layer before any animation:
LAYER index "layer name" visible locked
Indices are consecutive from 0. Visibility and lock flags are 0 or 1. Layer order is bottom to top. Double-quote names using JSON string escapes; never use JSON objects or arrays.

Then use:
ANIM "animation name" fps
ORDER layer-index layer-index ...
FRAME duration-ms CLEAR|PREV [KEY|BREAKDOWN|INBETWEEN]
CEL layer-index
SPAN y x pixel-string

Every animation needs a frame. CLEAR starts every layer transparent. PREV copies all layers of the immediately preceding frame in this animation; its first frame must therefore use CLEAR. The optional KEY, BREAKDOWN or INBETWEEN marks the frame's role (key pose, breakdown, in-between) without changing pixels. Select CEL again after each FRAME before writing SPAN. SPAN overwrites a contiguous row segment; coordinates are zero-based, y first. It must stay within that row. Repeated or overlapping spans are applied in order.

ORDER is optional, once immediately after ANIM and before its first FRAME. List every declared layer index exactly once, bottom to top. Omit it to use declaration order. The order applies only to that animation. Older readers without ORDER support cannot read files containing it.
FRAMEORDER is optional, once after FRAME and before SHIFT or CEL. It lists every layer index exactly once and overrides only that frame's order; omission uses animation order. PREV copies pixels, not frame order.

SHIFT dx dy may appear once immediately after a PREV FRAME, before CEL. It shifts every layer, clips pixels outside the canvas, and clears exposed cells. Offsets are signed whole numbers bounded by width and height.

Palette indices 0–63 use this exact, case-sensitive alphabet:
0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz@$
A period (.) is transparent and erases an old pixel. Optionally repeat one symbol with braces, such as A{6} or .{8}; counts are positive whole numbers. Pixel strings contain no spaces. An unchanged PREV frame needs no CEL or SPAN lines.

Preserve hidden layers, deliberate blank frames, names, palette order, visibility, locks, FPS, and durations unless asked to change them. Internal IDs are regenerated.

Limits: dimensions 1–256; 1–64 colors; 1–32 layers; 1–100 animations; 1–256 frames per animation, 1,024 total; 4,194,304 stored pixels across all layers and frames. FPS is 1–60, including decimals. Durations are whole milliseconds from 1–60,000. Use decimal numbers without leading zeros. Project names allow 120 characters; layer and animation names allow 80. Text is limited to 4 MiB of UTF-8.`;

function problem(message, lineNumber) {
  throw new Error(lineNumber === undefined ? message : `Line ${lineNumber}: ${message}`);
}

function quote(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function pixelRun(pixels, start, end) {
  let output = '';
  let cursor = start;
  while (cursor <= end) {
    const value = pixels[cursor];
    let next = cursor + 1;
    while (next <= end && pixels[next] === value) next += 1;
    const count = next - cursor;
    const symbol = value === -1 ? '.' : AI_PIXEL_ALPHABET[value];
    const repeated = `${symbol}{${count}}`;
    output += repeated.length < count ? repeated : symbol.repeat(count);
    cursor = next;
  }
  return output;
}

function frameBody(project, frame, previous, dx = 0, dy = 0) {
  const lines = dx || dy ? [`SHIFT ${dx} ${dy}`] : [];
  project.layers.forEach((layer, layerIndex) => {
    const pixels = getLayerPixels(frame, layer.id);
    const oldPixels = previous ? getLayerPixels(previous, layer.id) : null;
    let selected = false;
    for (let y = 0; y < project.height; y += 1) {
      const row = y * project.width;
      const oldY = y - dy;
      const unchanged = (x) => {
        const oldX = x - dx;
        const oldValue = oldPixels && oldX >= 0 && oldX < project.width && oldY >= 0 && oldY < project.height
          ? oldPixels[oldY * project.width + oldX] : -1;
        return pixels[row + x] === oldValue;
      };
      let first = 0;
      while (first < project.width && unchanged(first)) first += 1;
      if (first === project.width) continue;
      let last = project.width - 1;
      while (last > first && unchanged(last)) last -= 1;
      if (!selected) { lines.push(`CEL ${layerIndex}`); selected = true; }
      lines.push(`SPAN ${y} ${first} ${pixelRun(pixels, row + first, row + last)}`);
    }
  });
  return lines;
}

function bodyLength(lines) {
  // Frame commands contain only ASCII, so characters and UTF-8 bytes coincide.
  return lines.reduce((total, line) => total + line.length + 1, 0);
}

/** Stable text serialization; internal IDs are intentionally not part of PXA. */
export function encodeAIProjectV1(project) {
  const clean = validateProject(project);
  const lines = [];
  let byteLength = 0;
  const append = (line) => {
    byteLength += utf8.encode(line).length + 1;
    if (byteLength > MAX_AI_FILE_BYTES) {
      problem('This project exceeds the 4 MiB AI pixel data limit. Use the compact PXS file or reduce its canvas, layers, or frames.');
    }
    lines.push(line);
  };
  append('PXA 1');
  append(`SIZE ${clean.width} ${clean.height}`);
  append(`NAME ${quote(clean.name)}`);
  append(`PAL ${clean.palette.join(' ')}`);
  clean.layers.forEach((layer, index) => {
    append(`LAYER ${index} ${quote(layer.name)} ${layer.visible ? 1 : 0} ${layer.locked ? 1 : 0}`);
  });
  for (const animation of clean.animations) {
    append('');
    append(`ANIM ${quote(animation.name)} ${animation.fps}`);
    if (animation.layerOrder) append(`ORDER ${animation.layerOrder.map(id => clean.layers.findIndex(layer => layer.id === id)).join(' ')}`);
    let previous;
    for (const frame of animation.frames) {
      append(`FRAME ${frame.duration} ${previous ? 'PREV' : 'CLEAR'}${frame.kind ? ` ${frame.kind.toUpperCase()}` : ''}`);
      if(frame.layerOrder)append(`FRAMEORDER ${frame.layerOrder.map(id=>clean.layers.findIndex(layer=>layer.id===id)).join(' ')}`);
      let body = frameBody(clean, frame, previous);
      let shortest = bodyLength(body);
      if (previous) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;
            const candidate = frameBody(clean, frame, previous, dx, dy);
            const length = bodyLength(candidate);
            if (length < shortest) { body = candidate; shortest = length; }
          }
        }
      }
      for (const line of body) append(line);
      previous = frame;
    }
  }
  return `${lines.join('\n')}\n`;
}

// Iterate without allocating an array of every line in a hostile input file.
function* sourceLines(text) {
  let start = 0;
  let lineNumber = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n' && text[index] !== '\r') continue;
    yield { text: text.slice(start, index), lineNumber };
    if (text[index] === '\r' && text[index + 1] === '\n') index += 1;
    start = index + 1;
    lineNumber += 1;
  }
  if (start < text.length) yield { text: text.slice(start), lineNumber };
}

function whole(value, label, lineNumber) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || value.length > 10) {
    problem(`${label} must be a whole decimal number without leading zeros.`, lineNumber);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) problem(`${label} is too large.`, lineNumber);
  return number;
}

function signedWhole(value, label, lineNumber) {
  if (!/^[+-]?(?:0|[1-9][0-9]*)$/.test(value) || value.length > 11) {
    problem(`${label} must be a signed whole decimal number without leading zeros.`, lineNumber);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) problem(`${label} is too large.`, lineNumber);
  return number;
}

function shiftPixels(pixels, width, height, dx, dy) {
  const shifted = Array(width * height).fill(-1);
  for (let y = 0; y < height; y += 1) {
    const sourceY = y - dy;
    if (sourceY < 0 || sourceY >= height) continue;
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - dx;
      if (sourceX >= 0 && sourceX < width) shifted[y * width + x] = pixels[sourceY * width + sourceX];
    }
  }
  return shifted;
}

function fields(value, count, command, lineNumber) {
  const items = value ? value.split(/\s+/) : [];
  if (items.length !== count) problem(`${command} expects ${count} ${count === 1 ? 'argument' : 'arguments'}.`, lineNumber);
  return items;
}

function nameField(source, maximum, label, lineNumber) {
  if (source[0] !== '"') problem(`${label} must be a double-quoted string.`, lineNumber);
  let closing = -1;
  for (let index = 1; index < source.length; index += 1) {
    if (source[index] === '\\') { index += 1; continue; }
    if (source[index] === '"') { closing = index; break; }
  }
  if (closing < 0) problem(`${label} has an unterminated quoted string.`, lineNumber);
  let value;
  try {
    value = JSON.parse(source.slice(0, closing + 1));
  } catch {
    problem(`${label} must use valid quoted-string escapes, such as \\" and \\\\.`, lineNumber);
  }
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    problem(`${label} must contain 1–${maximum} characters.`, lineNumber);
  }
  const suffix = source.slice(closing + 1);
  if (suffix && !/^\s/.test(suffix)) problem(`Add whitespace after the quoted ${label.toLowerCase()}.`, lineNumber);
  return { value: value.trim(), rest: suffix.trim() };
}

function spanPixels(source, available, paletteLength, lineNumber) {
  if (!source) problem('SPAN needs a nonempty pixel string.', lineNumber);
  const output = [];
  for (let cursor = 0; cursor < source.length;) {
    const symbol = source[cursor++];
    const index = symbol === '.' ? -1 : AI_PIXEL_ALPHABET.indexOf(symbol);
    if (symbol !== '.' && index < 0) problem(`SPAN contains an invalid pixel symbol: ${symbol}.`, lineNumber);
    if (index >= paletteLength) problem(`SPAN symbol ${symbol} refers to a color outside the palette.`, lineNumber);
    let count = 1;
    if (source[cursor] === '{') {
      const end = source.indexOf('}', cursor + 1);
      if (end < 0) problem('A repeated pixel symbol needs a closing brace.', lineNumber);
      const digits = source.slice(cursor + 1, end);
      if (!/^[1-9][0-9]*$/.test(digits)) problem('Pixel repeat counts must be positive whole numbers without leading zeros.', lineNumber);
      if (digits.length > 3) problem('The expanded SPAN exceeds the canvas row.', lineNumber);
      count = Number(digits);
      cursor = end + 1;
    }
    if (count > available - output.length) problem('The expanded SPAN exceeds the canvas row.', lineNumber);
    for (let repeat = 0; repeat < count; repeat += 1) output.push(index);
  }
  return output;
}

/** Parse PXA text with bounded expansion and deterministic regenerated IDs. */
export function decodeAIProjectV1(text) {
  if (typeof text !== 'string') problem('AI pixel data must be supplied as text.');
  if (text.length > MAX_AI_FILE_BYTES || utf8.encode(text).length > MAX_AI_FILE_BYTES) {
    problem('AI pixel data exceeds the 4 MiB text limit.');
  }
  let stage = 'PXA';
  let width;
  let height;
  let name;
  let palette;
  const layers = [];
  const animations = [];
  let animation = null;
  let frame = null;
  let selectedLayer = null;
  let canShift = false;
  let frameCommands = false;
  let totalFrames = 0;
  let lastLine = 1;
  for (const entry of sourceLines(text)) {
    const lineNumber = entry.lineNumber;
    lastLine = lineNumber;
    const line = entry.text.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.length > MAX_LINE_CHARACTERS) problem('This line is too long for a PXA command.', lineNumber);
    const boundary = line.search(/\s/);
    const command = boundary < 0 ? line : line.slice(0, boundary);
    const rest = boundary < 0 ? '' : line.slice(boundary).trim();
    if (!['PXA', 'SIZE', 'NAME', 'PAL', 'LAYER', 'ANIM', 'ORDER', 'FRAME', 'FRAMEORDER', 'SHIFT', 'CEL', 'SPAN'].includes(command)) {
      problem(`Unknown command ${command.slice(0, 24)}. Use uppercase PXA, SIZE, NAME, PAL, LAYER, ANIM, ORDER, FRAME, SHIFT, CEL, or SPAN.`, lineNumber);
    }
    if (['PXA', 'SIZE', 'NAME', 'PAL'].includes(stage) && command !== stage) {
      problem(`Expected ${stage} before ${command}.`, lineNumber);
    }
    switch (command) {
      case 'PXA': {
        if (stage !== 'PXA') problem('PXA must appear once at the beginning of the file.', lineNumber);
        const [version] = fields(rest, 1, 'PXA', lineNumber);
        if (version !== '1') problem('Unsupported PXA version. Use PXA 1.', lineNumber);
        stage = 'SIZE';
        break;
      }
      case 'SIZE': {
        if (stage !== 'SIZE') problem('SIZE must follow PXA and appear only once.', lineNumber);
        const values = fields(rest, 2, 'SIZE', lineNumber);
        width = whole(values[0], 'Canvas width', lineNumber);
        height = whole(values[1], 'Canvas height', lineNumber);
        if (width < 1 || height < 1 || width > MAX_SIZE || height > MAX_SIZE) problem(`Canvas dimensions must be from 1 to ${MAX_SIZE}.`, lineNumber);
        stage = 'NAME';
        break;
      }
      case 'NAME': {
        if (stage !== 'NAME') problem('NAME must follow SIZE and appear only once.', lineNumber);
        const parsed = nameField(rest, 120, 'Project name', lineNumber);
        if (parsed.rest) problem('NAME accepts only one quoted project name.', lineNumber);
        name = parsed.value;
        stage = 'PAL';
        break;
      }
      case 'PAL': {
        if (stage !== 'PAL') problem('PAL must follow NAME and appear only once.', lineNumber);
        const values = rest ? rest.split(/\s+/) : [];
        if (values.length < 1 || values.length > MAX_COLORS) problem(`PAL needs 1–${MAX_COLORS} hex colors.`, lineNumber);
        palette = values.map((color) => {
          if (!/^#[0-9a-f]{6}$/i.test(color)) problem('Palette colors must use six-digit hex notation, such as #ffcc66.', lineNumber);
          return color.toLowerCase();
        });
        stage = 'LAYERS';
        break;
      }
      case 'LAYER': {
        if (stage !== 'LAYERS') problem('Declare every LAYER after PAL and before the first ANIM.', lineNumber);
        const match = /^(\S+)\s+([\s\S]+)$/.exec(rest);
        if (!match) problem('Use LAYER index "name" visible locked.', lineNumber);
        const index = whole(match[1], 'Layer index', lineNumber);
        if (index !== layers.length) problem(`Layer indices must be consecutive from 0; expected ${layers.length}.`, lineNumber);
        if (layers.length >= MAX_LAYERS) problem(`A project can contain at most ${MAX_LAYERS} layers.`, lineNumber);
        const parsed = nameField(match[2], 80, 'Layer name', lineNumber);
        const flags = fields(parsed.rest, 2, 'LAYER visibility and lock flags', lineNumber);
        if (!flags.every((flag) => flag === '0' || flag === '1')) problem('Layer visibility and lock flags must be 0 or 1.', lineNumber);
        layers.push({ id: `pxa-layer-${index}`, name: parsed.value, visible: flags[0] === '1', locked: flags[1] === '1' });
        break;
      }
      case 'ANIM': {
        if (stage !== 'LAYERS' && stage !== 'ANIMATIONS') problem('ANIM must follow the layer declarations.', lineNumber);
        if (!layers.length) problem('Declare at least one LAYER before ANIM.', lineNumber);
        if (animation && !animation.frames.length) problem('The preceding animation needs at least one FRAME.', lineNumber);
        if (animations.length >= MAX_ANIMATIONS) problem(`A project can contain at most ${MAX_ANIMATIONS} animations.`, lineNumber);
        const parsed = nameField(rest, 80, 'Animation name', lineNumber);
        const [fpsText] = fields(parsed.rest, 1, 'ANIM playback speed', lineNumber);
        if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(fpsText)) problem('Animation FPS must be a decimal number from 1 to 60.', lineNumber);
        const fps = Number(fpsText);
        if (!Number.isFinite(fps) || fps < 1 || fps > 60) problem('Animation FPS must be from 1 to 60.', lineNumber);
        animation = { id: `pxa-animation-${animations.length}`, name: parsed.value, fps, frames: [] };
        animations.push(animation);
        frame = null;
        selectedLayer = null;
        canShift = false;
        stage = 'ANIMATIONS';
        break;
      }
      case 'ORDER': {
        if (!animation || animation.frames.length || animation.layerOrder) problem('ORDER is allowed once after ANIM, before its first FRAME.', lineNumber);
        const indices = fields(rest, layers.length, 'ORDER', lineNumber).map(value => whole(value, 'Layer index', lineNumber));
        if (new Set(indices).size !== layers.length || indices.some(index => index >= layers.length)) problem('ORDER must contain every layer index exactly once.', lineNumber);
        animation.layerOrder = indices.map(index => layers[index].id);
        break;
      }
      case 'FRAME': {
        if (!animation) problem('Declare an ANIM before FRAME.', lineNumber);
        const kindToken = rest.split(/\s+/).length === 3 ? rest.split(/\s+/)[2] : '';
        const kind = { KEY: 'key', BREAKDOWN: 'breakdown', INBETWEEN: 'inbetween' }[kindToken];
        const [durationText, mode] = fields(kind ? rest.slice(0, rest.lastIndexOf(kindToken)).trim() : rest, 2, 'FRAME', lineNumber);
        const duration = whole(durationText, 'Frame duration', lineNumber);
        if (duration < 1 || duration > 60000) problem('Frame durations must be from 1 to 60,000 milliseconds.', lineNumber);
        if (mode !== 'CLEAR' && mode !== 'PREV') problem('FRAME mode must be CLEAR or PREV.', lineNumber);
        const previous = animation.frames.at(-1);
        if (mode === 'PREV' && !previous) problem('The first frame of each animation must use CLEAR, not PREV.', lineNumber);
        if (animation.frames.length >= MAX_FRAMES_PER_ANIMATION) problem(`An animation can contain at most ${MAX_FRAMES_PER_ANIMATION} frames.`, lineNumber);
        if (totalFrames >= MAX_TOTAL_FRAMES) problem(`A project can contain at most ${MAX_TOTAL_FRAMES.toLocaleString('en-US')} frames.`, lineNumber);
        const count = width * height;
        if ((totalFrames + 1) * count * layers.length > MAX_TOTAL_PIXELS) {
          problem(`A project can contain at most ${MAX_TOTAL_PIXELS.toLocaleString('en-US')} stored pixels across all layers and frames.`, lineNumber);
        }
        frame = {
          id: `pxa-frame-${animations.length - 1}-${animation.frames.length}`,
          duration,
          cels: layers.map((layer) => ({
            layerId: layer.id,
            pixels: mode === 'PREV' ? [...getLayerPixels(previous, layer.id)] : Array(count).fill(-1),
          })),
          ...(kind ? { kind } : {}),
        };
        animation.frames.push(frame);
        totalFrames += 1;
        selectedLayer = null;
        canShift = mode === 'PREV';
        frameCommands=false;
        break;
      }
      case 'FRAMEORDER': {
        if(!frame || frame.layerOrder || frameCommands)problem('FRAMEORDER is allowed once after FRAME, before SHIFT or CEL.',lineNumber);
        const indices=fields(rest,layers.length,'FRAMEORDER',lineNumber).map(value=>whole(value,'Layer index',lineNumber));
        if(new Set(indices).size!==layers.length || indices.some(index=>index>=layers.length))problem('FRAMEORDER must contain every layer index exactly once.',lineNumber);
        frame.layerOrder=indices.map(index=>layers[index].id);
        break;
      }
      case 'SHIFT': {
        frameCommands=true;
        if (!frame || !canShift) problem('SHIFT is allowed once immediately after a FRAME using PREV, before any CEL or SPAN.', lineNumber);
        const [dxText, dyText] = fields(rest, 2, 'SHIFT', lineNumber);
        const dx = signedWhole(dxText, 'SHIFT dx', lineNumber);
        const dy = signedWhole(dyText, 'SHIFT dy', lineNumber);
        if (Math.abs(dx) > width || Math.abs(dy) > height) problem('SHIFT offsets cannot exceed the canvas width or height.', lineNumber);
        for (const cel of frame.cels) cel.pixels = shiftPixels(cel.pixels, width, height, dx, dy);
        canShift = false;
        break;
      }
      case 'CEL': {
        frameCommands=true;
        if (!frame) problem('Start a FRAME before selecting a CEL.', lineNumber);
        const [indexText] = fields(rest, 1, 'CEL', lineNumber);
        const index = whole(indexText, 'Cel layer index', lineNumber);
        if (index >= layers.length) problem(`CEL ${index} refers to a layer that was not declared.`, lineNumber);
        selectedLayer = index;
        canShift = false;
        break;
      }
      case 'SPAN': {
        if (!frame) problem('Start a FRAME before writing SPAN.', lineNumber);
        if (selectedLayer === null) problem('Select a CEL in the current frame before writing SPAN.', lineNumber);
        const [yText, xText, source] = fields(rest, 3, 'SPAN', lineNumber);
        const y = whole(yText, 'SPAN y coordinate', lineNumber);
        const x = whole(xText, 'SPAN x coordinate', lineNumber);
        if (y >= height || x >= width) problem(`SPAN coordinates must be inside the ${width} × ${height} canvas.`, lineNumber);
        const values = spanPixels(source, width - x, palette.length, lineNumber);
        const pixels = getLayerPixels(frame, layers[selectedLayer].id);
        for (let index = 0; index < values.length; index += 1) pixels[y * width + x + index] = values[index];
        canShift = false;
        break;
      }
      default: break;
    }
  }
  if (stage !== 'ANIMATIONS') problem('The file is incomplete. Include PXA, SIZE, NAME, PAL, at least one LAYER, and at least one ANIM with a FRAME.', lastLine);
  if (!animation || !animation.frames.length) problem('Every animation needs at least one FRAME.', lastLine);
  return validateProject({ format: 'pixel-studio', version: 2, name, width, height, palette, layers, animations });
}

/** Explicit version routing; legacy raster projects retain their default encoding. */
export function encodeAIProject(project, { version = project.version === 3 ? 2 : 1 } = {}) {
  if (version === 1) return encodeAIProjectV1(project);
  if (version === 2) return encodePXA2(project);
  throw new Error('Unsupported PXA version.');
}
export function decodeAIProject(text) {
  if (typeof text !== 'string') problem('AI pixel data must be supplied as text.');
  if (text.length > MAX_AI_FILE_BYTES || utf8.encode(text).length > MAX_AI_FILE_BYTES) problem('AI pixel data exceeds the 4 MiB text limit.');
  for (const entry of sourceLines(text)) {
    const header = entry.text.trim();
    if (!header || header.startsWith('#')) continue;
    return header.split(/\s+/).join(' ') === 'PXA 2' ? decodePXA2(text) : decodeAIProjectV1(text);
  }
  return decodeAIProjectV1(text);
}
