/** MCP client configuration snippets for Pixel Studio (shared by the in-app dialog and `pixelstudio skills install`). */

const json = value => JSON.stringify(value, null, 2);
const toml = value => JSON.stringify(value);
const shellQuote = value => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * command: node executable; cli: absolute path of local/cli.mjs; root: default workspace for desktop apps.
 * Returns [{ id, client, where, language, text, note }].
 */
export function mcpSnippets({ command = 'node', cli = '/path/to/Pixel-studio/local/cli.mjs', root = '~/PixelStudio' } = {}) {
  const args = [cli, 'mcp'];
  return [
    {
      id: 'claude-code', client: 'Claude Code', where: 'Terminal, in your project folder', language: 'shell',
      text: `claude mcp add pixelstudio -- ${[command, ...args].map(shellQuote).join(' ')}`,
      note: 'Files are read and written in the folder you start Claude Code in. Add --scope user to use it everywhere.',
    },
    {
      id: 'claude-desktop', client: 'Claude Desktop', where: 'Settings → Developer → Edit Config (claude_desktop_config.json)', language: 'json',
      text: json({ mcpServers: { pixelstudio: { command, args: [...args, '--root', root] } } }),
      note: 'Restart Claude Desktop afterwards. Sprites are saved in the --root folder.',
    },
    {
      id: 'vscode', client: 'VS Code · GitHub Copilot', where: '.vscode/mcp.json in your workspace', language: 'json',
      text: json({ servers: { pixelstudio: { type: 'stdio', command, args: [...args, '--root', '${workspaceFolder}'] } } }),
      note: 'Open Copilot Chat in Agent mode and enable the pixelstudio tools.',
    },
    {
      id: 'copilot-cli', client: 'GitHub Copilot CLI', where: '~/.copilot/mcp-config.json (or /mcp add)', language: 'json',
      text: json({ mcpServers: { pixelstudio: { type: 'local', command, args, tools: ['*'] } } }),
      note: 'Uses the folder you start copilot in as the workspace.',
    },
    {
      id: 'cursor', client: 'Cursor', where: '~/.cursor/mcp.json (or .cursor/mcp.json in a project)', language: 'json',
      text: json({ mcpServers: { pixelstudio: { command, args: [...args, '--root', '${workspaceFolder}'] } } }),
      note: 'Enable the server in Cursor Settings → MCP.',
    },
    {
      id: 'codex', client: 'OpenAI Codex', where: '~/.codex/config.toml', language: 'toml',
      text: `[mcp_servers.pixelstudio]\ncommand = ${toml(command)}\nargs = ${toml(args)}`,
      note: 'Codex starts the server in your session folder, which becomes the workspace.',
    },
  ];
}

/** The skills installer command for this checkout. */
export function skillsCommand({ command = 'node', cli = '/path/to/Pixel-studio/local/cli.mjs' } = {}, target = 'all') {
  return `${[command, cli].map(shellQuote).join(' ')} skills install --target ${target}`;
}
