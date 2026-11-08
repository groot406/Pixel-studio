import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPlugin, PLUGIN_DIR } from '../scripts/build-plugin.mjs';
import { installCodexPlugin, upsertMarketplace, marketplaceEntry } from '../local/plugin.mjs';
import { createMcpServer } from '../local/mcp.mjs';

const REPO = new URL('../', import.meta.url);
const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function files(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(path, base)); else out.push(relative(base, path));
  }
  return out.sort();
}

async function scratch(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pixelstudio-plugin-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('plugins/pixel-studio is up to date (run npm run plugin)', async t => {
  const fresh = await buildPlugin(join(await scratch(t), 'pixel-studio'));
  const expected = await files(fresh);
  assert.deepEqual(await files(PLUGIN_DIR), expected);
  for (const file of expected) assert.ok((await readFile(join(PLUGIN_DIR, file))).equals(await readFile(join(fresh, file))), `${file} is stale`);
});

test('plugin manifests and marketplaces agree and point at bundled files', async () => {
  const { version } = await json(new URL('package.json', REPO));
  const plugin = await json(join(PLUGIN_DIR, 'plugin.json')), claude = await json(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'));
  assert.equal(plugin.name, 'pixel-studio');
  assert.equal(plugin.version, version);
  assert.equal(claude.version, version);
  const ui = plugin.extensions['com.openai'].interface;
  assert.ok((await stat(join(PLUGIN_DIR, ui.logo))).isFile());
  const codexServer = (await json(join(PLUGIN_DIR, 'mcp.json'))).mcpServers.pixelstudio;
  assert.equal(codexServer.type, 'stdio');
  assert.ok((await stat(join(PLUGIN_DIR, codexServer.args[0].replace('${PLUGIN_ROOT}/', '')))).isFile());
  const claudeServer = (await json(join(PLUGIN_DIR, '.mcp.json'))).mcpServers.pixelstudio;
  assert.ok((await stat(join(PLUGIN_DIR, claudeServer.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '')))).isFile());
  for (const skill of ['pixel-studio', 'pixel-studio-animate']) assert.ok((await stat(join(PLUGIN_DIR, 'skills', skill, 'SKILL.md'))).isFile());
  const codexMarket = await json(new URL('.agents/plugins/marketplace.json', REPO));
  const claudeMarket = await json(new URL('.claude-plugin/marketplace.json', REPO));
  assert.equal(codexMarket.plugins[0].source.path, './plugins/pixel-studio');
  assert.equal(claudeMarket.plugins[0].source, './plugins/pixel-studio');
});

test('upsertMarketplace keeps other plugins and replaces an older Pixel Studio entry', () => {
  const entry = marketplaceEntry('./.codex/plugins/pixel-studio');
  const market = upsertMarketplace({ name: 'mine', plugins: [{ name: 'other' }, { name: 'pixel-studio', source: './old' }] }, entry);
  assert.equal(market.name, 'mine');
  assert.deepEqual(market.plugins.map(p => p.name), ['other', 'pixel-studio']);
  assert.equal(market.plugins[1].source.path, './.codex/plugins/pixel-studio');
  assert.equal(upsertMarketplace(null, entry).interface.displayName, 'Personal');
});

test('plugin install writes a personal Codex marketplace whose path resolves to the plugin', async t => {
  const home = await scratch(t);
  const result = await installCodexPlugin({ home });
  const market = await json(result.marketplace);
  assert.equal(result.id, 'pixel-studio@personal');
  assert.equal(join(home, market.plugins[0].source.path), result.directory);
  assert.ok((await stat(join(result.directory, 'plugin.json'))).isFile());
  await assert.rejects(async () => {
    await writeFile(result.marketplace, '{ broken');
    await installCodexPlugin({ home });
  }, /Cannot update/);
});

test('the bundled server runs outside the repo and asks for a workspace from the plugin cache', async t => {
  const dir = await scratch(t), plugin = join(dir, 'cache', 'pixel-studio'), project = join(dir, 'project'), home = join(dir, 'home');
  await cp(PLUGIN_DIR, plugin, { recursive: true });
  await mkdir(project); await mkdir(home);
  const child = spawn(process.execPath, [join(plugin, 'server', 'local', 'mcp.mjs')], { cwd: plugin, env: { ...process.env, HOME: home, PIXELSTUDIO_ROOT: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let id = 0;
  const rpc = (method, params) => new Promise(done => { const n = ++id; waiting.set(n, done); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.match(init.result.instructions, /call set_workspace/);
  assert.ok((await rpc('tools/list')).result.tools.some(tool => tool.name === 'set_workspace'));
  assert.equal((await rpc('tools/call', { name: 'set_workspace', arguments: { path: '/' } })).result.isError, true);
  assert.equal((await rpc('tools/call', { name: 'set_workspace', arguments: { path: project } })).result.isError, undefined);
  assert.equal((await rpc('tools/call', { name: 'create_project', arguments: { path: 'hero.pxa', width: 8, height: 8 } })).result.isError, undefined);
  assert.match(await readFile(join(project, 'hero.pxa'), 'utf8'), /^PXA 2/);
  assert.deepEqual(await readdir(join(plugin, 'server')), ['local', 'package.json', 'public', 'skills', 'src']);
});

test('a fallback root adopts the client\'s MCP roots before tools run; explicit roots hide set_workspace', async t => {
  const dir = await scratch(t), project = join(dir, 'project');
  await mkdir(project);
  const sent = [];
  let server;
  const send = message => {
    sent.push(message);
    if (message.method === 'roots/list') setTimeout(() => server.receive({ jsonrpc: '2.0', id: message.id, result: { roots: [{ uri: 'https://example.com' }, { uri: pathToFileURL(project).href }] } }), 20);
  };
  server = createMcpServer({ root: dir, adoptClientRoots: true, bridgeDirectory: join(dir, 'bridge'), send });
  await server.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { roots: {} } } });
  await server.receive({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await server.receive({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_project', arguments: { path: 'a.pxa' } } });
  assert.equal(sent.find(m => m.id === 2).result.isError, undefined);
  assert.ok((await stat(join(project, 'a.pxa'))).isFile());

  const plain = [];
  const fixed = createMcpServer({ root: dir, bridgeDirectory: join(dir, 'bridge'), send: m => plain.push(m) });
  await fixed.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { roots: {} } } });
  await fixed.receive({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await fixed.receive({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(!plain.some(m => m.method === 'roots/list'));
  assert.ok(!plain.find(m => m.id === 2).result.tools.some(tool => tool.name === 'set_workspace'));
});
