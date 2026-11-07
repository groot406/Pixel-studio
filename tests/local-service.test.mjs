import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { createLocalServer } from '../local/server.mjs';
import { readLocalEditResponse } from '../src/features/ai/local-client.js';
import { buildSite } from '../scripts/build.mjs';

async function start(t, edit) {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-studio-test-'));
  await buildSite(join(directory, 'dist'));
  const requests = [];
  const app = createLocalServer({
    distDirectory: join(directory, 'dist'),
    clientFactory: () => ({
      async getStatus() { return { connected: true, authMode: 'chatgpt', models: [{ id: 'test-model', name: 'Test model' }] }; },
      async edit(options) {
        requests.push(options);
        if (edit) return edit(options);
        options.onEvent({ type: 'status', message: 'Preparing test edit' });
        options.onEvent({ type: 'delta', text: 'Test response' });
        return { text: 'Test response', model: options.model };
      },
      async close() {},
    }),
  });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const url = await app.listen(0);
  const connection = await (await fetch(`${url}api/local-ai/status`)).json();
  const headers = { 'Content-Type': 'application/json', Origin: url.slice(0, -1), 'X-Pixel-Studio-Token': connection.csrfToken };
  return { app, url, headers, requests, directory };
}

test('build serves every browser module and asset with the original layout', async t => {
  const { url } = await start(t);
  const page = await (await fetch(url)).text();
  assert.match(page, /Pixel Studio — a little world/);
  assert.match(page, /src="\.\/src\/editor\/app.js"/);
  const visited = new Set();
  const crawl = async path => {
    if (visited.has(path)) return;
    visited.add(path);
    const response = await fetch(path);
    assert.equal(response.status, 200, path);
    const source = await response.text();
    if (!path.endsWith('.js')) return;
    assert.match(response.headers.get('content-type'), /javascript/);
    for (const [, dependency] of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) await crawl(new URL(dependency, path).href);
  };
  for (const [, path] of page.matchAll(/(?:href|src)="(\.\/[^"#]+)"/g)) await crawl(new URL(path, url).href);
  assert.ok(visited.size > 15);
  assert.equal((await fetch(`${url}samples/panda.png`)).status, 200);
  assert.equal((await fetch(`${url}src/editor/app.js`, { method: 'HEAD' })).headers.get('content-type'), 'text/javascript; charset=utf-8');
});

test('all supported AI formats reach the local bridge and preserve the chosen model', async t => {
  const { url, headers, requests } = await start(t);
  for (const format of ['PXA 1', 'PXA 2', 'PXAPATCH 2', 'PXAINPAINT 1', 'PXAPALETTE 1']) {
    const response = await fetch(`${url}api/local-ai/edit`, { method: 'POST', headers, body: JSON.stringify({ prompt: `Return ${format}`, model: 'test-model' }) });
    const events = [];
    assert.equal(await readLocalEditResponse(response, event => events.push(event)), 'Test response');
    assert.equal(requests.at(-1).model, 'test-model');
    assert.equal(requests.at(-1).prompt, `Return ${format}`);
    assert.equal(events[0].type, 'status');
  }
});

test('local API rejects foreign origins, missing tokens, unsupported fields and commands', async t => {
  const { url, headers, requests } = await start(t);
  for (const [overrideHeaders, body, expected] of [
    [{ ...headers, Origin: 'https://foreign.example' }, { prompt: 'PXA 1' }, 403],
    [{ 'Content-Type': 'application/json' }, { prompt: 'PXA 1' }, 403],
    [headers, { prompt: 'PXA 1', cwd: '/private' }, 400],
    [headers, { prompt: 'Run an arbitrary command' }, 400],
    [headers, { prompt: 'PXAPALETTE 1', model: 'bad model;command' }, 400],
  ]) {
    const response = await fetch(`${url}api/local-ai/edit`, { method: 'POST', headers: overrideHeaders, body: JSON.stringify(body) });
    assert.equal(response.status, expected);
    await response.arrayBuffer();
  }
  assert.equal(requests.length, 0);
  const hostStatus = await new Promise((resolve, reject) => {
    get(url, { headers: { Host: 'foreign.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
});

test('local bridge forwards bounded PNG previews and rejects external image locations',async t=>{
  const {url,headers,requests}=await start(t);
  const png=await readFile(new URL('../public/samples/key.png',import.meta.url));
  const previews=[`data:image/png;base64,${png.toString('base64')}`];
  const response=await fetch(`${url}api/local-ai/edit`,{method:'POST',headers,body:JSON.stringify({prompt:'PXAPATCH 2',previews})});
  await readLocalEditResponse(response);
  assert.deepEqual(requests[0].previews,previews);
  for(const invalid of [['/tmp/input.png'],['https://example.test/input.png']]) {
    const denied=await fetch(`${url}api/local-ai/edit`,{method:'POST',headers,body:JSON.stringify({prompt:'PXAPATCH 2',previews:invalid})});
    assert.equal(denied.status,400);await denied.arrayBuffer();
  }
  assert.equal(requests.length,1);
});

test('static server never exposes source checkout secrets or escaping symlinks', async t => {
  const { url, directory } = await start(t);
  await writeFile(join(directory, 'secret.txt'), 'private fixture');
  await symlink(join(directory, 'secret.txt'), join(directory, 'dist', 'outside.txt'));
  for (const path of ['outside.txt', '.env', '.git/config', '%2e%2e%2fsecret.txt', 'local/codex-client.mjs', 'api/missing']) {
    assert.equal((await fetch(`${url}${path}`)).status, 404, path);
  }
});

test('one generation at a time; disconnect cancels the in-flight request', async t => {
  let started;
  let aborted;
  const ready = new Promise(resolve => { started = resolve; });
  const cancelled = new Promise(resolve => { aborted = resolve; });
  const { url, headers } = await start(t, ({ signal }) => new Promise((resolve, reject) => {
    started();
    signal.addEventListener('abort', () => { aborted(); reject(new Error('cancelled')); }, { once: true });
  }));
  const controller = new AbortController();
  const first = await fetch(`${url}api/local-ai/edit`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'PXA 1' }), signal: controller.signal });
  await ready;
  const second = await fetch(`${url}api/local-ai/edit`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'PXA 1' }) });
  assert.equal(second.status, 409);
  controller.abort();
  await cancelled;
  await first.body.cancel().catch(() => {});
});

test('stream parser rejects interrupted and malformed output instead of accepting a partial edit', async () => {
  const stream = text => new Response(text, { headers: { 'Content-Type': 'application/x-ndjson' } });
  await assert.rejects(readLocalEditResponse(stream('{"type":"delta","text":"partial"}\n')), /ended before/);
  await assert.rejects(readLocalEditResponse(stream('invalid\n')), /invalid response/);
  await assert.rejects(readLocalEditResponse(stream('{"type":"error","error":"usage limit"}\n')), /usage limit/);
  assert.equal(await readLocalEditResponse(stream('{"type":"done","text":"complete"}')), 'complete');
});
