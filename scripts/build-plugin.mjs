#!/usr/bin/env node
/**
 * Builds plugins/pixel-studio: one self-contained agent plugin for OpenAI Codex / ChatGPT (portable plugin.json +
 * mcp.json) and Claude Code (.claude-plugin/plugin.json + .mcp.json). It bundles the skills and a copy of the
 * stdio MCP server with exactly the source files it imports, so it runs from the plugin cache without this repo.
 *
 *   npm run plugin            rebuild plugins/pixel-studio
 *   node scripts/build-plugin.mjs --out DIR
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePng } from '../src/formats/png.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_NAME = 'pixel-studio';
export const PLUGIN_DIR = join(REPO, 'plugins', PLUGIN_NAME);
const SERVER_ENTRY = 'local/mcp.mjs';
const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/** Every repo file the MCP server imports (relative paths, sorted). */
export async function serverFiles(entry = SERVER_ENTRY) {
  const seen = new Set(), stack = [resolve(REPO, entry)];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) stack.push(resolve(dirname(file), match[1] || match[2]));
  }
  return [...seen].map(file => relative(REPO, file)).sort();
}

/** Data files the server reads at runtime (relative to its repo root). */
const SERVER_DATA = ['package.json', 'public/samples', 'skills/pixel-studio/SKILL.md'];

function manifests(version) {
  const description = 'Create, edit, animate and export pixel art with Pixel Studio: PXA sprite files, rendering, image-to-pixel clean-up, palettes, walk/run templates and a live link to the open editor.';
  const plugin = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: PLUGIN_NAME,
    version,
    description,
    author: { name: 'Pixel Studio', url: 'https://github.com/groot406/Pixel-studio' },
    homepage: 'https://github.com/groot406/Pixel-studio',
    repository: 'https://github.com/groot406/Pixel-studio',
    keywords: ['pixel-art', 'sprites', 'animation', 'game-dev', 'mcp'],
    extensions: {
      'com.openai': {
        interface: {
          displayName: 'Pixel Studio',
          shortDescription: 'Draw, animate and export pixel-art sprites',
          longDescription: `${description} Requires Node.js 20 or newer. Files stay in your workspace.`,
          developerName: 'Pixel Studio',
          category: 'Design',
          capabilities: ['Read', 'Write'],
          websiteURL: 'https://github.com/groot406/Pixel-studio',
          defaultPrompt: [
            'Use Pixel Studio to draw a 32×32 knight sprite and render it.',
            'Use Pixel Studio to turn hero.png into clean pixel art with 16 colours.',
            'Use Pixel Studio to add a walk cycle to my rigged character and export a sprite sheet.',
          ],
          brandColor: '#285B47',
          composerIcon: './assets/icon.png',
          logo: './assets/icon.png',
        },
      },
    },
  };
  const server = (root) => ({ command: 'node', args: [`${root}/server/${SERVER_ENTRY}`] });
  return {
    'plugin.json': plugin,
    'mcp.json': { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { pixelstudio: { type: 'stdio', ...server('${PLUGIN_ROOT}') } } },
    '.claude-plugin/plugin.json': { name: PLUGIN_NAME, version, description, author: plugin.author, homepage: plugin.homepage, repository: plugin.repository, keywords: plugin.keywords },
    '.mcp.json': { mcpServers: { pixelstudio: server('${CLAUDE_PLUGIN_ROOT}') } },
  };
}

/** The 2×2 Pixel Studio mark on a rounded tile, 64×64. */
async function icon() {
  const size = 64, rgba = new Uint8ClampedArray(size * size * 4);
  const fill = (x0, y0, w, h, [r, g, b]) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) rgba.set([r, g, b, 255], (y * size + x) * 4); };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const cx = Math.max(0, 10 - x, x - 53), cy = Math.max(0, 10 - y, y - 53);
    if (cx * cx + cy * cy <= 100) rgba.set([246, 248, 241, 255], (y * size + x) * 4);
  }
  const dark = [40, 91, 71], light = [124, 176, 120];
  fill(14, 14, 16, 16, dark); fill(34, 14, 16, 16, dark); fill(14, 34, 16, 16, dark); fill(34, 34, 16, 16, light);
  return encodePng(rgba, size, size);
}

export async function buildPlugin(out = PLUGIN_DIR) {
  const { version } = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'));
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, '.claude-plugin'), { recursive: true });
  for (const [file, data] of Object.entries(manifests(version))) await writeFile(join(out, file), `${JSON.stringify(data, null, 2)}\n`);
  await cp(join(REPO, 'skills'), join(out, 'skills'), { recursive: true });
  for (const file of [...await serverFiles(), ...SERVER_DATA]) await cp(join(REPO, file), join(out, 'server', file), { recursive: true });
  await mkdir(join(out, 'assets'), { recursive: true });
  await writeFile(join(out, 'assets', 'icon.png'), await icon());
  await writeFile(join(out, 'README.md'), `# Pixel Studio agent plugin

Generated by \`npm run plugin\` from the Pixel Studio repository — do not edit by hand.

Bundles the \`pixel-studio\` and \`pixel-studio-animate\` skills and the Pixel Studio MCP server (\`server/local/mcp.mjs\`, Node.js 20+).
The MCP server works on files in the folder the agent runs in; with Pixel Studio Local open (\`npm start\`) it can also read and edit the open editor tab.

- **Codex / ChatGPT desktop:** \`codex plugin marketplace add groot406/Pixel-studio\`, then install *Pixel Studio* from the Plugins directory (or \`/plugins\` in Codex CLI).
- **Claude Code:** \`/plugin marketplace add groot406/Pixel-studio\`, then \`/plugin install pixel-studio@pixel-studio\`.
- **From a clone:** \`node local/cli.mjs plugin install\` adds it to your personal Codex marketplace.
`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const at = process.argv.indexOf('--out');
  const out = await buildPlugin(at > 0 ? resolve(process.argv[at + 1]) : PLUGIN_DIR);
  process.stdout.write(`Built the Pixel Studio agent plugin in ${relative(process.cwd(), out) || '.'}\n`);
}
