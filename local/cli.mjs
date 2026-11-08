#!/usr/bin/env node
/** Pixel Studio command line: inspect, render, convert, pixelize and export sprites; run the MCP server; install skills. */
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  exportProject, formatOf, formatSummary, imageToProject, lintPxa, loadProject, projectSummary, renderPng, saveProject, writeBytes, writeExport,
} from './headless.mjs';

const USAGE = `Pixel Studio CLI

Usage: pixelstudio <command> [options]

  info <file>                          Summary of a .pxa/.pxs/.pixel.json project (--json for JSON)
  validate <file.pxa>                  Check PXA text and print line-precise errors
  render <file> [-o out.png]           Render a frame to PNG
        [--frame n|id] [--animation id|name] [--scale n] [--strip] [--background checker|transparent|#rrggbb]
  convert <in> <out>                   Convert between .pxa, .pxs and .pixel.json (or .png → project)
  pixelize <image.png> [-o out.pxa]    Turn an image into a clean pixel-art project
        [--colors 16] [--pixel-size n] [--max-size 128] [--keep-background]
  export <file> --sheet|--gif|--apng|--png -o <out>
        [--animation id] [--scale n] [--columns n] [--project]
  mcp [--root dir]                     Start the MCP server on stdio (for Claude, Copilot, Cursor, Codex…)
  skills install [--target claude|copilot|codex|cursor|all] [--project]
                                       Install the Pixel Studio agent skills and print MCP config snippets
  skills config                        Print MCP config snippets only
  serve [--port 4317] [--open]         Start Pixel Studio Local (editor + live agent bridge)
`;

class UsageError extends Error {}

/** Split argv into positionals and options. Flags listed in `booleans` take no value. */
export function parseArgs(args, booleans = []) {
  const positional = [], options = {};
  const aliases = { o: 'out', h: 'help' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') { positional.push(...args.slice(i + 1)); break; }
    const match = /^--?([a-zA-Z][\w-]*)(?:=(.*))?$/.exec(arg);
    if (!match) { positional.push(arg); continue; }
    const key = aliases[match[1]] || match[1];
    if (match[2] !== undefined) options[key] = match[2];
    else if (booleans.includes(key)) options[key] = true;
    else if (i + 1 >= args.length) throw new UsageError(`Option --${key} needs a value.`);
    else options[key] = args[++i];
  }
  return { positional, options };
}

const number = (value, name) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number.`);
  return n;
};
const frameRef = value => value === undefined ? undefined : /^\d+$/.test(value) ? Number(value) : value;
const need = (value, what) => { if (!value) throw new UsageError(`Missing ${what}.\n\n${USAGE}`); return value; };
const say = text => process.stdout.write(`${text}\n`);

const commands = {
  async info(args) {
    const { positional, options } = parseArgs(args, ['json']);
    const { project } = await loadProject(need(positional[0], 'project file'));
    const summary = projectSummary(project);
    say(options.json ? JSON.stringify(summary, null, 2) : formatSummary(summary));
  },

  async validate(args) {
    const { positional } = parseArgs(args);
    const file = need(positional[0], 'PXA file');
    const result = lintPxa(await readFile(file, 'utf8'));
    for (const e of result.errors) say(`${file}:${e.line ?? '?'}: error: ${e.message}${e.source ? `\n    ${e.source}` : ''}`);
    for (const w of result.warnings || []) say(`${file}: warning: ${w}`);
    if (result.ok) say(`${file}: OK — ${formatSummary(result.summary).split('\n')[0]}`);
    else { if (result.hint) say(result.hint); process.exitCode = 1; }
  },

  async render(args) {
    const { positional, options } = parseArgs(args, ['strip']);
    const file = need(positional[0], 'project file');
    const { project } = await loadProject(file);
    const result = await renderPng(project, {
      animation: frameRef(options.animation), frame: frameRef(options.frame), scale: number(options.scale, 'scale'),
      background: options.background || 'transparent', strip: Boolean(options.strip), layer: options.layer,
    });
    const out = options.out || `${basename(file, extname(file)).replace(/\.pixel$/, '')}.png`;
    await writeBytes(out, result.png);
    say(`Wrote ${out} (${result.width}×${result.height}, ${result.frames.length} frame${result.frames.length === 1 ? '' : 's'} of "${result.animation.name}", scale ${result.scale}).`);
  },

  async convert(args) {
    const { positional, options } = parseArgs(args);
    const input = need(positional[0], 'input file'), out = need(positional[1] || options.out, 'output file');
    if (formatOf(out) === 'png') throw new UsageError('Use `pixelstudio render` or `export` to write PNG images.');
    const { project } = await loadProject(input);
    const size = await saveProject(out, project, { pxaVersion: options.pxa === '1' ? 1 : 2 });
    say(`Wrote ${out} (${size} bytes).`);
    if (formatOf(out) === 'pxs' && project.version >= 3) say('Note: .pxs stores flattened pixels; parts, objects and bones are kept only in .pxa or .pixel.json.');
  },

  async pixelize(args) {
    const { positional, options } = parseArgs(args, ['keep-background', 'no-trim']);
    const input = need(positional[0], 'PNG image');
    const result = await imageToProject(await readFile(input), {
      colors: number(options.colors, 'colors') ?? 16, pixelSize: number(options['pixel-size'], 'pixel-size'),
      maxSize: number(options['max-size'], 'max-size') ?? 128, background: !options['keep-background'], trim: !options['no-trim'],
      palette: options.palette, name: options.name || basename(input, extname(input)),
    });
    const out = options.out || `${basename(input, extname(input))}.pxa`;
    await saveProject(out, result.project);
    say(`Wrote ${out}: ${result.project.width}×${result.project.height}, ${result.project.palette.length} colours (from ${result.source.width}×${result.source.height}${result.grid?.scale > 1 ? `, detected ${result.grid.scale}px grid` : ''}).`);
  },

  async export(args) {
    const { positional, options } = parseArgs(args, ['sheet', 'gif', 'apng', 'png', 'sequence', 'project']);
    const file = need(positional[0], 'project file'), out = need(options.out, 'output path (-o)');
    const kind = ['sheet', 'gif', 'apng', 'sequence', 'png'].find(k => options[k]) || ({ '.gif': 'gif', '.zip': 'sequence' }[extname(out).toLowerCase()] ?? 'sheet');
    const { project } = await loadProject(file);
    const result = await exportProject(project, {
      kind, animation: frameRef(options.animation), frame: frameRef(options.frame), scale: number(options.scale, 'scale') ?? 1,
      columns: number(options.columns, 'columns') ?? 0, layout: options.layout || 'rows', scope: options.project ? 'project' : options.scope,
    });
    const written = await writeExport(result, out);
    say(`Exported ${kind}: ${written.join(', ')}`);
  },

  async mcp(args) {
    const { runStdioServer, parseMcpArgs } = await import('./mcp.mjs');
    await runStdioServer(parseMcpArgs(args));
  },

  async skills(args) {
    const { positional, options } = parseArgs(args, ['project']);
    const { installSkills, mcpSetupText } = await import('./skills.mjs');
    const action = positional[0] || 'install';
    if (action === 'config') { say(mcpSetupText()); return; }
    if (action !== 'install') throw new UsageError(`Unknown skills action "${action}". Use install or config.`);
    const results = await installSkills({ target: options.target || 'all', project: Boolean(options.project) });
    for (const r of results) say(`Installed ${r.skills.join(', ')} for ${r.label} → ${r.directory}${r.extra.length ? ` (+ ${r.extra.join(', ')})` : ''}`);
    say(`\n${mcpSetupText()}`);
  },

  async serve(args) {
    const start = join(fileURLToPath(new URL('.', import.meta.url)), 'start.mjs');
    const child = spawn(process.execPath, [start, ...args], { stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    await new Promise(done => child.once('exit', code => { process.exitCode = code ?? 0; done(); }));
  },
};

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') { process.stdout.write(USAGE); return; }
  if (command === '--version' || command === '-v') {
    say(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
    return;
  }
  const run = commands[command];
  if (!run) throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  await run(rest);
}

const invokedPath = () => { try { return realpathSync(process.argv[1]); } catch { return resolve(process.argv[1]); } };
if (process.argv[1] && invokedPath() === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`pixelstudio: ${error.message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}
