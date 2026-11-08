import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePng } from '../local/png-decode.mjs';
import { encodePng } from '../src/formats/png.js';

const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); Buffer.from(data).copy(out, 8);
  return out; // CRC left zero: the decoder does not verify it
};
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

/** Build a PNG from unfiltered scanlines, filtering every row with `filters[y % n]`. */
function png({ width, height, colorType, depth = 8, rows, filters = [0], interlace = 0, extra = [] }) {
  const bpp = Math.max(1, ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] * depth) >> 3);
  const out = [];
  let prev = Buffer.alloc(rows[0].length);
  rows.forEach((row, y) => {
    const f = filters[y % filters.length], line = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i += 1) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f];
      line[i] = (row[i] - predictor) & 255;
    }
    out.push(Buffer.from([f]), line);
    prev = Buffer.from(row);
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = colorType; ihdr[12] = interlace;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(Buffer.concat(out))), chunk('IEND', Buffer.alloc(0))]);
}

test('decodes RGBA with every filter type', () => {
  const width = 5, height = 5, rows = [];
  for (let y = 0; y < height; y += 1) rows.push(Buffer.from(Array.from({ length: width * 4 }, (_, i) => (i * 37 + y * 91) & 255)));
  const { rgba } = decodePng(png({ width, height, colorType: 6, rows, filters: [0, 1, 2, 3, 4] }));
  assert.deepEqual(Buffer.from(rgba), Buffer.concat(rows));
});

test('decodes grey, grey+alpha and RGB with colour-key transparency', () => {
  const grey = decodePng(png({ width: 2, height: 1, colorType: 0, rows: [Buffer.from([0, 200])] }));
  assert.deepEqual([...grey.rgba], [0, 0, 0, 255, 200, 200, 200, 255]);
  const ga = decodePng(png({ width: 1, height: 1, colorType: 4, rows: [Buffer.from([90, 10])] }));
  assert.deepEqual([...ga.rgba], [90, 90, 90, 10]);
  const key = Buffer.from([0, 1, 0, 2, 0, 3]);
  const rgb = decodePng(png({ width: 2, height: 1, colorType: 2, rows: [Buffer.from([1, 2, 3, 9, 8, 7])], filters: [1], extra: [chunk('tRNS', key)] }));
  assert.deepEqual([...rgb.rgba], [1, 2, 3, 0, 9, 8, 7, 255]);
});

test('decodes indexed PNGs with palette alpha and sub-byte depths', () => {
  const plte = chunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255])), trns = chunk('tRNS', Buffer.from([0]));
  const two = decodePng(png({ width: 3, height: 1, colorType: 3, depth: 2, rows: [Buffer.from([0b00011000])], extra: [plte, trns] }));
  assert.deepEqual([...two.rgba], [255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255]);
  const one = decodePng(png({ width: 3, height: 1, colorType: 0, depth: 1, rows: [Buffer.from([0b10100000])] }));
  assert.deepEqual([...one.rgba].filter((_, i) => i % 4 === 0), [255, 0, 255]);
});

test('round-trips the editor PNG encoder', async () => {
  const rgba = new Uint8Array(Array.from({ length: 7 * 3 * 4 }, (_, i) => (i * 13) & 255));
  const decoded = decodePng(await encodePng(rgba, 7, 3));
  assert.equal(decoded.width, 7); assert.equal(decoded.height, 3);
  assert.deepEqual([...decoded.rgba], [...rgba]);
});

test('rejects interlaced, truncated and non-PNG input with clear errors', () => {
  assert.throws(() => decodePng(png({ width: 1, height: 1, colorType: 6, rows: [Buffer.alloc(4)], interlace: 1 })), /Interlaced/);
  assert.throws(() => decodePng(Buffer.from('GIF89a')), /Not a PNG/);
  const good = png({ width: 1, height: 1, colorType: 6, rows: [Buffer.alloc(4)] });
  assert.throws(() => decodePng(good.subarray(0, 40)), /truncated|no image data/);
  assert.throws(() => decodePng(png({ width: 1, height: 1, colorType: 3, rows: [Buffer.alloc(1)] })), /palette/);
});
