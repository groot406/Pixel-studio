#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createLocalServer } from './server.mjs';
import { defaultBridgeDirectory } from './bridge.mjs';
import { buildSite } from '../scripts/build.mjs';
import { watchSite } from '../scripts/watch.mjs';

function options(args) {
  let port = Number(process.env.PORT || 4317);
  let open = false;
  let dev = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--open') open = true;
    else if (argument === '--dev') dev = true;
    else if (argument === '--strictPort') { /* Already enforced: listen never falls back to another port. */ }
    else if (argument === '--port') port = Number(args[++index]);
    else if (argument.startsWith('--port=')) port = Number(argument.slice(7));
    else if (argument === '--host') {
      if (!['127.0.0.1', 'localhost'].includes(args[++index])) throw new Error('Pixel Studio Local only listens on 127.0.0.1.');
    } else if (argument === '--help' || argument === '-h') return { help: true };
    else throw new Error(`Unknown option: ${argument}. Use --port NUMBER or --open.`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a port from 1 to 65535.');
  return { port, open, dev };
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!command) return;
  const child = spawn(command, [url], { stdio: 'ignore', detached: true, shell: false });
  child.on('error', () => {});
  child.unref();
}

let app;
let stopWatching;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await stopWatching?.();
  await app?.close();
  process.exit(0);
}

try {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Pixel Studio Local requires Node.js 20 or newer.');
  const selected = options(process.argv.slice(2));
  if (selected.help) {
    process.stdout.write('Pixel Studio Local\n\nnode local/start.mjs [--port 4317] [--open] [--dev]\n\nUses your local Codex ChatGPT login. Run codex login if needed.\nImage generation (Generate with an image model) reads OPENAI_API_KEY and GEMINI_API_KEY\n(or GOOGLE_API_KEY) from the environment, or {"openai","gemini"} from ~/.pixelstudio/keys.json.\nKeys stay on this machine and are never sent to the browser.\n');
  } else {
    await buildSite();
    app = createLocalServer({ bridgeDirectory: defaultBridgeDirectory() });
    const url = await app.listen(selected.port);
    if (selected.dev) stopWatching = watchSite();
    process.stdout.write(`\nPixel Studio Local\n${url}\n\nAI editing uses your local Codex ChatGPT login.\nRun codex login in Terminal if the app asks you to connect.\nImage models use OPENAI_API_KEY / GEMINI_API_KEY or ~/.pixelstudio/keys.json.\nPress Ctrl+C to stop.\n\n`);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (selected.open) openBrowser(url);
  }
} catch (error) {
  const message = error.code === 'EADDRINUSE'
    ? 'That port is already in use. Stop the other Pixel Studio instance or use --port 4318.'
    : error.code === 'ENOENT'
      ? 'Pixel Studio files are missing. Extract the complete download before starting it.'
      : error.message || 'Pixel Studio could not start.';
  process.stderr.write(`Pixel Studio: ${message}\n`);
  process.exitCode = 1;
}
