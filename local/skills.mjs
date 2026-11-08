/**
 * Installs the Pixel Studio agent skills (skills/<name>/SKILL.md + reference files) for AI coding agents and prints
 * MCP configuration snippets.
 */
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpSnippets, skillsCommand } from '../src/bridge/mcp-config.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_SOURCE = join(REPO, 'skills');
export const CLI_PATH = join(REPO, 'local', 'cli.mjs');

/** Skill directories per agent: user (global) scope and project scope. */
export const SKILL_TARGETS = {
  claude: { label: 'Claude Code', user: home => join(home, '.claude', 'skills'), project: cwd => join(cwd, '.claude', 'skills') },
  copilot: { label: 'GitHub Copilot', user: home => join(home, '.copilot', 'skills'), project: cwd => join(cwd, '.github', 'skills') },
  codex: { label: 'OpenAI Codex', user: home => join(home, '.agents', 'skills'), project: cwd => join(cwd, '.agents', 'skills') },
  cursor: { label: 'Cursor', user: home => join(home, '.cursor', 'skills'), project: cwd => join(cwd, '.cursor', 'skills'), rule: true },
};

export async function listSkills(source = SKILLS_SOURCE) {
  const entries = await readdir(source, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(join(source, entry.name, 'SKILL.md'), 'utf8').catch(() => null);
    if (!text) continue;
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] || '';
    const field = key => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front)?.[1].trim();
    skills.push({ dir: entry.name, name: field('name') || entry.name, description: field('description') || '', body: text.replace(/^---[\s\S]*?---\s*/, '') });
  }
  return skills.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** A Cursor project rule (agent-requested) pointing at the installed skill. */
function cursorRule(skills, skillDir) {
  const lines = skills.map(skill => `- \`${join(skillDir, skill.dir, 'SKILL.md')}\` — ${skill.description}`);
  return `---\ndescription: Pixel art, sprites and sprite animation with Pixel Studio (.pxa / .pxs files, PXA 2 format)\nalwaysApply: false\n---\n\nWhen working on pixel art, sprites or Pixel Studio projects, read and follow:\n\n${lines.join('\n')}\n\nThe PXA 2 grammar is in \`${join(skillDir, 'pixel-studio', 'reference', 'pxa2-format.md')}\`. Prefer the pixelstudio MCP tools when they are configured.\n`;
}

/**
 * Copy every skill into the target directories. target: 'all' or a key of SKILL_TARGETS (comma separated allowed).
 * Returns [{ target, label, directory, skills: [names], extra: [paths] }].
 */
export async function installSkills({ target = 'all', project = false, cwd = process.cwd(), home = homedir(), source = SKILLS_SOURCE } = {}) {
  const keys = target === 'all' ? Object.keys(SKILL_TARGETS) : String(target).split(',').map(t => t.trim()).filter(Boolean);
  for (const key of keys) if (!SKILL_TARGETS[key]) throw new Error(`Unknown target "${key}". Use ${Object.keys(SKILL_TARGETS).join(', ')} or all.`);
  const skills = await listSkills(source);
  if (!skills.length) throw new Error(`No skills found in ${source}.`);
  const results = [];
  for (const key of keys) {
    const spec = SKILL_TARGETS[key], directory = project ? spec.project(cwd) : spec.user(home), extra = [];
    await mkdir(directory, { recursive: true });
    for (const skill of skills) await cp(join(source, skill.dir), join(directory, skill.dir), { recursive: true, force: true });
    if (spec.rule && project) {
      const rule = join(cwd, '.cursor', 'rules', 'pixel-studio.mdc');
      await mkdir(dirname(rule), { recursive: true });
      await writeFile(rule, cursorRule(skills, '.cursor/skills'));
      extra.push(rule);
    }
    results.push({ target: key, label: spec.label, directory, skills: skills.map(s => s.name), extra });
  }
  return results;
}

/** Human-readable MCP setup instructions for every client. */
export function mcpSetupText({ command = process.execPath, cli = CLI_PATH, root = join(homedir(), 'PixelStudio') } = {}) {
  const parts = ['Connect the Pixel Studio MCP server (tools to create, render and export sprites, plus the live editor bridge):', ''];
  for (const snippet of mcpSnippets({ command, cli, root })) {
    parts.push(`## ${snippet.client} — ${snippet.where}`, '', snippet.text, '', snippet.note, '');
  }
  parts.push(`Reinstall or update the skills any time with: ${skillsCommand({ command, cli })}`);
  return parts.join('\n');
}
