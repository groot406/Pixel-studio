import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile, access } from 'node:fs/promises';
import { CodexClient, codexEnvironment, codexArguments } from '../local/codex-client.mjs';

function client(t, behavior = 'success') {
  const result = new CodexClient({ command: process.execPath, prefixArgs: [fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url)), behavior], rpcTimeoutMs: 2000, turnTimeoutMs: 3000 });
  t.after(() => result.close());
  return result;
}

test('Codex adapter supports palette output instead of forcing a full PXA document', async t => {
  const result = await client(t).edit({ prompt: 'Return PXAPALETTE 1', model: 'test-model' });
  assert.match(result.text, /PXAPALETTE 1 for palette recoloring/);
  assert.match(result.text, /PXAINPAINT 1 for selected pixels/);
  assert.equal(result.model, 'test-model');
});

test('assistant prompts get assistant instructions instead of the data-only ones', async t => {
  const result = await client(t).edit({ prompt: 'PXACHAT 1\nWhat is in this project?' });
  assert.match(result.text, /Pixel Studio assistant/);
  assert.doesNotMatch(result.text, /pixel-art data editor/);
});

test('API-key authentication is reported without generating', async t => {
  const connection = client(t, 'apikey');
  assert.equal((await connection.getStatus()).connected, false);
  await assert.rejects(connection.edit({ prompt: 'PXA 1' }), error => error.code === 'CHATGPT_SIGN_IN_REQUIRED');
});

test('6.1 models and Astra are listed and the selected model reaches Codex', async t => {
  const connection = client(t, 'modern-models');
  const status = await connection.getStatus();
  assert.deepEqual(status.models.map(model => model.id), ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra']);
  for (const model of status.models) {
    const result = await client(t, 'modern-models').edit({ prompt: 'PXA 1', model: model.id });
    assert.equal(JSON.parse(result.text).model, model.id);
  }
});

test('unknown models and tool requests are rejected', async t => {
  await assert.rejects(client(t).edit({ prompt: 'PXA 1', model: 'not-in-catalog' }), error => error.code === 'INVALID_MODEL');
  await assert.rejects(client(t, 'tool').edit({ prompt: 'PXA 1' }), error => error.code === 'TOOLS_DISABLED');
});

test('aborting generation closes the Codex session', async t => {
  const controller = new AbortController();
  const connection = client(t, 'wait');
  const promise = connection.edit({ prompt: 'PXAINPAINT 1', signal: controller.signal, onEvent: event => {
    if (event.message === 'Codex is generating pixel data…') setTimeout(() => controller.abort(), 20);
  } });
  await assert.rejects(promise, error => error.code === 'CANCELLED');
  assert.equal(connection.closed, true);
});

test('local execution retains billing and tool-isolation boundaries', () => {
  const env = codexEnvironment({ PATH: '/safe/bin', OPENAI_API_KEY: 'fixture', OPENAI_BASE_URL: 'https://example.test', CODEX_ACCESS_TOKEN: 'fixture' });
  assert.deepEqual(env, { PATH: '/safe/bin' });
  const args = codexArguments();
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('features.shell_tool=false'));
});

test('rendered previews reach Codex as application-owned local images and are removed after the turn',async t=>{
  const png=await readFile(new URL('../public/samples/key.png',import.meta.url));
  const connection=client(t,'images');
  const result=await connection.edit({prompt:'PXAPATCH 2',previews:[`data:image/png;base64,${png.toString('base64')}`]});
  assert.deepEqual(JSON.parse(result.text),[{type:'text',text:'PXAPATCH 2'},{type:'localImage',png:'89504e470d0a1a0a'}]);
  await assert.rejects(access(connection.directory));
});
