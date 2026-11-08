import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installSkills, listSkills, mcpSetupText } from '../local/skills.mjs';
import { skillReference } from '../local/skill-reference.mjs';

const WORK = fileURLToPath(new URL(`./.work-skills-${process.pid}/`, import.meta.url));

test('skills have valid frontmatter and an up-to-date PXA 2 reference', async () => {
  const skills = await listSkills();
  assert.deepEqual(skills.map(s => s.name), ['pixel-studio', 'pixel-studio-animate']);
  for (const skill of skills) {
    assert.match(skill.name, /^[a-z0-9-]{1,64}$/);
    assert.ok(skill.description.length > 40 && skill.description.length <= 1024, skill.name);
  }
  assert.equal(await readFile(new URL('../skills/pixel-studio/reference/pxa2-format.md', import.meta.url), 'utf8'), skillReference(), 'run npm run formats');
});

test('installs skills per agent in user and project scope', async t => {
  t.after(() => rm(WORK, { recursive: true, force: true }));
  const home = `${WORK}home`, cwd = `${WORK}project`;
  const user = await installSkills({ target: 'all', home, cwd });
  assert.deepEqual(user.map(r => r.directory), [`${home}/.claude/skills`, `${home}/.copilot/skills`, `${home}/.agents/skills`, `${home}/.cursor/skills`]);
  assert.match(await readFile(`${home}/.claude/skills/pixel-studio/SKILL.md`, 'utf8'), /^---\nname: pixel-studio\n/);
  assert.ok(await readFile(`${home}/.agents/skills/pixel-studio/reference/pxa2-format.md`, 'utf8'));
  const project = await installSkills({ target: 'copilot,cursor', project: true, home, cwd });
  assert.deepEqual(project.map(r => r.directory), [`${cwd}/.github/skills`, `${cwd}/.cursor/skills`]);
  assert.match(await readFile(`${cwd}/.cursor/rules/pixel-studio.mdc`, 'utf8'), /^---\ndescription: .+\nalwaysApply: false\n---/);
  await assert.rejects(installSkills({ target: 'emacs', home, cwd }), /Unknown target "emacs"/);
});

test('MCP setup text covers every client with the absolute CLI path', () => {
  const text = mcpSetupText({ command: '/usr/bin/node', cli: '/opt/pixel studio/local/cli.mjs', root: '/home/me/PixelStudio' });
  for (const client of ['Claude Code', 'Claude Desktop', 'VS Code', 'Cursor', 'Codex']) assert.match(text, new RegExp(client));
  assert.match(text, /claude mcp add pixelstudio -- \/usr\/bin\/node '\/opt\/pixel studio\/local\/cli.mjs' mcp/);
  assert.match(text, /\[mcp_servers\.pixelstudio\]\ncommand = "\/usr\/bin\/node"\nargs = \["\/opt\/pixel studio\/local\/cli.mjs","mcp"\]/);
  assert.match(text, /"mcpServers": \{\n {4}"pixelstudio"/);
});
