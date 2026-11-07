import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateProject, blankProject } from '../src/domain/project.js';
import { decodeAIProject, encodeAIProject } from '../src/formats/pxa.js';
import { decodePixelProject, encodePixelProject } from '../src/formats/pxs.js';
import { createSheetMetadata, validateSheetMetadata } from '../src/formats/spritesheet.js';
import { createAIRequest, prepareAIResult } from '../src/features/ai/requests.js';
import { fixture, options, artwork } from './fixtures/project.mjs';

for (const name of ['panda', 'red-panda', 'campfire', 'key']) {
  test(`original ${name} sample survives PXA, PXS, and JSON migration`, async () => {
    const source = validateProject(JSON.parse(await readFile(new URL(`../public/samples/${name}.pixel.json`, import.meta.url), 'utf8')));
    const pxa = decodeAIProject(await readFile(new URL(`../public/samples/${name}.pxa`, import.meta.url), 'utf8'));
    const pxs = await decodePixelProject(await readFile(new URL(`../public/samples/${name}.pxs`, import.meta.url)));
    assert.deepEqual(artwork(pxa), artwork(source));
    assert.deepEqual(artwork(pxs), artwork(source));
    assert.deepEqual(artwork(decodeAIProject(encodeAIProject(source))), artwork(source));
    assert.deepEqual(artwork(await decodePixelProject(await encodePixelProject(source))), artwork(source));
  });
}

test('format round trips retain hidden layers, transparent frames, duplicate colors, and fractional FPS', async () => {
  const source = fixture();
  source.layers[0].visible = false;
  source.palette.push(source.palette[0]);
  source.animations[0].frames[1].cels[1].pixels.fill(-1);
  assert.deepEqual(artwork(decodeAIProject(encodeAIProject(source))), artwork(source));
  const pxa2 = decodeAIProject(encodeAIProject(source, { version: 2 }));
  assert.deepEqual(artwork(pxa2), artwork(source));
  assert.deepEqual(decodeAIProject(encodeAIProject(pxa2)), pxa2);
  assert.deepEqual(artwork(await decodePixelProject(await encodePixelProject(source))), artwork(source));
  const bytes = await encodePixelProject(source);
  bytes[16] ^= 1;
  await assert.rejects(decodePixelProject(bytes), /checksum|trailer/);
});

test('256×256 canvases round trip through PXS and PXA 2; 257 is rejected', async () => {
  const source = blankProject('Big', 256, 256);
  const cel = source.animations[0].frames[0].cels[0].pixels;
  for (let i = 0; i < cel.length; i += 7) cel[i] = i % 3 === 0 ? 0 : -1;
  cel[cel.length - 1] = 0;
  const pxs = await decodePixelProject(await encodePixelProject(source));
  assert.equal(pxs.width, 256); assert.equal(pxs.height, 256);
  assert.deepEqual(artwork(pxs), artwork(source));
  assert.deepEqual(artwork(decodeAIProject(encodeAIProject(source, { version: 2 }))), artwork(source));
  assert.throws(() => validateProject({ ...source, width: 257, animations: [] }), /size|width|dimension/i);
  assert.throws(() => blankProject('Too big', 257, 1));
});

test('existing scoped AI edits preserve locks, timing, other frames, and IDs', () => {
  const request = createAIRequest(fixture(), { ...options, mode: 'edit' });
  const edited = structuredClone(request.targetProject);
  edited.animations[0].frames[0].cels[1].pixels[9] = 2;
  const result = prepareAIResult(request, `${encodeAIProject(edited)}\n${request.completionMarker}`);
  assert.equal(result.changes.pixels, 1);
  assert.deepEqual(result.project.animations[0].frames[1], request.sourceProject.animations[0].frames[1]);
  assert.deepEqual(result.project.animations[1], request.sourceProject.animations[1]);
  assert.equal(result.project.animations[0].frames[0].id, 'idle-0');
  edited.animations[0].frames[0].cels[0].pixels[9] = 1;
  assert.throws(() => prepareAIResult(request, `${encodeAIProject(edited)}\n${request.completionMarker}`), /locked/);
});

test('spritesheet metadata preserves animation order, timing, and dimensions', () => {
  const source = fixture();
  const metadata = createSheetMetadata(source, 2);
  assert.deepEqual(validateSheetMetadata(metadata, 32, 32), metadata);
});
