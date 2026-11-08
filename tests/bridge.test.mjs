import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { createLocalServer } from '../local/server.mjs';
import { callBridge, readBridgeInfo } from '../local/bridge.mjs';

const WORK = new URL(`./.work-bridge-${process.pid}/`, import.meta.url);

async function start(t) {
  const bridgeDirectory = new URL('bridge/', WORK).pathname, dist = new URL('dist/', WORK).pathname;
  await mkdir(dist, { recursive: true });
  const app = createLocalServer({ distDirectory: dist, bridgeDirectory, clientFactory: () => ({ async getStatus() { return { connected: false }; }, async close() {} }) });
  t.after(async () => { await app.close(); await rm(WORK, { recursive: true, force: true }); });
  const url = await app.listen(0);
  const status = await (await fetch(`${url}api/local-ai/status`)).json();
  return { app, url, status, bridgeDirectory };
}

/** Minimal SSE subscriber: resolves events through `next(name)`. */
function subscribe(url, token) {
  const queue = [], waiters = [];
  let buffer = '';
  const req = request(`${url}api/bridge/events?token=${token}`, response => {
    response.setEncoding('utf8');
    response.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
        if (!event) continue;
        const item = { event, data: JSON.parse(data) }, waiter = waiters.findIndex(w => w.name === item.event);
        if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(item.data); else queue.push(item);
      }
    });
  });
  req.on('error', () => {});
  req.end();
  return {
    next(name) {
      const index = queue.findIndex(item => item.event === name);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0].data);
      return new Promise(resolve => waiters.push({ name, resolve }));
    },
    close() { req.destroy(); },
  };
}

test('an agent call reaches the editor and the editor reply returns to the agent', async t => {
  const { url, status, bridgeDirectory } = await start(t);
  assert.equal(status.bridge, true);
  assert.equal(status.mcpCommand.args.at(-1), 'mcp');
  const info = await readBridgeInfo(bridgeDirectory);
  assert.equal(info.url, url);
  assert.equal((await stat(`${bridgeDirectory}/bridge.json`)).mode & 0o777, 0o600);

  await assert.rejects(callBridge('get_project', {}, { directory: bridgeDirectory }), /No Pixel Studio editor is open/);
  assert.deepEqual(await callBridge('status', {}, { directory: bridgeDirectory }), { editorConnected: false, editors: 0 });

  const editor = subscribe(url, status.csrfToken);
  t.after(() => editor.close());
  assert.equal((await editor.next('hello')).agent, true, 'the earlier status call marks an agent as active');
  const pending = callBridge('get_project', { preview: false }, { directory: bridgeDirectory });
  const call = await editor.next('request');
  assert.equal(call.tool, 'get_project');
  assert.deepEqual(call.args, { preview: false });

  const badReply = await fetch(`${url}api/bridge/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pixel-studio-token': 'nope' }, body: JSON.stringify({ id: call.id, result: {} }) });
  assert.equal(badReply.status, 403);
  const reply = await fetch(`${url}api/bridge/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pixel-studio-token': status.csrfToken }, body: JSON.stringify({ id: call.id, result: { pxa: 'PXA 2', name: 'Test' } }) });
  assert.equal(reply.status, 200);
  assert.deepEqual(await pending, { pxa: 'PXA 2', name: 'Test' });

  const denied = callBridge('apply_project', { pxa: 'x' }, { directory: bridgeDirectory });
  const second = await editor.next('request');
  await fetch(`${url}api/bridge/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pixel-studio-token': status.csrfToken }, body: JSON.stringify({ id: second.id, error: 'The user did not allow agent edits.', code: 'DENIED' }) });
  await assert.rejects(denied, /did not allow/);
});

test('bridge endpoints reject wrong tokens and unknown tools', async t => {
  const { url, status, bridgeDirectory } = await start(t);
  const call = (headers, body = { tool: 'status' }) => fetch(`${url}api/bridge/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await call({})).status, 401);
  assert.equal((await call({ Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await call({ Authorization: `Bearer ${status.csrfToken}` })).status, 401, 'the browser token is not a bridge token');
  const { token } = await readBridgeInfo(bridgeDirectory);
  assert.equal((await call({ Authorization: `Bearer ${token}` })).status, 200);
  assert.equal((await call({ Authorization: `Bearer ${token}` }, { tool: 'delete_everything' })).status, 400);
  assert.equal((await fetch(`${url}api/bridge/events?token=wrong`)).status, 403);
  assert.equal((await fetch(`${url}api/bridge/events?token=${status.csrfToken}`, { headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('bridge.json is removed when the server closes', async t => {
  const { app, bridgeDirectory } = await start(t);
  assert.ok(await readBridgeInfo(bridgeDirectory));
  await app.close();
  assert.equal(await readBridgeInfo(bridgeDirectory), null);
});
