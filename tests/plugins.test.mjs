import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { parsePluginSource, validateRegistrations, validateResult, resolveParams, compareVersions } from '../src/plugins/validate.js';
import { PluginHost } from '../src/plugins/protocol.js';
import { PluginRegistry, memoryStore } from '../src/plugins/runtime.js';
import { pixelFrames, applyPixelResults, applyAnimationResult } from '../src/plugins/apply.js';
import { buildCreationPrompt, validatePromptConfig } from '../src/features/ai/prompt-builder.js';
import { PLUGIN_API_DOC, pluginAuthorPrompt } from '../src/plugins/api-doc.js';
import { blankProject } from '../src/domain/project.js';

const plugin = name => readFileSync(new URL(`../public/plugins/${name}`, import.meta.url), 'utf8');
const header = (manifest, code = '') => `/* pixelstudio-plugin ${JSON.stringify(manifest)} */\n${code}`;
const base = { id: 'demo', name: 'Demo', version: '1.0.0', permissions: ['pixels'] };

/** worker_threads adapter with the same endpoint shape as the browser's Web Worker spawner. */
function spawn(source) {
  const worker = new Worker(source, { eval: true });
  return { post: (m, t) => worker.postMessage(m, t), terminate: () => worker.terminate(), onMessage: fn => worker.on('message', fn), onError: fn => worker.on('error', fn) };
}
const host = (code, options) => new PluginHost(code, spawn, { platform: 'node', ...options });

function scene(width = 8, height = 8, frames = 1) {
  const p = blankProject('t', width, height);
  p.animations[0].id = 'A'; p.layers[0].id = 'L';
  const pixels = Array(width * height).fill(-1);
  pixels[3 * width + 3] = 1; pixels[3 * width + 4] = 2;
  p.animations[0].frames = Array.from({ length: frames }, (_, k) => ({ id: `f${k}`, duration: 100, cels: [{ layerId: 'L', pixels: [...pixels] }] }));
  return p;
}

test('manifest header parsing and validation', () => {
  const { manifest } = parsePluginSource(header({ ...base, description: 'x', author: 'me' }, 'pixelStudio.log(1)'));
  assert.deepEqual(manifest, { id: 'demo', name: 'Demo', version: '1.0.0', description: 'x', author: 'me', permissions: ['pixels'] });
  assert.throws(() => parsePluginSource('pixelStudio.log(1)'), /no Pixel Studio plugin header/);
  assert.throws(() => parsePluginSource('/* pixelstudio-plugin {nope} */'), /not valid JSON/);
  assert.throws(() => parsePluginSource(header({ ...base, id: 'Bad Id!' })), /Manifest id/);
  assert.throws(() => parsePluginSource(header({ ...base, version: 'one' })), /version/);
  assert.throws(() => parsePluginSource(header({ ...base, permissions: ['network'] })), /Unknown permission/);
  assert.ok(compareVersions('1.2.0', '1.10.0') < 0 && compareVersions('2.0.0', '2.0.0-beta') > 0 && compareVersions('1.0.0', '1.0.0') === 0);
});

test('registrations need matching permissions and valid params', () => {
  const m = parsePluginSource(header(base)).manifest;
  const effect = { id: 'e', title: 'E', params: [{ id: 'n', type: 'number', min: 0, max: 4, default: 2 }, { id: 'c', type: 'color', default: 'darkest' }] };
  const out = validateRegistrations({ effects: [effect] }, m);
  assert.equal(out.effects[0].scope, 'frame');
  assert.throws(() => validateRegistrations({ commands: [{ id: 'a', title: 'A', scope: 'animation' }] }, m), /“animation” permission/);
  assert.throws(() => validateRegistrations({ promptSkills: [{ id: 's', title: 'S', instructions: 'x' }] }, m), /“prompt” permission/);
  assert.throws(() => validateRegistrations({ effects: [{ ...effect, params: [{ id: 'n', type: 'number', min: 0, max: 4, default: 9 }] }] }, m), /default/);
  assert.throws(() => validateRegistrations({ effects: [effect, effect] }, m), /unique/);
  assert.throws(() => validateRegistrations({}, m), /registered no/);
  assert.deepEqual(resolveParams(out.effects[0].params, { n: '99' }, { paletteLength: 4, darkest: 3 }), { n: 4, c: 3 });
});

test('results are validated: sizes, palette indices, palette growth, frames', () => {
  const ctx = { width: 2, height: 2, palette: ['#000000', '#ffffff'], frameCount: 2 };
  assert.deepEqual(validateResult('frame', { pixels: new Int16Array([0, 1, -1, 1]) }, ctx), { pixels: [0, 1, -1, 1] });
  assert.throws(() => validateResult('frame', { pixels: [0, 1, 1] }, ctx), /exactly 4/);
  assert.throws(() => validateResult('frame', { pixels: [0, 1, 2, 1] }, ctx), /palette index 0–1/);
  assert.throws(() => validateResult('frame', { pixels: [0, 0.5, 0, 0] }, ctx), /pixel 1/);
  assert.throws(() => validateResult('frame', null, ctx), /nothing usable/);
  assert.deepEqual(validateResult('selection', { pixels: [2, 2, 2, 2], palette: ['#000000', '#FFFFFF', '#ff0000'] }, ctx).palette, ['#000000', '#ffffff', '#ff0000']);
  assert.throws(() => validateResult('frame', { pixels: [0, 0, 0, 0], palette: ['#ffffff', '#000000'] }, ctx), /keep the current colours/);
  assert.throws(() => validateResult('frame', { pixels: [0, 0, 0, 0], palette: [...ctx.palette, ...Array(63).fill('#123456')] }, ctx), /1–64 colours/);
  assert.throws(() => validateResult('animation', { frames: [[0, 0, 0, 0]] }, ctx), /add frames, not remove/);
  assert.deepEqual(validateResult('animation', { frames: [[0, 0, 0, 0], { pixels: [1, 1, 1, 1], duration: 50 }] }, ctx).frames[1], { pixels: [1, 1, 1, 1], duration: 50 });
  assert.throws(() => validateResult('project', { project: 42 }, ctx), /PXA text/);
});

test('every gallery plugin parses, loads in a worker and registers valid actions', async () => {
  const index = JSON.parse(plugin('index.json')).plugins;
  const files = readdirSync(new URL('../public/plugins/', import.meta.url)).filter(f => f.endsWith('.js'));
  assert.deepEqual(index.map(p => p.file).sort(), files.sort());
  for (const { file } of index) {
    const { manifest, code } = parsePluginSource(plugin(file)), h = host(code);
    try { validateRegistrations(await h.start(), manifest); } finally { h.stop(); }
  }
});

test('drop shadow runs in a worker and its result applies as one edit', async () => {
  const registry = new PluginRegistry({ store: memoryStore(), spawn, platform: 'node' });
  const { manifest } = await registry.install(plugin('drop-shadow.js'), 'gallery');
  try {
    assert.equal(manifest.id, 'drop-shadow');
    const p = scene(), target = { animationId: 'A', frameId: 'f0', layerId: 'L' };
    const { frames } = pixelFrames(p, target);
    const raw = await registry.run('drop-shadow', 'drop-shadow', { width: 8, height: 8, palette: p.palette, pixels: Int16Array.from(frames[0].pixels), params: { dx: 1, dy: 1, color: 0 }, frameIndex: 0 });
    const { pixels } = validateResult('frame', raw, { width: 8, height: 8, palette: p.palette });
    assert.equal(pixels[4 * 8 + 5], 0);
    assert.equal(pixels[4 * 8 + 4], 0);
    assert.equal(pixels[3 * 8 + 4], 2, 'the art itself is untouched');
    const result = applyPixelResults(p, target, [{ frameId: 'f0', pixels }]);
    assert.deepEqual(result.frameIds, ['f0']);
    const masked = applyPixelResults(p, { ...target, selection: { rect: { x: 0, y: 0, width: 5, height: 8 } } }, [{ frameId: 'f0', pixels }]);
    assert.equal(masked.project.animations[0].frames[0].cels[0].pixels[4 * 8 + 5], -1, 'outside the selection stays unchanged');
  } finally { registry.stopAll(); }
});

test('palette cycle adds frames; game boy appends its palette', async () => {
  const registry = new PluginRegistry({ store: memoryStore(), spawn, platform: 'node' });
  await registry.install(plugin('palette-cycle.js'));
  await registry.install(plugin('gameboy.js'));
  try {
    const p = scene(8, 8, 1), cel = p.animations[0].frames[0].cels[0].pixels;
    const raw = await registry.run('palette-cycle', 'palette-cycle', { width: 8, height: 8, palette: p.palette, frames: [{ pixels: Int16Array.from(cel), duration: 100 }], frameIndex: 0, params: { frames: 4, direction: 'up', duration: 80 } });
    const { frames } = validateResult('animation', raw, { width: 8, height: 8, palette: p.palette, frameCount: 1 });
    const applied = applyAnimationResult(p, { animationId: 'A', layerId: 'L' }, frames);
    assert.equal(applied.added, 3);
    assert.equal(applied.project.animations[0].frames.length, 4);
    assert.notDeepEqual(applied.project.animations[0].frames[1].cels[0].pixels, cel);
    const gb = await registry.run('gameboy-palette', 'gameboy-remap', { width: 8, height: 8, palette: p.palette, pixels: Int16Array.from(cel), params: { brightness: 0 } });
    const checked = validateResult('frame', gb, { width: 8, height: 8, palette: p.palette });
    assert.equal(checked.palette.length, p.palette.length + 4);
    assert.ok(checked.pixels.filter(v => v >= 0).every(v => v >= p.palette.length));
    assert.equal(registry.palettes()[0].name, 'Game Boy (DMG)');
  } finally { registry.stopAll(); }
});

test('the worker sandbox: network stubs, errors, timeouts and a broken install', async () => {
  const net = host(`pixelStudio.registerCommand({id:'x',title:'X'}, () => { fetch('https://example.com'); });`);
  await net.start();
  await assert.rejects(net.run('x', {}), /not available to Pixel Studio plugins/);
  net.stop();
  const slow = host(`pixelStudio.registerCommand({id:'x',title:'X'}, () => { for(;;){} });`, { runTimeout: 300 });
  await slow.start();
  await assert.rejects(slow.run('x', {}), /longer than 0.3 s/);
  assert.equal(slow.running, false);
  const registry = new PluginRegistry({ store: memoryStore(), spawn, platform: 'node' });
  await assert.rejects(registry.install(header(base, 'throw new Error("boom")')), /failed while loading: boom/);
  await assert.rejects(registry.install(header(base, 'pixelStudio.registerCommand({id:"a",title:"A",scope:"project"}, () => ({}))')), /“project” permission/);
  assert.equal(registry.list().length, 0, 'nothing broken gets installed');
});

test('registry: install, update, disable and uninstall persist to the store', async () => {
  const store = memoryStore(), registry = new PluginRegistry({ store, spawn, platform: 'node' });
  const v1 = header(base, `pixelStudio.registerEffect({id:'e',title:'E'}, c => ({pixels:c.pixels}));`);
  assert.equal((await registry.install(v1)).change, 'install');
  assert.equal(registry.inspect(v1.replace('1.0.0', '1.1.0')).change, 'update');
  await registry.install(v1.replace('1.0.0', '1.1.0'));
  assert.equal(registry.list()[0].manifest.version, '1.1.0');
  await registry.setEnabled('demo', false);
  assert.equal(registry.actions().length, 0);
  const reloaded = new PluginRegistry({ store, spawn, platform: 'node' });
  await reloaded.load();
  assert.equal(reloaded.list()[0].enabled, false);
  await reloaded.setEnabled('demo', true);
  assert.equal(reloaded.actions()[0].key, 'demo/e');
  await reloaded.uninstall('demo');
  assert.equal((await store.list()).length, 0);
  registry.stopAll(); reloaded.stopAll();
});

test('prompt skills add their instructions to the creation prompt', () => {
  const config = { name: 'Hero', description: 'A knight', width: 32, height: 32, paletteMode: 'auto', maxColors: 16, animations: [{ name: 'Idle', frameCount: 2, fps: 8 }] };
  const skill = { title: 'Platformer hero', instructions: 'Use squash on landing.' };
  assert.deepEqual(validatePromptConfig({ ...config, skill }).skill, skill);
  for (const formatVersion of [1, 2]) {
    const text = buildCreationPrompt({ ...config, formatVersion, skill });
    assert.match(text, /PROMPT SKILL — Platformer hero/);
    assert.match(text, /Use squash on landing\./);
    assert.doesNotMatch(buildCreationPrompt({ ...config, formatVersion }), /PROMPT SKILL/);
  }
  assert.throws(() => validatePromptConfig({ ...config, skill: { title: 'x', instructions: 'y'.repeat(5000) } }), /Prompt skill/);
});

test('the API reference is one source for docs/plugins.md and the author prompt', () => {
  const doc = readFileSync(new URL('../docs/plugins.md', import.meta.url), 'utf8');
  assert.ok(doc.includes(PLUGIN_API_DOC.trim()), 'run: node scripts/sync-plugin-docs.mjs');
  const prompt = pluginAuthorPrompt('a sepia filter');
  assert.match(prompt, /a sepia filter/);
  assert.ok(prompt.includes(PLUGIN_API_DOC.trim()));
});
