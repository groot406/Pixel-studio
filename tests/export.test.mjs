import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { crc32, createZip, readZip } from '../src/formats/zip.js';
import { encodePng, encodeApng, readPngChunks } from '../src/formats/png.js';
import { lzwEncode, lzwDecode, encodeGif, indexRgbaFrames } from '../src/formats/gif.js';
import { sheetLayout, rasterize, describeSheet, asepriteJson, godotSpriteFrames, texturePackerJson, genericJson, exportGroups } from '../src/formats/image-export.js';
import { buildExport, cleanSettings, planExport } from '../src/formats/export-bundle.js';
import { validateSheetMetadata } from '../src/formats/spritesheet.js';
import { fixture } from './fixtures/project.mjs';

const ctx = { animationId: 'idle', frameId: 'idle-1', layerId: 'artwork', name: 'Test sprite' };
const u32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset);

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new TextEncoder().encode('1234'), new TextEncoder().encode('56789')), 0xcbf43926);
});

test('store-only ZIP has valid headers, CRCs and round-trips its entries', () => {
  const zip = createZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.bin', data: Uint8Array.of(0, 1, 2, 255) }], new Date(2024, 4, 6, 12, 30, 10));
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(8, true), 0, 'stored');
  assert.equal(view.getUint32(14, true), crc32(new TextEncoder().encode('hello')));
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(zip.length - 12, true), 2);
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ['a.txt', 'dir/b.bin']);
  assert.equal(new TextDecoder().decode(entries[0].data), 'hello');
  assert.deepEqual([...entries[1].data], [0, 1, 2, 255]);
  for (const e of entries) assert.equal(e.crc, crc32(e.data));
  assert.throws(() => createZip([{ name: 'x', data: '' }, { name: 'x', data: '' }]), /unique/);
});

test('GIF LZW round-trips including table resets and code-size growth', () => {
  const samples = [
    [0], [1, 1, 1, 1, 1, 1, 1, 1], Array.from({ length: 300 }, (_, i) => i % 4),
    Array.from({ length: 20000 }, (_, i) => (i * 7919 + (i >> 3)) % 64),
    Array.from({ length: 70000 }, (_, i) => (i * i + 3 * i) % 256),
  ];
  for (const indices of samples) {
    const bits = Math.max(2, Math.ceil(Math.log2(Math.max(...indices) + 1)));
    assert.deepEqual(lzwDecode(lzwEncode(Uint8Array.from(indices), bits), bits, indices.length), indices);
  }
});

/** Walk a GIF's blocks and return frames with delays, disposal and decoded indices. */
function parseGif(bytes) {
  assert.equal(String.fromCharCode(...bytes.subarray(0, 6)), 'GIF89a');
  const width = bytes[6] | (bytes[7] << 8), height = bytes[8] | (bytes[9] << 8), packed = bytes[10];
  let offset = 13 + (packed & 0x80 ? 3 * (2 << (packed & 7)) : 0), control = null, netscape = false;
  const frames = [];
  const blocks = () => { const out = []; while (bytes[offset]) { out.push(...bytes.subarray(offset + 1, offset + 1 + bytes[offset])); offset += bytes[offset] + 1; } offset += 1; return Uint8Array.from(out); };
  while (bytes[offset] !== 0x3b) {
    if (bytes[offset] === 0x21 && bytes[offset + 1] === 0xff) { offset += 2; netscape ||= String.fromCharCode(...blocks().subarray(0, 11)) === 'NETSCAPE2.0'; }
    else if (bytes[offset] === 0x21 && bytes[offset + 1] === 0xf9) {
      control = { disposal: (bytes[offset + 3] >> 2) & 7, transparent: bytes[offset + 3] & 1, delay: bytes[offset + 4] | (bytes[offset + 5] << 8), index: bytes[offset + 6] };
      offset += 8;
    } else if (bytes[offset] === 0x2c) {
      const w = bytes[offset + 5] | (bytes[offset + 6] << 8), h = bytes[offset + 7] | (bytes[offset + 8] << 8), min = bytes[offset + 10];
      offset += 11;
      frames.push({ ...control, indices: lzwDecode(blocks(), min, w * h) });
    } else throw new Error(`Unexpected GIF block ${bytes[offset]}`);
  }
  return { width, height, frames, netscape };
}

test('GIF89a encoder writes header, loop extension, delays, transparency and decodable frames', () => {
  const frames = [{ indices: Uint8Array.of(0, 1, 2, 1), delay: 125 }, { indices: Uint8Array.of(2, 2, 0, 1), delay: 5 }];
  const gif = encodeGif({ width: 2, height: 2, palette: [[0, 0, 0], [255, 0, 0], [0, 0, 255]], transparentIndex: 0, frames });
  const parsed = parseGif(gif);
  assert.equal(parsed.width, 2); assert.equal(parsed.netscape, true);
  assert.equal(parsed.frames.length, 2);
  assert.deepEqual(parsed.frames.map((f) => f.delay), [13, 2]);
  assert.deepEqual(parsed.frames.map((f) => [f.disposal, f.transparent, f.index]), [[2, 1, 0], [2, 1, 0]]);
  assert.deepEqual(parsed.frames[1].indices, [2, 2, 0, 1]);
  assert.equal(gif.at(-1), 0x3b);
});

test('RGBA frames share one GIF palette with a reserved transparent index', () => {
  const { palette, frames, transparentIndex } = indexRgbaFrames([Uint8Array.of(0, 0, 0, 0, 9, 8, 7, 255), Uint8Array.of(9, 8, 7, 255, 1, 2, 3, 255)]);
  assert.equal(transparentIndex, 0);
  assert.deepEqual(palette, [[0, 0, 0], [9, 8, 7], [1, 2, 3]]);
  assert.deepEqual(frames.map((f) => [...f]), [[0, 1], [1, 2]]);
});

test('PNG and APNG chunks carry valid CRCs, frame control and sequence numbers', async () => {
  const frame = (v) => Uint8Array.from({ length: 2 * 3 * 4 }, (_, i) => (i * v) & 255);
  const png = readPngChunks(await encodePng(frame(3), 2, 3));
  assert.deepEqual(png.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  assert.deepEqual([...inflateSync(png[1].data)].slice(0, 9), [0, ...frame(3).subarray(0, 8)]);
  const chunks = readPngChunks(await encodeApng([frame(1), frame(2), frame(5)], 2, 3, [100, 250, 40], { loops: 0 }));
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND']);
  assert.equal(u32(chunks[1].data, 0), 3); assert.equal(u32(chunks[1].data, 4), 0);
  const sequence = chunks.filter((c) => c.type === 'fcTL' || c.type === 'fdAT').map((c) => u32(c.data, 0));
  assert.deepEqual(sequence, [0, 1, 2, 3, 4]);
  const delays = chunks.filter((c) => c.type === 'fcTL').map((c) => [c.data[20] << 8 | c.data[21], c.data[22] << 8 | c.data[23]]);
  assert.deepEqual(delays, [[100, 1000], [250, 1000], [40, 1000]]);
  const last = chunks[7].data;
  assert.deepEqual([...inflateSync(last.subarray(4))].slice(1, 9), [...frame(5).subarray(0, 8)]);
});

test('sheet layouts compute sizes and cell positions', () => {
  assert.deepEqual(sheetLayout([3, 1], 8, 8, { layout: 'horizontal' }), { width: 32, height: 8, columns: 4, rows: 1, rects: [0, 8, 16, 24].map((x, i) => ({ x, y: 0, w: 8, h: 8, group: i < 3 ? 0 : 1, index: i < 3 ? i : 0 })) });
  const vertical = sheetLayout([2], 4, 6, { layout: 'vertical', spacing: 2, margin: 1 });
  assert.deepEqual([vertical.width, vertical.height, vertical.rects[1].y], [6, 16, 9]);
  const grid = sheetLayout([5], 10, 10, { layout: 'grid' });
  assert.deepEqual([grid.columns, grid.rows, grid.width, grid.height, grid.rects[4].x, grid.rects[4].y], [3, 2, 30, 20, 10, 10]);
  assert.equal(sheetLayout([5], 10, 10, { layout: 'grid', columns: 2 }).rows, 3);
  const rows = sheetLayout([3, 1], 8, 8, { layout: 'rows', spacing: 1 });
  assert.deepEqual([rows.width, rows.height, rows.rects[3].x, rows.rects[3].y], [26, 17, 0, 9]);
});

test('rasterize scales crisply with padding and background', () => {
  const project = { width: 2, height: 1, palette: ['#ff0000', '#00ff00'] };
  const { rgba, width, height } = rasterize(project, [0, -1], { scale: 2, padding: 1, background: '#0000ff' });
  assert.deepEqual([width, height], [6, 4]);
  const px = (x, y) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
  assert.deepEqual(px(0, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(1, 1), [255, 0, 0, 255]); assert.deepEqual(px(2, 2), [255, 0, 0, 255]);
  assert.deepEqual(px(3, 1), [0, 0, 255, 255]);
  assert.deepEqual(px(3, 1), px(5, 3));
});

function sheetFor(project) {
  const groups = exportGroups(project, { scope: 'project' });
  const layout = sheetLayout(groups.map((g) => g.frames.length), 16, 16, { layout: 'rows' });
  return describeSheet(groups, layout, { image: 'test-sheet.png', scale: 2, title: 'test' });
}

test('Aseprite JSON hash and array follow the Aseprite export schema', () => {
  const sheet = sheetFor(fixture());
  const hash = asepriteJson(sheet);
  assert.deepEqual(Object.keys(hash.frames), ['test 0.aseprite', 'test 1.aseprite', 'test 2.aseprite']);
  assert.deepEqual(hash.frames['test 1.aseprite'], { frame: { x: 16, y: 0, w: 16, h: 16 }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: 16, h: 16 }, sourceSize: { w: 16, h: 16 }, duration: 150 });
  assert.deepEqual(hash.meta.frameTags, [{ name: 'Idle', from: 0, to: 1, direction: 'forward', color: '#000000ff' }, { name: 'Walk', from: 2, to: 2, direction: 'forward', color: '#000000ff' }]);
  assert.deepEqual([hash.meta.image, hash.meta.format, hash.meta.size, hash.meta.scale], ['test-sheet.png', 'RGBA8888', { w: 32, h: 32 }, '2']);
  const array = asepriteJson(sheet, { array: true });
  assert.equal(array.frames[2].filename, 'test 2.aseprite');
  assert.deepEqual(array.frames[2].frame, { x: 0, y: 16, w: 16, h: 16 });
});

test('Godot SpriteFrames .tres lists atlas regions and relative durations', () => {
  const tres = godotSpriteFrames(sheetFor(fixture()));
  assert.match(tres, /^\[gd_resource type="SpriteFrames" load_steps=5 format=3\]/);
  assert.match(tres, /\[ext_resource type="Texture2D" path="res:\/\/test-sheet\.png" id="1_sheet"\]/);
  assert.match(tres, /\[sub_resource type="AtlasTexture" id="AtlasTexture_2"\]\natlas = ExtResource\("1_sheet"\)\nregion = Rect2\(0, 16, 16, 16\)/);
  assert.match(tres, /"duration": 0\.9375,\n"texture": SubResource\("AtlasTexture_0"\)/);
  assert.match(tres, /"loop": true,\n"name": &"Idle",\n"speed": 7\.5/);
  assert.match(tres, /"name": &"Walk",\n"speed": 8\.0/);
});

test('Unity (TexturePacker hash) and generic JSON describe every frame', () => {
  const sheet = sheetFor(fixture());
  const tp = texturePackerJson(sheet);
  assert.deepEqual(Object.keys(tp.frames), ['Idle_0', 'Idle_1', 'Walk_0']);
  assert.deepEqual(tp.animations, { Idle: ['Idle_0', 'Idle_1'], Walk: ['Walk_0'] });
  assert.deepEqual(tp.frames.Walk_0.pivot, { x: 0.5, y: 0.5 });
  const generic = genericJson(sheet);
  assert.deepEqual(generic.animations[0], { name: 'Idle', fps: 7.5, loop: true, from: 0, to: 1, durations: [125, 150] });
  assert.equal(generic.frames.length, 3);
});

test('buildExport bundles sheets, sequences, GIF and APNG with readable files', async () => {
  const project = fixture();
  const sheet = await buildExport(project, { kind: 'sheet', scope: 'project', scale: 2, metadata: 'aseprite-hash' }, ctx);
  assert.equal(sheet.download.name, 'test-sprite-all-animations-sheet-2x.zip');
  const entries = readZip(sheet.download.data);
  assert.deepEqual(entries.map((e) => e.name), ['test-sprite-all-animations-sheet-2x.png', 'test-sprite-all-animations-sheet-2x.json']);
  assert.deepEqual(readPngChunks(entries[0].data)[0].data.subarray(0, 8), Uint8Array.of(0, 0, 0, 32, 0, 0, 0, 32));
  assert.equal(JSON.parse(new TextDecoder().decode(entries[1].data)).meta.image, entries[0].name);

  const reimport = await buildExport(project, { kind: 'sheet', scope: 'project', metadata: 'pixel-studio' }, ctx);
  const meta = JSON.parse(new TextDecoder().decode(readZip(reimport.download.data)[1].data));
  assert.equal(validateSheetMetadata(meta, 16, 16).animations.length, 2);
  await assert.rejects(buildExport(project, { kind: 'sheet', layout: 'grid', metadata: 'pixel-studio' }, ctx), /row per animation/);

  const sequence = await buildExport(project, { kind: 'sequence', scope: 'project' }, ctx);
  assert.deepEqual(readZip(sequence.download.data).map((e) => e.name), ['idle-001.png', 'idle-002.png', 'walk-001.png']);

  const gif = await buildExport(project, { kind: 'gif', scope: 'animation' }, ctx);
  assert.equal(gif.download.name, 'test-sprite-idle.gif');
  assert.deepEqual(parseGif(gif.download.data).frames.map((f) => f.delay), [13, 15]);

  const apng = await buildExport(project, { kind: 'apng', scope: 'project', layers: 'layer' }, ctx);
  assert.deepEqual(readZip(apng.download.data).map((e) => e.name), ['test-sprite-idle.png', 'test-sprite-walk.png']);

  const single = await buildExport(project, { kind: 'png', scale: 4, background: '#ffffff' }, ctx);
  assert.equal(single.download.name, 'test-sprite-idle-frame-2-4x.png');
  assert.equal(u32(readPngChunks(single.download.data)[0].data, 0), 32);
});

test('settings are clamped and oversized exports are refused', () => {
  assert.deepEqual([cleanSettings({ scale: 999, kind: 'bad', background: 'red' }).scale, cleanSettings({ kind: 'bad' }).kind, cleanSettings({ background: 'red' }).background], [64, 'png', null]);
  assert.throws(() => planExport(fixture(64, 64), { kind: 'sheet', scope: 'project', layout: 'horizontal', scale: 64 }, ctx), /too large/);
});
