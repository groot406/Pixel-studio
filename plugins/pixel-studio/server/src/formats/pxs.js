/**
 * PXS: a compact binary Pixel Studio project. No JSON is stored in this format.
 *
 * Container v1, all multibyte numbers little-endian:
 *   0..3   ASCII "PXST"
 *   4      container version (1)
 *   5      codec (0 = raw, 1 = gzip)
 *   6..7   reserved, must be zero
 *   8..11  uncompressed payload length
 *   12..15 stored body length
 *   16..19 CRC32 of the uncompressed payload
 *
 * Payload: six u8 fields (payload schema=2, 3 or 4, width, height, palette count,
 * layer count, animation count; a width/height byte of 0 means 256), then the project name and RGB palette bytes.
 * Strings use a u16 UTF-8 byte length followed by those bytes. Each layer is
 * id/name/u8 flags (bit 0 visible, bit 1 locked). Each animation is id/name/
 * float64 FPS/u16 frame count. Each frame is id/u16 duration followed by one
 * width*height byte cel per layer, in project layer order. A pixel byte is its
 * palette index + 1; zero is transparent. Hidden and locked cels are preserved.
 * Payload schema 3 adds layer-count u8 layer indices after each animation's
 * frame count, bottom to top. Cel storage remains in project declaration order.
 * Writers retain schema 2 when no animation has an explicit layer order.
 * Schema 4 also stores layer-count u8 indices after each frame duration for
 * frame-specific order. Schema 5 is schema 4 with u16 width and height (canvases wider or taller than 256).
 * Object/group structure is baked into raster cels.
 */
import {
  MAX_COLORS, MAX_SIZE, MAX_LAYERS, MAX_TOTAL_PIXELS,
  getAnimationLayers, getLayerPixels, validateProject,
} from '../domain/project.js';

export const PIXEL_FILE_HEADER_BYTES = 20;
// 4,194,304 pixel bytes plus bounded frame IDs, names, and other metadata
// fit comfortably in 8 MiB under the same limits as core validation.
export const MAX_PIXEL_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_PIXEL_FILE_BYTES = PIXEL_FILE_HEADER_BYTES + MAX_PIXEL_PAYLOAD_BYTES + 65536;
const MAX_ANIMATIONS = 100;
const MAX_FRAMES_PER_ANIMATION = 256;
const MAX_TOTAL_FRAMES = 1024;
const MAGIC = [0x50, 0x58, 0x53, 0x54];
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class PixelFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PixelFileError';
  }
}

function invalid(message) {
  throw new PixelFileError(message);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

class Writer {
  constructor() {
    this.bytes = new Uint8Array(4096);
    this.view = new DataView(this.bytes.buffer);
    this.offset = 0;
  }

  reserve(length) {
    const needed = this.offset + length;
    if (needed > MAX_PIXEL_PAYLOAD_BYTES) invalid('The pixel project exceeds the binary file size limit.');
    if (needed <= this.bytes.length) return;
    const next = new Uint8Array(Math.min(MAX_PIXEL_PAYLOAD_BYTES, Math.max(needed, this.bytes.length * 2)));
    next.set(this.bytes.subarray(0, this.offset));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  u8(value) { this.reserve(1); this.view.setUint8(this.offset, value); this.offset += 1; }
  u16(value) { this.reserve(2); this.view.setUint16(this.offset, value, true); this.offset += 2; }
  f64(value) { this.reserve(8); this.view.setFloat64(this.offset, value, true); this.offset += 8; }

  string(value, maximumCharacters, label) {
    const bytes = encoder.encode(value);
    // TextEncoder replaces lone UTF-16 surrogates; reject those instead of
    // silently changing a name during an otherwise lossless round trip.
    if (decoder.decode(bytes) !== value) invalid(`${label} must contain valid Unicode text.`);
    if (value.length > maximumCharacters || bytes.length > maximumCharacters * 4) {
      invalid(`${label} is too long for a pixel file.`);
    }
    this.u16(bytes.length);
    this.reserve(bytes.length);
    this.bytes.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  pixels(values) {
    this.reserve(values.length);
    for (const value of values) this.bytes[this.offset++] = value + 1;
  }

  finish() { return this.bytes.slice(0, this.offset); }
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  need(length) {
    if (this.offset + length > this.bytes.length) invalid('The pixel file is truncated inside its project data.');
  }

  u8() { this.need(1); const value = this.view.getUint8(this.offset); this.offset += 1; return value; }
  u16() { this.need(2); const value = this.view.getUint16(this.offset, true); this.offset += 2; return value; }
  f64() { this.need(8); const value = this.view.getFloat64(this.offset, true); this.offset += 8; return value; }

  string(maximumCharacters, label) {
    const length = this.u16();
    if (length < 1 || length > maximumCharacters * 4) invalid(`${label} has an invalid UTF-8 length.`);
    this.need(length);
    let value;
    try {
      value = decoder.decode(this.bytes.subarray(this.offset, this.offset + length));
    } catch {
      invalid(`${label} contains invalid UTF-8 text.`);
    }
    this.offset += length;
    if (!value.trim() || value !== value.trim() || value.length > maximumCharacters) {
      invalid(`${label} must contain 1–${maximumCharacters} characters without surrounding whitespace.`);
    }
    return value;
  }

  pixels(length, paletteLength) {
    this.need(length);
    const values = Array(length);
    for (let index = 0; index < length; index += 1) {
      const value = this.bytes[this.offset++];
      if (value > paletteLength) invalid('The pixel file contains a color index outside its palette.');
      values[index] = value - 1;
    }
    return values;
  }

  finish() {
    if (this.offset !== this.bytes.length) invalid('The pixel file has extra bytes after its project data.');
  }
}

function encodePayload(project) {
  const writer = new Writer();
  const big = project.width > 256 || project.height > 256;
  const schema = big ? 5 : project.animations.some(a=>a.frames.some(f=>f.layerOrder)) ? 4 : project.animations.some(animation => animation.layerOrder) ? 3 : 2;
  writer.u8(schema);
  if (big) { writer.u16(project.width); writer.u16(project.height); }
  else { writer.u8(project.width & 255); writer.u8(project.height & 255); }
  writer.u8(project.palette.length);
  writer.u8(project.layers.length);
  writer.u8(project.animations.length);
  writer.string(project.name, 120, 'Project name');
  for (const color of project.palette) {
    writer.u8(Number.parseInt(color.slice(1, 3), 16));
    writer.u8(Number.parseInt(color.slice(3, 5), 16));
    writer.u8(Number.parseInt(color.slice(5, 7), 16));
  }
  for (const layer of project.layers) {
    writer.string(layer.id, 100, 'Layer ID');
    writer.string(layer.name, 80, 'Layer name');
    writer.u8((layer.visible ? 1 : 0) | (layer.locked ? 2 : 0));
  }
  for (const animation of project.animations) {
    writer.string(animation.id, 100, 'Animation ID');
    writer.string(animation.name, 80, 'Animation name');
    writer.f64(animation.fps);
    writer.u16(animation.frames.length);
    if (schema >= 3) {
      const order = animation.layerOrder || project.layers.map(layer => layer.id);
      for (const id of order) writer.u8(project.layers.findIndex(layer => layer.id === id));
    }
    for (const frame of animation.frames) {
      writer.string(frame.id, 100, 'Frame ID');
      writer.u16(frame.duration);
      if(schema>=4)for(const layer of getAnimationLayers(project,animation,frame))writer.u8(project.layers.indexOf(layer));
      for (const layer of project.layers) writer.pixels(getLayerPixels(frame, layer.id));
    }
  }
  return writer.finish();
}

function decodePayload(bytes) {
  const reader = new Reader(bytes);
  const schema = reader.u8();
  if (![2, 3, 4, 5].includes(schema)) invalid('This pixel file uses an unsupported payload schema. Expected version 2, 3, 4 or 5.');
  const width = schema === 5 ? reader.u16() : reader.u8() || 256;
  const height = schema === 5 ? reader.u16() : reader.u8() || 256;
  if (width < 1 || height < 1 || width > MAX_SIZE || height > MAX_SIZE) {
    invalid(`Pixel file dimensions must be from 1 to ${MAX_SIZE} pixels.`);
  }
  const paletteCount = reader.u8();
  const layerCount = reader.u8();
  const animationCount = reader.u8();
  if (paletteCount < 1 || paletteCount > MAX_COLORS) invalid(`A pixel file needs 1–${MAX_COLORS} palette colors.`);
  if (layerCount < 1 || layerCount > MAX_LAYERS) invalid(`A pixel file needs 1–${MAX_LAYERS} layers.`);
  if (animationCount < 1 || animationCount > MAX_ANIMATIONS) invalid(`A pixel file needs 1–${MAX_ANIMATIONS} animations.`);
  const name = reader.string(120, 'Project name');
  const palette = Array.from({ length: paletteCount }, () => {
    const channels = [reader.u8(), reader.u8(), reader.u8()];
    return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  });
  const ids = new Set();
  const readId = (label) => {
    const id = reader.string(100, label);
    if (!/^[a-z0-9_-]{1,100}$/i.test(id)) invalid(`${label} contains unsupported characters.`);
    if (ids.has(id)) invalid('The pixel file contains duplicate layer, animation, or frame IDs.');
    ids.add(id);
    return id;
  };
  const layers = Array.from({ length: layerCount }, () => {
    const id = readId('Layer ID');
    const layerName = reader.string(80, 'Layer name');
    const flags = reader.u8();
    if (flags & ~3) invalid('The pixel file contains unsupported layer flags.');
    return { id, name: layerName, visible: Boolean(flags & 1), locked: Boolean(flags & 2) };
  });
  const count = width * height;
  let totalFrames = 0;
  const animations = Array.from({ length: animationCount }, () => {
    const id = readId('Animation ID');
    const animationName = reader.string(80, 'Animation name');
    const fps = reader.f64();
    if (!Number.isFinite(fps) || fps < 1 || fps > 60) invalid('Animation playback speed must be from 1 to 60 FPS.');
    const frameCount = reader.u16();
    if (frameCount < 1 || frameCount > MAX_FRAMES_PER_ANIMATION) {
      invalid(`An animation must contain 1–${MAX_FRAMES_PER_ANIMATION} frames.`);
    }
    totalFrames += frameCount;
    if (totalFrames > MAX_TOTAL_FRAMES) invalid(`A pixel file can contain at most ${MAX_TOTAL_FRAMES.toLocaleString('en-US')} frames.`);
    if (totalFrames * count * layerCount > MAX_TOTAL_PIXELS) {
      invalid(`A pixel file can contain at most ${MAX_TOTAL_PIXELS.toLocaleString('en-US')} stored pixels across all frames and layers.`);
    }
    let layerOrder;
    if (schema >= 3) {
      const indices = Array.from({ length: layerCount }, () => reader.u8());
      if (new Set(indices).size !== layerCount || indices.some(index => index >= layerCount)) invalid('Animation layer order must contain every layer index exactly once.');
      layerOrder = indices.map(index => layers[index].id);
    }
    const frames = Array.from({ length: frameCount }, () => {
      const frameId = readId('Frame ID');
      const duration = reader.u16();
      if (duration < 1 || duration > 60000) invalid('A frame duration must be from 1 to 60,000 milliseconds.');
      let frameOrder;
      if(schema>=4) {
        const indices=Array.from({length:layerCount},()=>reader.u8());
        if(new Set(indices).size!==layerCount || indices.some(index=>index>=layerCount))invalid('Frame layer order must contain every layer index exactly once.');
        frameOrder=indices.map(index=>layers[index].id);
      }
      const cels = layers.map((layer) => ({ layerId: layer.id, pixels: reader.pixels(count, paletteCount) }));
      return { id: frameId, duration, cels, ...(frameOrder?{layerOrder:frameOrder}:{}) };
    });
    return { id, name: animationName, fps, ...(layerOrder ? { layerOrder } : {}), frames };
  });
  reader.finish();
  return validateProject({ format: 'pixel-studio', version: 2, name, width, height, palette, layers, animations });
}

/** Never collect more than the declared output size from a gzip stream. */
async function readBoundedStream(stream, maximum, expectedLength) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) invalid('The pixel codec produced invalid byte data.');
      length += result.value.byteLength;
      if (length > maximum) invalid('The decompressed pixel data exceeds its declared size or the file limit.');
      chunks.push(result.value);
    }
    if (expectedLength !== undefined && length !== expectedLength) {
      invalid('The decompressed pixel data length does not match the file header.');
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* The stream may already be errored. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Serialize all project layers losslessly; use gzip only when it is smaller. */
export async function encodePixelProject(project) {
  const clean = validateProject(project);
  const payload = encodePayload(clean);
  let body = payload;
  let codec = 0;
  if (typeof globalThis.CompressionStream === 'function') {
    try {
      const stream = new Blob([payload]).stream().pipeThrough(new globalThis.CompressionStream('gzip'));
      const compressed = await readBoundedStream(stream, payload.length);
      if (compressed.length < payload.length) { body = compressed; codec = 1; }
    } catch {
      // Compression is optional. A supported raw container is always available.
    }
  }
  const output = new Uint8Array(PIXEL_FILE_HEADER_BYTES + body.length);
  output.set(MAGIC);
  const header = new DataView(output.buffer);
  header.setUint8(4, 1);
  header.setUint8(5, codec);
  header.setUint32(8, payload.length, true);
  header.setUint32(12, body.length, true);
  header.setUint32(16, crc32(payload), true);
  output.set(body, PIXEL_FILE_HEADER_BYTES);
  return output;
}

function byteView(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  invalid('A pixel file must be supplied as an ArrayBuffer or byte array.');
}

/** Parse a bounded binary container, verify its integrity, and return a v2 project. */
export async function decodePixelProject(input) {
  const source = byteView(input);
  if (source.byteLength > MAX_PIXEL_FILE_BYTES) invalid('The pixel file exceeds the maximum supported file size.');
  if (source.byteLength < PIXEL_FILE_HEADER_BYTES) invalid('The pixel file header is truncated.');
  // Snapshot caller-owned memory before asynchronous decompression.
  const bytes = new Uint8Array(source);
  if (!MAGIC.every((value, index) => bytes[index] === value)) invalid('This is not a Pixel Studio binary file (PXST).');
  const header = new DataView(bytes.buffer);
  if (header.getUint8(4) !== 1) invalid('This pixel file uses an unsupported container version. Expected version 1.');
  const codec = header.getUint8(5);
  if (codec !== 0 && codec !== 1) invalid('This pixel file uses an unsupported compression codec.');
  if (header.getUint16(6, true) !== 0) invalid('This pixel file contains unsupported header flags.');
  const payloadLength = header.getUint32(8, true);
  const bodyLength = header.getUint32(12, true);
  if (payloadLength < 1 || payloadLength > MAX_PIXEL_PAYLOAD_BYTES) invalid('The declared pixel data length exceeds the supported payload limit.');
  if (bodyLength < 1 || bodyLength > MAX_PIXEL_FILE_BYTES - PIXEL_FILE_HEADER_BYTES) invalid('The stored pixel data length exceeds the supported file limit.');
  if (bytes.length !== PIXEL_FILE_HEADER_BYTES + bodyLength) {
    invalid('The pixel file is truncated or has extra bytes after its declared body.');
  }
  const body = bytes.subarray(PIXEL_FILE_HEADER_BYTES);
  let payload;
  if (codec === 0) {
    if (bodyLength !== payloadLength) invalid('The raw pixel data length does not match the file header.');
    payload = body;
  } else {
    if (body.length < 18 || body[0] !== 0x1f || body[1] !== 0x8b || body[2] !== 8) {
      invalid('The compressed pixel data is not a valid gzip stream.');
    }
    const trailer = new DataView(body.buffer, body.byteOffset + body.length - 8, 8);
    if (trailer.getUint32(0, true) !== header.getUint32(16, true) || trailer.getUint32(4, true) !== payloadLength) {
      invalid('The gzip trailer does not match the declared length or checksum.');
    }
    if (typeof globalThis.DecompressionStream !== 'function') {
      invalid('This browser cannot open gzip-compressed pixel files. Open the file in a browser with DecompressionStream support.');
    }
    try {
      const stream = new Blob([body]).stream().pipeThrough(new globalThis.DecompressionStream('gzip'));
      payload = await readBoundedStream(stream, payloadLength, payloadLength);
    } catch (error) {
      if (error instanceof PixelFileError) throw error;
      invalid('The compressed pixel data is damaged or is not a valid gzip stream.');
    }
  }
  if (crc32(payload) !== header.getUint32(16, true)) invalid('The pixel data checksum does not match. The file may be damaged.');
  return decodePayload(payload);
}
