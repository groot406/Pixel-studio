import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decodePng } from '../local/png-decode.mjs';

const WORK = fileURLToPath(new URL(`./.work-mcp-${process.pid}/`, import.meta.url));
const MCP = fileURLToPath(new URL('../local/mcp.mjs', import.meta.url));

async function startMcp(t) {
  const root = `${WORK}root`, bridge = `${WORK}no-bridge`;
  await mkdir(root, { recursive: true });
  const child = spawn(process.execPath, [MCP, '--root', root, '--bridge-dir', bridge], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const waiting = new Map(), lines = [];
  createInterface({ input: child.stdout }).on('line', line => {
    lines.push(line);
    const message = JSON.parse(line); // stdout must only ever contain JSON-RPC
    waiting.get(message.id)?.(message);
  });
  t.after(async () => { child.kill(); await rm(WORK, { recursive: true, force: true }); });
  let nextId = 1;
  const rpc = (method, params) => new Promise(resolve => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { rpc, call, root, lines, stderr: () => stderr, send: line => child.stdin.write(`${line}\n`) };
}

test('MCP handshake lists tools, resources and prompts', async t => {
  const { rpc, send, stderr } = await startMcp(t);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'pixel-studio');
  assert.ok(init.result.capabilities.tools && init.result.capabilities.resources && init.result.capabilities.prompts);
  send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.deepEqual((await rpc('ping')).result, {});
  const { tools } = (await rpc('tools/list')).result;
  const names = tools.map(tool => tool.name);
  for (const name of ['pixel_guide', 'create_project', 'project_info', 'read_project', 'write_project', 'render_png', 'image_to_pixels', 'apply_template', 'set_palette', 'export', 'list_palette_presets', 'editor_status', 'editor_get_project', 'editor_apply_project', 'editor_open_file']) assert.ok(names.includes(name), name);
  for (const tool of tools) assert.equal(tool.inputSchema.type, 'object', tool.name);
  const guide = (await rpc('resources/read', { uri: 'pixelstudio://guide/pxa2' })).result.contents[0];
  assert.match(guide.text, /^PXA 2: uppercase commands/);
  assert.ok((await rpc('resources/list')).result.resources.some(r => r.uri === 'pixelstudio://samples/puppet'));
  const prompt = (await rpc('prompts/get', { name: 'draw-sprite', arguments: { subject: 'a frog' } })).result;
  assert.match(prompt.messages[0].content.text, /a frog/);
  assert.equal((await rpc('nope/method')).error.code, -32601);
  assert.equal((await rpc('tools/call', { name: 'no_such_tool', arguments: {} })).error.code, -32602);
  assert.match(stderr(), /ready/);
});

test('create, render, write and export projects inside the workspace', async t => {
  const { rpc, call, root } = await startMcp(t);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const created = await call('create_project', { path: 'hero.pxa', width: 16, height: 16, name: 'Hero' });
  assert.ok(!created.isError, created.content[0].text);
  assert.match(await readFile(`${root}/hero.pxa`, 'utf8'), /^PXA 2\nSIZE 16 16\nNAME "Hero"/);

  const pxa = 'PXA 2\nSIZE 4 4\nNAME "Dot"\nPAL #000000 #ff0000\nLAYER art "Art" 1 0\nANIM idle "Idle" 8\nFRAME f1 100 CLEAR\nCEL art RASTER\nSPAN 1 1 11\nSPAN 1 2 11\nEND\n';
  const written = await call('write_project', { path: 'dot.pxa', pxa });
  assert.ok(!written.isError, written.content[0].text);
  const render = await call('render_png', { path: 'dot.pxa', scale: 2, background: 'transparent', out: 'dot.png' });
  const image = render.content.find(c => c.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  const png = decodePng(Buffer.from(image.data, 'base64'));
  assert.equal(png.width, 8);
  assert.deepEqual([...png.rgba.subarray((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 4)], [255, 0, 0, 255]);
  assert.equal(decodePng(await readFile(`${root}/dot.png`)).width, 8);

  const broken = await call('write_project', { path: 'broken.pxa', pxa: pxa.replace('SPAN 1 2 11', 'SPAN 1 2 1Z') });
  assert.equal(broken.isError, true);
  assert.match(broken.content[0].text, /line 10/i);
  await assert.rejects(readFile(`${root}/broken.pxa`));

  const wrong = await call('export', { path: 'dot.pxa', kind: 'gif', out: 'dot.gif' });
  assert.match(wrong.content[0].text, /Missing required argument "format"/);
  const exported = await call('export', { path: 'dot.pxa', format: 'gif', out: 'dot.gif' });
  assert.ok(!exported.isError, exported.content[0].text);
  assert.equal((await readFile(`${root}/dot.gif`)).subarray(0, 6).toString(), 'GIF89a');
});

test('paths outside the workspace root are rejected', async t => {
  const { rpc, call } = await startMcp(t);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  await writeFile(`${WORK}secret.pxa`, 'PXA 2\nSIZE 1 1\nNAME "x"\nPAL #000000\nLAYER a "a" 1 0\nANIM b "b" 8\nFRAME c 100 CLEAR\nEND\n');
  for (const path of ['../secret.pxa', `${WORK}secret.pxa`, 'sub/../../secret.pxa']) {
    const result = await call('read_project', { path });
    assert.equal(result.isError, true, path);
    assert.match(result.content[0].text, /outside the workspace root/);
  }
  const write = await call('write_project', { path: '../escape.pxa', pxa: 'PXA 2\nEND\n' });
  assert.equal(write.isError, true);
  await assert.rejects(readFile(`${WORK}escape.pxa`));
  const status = await call('editor_status', {});
  assert.match(status.content[0].text, /not running/);
});
