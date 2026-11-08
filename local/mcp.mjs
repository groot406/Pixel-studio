#!/usr/bin/env node
/**
 * Pixel Studio MCP server: Model Context Protocol over stdio (newline-delimited JSON-RPC 2.0), no SDK.
 * stdout carries only protocol messages; logs go to stderr.
 *   node local/mcp.mjs [--root DIR] [--bridge-dir DIR]
 */
import { createInterface } from 'node:readline';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, parse, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMcpHandlers, PACKAGE_VERSION, ToolError } from './mcp-tools.mjs';
import { defaultBridgeDirectory } from './bridge.mjs';

export const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = `Pixel Studio is a pixel-art and sprite-animation editor. Projects are plain-text PXA 2 documents (.pxa) or binary .pxs files inside the workspace root.
Workflow: pixel_guide → create_project or read_project → edit the PXA text → write_project (validates; returns line-precise errors or a preview image) → look at the preview and iterate → export (PNG, sprite sheet, GIF).
Use apply_template for walk/run/jump/idle/wave/hover on rigged characters (BONE lines), image_to_pixels to clean up generated images, and set_palette for palette presets.
editor_* tools edit the project open in the user's Pixel Studio Local editor (live bridge); every applied change is one undo step for the user.`;

/** The plugin folder when this server runs from a packaged agent plugin (<plugin>/server/local/mcp.mjs), else null. */
const ROOTS_TIMEOUT_MS = 3000;
const SET_WORKSPACE_TOOL = {
  name: 'set_workspace',
  title: 'Set workspace folder',
  description: 'Point the Pixel Studio tools at your project: pass the absolute path of the folder you are working in (e.g. your current working directory). Relative paths in every other tool resolve inside it. Call this first when the workspace root is a fallback such as ~/PixelStudio.',
  inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path of an existing project folder.' } }, required: ['path'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};
const PLUGIN_ROOT = (() => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return existsSync(join(root, 'plugin.json')) && existsSync(join(root, 'server', 'local', 'mcp.mjs')) ? realpathSync(root) : null;
})();

/**
 * Resolve the workspace root: --root, else the current directory — or ~/PixelStudio when started from "/" or from
 * inside an installed plugin's own folder (hosts may launch plugin servers there; never write into the plugin cache).
 */
export async function workspaceRoot(option, pluginRoot = PLUGIN_ROOT) {
  let root = option ? resolve(option) : process.cwd();
  if (pluginRoot && !option) root = realpathSync(root);
  const insidePlugin = pluginRoot && (root === pluginRoot || root.startsWith(pluginRoot + sep));
  if (!option && (root === parse(root).root || insidePlugin)) root = join(homedir(), 'PixelStudio');
  await mkdir(root, { recursive: true });
  const real = await realpath(root);
  if (!(await stat(real)).isDirectory()) throw new Error(`Workspace root ${root} is not a directory.`);
  return real;
}

/** Protocol core, independent of stdio (send receives each outgoing message object). */
export function createMcpServer({ root, adoptClientRoots = false, switchable = adoptClientRoots, bridgeDirectory = defaultBridgeDirectory(), send, log = () => {} }) {
  let handlers = createMcpHandlers({ root, bridgeDirectory, log });
  let initialized = false, clientRoots = false, rootsRequest = 0, rootsWait = null;
  /** Ask the client for its project folders (MCP roots) and work in the first local one. */
  const requestRoots = () => {
    const id = `pixelstudio-roots-${++rootsRequest}`;
    let settle;
    const timer = setTimeout(() => settle?.(), ROOTS_TIMEOUT_MS);
    rootsWait = { id, done: new Promise(done => { settle = () => { clearTimeout(timer); rootsWait = rootsWait?.id === id ? null : rootsWait; done(); }; }) };
    rootsWait.settle = settle;
    send({ jsonrpc: '2.0', id, method: 'roots/list' });
  };
  const useRoot = real => {
    if (real === root) return;
    root = real;
    handlers = createMcpHandlers({ root, bridgeDirectory, log });
  };
  const setWorkspace = async args => {
    const path = args?.path;
    if (typeof path !== 'string' || !isAbsolute(path)) return { content: [{ type: 'text', text: 'set_workspace needs the absolute path of an existing project folder.' }], isError: true };
    let real;
    try { real = await realpath(path); if (!(await stat(real)).isDirectory()) throw new Error('not a directory'); }
    catch { return { content: [{ type: 'text', text: `${path} is not an existing folder.` }], isError: true }; }
    if (real === parse(real).root || real === (await realpath(homedir()).catch(() => homedir()))) return { content: [{ type: 'text', text: `Use a project folder, not ${real}.` }], isError: true };
    useRoot(real);
    log(`workspace root ${root} (set_workspace)`);
    return { content: [{ type: 'text', text: `Workspace root is now ${root}. Paths in other tools are relative to it.` }] };
  };
  const adoptRoots = async roots => {
    for (const entry of Array.isArray(roots) ? roots : []) {
      if (typeof entry?.uri !== 'string' || !entry.uri.startsWith('file:')) continue;
      try {
        const real = await realpath(fileURLToPath(entry.uri));
        if (!(await stat(real)).isDirectory()) continue;
        if (real !== root) { useRoot(real); log(`workspace root ${root} (from the client's roots)`); }
        return;
      } catch { /* try the next root */ }
    }
  };
  const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
  const failure = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  const methods = {
    async initialize(params) {
      initialized = true;
      clientRoots = adoptClientRoots && Boolean(params?.capabilities?.roots);
      const requested = params?.protocolVersion;
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'pixel-studio', title: 'Pixel Studio', version: PACKAGE_VERSION },
        instructions: `${INSTRUCTIONS}\nWorkspace root: ${root}.${switchable ? ' This is a fallback folder: before creating or editing files, call set_workspace with the absolute path of the project you are working in.' : ''}`,
      };
    },
    ping: async () => ({}),
    'tools/list': async () => ({ tools: switchable ? [...handlers.listTools(), SET_WORKSPACE_TOOL] : handlers.listTools() }),
    async 'tools/call'(params) {
      if (!params || typeof params.name !== 'string') throw Object.assign(new Error('tools/call needs a tool name.'), { code: -32602 });
      if (params.arguments !== undefined && (typeof params.arguments !== 'object' || params.arguments === null || Array.isArray(params.arguments))) throw Object.assign(new Error('Tool arguments must be an object.'), { code: -32602 });
      await rootsWait?.done;
      if (switchable && params.name === SET_WORKSPACE_TOOL.name) return setWorkspace(params.arguments);
      const out = await handlers.callTool(params.name, params.arguments);
      if (!out) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { code: -32602 });
      return out;
    },
    'resources/list': async () => { await rootsWait?.done; return { resources: await handlers.listResources() }; },
    'resources/templates/list': async () => ({ resourceTemplates: [] }),
    async 'resources/read'(params) {
      const contents = await handlers.readResource(params?.uri);
      if (!contents) throw Object.assign(new Error(`Resource not found: ${params?.uri}`), { code: -32002 });
      return { contents };
    },
    'prompts/list': async () => ({ prompts: handlers.listPrompts() }),
    async 'prompts/get'(params) {
      let prompt;
      try { prompt = handlers.getPrompt(params?.name, params?.arguments || {}); }
      catch (error) { throw Object.assign(error, { code: -32602 }); }
      if (!prompt) throw Object.assign(new Error(`Unknown prompt: ${params?.name}`), { code: -32602 });
      return prompt;
    },
    'logging/setLevel': async () => ({}),
  };

  return {
    get initialized() { return initialized; },
    /** Handle one incoming JSON-RPC message (already parsed, or a raw line). */
    async receive(message) {
      if (typeof message === 'string') {
        if (!message.trim()) return;
        try { message = JSON.parse(message); } catch { failure(null, -32700, 'Parse error: each line must be one JSON-RPC message.'); return; }
      }
      if (Array.isArray(message)) { failure(null, -32600, 'JSON-RPC batches are not supported (MCP 2025-06-18).'); return; }
      if (!message || message.jsonrpc !== '2.0' || (typeof message.method !== 'string' && !('result' in message || 'error' in message))) {
        failure(message?.id ?? null, -32600, 'Invalid JSON-RPC 2.0 message.');
        return;
      }
      if (typeof message.method !== 'string') { // a response to a server request: only roots/list is sent
        if (rootsWait && message.id === rootsWait.id) {
          const wait = rootsWait;
          if (message.result) await adoptRoots(message.result.roots);
          wait.settle();
        }
        return;
      }
      const isRequest = message.id !== undefined && message.id !== null;
      if (!isRequest) { // notifications: initialized, cancelled, roots/list_changed… need no answer
        if (clientRoots && (message.method === 'notifications/initialized' || message.method === 'notifications/roots/list_changed')) requestRoots();
        return;
      }
      const method = methods[message.method];
      if (!method) { failure(message.id, -32601, `Method not found: ${message.method}`); return; }
      try { result(message.id, await method(message.params)); }
      catch (error) {
        log(`${message.method} failed: ${error.stack || error.message}`);
        failure(message.id, Number.isInteger(error.code) ? error.code : error instanceof ToolError ? -32602 : -32603, error.message || 'Internal error');
      }
    },
  };
}

export async function runStdioServer({ root: rootOption, bridgeDirectory } = {}) {
  const root = await workspaceRoot(rootOption);
  const log = line => process.stderr.write(`[pixel-studio mcp] ${line}\n`);
  const cwd = process.cwd();
  // Started from a plugin cache or "/": the folder is a guess, so take the client's roots or a set_workspace call.
  const fallback = !rootOption && (cwd === parse(cwd).root || Boolean(PLUGIN_ROOT && (realpathSync(cwd) + sep).startsWith(PLUGIN_ROOT + sep)));
  const server = createMcpServer({ root, adoptClientRoots: fallback, bridgeDirectory: bridgeDirectory || defaultBridgeDirectory(), log, send: message => process.stdout.write(`${JSON.stringify(message)}\n`) });
  log(`ready (MCP ${PROTOCOL_VERSION}), workspace root ${root}`);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inflight = new Set();
  lines.on('line', line => {
    const job = server.receive(line).catch(error => log(error.stack || error.message)).finally(() => inflight.delete(job));
    inflight.add(job);
  });
  await new Promise(done => lines.once('close', done));
  await Promise.allSettled([...inflight]);
}

export function parseMcpArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--root') options.root = args[++i];
    else if (a.startsWith('--root=')) options.root = a.slice(7);
    else if (a === '--bridge-dir') options.bridgeDirectory = args[++i];
    else if (a.startsWith('--bridge-dir=')) options.bridgeDirectory = a.slice(13);
    else throw new Error(`Unknown MCP option ${a}. Use --root DIR.`);
  }
  if (options.root === undefined && process.env.PIXELSTUDIO_ROOT) options.root = process.env.PIXELSTUDIO_ROOT;
  return options;
}

const isMain = () => { try { return import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href; } catch { return false; } };
if (process.argv[1] && isMain()) {
  try { await runStdioServer(parseMcpArgs(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`[pixel-studio mcp] ${error.message}\n`); process.exitCode = 1; }
}
