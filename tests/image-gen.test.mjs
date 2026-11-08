import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLocalServer } from '../local/server.mjs';
import { createImageClient, readImageKeys } from '../local/image-client.mjs';
import { mapRgbaPerceptual, indicesToRgba } from '../src/domain/palette-map.js';
import { cleanImage, quantizeImage, sliceSheet, removeKeyColor } from '../src/domain/image-pipeline.js';
import { buildImagePrompt, normalizeImageOptions } from '../src/features/ai/image-prompt.js';
import { imageRequests, readImageResponse, requestImages, ImageApiError } from '../src/features/ai/image-api.js';

const PNG = (await readFile(new URL('../public/samples/key.png', import.meta.url))).toString('base64');

/** Upscale a tiny sprite (palette indices, -1 = background) by `scale` onto a flat background. */
function upscale(art, w, h, scale, colors, bg = [255, 0, 255]) {
  const W = w * scale, H = h * scale, rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = art[((y / scale) | 0) * w + ((x / scale) | 0)], c = v < 0 ? bg : colors[v], i = (y * W + x) * 4;
    rgba.set([...c, 255], i);
  }
  return { rgba, width: W, height: H };
}

test('perceptual palette mapping picks the colour a person would, keeps transparency and can dither', () => {
  // RGB distance prefers grey for this dark blue; OKLab keeps it blue.
  const palette = ['#808080', '#0000ff', '#000000'];
  const rgba = new Uint8ClampedArray([60, 60, 140, 255, 0, 0, 0, 0]);
  assert.deepEqual(mapRgbaPerceptual(rgba, palette, 2, 1), [1, -1]);
  const flat = new Uint8ClampedArray(8 * 8 * 4).map((_, i) => i % 4 === 3 ? 255 : 128);
  const plain = mapRgbaPerceptual(flat, ['#000000', '#ffffff'], 8, 8);
  const dithered = mapRgbaPerceptual(flat, ['#000000', '#ffffff'], 8, 8, { dither: true });
  assert.equal(new Set(plain).size, 1);
  assert.equal(new Set(dithered).size, 2);
  assert.deepEqual([...indicesToRgba([1, -1], ['#000000', '#ff0000'])], [255, 0, 0, 255, 0, 0, 0, 0]);
});

test('cleanImage turns an upscaled magenta-key sprite into real pixels, including enclosed key holes', () => {
  const art = [-1, -1, -1, -1, -1, -1, 0, 0, 0, -1, -1, 0, -1, 0, -1, -1, 1, 1, 1, -1, -1, -1, -1, -1, -1];
  const big = upscale(art, 5, 5, 12, [[20, 30, 40], [220, 180, 60]]);
  const result = cleanImage(big.rgba, big.width, big.height, { mode: 'auto', keyColor: [255, 0, 255] });
  assert.equal(result.mode, 'detect');
  assert.equal(result.width, 3); assert.equal(result.height, 3);
  assert.equal(result.rgba[(1 * 3 + 1) * 4 + 3], 0, 'enclosed magenta hole is cleared');
  const { palette, pixels } = quantizeImage(result.rgba, 3, 3, { colors: 'palette', palette: ['#ffcc33', '#101820'] });
  assert.deepEqual(palette, ['#ffcc33', '#101820']);
  assert.deepEqual(pixels, [1, 1, 1, 1, -1, 1, 0, 0, 0]);
  assert.equal(removeKeyColor(new Uint8ClampedArray([250, 10, 250, 255]), [255, 0, 255]).removed, 1);
});

test('sliceSheet keeps frames aligned by cropping every cell to the shared box', () => {
  // Two 4×3 cells; the sprite moves down one pixel in the second.
  const W = 8, H = 3, rgba = new Uint8ClampedArray(W * H * 4);
  const dot = (x, y) => rgba.set([9, 9, 9, 255], (y * W + x) * 4);
  dot(1, 0); dot(2, 0); dot(5, 1); dot(6, 1);
  const { frames, width, height } = sliceSheet(rgba, W, H, 2);
  assert.equal(frames.length, 2);
  assert.equal(width, 2); assert.equal(height, 2);
  assert.equal(frames[0][3], 255); assert.equal(frames[1][(1 * 2) * 4 + 3], 255);
});

test('image prompt asks for a flat key background, a pixel grid, a palette, sheets and references', () => {
  const prompt = buildImagePrompt({ subject: 'a tiny  knight', size: 48, view: 'side', style: 'nes', usePalette: true, palette: ['#112233', 'bad'], background: 'magenta' });
  assert.match(prompt, /a tiny knight/);
  assert.match(prompt, /48×48 pixel grid/);
  assert.match(prompt, /#FF00FF/);
  assert.match(prompt, /no anti-aliasing/);
  assert.match(prompt, /only these colours \(hex\): #112233\./);
  assert.match(buildImagePrompt({ subject: 'cat', frames: 6 }), /exactly 6 animation frames in a single horizontal row/);
  assert.match(buildImagePrompt({ subject: 'cat', reference: true }), /Redraw the attached/);
  assert.doesNotMatch(buildImagePrompt({ subject: 'cat', outline: false }), /1-pixel outline/);
  assert.throws(() => buildImagePrompt({ subject: '  ' }), /Describe/);
  assert.equal(normalizeImageOptions({ size: 9999, view: 'nope', frames: 0 }).size, 256);
  assert.equal(normalizeImageOptions({ view: 'nope' }).view, 'side');
});

test('provider requests use the documented endpoints and parse both response shapes', async () => {
  const [openai] = imageRequests({ provider: 'openai', model: 'gpt-image-1', prompt: 'p', n: 3, key: 'sk-test', background: 'transparent', quality: 'low' });
  assert.equal(openai.url, 'https://api.openai.com/v1/images/generations');
  assert.deepEqual(JSON.parse(openai.init.body), { model: 'gpt-image-1', prompt: 'p', n: 3, size: '1024x1024', background: 'transparent', quality: 'low' });
  assert.equal(openai.init.headers.Authorization, 'Bearer sk-test');
  const [edit] = imageRequests({ provider: 'openai', model: 'gpt-image-1', prompt: 'p', reference: PNG, key: 'k' });
  assert.equal(edit.url, 'https://api.openai.com/v1/images/edits');
  assert.ok(edit.init.body instanceof FormData);
  assert.equal(edit.init.body.get('image').type, 'image/png');
  const gemini = imageRequests({ provider: 'gemini', model: 'gemini-2.5-flash-image', prompt: 'p', n: 2, reference: PNG, key: 'g' });
  assert.equal(gemini.length, 2);
  assert.match(gemini[0].url, /models\/gemini-2\.5-flash-image:generateContent$/);
  assert.equal(gemini[0].init.headers['x-goog-api-key'], 'g');
  assert.equal(JSON.parse(gemini[0].init.body).contents[0].parts[1].inline_data.data, PNG);
  const json = value => new Response(JSON.stringify(value), { status: 200 });
  assert.deepEqual(await readImageResponse('openai', json({ data: [{ b64_json: 'AAA' }] })), ['AAA']);
  assert.deepEqual(await readImageResponse('gemini', json({ candidates: [{ content: { parts: [{ text: 'hi' }, { inlineData: { data: 'BBB' } }] } }] })), ['BBB']);
  await assert.rejects(readImageResponse('gemini', json({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] })), e => e.kind === 'rejected');
  await assert.rejects(readImageResponse('openai', new Response('{"error":{"message":"Incorrect API key sk-secret"}}', { status: 401 })), e => e instanceof ImageApiError && e.kind === 'auth' && !e.message.includes('sk-secret'));
  // One failed Gemini call out of two still returns the other image.
  let calls = 0;
  const images = await requestImages({ provider: 'gemini', model: 'gemini-2.5-flash-image', prompt: 'p', n: 2, key: 'g' }, { fetchImpl: async () => (++calls === 1 ? new Response('', { status: 500 }) : json({ candidates: [{ content: { parts: [{ inline_data: { data: 'CCC' } }] } }] })) });
  assert.deepEqual(images, ['CCC']);
});

test('keys come from the environment first, then the keys file', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/image-keys.json', import.meta.url));
  assert.deepEqual(await readImageKeys({ env: {}, keysFile: fixture }), { openai: 'sk-file', gemini: 'gemini-file' });
  assert.deepEqual(await readImageKeys({ env: { OPENAI_API_KEY: 'sk-env', GOOGLE_API_KEY: 'g-env' }, keysFile: fixture }), { openai: 'sk-env', gemini: 'g-env' });
  assert.deepEqual(await readImageKeys({ env: {}, keysFile: fixture + '.missing' }), { openai: '', gemini: '' });
});

async function start(t, { fetchImpl, keys = { openai: 'sk-never-sent', gemini: '' } } = {}) {
  const calls = [];
  const fake = fetchImpl || (async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ data: [{ b64_json: PNG }] }), { status: 200 }); });
  const app = createLocalServer({
    distDirectory: fileURLToPath(new URL('../public/', import.meta.url)),
    clientFactory: () => ({ async getStatus() { return { connected: false, models: [] }; }, async close() {} }),
    imageClientFactory: () => createImageClient({ keys, fetchImpl: fake, timeoutMs: 2000 }),
  });
  t.after(() => app.close());
  const url = await app.listen(0);
  const status = await (await fetch(`${url}api/image/status`)).json();
  const headers = { 'Content-Type': 'application/json', Origin: url.slice(0, -1), 'X-Pixel-Studio-Token': status.csrfToken };
  return { url, headers, status, calls };
}

test('local image status lists providers without exposing keys; generate proxies through the injected client', async t => {
  const { url, headers, status, calls } = await start(t);
  assert.equal(status.local, true);
  assert.equal(status.providers.openai.available, true);
  assert.equal(status.providers.gemini.available, false);
  assert.doesNotMatch(JSON.stringify(status), /sk-never-sent/);
  const response = await fetch(`${url}api/image/generate`, { method: 'POST', headers, body: JSON.stringify({ provider: 'openai', prompt: 'a cat', n: 2, size: '1024x1024' }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.images, [PNG]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-never-sent');
  const missing = await fetch(`${url}api/image/generate`, { method: 'POST', headers, body: JSON.stringify({ provider: 'gemini', prompt: 'a cat' }) });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, 'IMAGE_KEY_MISSING');
});

test('local image API enforces token, origin, fields and maps upstream errors without leaking them', async t => {
  const { url, headers, calls } = await start(t);
  for (const [overrideHeaders, body, expected] of [
    [{ 'Content-Type': 'application/json' }, { provider: 'openai', prompt: 'x' }, 403],
    [{ ...headers, Origin: 'https://foreign.example' }, { provider: 'openai', prompt: 'x' }, 403],
    [headers, { provider: 'openai', prompt: 'x', key: 'mine' }, 400],
    [headers, { provider: 'other', prompt: 'x' }, 400],
    [headers, { provider: 'openai', model: 'gpt-4o; rm', prompt: 'x' }, 400],
    [headers, { provider: 'openai', prompt: 'x', n: 9 }, 400],
    [headers, { provider: 'openai', prompt: 'x', reference: 'not-a-png' }, 400],
  ]) {
    const response = await fetch(`${url}api/image/generate`, { method: 'POST', headers: overrideHeaders, body: JSON.stringify(body) });
    assert.equal(response.status, expected, JSON.stringify(body));
    await response.arrayBuffer();
  }
  assert.equal(calls.length, 0);
  const failing = await start(t, { fetchImpl: async () => new Response('{"error":{"message":"Rate limit for org-secret"}}', { status: 429 }) });
  const response = await fetch(`${failing.url}api/image/generate`, { method: 'POST', headers: failing.headers, body: JSON.stringify({ provider: 'openai', prompt: 'x' }) });
  assert.equal(response.status, 429);
  const text = await response.text();
  assert.match(text, /IMAGE_USAGE_LIMIT/);
  assert.doesNotMatch(text, /org-secret/);
});

test('one image generation at a time', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { url, headers } = await start(t, { fetchImpl: async () => { await gate; return new Response(JSON.stringify({ data: [{ b64_json: PNG }] })); } });
  const first = fetch(`${url}api/image/generate`, { method: 'POST', headers, body: JSON.stringify({ provider: 'openai', prompt: 'x' }) });
  await new Promise(resolve => setTimeout(resolve, 50));
  const second = await fetch(`${url}api/image/generate`, { method: 'POST', headers, body: JSON.stringify({ provider: 'openai', prompt: 'x' }) });
  assert.equal(second.status, 409); await second.arrayBuffer();
  release();
  assert.equal((await first).status, 200);
});
