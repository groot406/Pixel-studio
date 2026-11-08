# Pixel Studio for AI agents: MCP server, CLI, skills and live bridge

Pixel Studio projects are plain-text [PXA 2](../public/pxa-v2-format.txt) documents, so language-model agents can write
them directly. This checkout ships everything an agent needs to work headless (Node.js 20+, no dependencies):

| Piece | Entry point | Purpose |
|-------|-------------|---------|
| MCP server | `node local/cli.mjs mcp [--root DIR]` (`npm run mcp`) | Tools for Claude, Copilot, Cursor, Codex and any MCP client |
| CLI | `node local/cli.mjs …` (`pixelstudio` after `npm link`) | The same operations for shell-only agents and scripts |
| Plugin | `codex plugin marketplace add groot406/Pixel-studio` / Claude Code `/plugin marketplace add …` | Skills + MCP server packaged for Codex, ChatGPT desktop and Claude Code |
| Skills | `node local/cli.mjs skills install` (`npm run skills`) | `SKILL.md` instructions: PXA 2 workflow, pixel-art and animation rules |
| Live bridge | `npm start` + an open editor | `editor_*` tools read and edit the project in the user's open tab |

## Plugin (Codex and Claude Code)

`plugins/pixel-studio` is a self-contained agent plugin: both skills, a copy of the MCP server with only the source files
it imports (`server/`), an icon and manifests for both hosts — portable `plugin.json` + `mcp.json` (Codex / ChatGPT, with
`extensions["com.openai"].interface` for the Plugins directory) and `.claude-plugin/plugin.json` + `.mcp.json` (Claude
Code). The repository is its own marketplace (`.agents/plugins/marketplace.json` and `.claude-plugin/marketplace.json`).

```sh
# Codex CLI (or add the marketplace, then install from /plugins or the ChatGPT desktop Plugins directory)
codex plugin marketplace add groot406/Pixel-studio
codex plugin add pixel-studio@pixel-studio

# Claude Code
/plugin marketplace add groot406/Pixel-studio
/plugin install pixel-studio@pixel-studio

# From a checkout: copy to ~/.codex/plugins/pixel-studio and list it in ~/.agents/plugins/marketplace.json
node local/cli.mjs plugin install        # npm run plugin:install
```

Codex starts plugin MCP servers inside the plugin cache and doesn't pass your project folder, so the server falls back
to `~/PixelStudio` and offers a `set_workspace` tool; the skill tells the agent to call it with its working directory.
Clients that support MCP roots get the project folder automatically. Run `npm run plugin` after changing the skills or
the server (`npm test` fails when the package is stale), then bump `version` in `package.json` so installs refresh.

## Connecting clients

`node local/cli.mjs skills config` prints every snippet with the absolute paths of your checkout; the app shows the
same under **Help → Docs → Connect an AI agent**.

- **Claude Code**: `claude mcp add pixelstudio -- node /abs/Pixel-studio/local/cli.mjs mcp` (add `--scope user` for all projects).
- **Claude Desktop**: Settings → Developer → Edit Config, `claude_desktop_config.json`:
  `{"mcpServers": {"pixelstudio": {"command": "node", "args": ["/abs/Pixel-studio/local/cli.mjs", "mcp", "--root", "/Users/me/PixelStudio"]}}}`.
  Desktop apps start servers in `/`, so give `--root` (without it the server uses `~/PixelStudio`).
- **VS Code / GitHub Copilot**: `.vscode/mcp.json`:
  `{"servers": {"pixelstudio": {"type": "stdio", "command": "node", "args": ["/abs/Pixel-studio/local/cli.mjs", "mcp", "--root", "${workspaceFolder}"]}}}`.
- **GitHub Copilot CLI**: `~/.copilot/mcp-config.json` with `{"mcpServers": {"pixelstudio": {"type": "local", "command": "node", "args": ["/abs/…/cli.mjs", "mcp"], "tools": ["*"]}}}` (or `/mcp add`).
- **Cursor**: `~/.cursor/mcp.json` (or `.cursor/mcp.json`) with the same `mcpServers` shape as Claude Desktop.
- **OpenAI Codex**: `~/.codex/config.toml`:
  ```toml
  [mcp_servers.pixelstudio]
  command = "node"
  args = ["/abs/Pixel-studio/local/cli.mjs", "mcp"]
  ```

`PIXELSTUDIO_ROOT` can replace `--root`. All file paths in tools are relative to the root; absolute paths, `..`
traversal and symlinks leading outside it are rejected.

## Tools

Arguments marked * are required. Frames and animations accept an id, a name or a zero-based index.

| Tool | Arguments | Result |
|------|-----------|--------|
| `pixel_guide` | `topic` (`pxa2` default, `workflow`, `pxa1`, `prompting`) | The format guide or the agent workflow/pixel-art rules |
| `list_palette_presets` | – | Built-in palettes (PICO-8, Sweetie 16, Endesga 32, Game Boy…) |
| `create_project` | `path`*, `name`, `width`, `height`, `palette` (preset id or hex list), `animation`, `frames`, `fps`, `overwrite` | New blank project; returns its PXA 2 text |
| `project_info` | `path`* | Size, palette, layers, parts, animations, bones, poses (JSON) |
| `read_project` | `path`*, `animation` | The project as PXA 2 text (optionally one animation) |
| `validate_pxa` | `pxa`* | Errors with line, message, offending source and a hint — or a summary with warnings |
| `write_project` | `path`*, `pxa`*, `overwrite`, `preview`, `previewAnimation` | Validates, then saves (`.pxa` verbatim, `.pxs`/`.pixel.json` converted) and returns a preview strip; nothing is written on errors |
| `render_png` | `path`*, `animation`, `frame`, `strip`, `scale`, `background` (`checker`/`transparent`/`#rrggbb`), `out` | Inline PNG image (and optional file) |
| `image_to_pixels` | `image`* (PNG), `out`, `colors`, `palette`, `pixelSize`, `maxSize`, `removeBackground`, `name` | Grid-detected, cleaned, quantized pixel project + preview |
| `make_parts` | `path`*, `out`, `layers` (ids or names), `rig` (default true), `animation`, `frame` | Turn drawn (raster) layers into parts and auto-rig them where they touch, ready for `apply_template` |
| `outline` | `path`*, `out`, `live` (true / false / `{color, style, mode, corners, thickness, separate, skip}`), `strip` (true or `{colors, passes, parts}`), `layers` | Remove baked-in outlines from layers and parts (all frames) and/or set the live outline that is recomputed on every render |
| `apply_template` | `path`*, `template`* (`walk`, `run`, `jump`, `idle`, `wave`, `hover`), `out`, `animation`, `frame`, `rootBone`, `frames`, `frameMs`, `amplitude`, `bounce`, `exaggeration`, `facing`, `mode` (`new`/`replace`/`merge`), `name` | Procedural animation for a rigged (BONE) character + preview strip |
| `set_palette` | `path`*, `out`, `preset` or `colors`, `remap` | Palette replaced (pixels remapped to the nearest colour by default) |
| `export` | `path`*, `format`* (`png`, `spritesheet`, `gif`, `apng`, `sequence`), `out`*, `animation`, `frame`, `scale`, `scope`, `layout`, `spacing`, `padding`, `metadata`, `background` | Files written with the editor's exporter (sheets include Aseprite/Godot/Unity metadata) |
| `editor_status` | – | Whether Pixel Studio Local runs and an editor tab is connected |
| `editor_get_project` | `preview`, `strip` | The open tab as PXA 2 + PNG preview |
| `editor_apply_project` | `pxa` or `path`, `mode` (`replace`/`new-tab`), `message` | Validated, then applied in the editor (one undo step) or opened as a new tab |
| `editor_open_file` | `path`* | Opens a workspace project in a new editor tab |
| `set_workspace` | `path`* | Only when the root is a fallback (plugin cache or `/`): switch to the agent's project folder |

Tool failures are returned as `isError` results with an actionable message (for example the PXA line to fix), so the
agent can correct itself. Arguments are checked against each tool's JSON Schema.

**Resources**: `pixelstudio://guide/pxa2`, `pixelstudio://guide/workflow`, `pixelstudio://guide/prompting`,
`pixelstudio://guide/pxa1`, and `pixelstudio://samples/<id>` (panda, red-panda, key, campfire, key-v2, puppet).
**Prompts**: `draw-sprite` (`subject`, `size`, `palette`, `path`) and `animate-sprite` (`path`, `motion`, `frames`).

## Recommended agent loop

`pixel_guide` → `create_project` / `read_project` → edit PXA → `write_project` (fix reported lines) → `render_png`
and look at the image → iterate → `export`. The `pixel-studio` skill spells this out together with pixel-art rules
(limited palettes, outlines, silhouettes, clean lines) and animation timing.

## Live editor bridge

`npm start` (or `pixelstudio serve`) writes `~/.pixelstudio/bridge.json` (`port`, random `token`; mode 0600; removed
on exit; `PIXELSTUDIO_BRIDGE_DIR` overrides the folder for both sides). The MCP process reads it and calls `POST /api/bridge/call` with `Authorization: Bearer <token>` and
`{tool, args}`; the server forwards the request to the most recently opened editor tab over Server-Sent Events
(`GET /api/bridge/events?token=<csrf>`, same-origin) and waits up to 30 s for `POST /api/bridge/reply`. Loopback,
Host and Origin checks of the local server still apply; the browser token and the bridge token are not
interchangeable.

In the editor, a header chip shows **AI agent connected** while an agent is active. The first project change an agent
proposes in a session shows an **Allow / Deny** card; allowed changes are applied as one undo step (with a version
snapshot) or opened in a new tab.

## CLI

```sh
pixelstudio info sprite.pxa [--json]
pixelstudio validate sprite.pxa
pixelstudio render sprite.pxa -o sprite.png [--animation walk] [--frame 2] [--scale 8] [--strip] [--background checker]
pixelstudio convert sprite.pxa sprite.pixel.json        # .pxa ⇄ .pxs ⇄ .pixel.json; .pxs flattens parts
pixelstudio pixelize generated.png -o sprite.pxa --colors 16 [--pixel-size 8] [--max-size 128] [--keep-background]
pixelstudio rig sprite.pxa [-o rigged.pxa] [--layers a,b] [--no-rig]   # drawn layers → parts + auto-rig
pixelstudio outline sprite.pxa [--strip [--colors 0,3]] [--live [auto|N|off]] [--inside] [--corners] [--thickness 2]
pixelstudio export sprite.pxa --sheet -o sheet.png      # also --gif, --apng, --png, --sequence (zip)
pixelstudio mcp --root ~/PixelStudio
pixelstudio skills install [--target claude|copilot|codex|cursor|all] [--project]
pixelstudio skills config
pixelstudio plugin install                               # Codex personal marketplace (~/.codex/plugins)
pixelstudio serve [--port 4317] [--open]
```

## Skills

`skills/pixel-studio/SKILL.md` (+ `reference/pxa2-format.md`, regenerated by `npm run formats`) and
`skills/pixel-studio-animate/SKILL.md` use the Agent Skills format (YAML frontmatter `name` and `description`).
`skills install` copies them to:

| Target | User scope (default) | Project scope (`--project`) |
|--------|---------------------|-----------------------------|
| `claude` | `~/.claude/skills/` | `.claude/skills/` |
| `copilot` | `~/.copilot/skills/` | `.github/skills/` |
| `codex` | `~/.agents/skills/` | `.agents/skills/` |
| `cursor` | `~/.cursor/skills/` | `.cursor/skills/` + `.cursor/rules/pixel-studio.mdc` |

## Limitations

- The editor bridge talks to the newest open tab of one Pixel Studio Local instance; the static web build has no bridge.
- Agent edits need the user's approval once per page session; unanswered requests time out after 30 s.
- PNG input supports every non-interlaced colour type and bit depth; interlaced (Adam7) PNGs are rejected.
- `.pxs` stores flattened pixels: use `.pxa` or `.pixel.json` to keep parts, objects and bones.
