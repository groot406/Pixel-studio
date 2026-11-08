/**
 * Installs the packaged Pixel Studio agent plugin (skills + bundled MCP server) into Codex / ChatGPT desktop via the
 * personal marketplace: ~/.codex/plugins/pixel-studio + an entry in ~/.agents/plugins/marketplace.json.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildPlugin, PLUGIN_NAME } from '../scripts/build-plugin.mjs';

export const PERSONAL_MARKETPLACE = { name: 'personal', interface: { displayName: 'Personal' } };

export function marketplaceEntry(path) {
  return { name: PLUGIN_NAME, source: { source: 'local', path }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Design' };
}

/** Add or replace the pixel-studio entry, keeping every other plugin and setting in the marketplace. */
export function upsertMarketplace(existing, entry) {
  const market = existing && typeof existing === 'object' ? { ...existing } : { ...PERSONAL_MARKETPLACE };
  market.name ||= PERSONAL_MARKETPLACE.name;
  market.interface ||= { ...PERSONAL_MARKETPLACE.interface };
  const plugins = Array.isArray(market.plugins) ? market.plugins.filter(plugin => plugin?.name !== entry.name) : [];
  market.plugins = [...plugins, entry];
  return market;
}

export async function installCodexPlugin({ home = homedir() } = {}) {
  const directory = join(home, '.codex', 'plugins', PLUGIN_NAME);
  const marketplace = join(home, '.agents', 'plugins', 'marketplace.json');
  await buildPlugin(directory);
  let existing = null;
  try { existing = JSON.parse(await readFile(marketplace, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot update ${marketplace}: ${error.message}. Fix or remove it and try again.`);
  }
  // The personal marketplace root is the home directory: source paths are relative to it.
  const market = upsertMarketplace(existing, marketplaceEntry(`./.codex/plugins/${PLUGIN_NAME}`));
  await mkdir(join(home, '.agents', 'plugins'), { recursive: true });
  await writeFile(marketplace, `${JSON.stringify(market, null, 2)}\n`);
  return { directory, marketplace, id: `${PLUGIN_NAME}@${market.name}` };
}

export function pluginInstructions({ directory, marketplace, id }) {
  return `Installed the Pixel Studio plugin for Codex → ${directory}
Listed it in your personal marketplace → ${marketplace}

Next:
  • ChatGPT desktop / Codex app: restart it, open Plugins, choose the "${id.split('@')[1]}" source and install Pixel Studio.
  • Codex CLI: run /plugins and install Pixel Studio (or enable it per project in .codex/config.toml:
      [plugins."${id}"]
      enabled = true)
  • Then ask: "Use Pixel Studio to draw a 32×32 knight sprite and render it." (Node.js 20+ required.)

Without a clone: codex plugin marketplace add groot406/Pixel-studio
Claude Code:     /plugin marketplace add groot406/Pixel-studio  then  /plugin install pixel-studio@pixel-studio`;
}
