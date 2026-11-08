/** PNG and animated PNG (APNG) encoders for 8-bit RGBA pixels. */
import { crc32 } from './zip.js';

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const ascii = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i += 1) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

/** zlib-wrapped stored blocks: a fallback where CompressionStream is unavailable. */
function storedZlib(bytes) {
  const blocks = Math.max(1, Math.ceil(bytes.length / 65535));
  const out = new Uint8Array(2 + bytes.length + blocks * 5 + 4), view = new DataView(out.buffer);
  out[0] = 0x78; out[1] = 0x01;
  let offset = 2;
  for (let block = 0; block < blocks; block += 1) {
    const chunk = bytes.subarray(block * 65535, (block + 1) * 65535);
    out[offset] = block === blocks - 1 ? 1 : 0;
    view.setUint16(offset + 1, chunk.length, true); view.setUint16(offset + 3, ~chunk.length & 0xffff, true);
    out.set(chunk, offset + 5); offset += 5 + chunk.length;
  }
  view.setUint32(offset, adler32(bytes));
  return out;
}

/** zlib (RFC 1950) compression via CompressionStream('deflate'), with a stored fallback. */
export async function zlib(bytes) {
  if (typeof CompressionStream !== 'function') return storedZlib(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type, data) {
  const name = ascii(type), out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
  view.setUint32(0, data.length); out.set(name, 4); out.set(data, 8);
  view.setUint32(8 + data.length, crc32(name, data));
  return out;
}

function fields(...pairs) {
  const size = pairs.reduce((n, [bytes]) => n + bytes, 0), out = new Uint8Array(size), view = new DataView(out.buffer);
  let offset = 0;
  for (const [bytes, value] of pairs) {
    if (bytes === 4) view.setUint32(offset, value); else if (bytes === 2) view.setUint16(offset, value); else view.setUint8(offset, value);
    offset += bytes;
  }
  return out;
}

const header = (width, height) => chunk('IHDR', fields([4, width], [4, height], [1, 8], [1, 6], [1, 0], [1, 0], [1, 0]));

/** Filter type 0 per scanline, then zlib. */
async function imageData(rgba, width, height) {
  if (rgba.length !== width * height * 4) throw new Error('PNG pixel data does not match its size.');
  const stride = width * 4, raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return zlib(raw);
}

const join = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};

/** Encode one RGBA image as a PNG file. */
export async function encodePng(rgba, width, height) {
  return join([SIGNATURE, header(width, height), chunk('IDAT', await imageData(rgba, width, height)), chunk('IEND', new Uint8Array())]);
}

/** Encode full-canvas RGBA frames as an APNG; delays are in milliseconds and loops=0 repeats forever. */
export async function encodeApng(frames, width, height, delays, { loops = 0 } = {}) {
  if (!frames.length || frames.length !== delays.length) throw new Error('An APNG needs one delay per frame.');
  const parts = [SIGNATURE, header(width, height), chunk('acTL', fields([4, frames.length], [4, loops]))];
  let sequence = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const delay = Math.max(1, Math.min(65535, Math.round(delays[index])));
    parts.push(chunk('fcTL', fields([4, sequence++], [4, width], [4, height], [4, 0], [4, 0], [2, delay], [2, 1000], [1, 0], [1, 0])));
    const data = await imageData(frames[index], width, height);
    if (index === 0) parts.push(chunk('IDAT', data));
    else parts.push(chunk('fdAT', join([fields([4, sequence++]), data])));
  }
  parts.push(chunk('IEND', new Uint8Array()));
  return join(parts);
}

/** List PNG chunks as {type, data} after checking the signature and every CRC. */
export function readPngChunks(bytes) {
  if (!SIGNATURE.every((value, index) => bytes[index] === value)) throw new Error('Not a PNG file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8), data) !== view.getUint32(offset + 8 + length)) throw new Error(`Bad CRC in ${type}.`);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}
