#!/usr/bin/env node
/**
 * Pixel Studio MCP server: Model Context Protocol over stdio (newline-delimited JSON-RPC 2.0), no SDK.
 * stdout carries only protocol messages; logs go to stderr.
 *   node local/mcp.mjs [--root DIR] [--bridge-dir DIR]
 */
import { createInterface } from 'node:readline';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMcpHandlers, PACKAGE_VERSION, ToolError } from './mcp-tools.mjs';
import { defaultBridgeDirectory } from './bridge.mjs';

export const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = `Pixel Studio is a pixel-art and sprite-animation editor. Projects are plain-text PXA 2 documents (.pxa) or binary .pxs files inside the workspace root.
Workflow: pixel_guide → create_project or read_project → edit the PXA text → write_project (validates; returns line-precise errors or a preview image) → look at the preview and iterate → export (PNG, sprite sheet, GIF).
Use apply_template for walk/run/jump/idle/wave/hover on rigged characters (BONE lines), image_to_pixels to clean up generated images, and set_palette for palette presets.
editor_* tools edit the project open in the user's Pixel Studio Local editor (live bridge); every applied change is one undo step for the user.`;

/** Resolve the workspace root: --root, else the current directory (or ~/PixelStudio when started from "/"). */
export async function workspaceRoot(option) {
  let root = option ? resolve(option) : process.cwd();
  if (!option && root === parse(root).root) root = join(homedir(), 'PixelStudio');
  await mkdir(root, { recursive: true });
  const real = await realpath(root);
  if (!(await stat(real)).isDirectory()) throw new Error(`Workspace root ${root} is not a directory.`);
  return real;
}

/** Protocol core, independent of stdio (send receives each outgoing message object). */
export function createMcpServer({ root, bridgeDirectory = defaultBridgeDirectory(), send, log = () => {} }) {
  const handlers = createMcpHandlers({ root, bridgeDirectory, log });
  let initialized = false;
  const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
  const failure = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  const methods = {
    async initialize(params) {
      initialized = true;
      const requested = params?.protocolVersion;
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'pixel-studio', title: 'Pixel Studio', version: PACKAGE_VERSION },
        instructions: `${INSTRUCTIONS}\nWorkspace root: ${root}`,
      };
    },
    ping: async () => ({}),
    'tools/list': async () => ({ tools: handlers.listTools() }),
    async 'tools/call'(params) {
      if (!params || typeof params.name !== 'string') throw Object.assign(new Error('tools/call needs a tool name.'), { code: -32602 });
      if (params.arguments !== undefined && (typeof params.arguments !== 'object' || params.arguments === null || Array.isArray(params.arguments))) throw Object.assign(new Error('Tool arguments must be an object.'), { code: -32602 });
      const out = await handlers.callTool(params.name, params.arguments);
      if (!out) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { code: -32602 });
      return out;
    },
    'resources/list': async () => ({ resources: await handlers.listResources() }),
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
      if (typeof message.method !== 'string') return; // a response to a server request; none are sent
      const isRequest = message.id !== undefined && message.id !== null;
      if (!isRequest) return; // notifications: initialized, cancelled, roots/list_changed… need no answer
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
  const server = createMcpServer({ root, bridgeDirectory: bridgeDirectory || defaultBridgeDirectory(), log, send: message => process.stdout.write(`${JSON.stringify(message)}\n`) });
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runStdioServer(parseMcpArgs(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`[pixel-studio mcp] ${error.message}\n`); process.exitCode = 1; }
}
