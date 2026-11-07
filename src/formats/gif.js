/** GIF89a encoder with LZW compression for indexed, full-canvas animation frames. */

/** LZW-compress palette indices into a GIF code stream (before 255-byte sub-blocking). */
export function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize, end = clear + 1, out = [];
  let size = minCodeSize + 1, next = end + 1, table = new Map(), bits = 0, count = 0;
  const emit = (code) => {
    bits |= code << count; count += size;
    while (count >= 8) { out.push(bits & 255); bits >>>= 8; count -= 8; }
  };
  emit(clear);
  if (!indices.length) { emit(end); if (count) out.push(bits & 255); return Uint8Array.from(out); }
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const value = indices[i], key = (prefix << 8) | value, found = table.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next === 4096) {
      emit(clear); table = new Map(); next = end + 1; size = minCodeSize + 1;
    } else {
      if (next >= 1 << size) size += 1;
      table.set(key, next++);
    }
    prefix = value;
  }
  emit(prefix); emit(end);
  if (count) out.push(bits & 255);
  return Uint8Array.from(out);
}

/** Inverse of lzwEncode (for tests and verification). */
export function lzwDecode(bytes, minCodeSize, expected = Infinity) {
  const clear = 1 << minCodeSize, end = clear + 1, out = [];
  let size, next, dict, previous = null, bits = 0, count = 0, offset = 0;
  const reset = () => { size = minCodeSize + 1; next = end + 1; dict = Array.from({ length: clear }, (_, i) => [i]); previous = null; };
  reset();
  while (out.length < expected) {
    while (count < size && offset < bytes.length) { bits |= bytes[offset++] << count; count += 8; }
    if (count < size) break;
    const code = bits & ((1 << size) - 1); bits >>>= size; count -= size;
    if (code === clear) { reset(); continue; }
    if (code === end) break;
    let entry = dict[code];
    if (!entry && previous && code === next) entry = [...previous, previous[0]];
    if (!entry) throw new Error('Invalid LZW code.');
    out.push(...entry);
    if (previous && next < 4096) { dict[next++] = [...previous, entry[0]]; if (next >= 1 << size && size < 12) size += 1; }
    previous = entry;
  }
  return out;
}

const subBlocks = (data) => {
  const out = [];
  for (let i = 0; i < data.length; i += 255) { const part = data.subarray(i, i + 255); out.push(part.length, ...part); }
  out.push(0);
  return out;
};

/**
 * Encode a looping GIF. palette: [[r,g,b]] (≤256); frames: [{indices, delay}] with delay in ms
 * (stored as centiseconds, minimum 2). transparentIndex marks the clear colour; loops=0 repeats forever.
 */
export function encodeGif({ width, height, palette, frames, transparentIndex = -1, loops = 0 }) {
  if (!palette.length || palette.length > 256) throw new Error('A GIF palette needs 1–256 colours.');
  if (!frames.length) throw new Error('A GIF needs at least one frame.');
  if (width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error('GIF images must be 1–65,535 pixels wide and tall.');
  const bitsPerColour = Math.max(1, Math.ceil(Math.log2(palette.length)));
  const tableSize = 1 << bitsPerColour, minCodeSize = Math.max(2, bitsPerColour);
  const out = [...'GIF89a'].map((c) => c.charCodeAt(0));
  const u16 = (value) => out.push(value & 255, (value >> 8) & 255);
  u16(width); u16(height);
  out.push(0x80 | ((bitsPerColour - 1) << 4) | (bitsPerColour - 1), Math.max(0, transparentIndex), 0);
  for (let i = 0; i < tableSize; i += 1) out.push(...(palette[i] || [0, 0, 0]));
  out.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1);
  u16(loops); out.push(0);
  let elapsed = 0;
  for (const frame of frames) {
    if (frame.indices.length !== width * height) throw new Error('GIF frame data does not match its size.');
    const transparent = transparentIndex >= 0;
    out.push(0x21, 0xf9, 4, (transparent ? 2 << 2 : 1 << 2) | (transparent ? 1 : 0));
    // Carry centisecond rounding forward so the loop keeps its total length.
    const delay = Math.round((elapsed + frame.delay) / 10) - Math.round(elapsed / 10);
    elapsed += frame.delay;
    u16(Math.max(2, Math.min(65535, delay)));
    out.push(transparent ? transparentIndex : 0, 0);
    out.push(0x2c); u16(0); u16(0); u16(width); u16(height); out.push(0);
    out.push(minCodeSize, ...subBlocks(lzwEncode(frame.indices, minCodeSize)));
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

/** Map RGBA frames to one shared palette; fully transparent pixels share a reserved index. */
export function indexRgbaFrames(rgbaFrames) {
  const colours = new Map(), palette = [];
  let transparentIndex = -1;
  const frames = rgbaFrames.map((rgba) => {
    const indices = new Uint8Array(rgba.length / 4);
    for (let p = 0; p < indices.length; p += 1) {
      const o = p * 4;
      if (rgba[o + 3] < 128) {
        if (transparentIndex < 0) { transparentIndex = palette.length; palette.push([0, 0, 0]); }
        indices[p] = transparentIndex; continue;
      }
      const key = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
      let index = colours.get(key);
      if (index === undefined) {
        if (palette.length >= 256) throw new Error('This animation uses more than 256 colours, which a GIF cannot store.');
        index = palette.length; colours.set(key, index); palette.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
      }
      indices[p] = index;
    }
    return indices;
  });
  return { palette, frames, transparentIndex };
}
