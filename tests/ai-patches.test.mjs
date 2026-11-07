import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SIZE, MAX_COLORS } from '../src/domain/project.js';
import { AI_PIXEL_ALPHABET } from '../src/formats/pxa.js';
import { createAIRequest, prepareAIResult } from '../src/features/ai/requests.js';
import { projectFingerprint, previewInpaint, expandPixelRun } from '../src/features/ai/patch-engine.js';
import { fixture, options, selection } from './fixtures/project.mjs';

function response(request, commands) {
  const source = request.sourceProject;
  const header = request.mode === 'recolor'
    ? `PXAPALETTE 1\nBASE ${projectFingerprint(source)}`
    : `PXAINPAINT 1\nSIZE ${source.width} ${source.height}\nRECT ${Object.values(request.target.selection).join(' ')}\nBASE ${projectFingerprint(source)}`;
  return `${header}\n${commands}\n${request.completionMarker}`;
}

test('inpaint modifies only selected pixels on one unlocked cel, without mutating its source', () => {
  const source = fixture();
  const before = structuredClone(source);
  const request = createAIRequest(source, options);
  const result = prepareAIResult(request, response(request, 'TARGET 0 0 1\nSPAN 1 1 1{2}2\nSPAN 2 2 .'));
  assert.equal(result.changedPixels, 4);
  assert.equal(result.project.animations[0].frames[0].cels[1].pixels[9], 1);
  assert.equal(result.project.animations[0].frames[0].cels[1].pixels[18], -1);
  assert.deepEqual(source, before);
  assert.deepEqual(result.project.layers, source.layers);
  assert.deepEqual(result.project.animations[1], source.animations[1]);
  assert.deepEqual(result.project.animations[0].frames[1], source.animations[0].frames[1]);
  assert.deepEqual(result.project.animations[0].frames[0].cels[0], source.animations[0].frames[0].cels[0]);
  assert.equal(result.project.animations[0].fps, 7.5);
});

test('animation scope applies the same mask to multiple frames and preserves timing', () => {
  const request = createAIRequest(fixture(), { ...options, scope: 'animation' });
  const result = prepareAIResult(request, response(request, 'TARGET 0 0 1\nSPAN 1 1 1\nTARGET 0 1 1\nSPAN 1 1 2'));
  assert.equal(result.changes.frames, 2);
  assert.equal(result.changedPixels, 2);
  assert.deepEqual(result.project.animations[0].frames.map(frame => frame.duration), [125, 150]);
});

for (const [name, commands] of Object.entries({
  'outside mask': 'TARGET 0 0 1\nSPAN 1 0 1',
  'overflowing row': 'TARGET 0 0 1\nSPAN 1 3 11',
  'different frame': 'TARGET 0 1 1\nSPAN 1 1 1',
  'different animation': 'TARGET 1 0 1\nSPAN 1 1 1',
  'locked layer': 'TARGET 0 0 0\nSPAN 1 1 1',
  'missing palette color': 'TARGET 0 0 1\nSPAN 1 1 A',
  'no actual change': 'TARGET 0 0 1\nSPAN 2 2 0',
})) {
  test(`rejects ${name} without modifying the original`, () => {
    const request = createAIRequest(fixture(), options);
    const before = structuredClone(request.sourceProject);
    assert.throws(() => prepareAIResult(request, response(request, commands)));
    assert.deepEqual(request.sourceProject, before);
  });
}

test('binds patches to the request, rejecting truncation, another response, and stale projects', () => {
  const request = createAIRequest(fixture(), options);
  const text = response(request, 'TARGET 0 0 1\nSPAN 1 1 1');
  assert.throws(() => prepareAIResult(request, text.replace(request.completionMarker, '')), /incomplete/);
  assert.throws(() => prepareAIResult(createAIRequest(fixture(), options), text), /another edit/);
  const changed = structuredClone(request.sourceProject);
  changed.animations[0].fps = 7.6;
  assert.throws(() => previewInpaint(changed, text, request.target), /changed/);
  changed.animations[0].fps = 7.5;
  changed.name = 'Renamed';
  assert.throws(() => previewInpaint(changed, text, request.target), /changed/);
});

test('palette recolor preserves every pixel index and reports all changed swatches', () => {
  const request = createAIRequest(fixture(), { ...options, mode: 'recolor' });
  const result = prepareAIResult(request, response(request, 'SET 0 #fefefe\nSET 2 #112233'));
  assert.equal(request.scope, 'project');
  assert.deepEqual(result.project.animations, request.sourceProject.animations);
  assert.deepEqual(result.project.layers, request.sourceProject.layers);
  assert.deepEqual(result.project.palette, ['#fefefe', '#abcdef', '#112233']);
  assert.deepEqual(result.swatches.map(item => item.index), [0, 2]);
  assert.equal(result.changes.pixels, 0);
  assert.equal(result.changes.visiblePixels, 3);
  assert.match(result.warning, /every frame/);
  assert.throws(() => prepareAIResult(request, response(request, 'SET 3 #123456')), /does not exist/);
  assert.throws(() => prepareAIResult(request, response(request, 'SET 0 #123456')), /No actual/);
  assert.throws(() => prepareAIResult(request, response(request, 'SET 0 #123456\nSET 0 #ffffff')), /Duplicate/);
});

test('supports the original 64-color PXA alphabet and maximum canvas', () => {
  const source = fixture(MAX_SIZE, MAX_SIZE);
  source.palette = Array.from({ length: MAX_COLORS }, (_, index) => `#${index.toString(16).padStart(6, '0')}`);
  const request = createAIRequest(source, { ...options, selection: { x: MAX_SIZE - 4, y: MAX_SIZE - 4, width: 4, height: 4 } });
  const result = prepareAIResult(request, response(request, `TARGET 0 0 1\nSPAN ${MAX_SIZE - 1} ${MAX_SIZE - 4} a@$Z`));
  assert.equal(result.changedPixels, 4);
  assert.deepEqual(result.project.animations[0].frames[0].cels[1].pixels.slice(-4), [36, 62, 63, 35]);
  assert.match(request.prompt, new RegExp(AI_PIXEL_ALPHABET.replace(/[$]/g, '\\$')));
});

test('uses cel identities rather than positional assumptions', () => {
  const source = fixture();
  source.animations[0].frames[0].cels.reverse();
  const request = createAIRequest(source, options);
  const result = prepareAIResult(request, response(request, 'TARGET 0 0 1\nSPAN 1 1 1'));
  assert.equal(result.project.animations[0].frames[0].cels.find(cel => cel.layerId === 'artwork').pixels[9], 1);
  assert.ok(result.project.animations[0].frames[0].cels.find(cel => cel.layerId === 'background').pixels.every(pixel => pixel === -1));
});

test('validates selection, locked layer, and instruction before requesting generation', () => {
  const source = fixture();
  for (const override of [{ selection: null }, { scope: 'project' }, { layerId: 'background' }, { animationId: 'missing' }, { selection: { ...selection, width: 99 } }]) {
    assert.throws(() => createAIRequest(source, { ...options, ...override }));
  }
  assert.doesNotThrow(() => createAIRequest(source, { ...options, instruction: 'x'.repeat(6000) }));
  assert.throws(() => createAIRequest(source, { ...options, instruction: 'x'.repeat(6001) }));
});

test('run lengths are bounded and malformed commands are rejected', () => {
  assert.deepEqual(expandPixelRun('2{3}.0{2}'), [2, 2, 2, -1, 0, 0]);
  for (const value of ['A{9999}', '0{1}', '0{X}', '0{', '?', '']) assert.throws(() => expandPixelRun(value, 10));
});
