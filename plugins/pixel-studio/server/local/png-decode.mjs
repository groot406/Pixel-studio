/** Dependency-free PNG decoder for Node: every non-interlaced colour type at bit depths 1–16 → 8-bit RGBA. */
import { inflateSync } from 'node:zlib';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
export const MAX_DECODE_PIXELS = 64 * 1024 * 1024;

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode PNG bytes to { width, height, rgba: Uint8Array }. Throws a clear Error for unsupported or corrupt files. */
export function decodePng(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 8 || !SIGNATURE.every((v, i) => bytes[i] === v)) throw new Error('Not a PNG file (bad signature).');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header = null, palette = null, transparency = null;
  const idat = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('PNG file is truncated.');
    const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset + 12 + length > bytes.length) throw new Error(`PNG chunk ${type} is truncated.`);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (length !== 13) throw new Error('PNG header (IHDR) is invalid.');
      const d = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: d.getUint32(0), height: d.getUint32(4), depth: data[8], colorType: data[9], compression: data[10], filter: data[11], interlace: data[12] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!header) throw new Error('PNG file has no IHDR header.');
  const { width, height, depth, colorType, interlace } = header;
  if (!(colorType in CHANNELS) || !DEPTHS[colorType].includes(depth)) throw new Error(`Unsupported PNG colour type ${colorType} at bit depth ${depth}.`);
  if (header.compression !== 0 || header.filter !== 0) throw new Error('Unsupported PNG compression or filter method.');
  if (interlace) throw new Error('Interlaced (Adam7) PNGs are not supported. Re-save the image without interlacing.');
  if (!width || !height || width * height > MAX_DECODE_PIXELS) throw new Error(`PNG size ${width} × ${height} is empty or too large.`);
  if (colorType === 3 && !palette) throw new Error('Indexed PNG has no palette (PLTE).');
  if (!idat.length) throw new Error('PNG file has no image data (IDAT).');
  let raw;
  try { raw = inflateSync(Buffer.concat(idat.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))); }
  catch { throw new Error('PNG image data is corrupt (zlib inflate failed).'); }
  const channels = CHANNELS[colorType], bitsPerPixel = channels * depth, stride = Math.ceil(width * bitsPerPixel / 8), bpp = Math.max(1, bitsPerPixel >> 3);
  if (raw.length < (stride + 1) * height) throw new Error('PNG image data is shorter than its size.');
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x], a = x >= bpp ? pixels[row + x - bpp] : 0, b = y ? pixels[prev + x] : 0, c = y && x >= bpp ? pixels[prev + x - bpp] : 0;
      let out;
      if (filter === 0) out = value;
      else if (filter === 1) out = value + a;
      else if (filter === 2) out = value + b;
      else if (filter === 3) out = value + ((a + b) >> 1);
      else if (filter === 4) out = value + paeth(a, b, c);
      else throw new Error(`PNG row ${y} uses unknown filter type ${filter}.`);
      pixels[row + x] = out & 255;
    }
  }
  const max = (1 << depth) - 1;
  const sample = (row, index) => {
    if (depth === 8) return pixels[row + index];
    if (depth === 16) return pixels[row + index * 2];
    const bit = index * depth;
    return (pixels[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
  };
  const scale = depth < 8 ? 255 / max : 1;
  const rawSample = (row, index) => depth === 16 ? (pixels[row + index * 2] << 8) | pixels[row + index * 2 + 1] : sample(row, index);
  const key = transparency && (colorType === 0 || colorType === 2) ? Array.from({ length: colorType === 0 ? 1 : 3 }, (_, i) => (transparency[i * 2] << 8) | transparency[i * 2 + 1]) : null;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4, i = x * channels;
      if (colorType === 3) {
        const index = sample(row, x);
        if (index * 3 + 2 >= palette.length) throw new Error(`PNG pixel uses palette index ${index} outside the palette.`);
        rgba[o] = palette[index * 3]; rgba[o + 1] = palette[index * 3 + 1]; rgba[o + 2] = palette[index * 3 + 2];
        rgba[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const g = Math.round(sample(row, i) * scale);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = colorType === 4 ? sample(row, i + 1) : key && rawSample(row, i) === key[0] ? 0 : 255;
      } else {
        rgba[o] = sample(row, i); rgba[o + 1] = sample(row, i + 1); rgba[o + 2] = sample(row, i + 2);
        rgba[o + 3] = colorType === 6 ? sample(row, i + 3) : key && key.every((k, c) => rawSample(row, i + c) === k) ? 0 : 255;
      }
    }
  }
  return { width, height, rgba };
}
