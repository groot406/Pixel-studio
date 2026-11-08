# Pixel Studio

Pixel Studio is a local pixel-art and animation editor with objects, optional groups, reusable parts, and AI edits you can review before applying. PXA 2 supports shapes, part instances, local pixel overrides, and compact scoped patches. Existing PXA 1 projects and drawing tools remain supported.

The **Objects** panel exposes part instances and pixel artwork, with optional groups. Existing layers open as groups; new projects start with ungrouped pixels. Reorder objects for the current animation (the default), or choose one frame. Select **Object (V)** to pick and drag a part on the canvas; double-click it to open the shared editor. Paint, erase and fill with local Undo/Redo, preview the result in any animation frame, then **Apply to all instances** as one project Undo step. Groups can be added or ungrouped, and instances can move between them. Hidden and locked objects retain their source artwork; shared editing checks every locked reference.

Working with objects:

- **Copy, cut, paste and duplicate** objects with Ctrl/⌘+C, X, V and D, the Objects toolbar, or the right-click menu. The object clipboard is shared between project tabs, so you can copy an object and paste it into another animation or another project. Shift+paste makes an independent copy of shared parts. **Copy to animation…** places a copy in another animation. Copying rigged parts copies their bones too: the copy gets its own bones (same joints, limits and rest pose, names suffixed " 2"), so posing it leaves the original alone; a part whose parent bone was not copied becomes the copy's root.
- **Drag and drop** rows in the Objects panel to reorder objects, move an instance into a group, or drop it between rows to give it its own stack.
- The selected object gets a bright animated outline on the canvas. Click empty canvas or press Escape to deselect.
- While editing an object on the canvas, paint outside its outline to grow its canvas. The **Select** tool works inside the object: select, move, copy, paste and delete pixels in the draft.
- **Shift+click** with the pencil or eraser draws a straight line from the last point.
- **Drop** .pxa, .pxs or .pixel.json files on the canvas to open them in a new tab; dropped or pasted (⌘V) PNG, JPG, WebP and GIF images import.
- **AI image clean-up.** Images from general AI models (or upscaled, JPEG-compressed sprites) only *look* like pixel art. *Import → Image* detects the hidden pixel grid (including fractional sizes like 13.3 px), takes one colour per cell (the median of the cell centre, so blurred edges and JPEG noise vanish), merges near-identical shades, flood-fills the background away from the borders (enclosed holes stay), trims, and reduces to 8–64 colours. *Pixelate* averages photos or paintings down to a chosen size. You can override the detected pixel size. A large preview lets you zoom in (scroll or pinch), pan, show a pixel grid and flip to the original image to compare. Every setting has a short explanation. Spritesheet import detects upscaled sheets too. Everything runs locally, instantly and free.
- **Make object (Ctrl/⌘+G):** select pixels with Select or the **Magic wand** (W, shape or same-color mode); with both, Shift adds, Alt subtracts and Shift+Alt intersects, then click **Make object** to turn them into a reusable object in this frame or every frame of the animation. Right-click a pixel layer for **Convert to object** or **Split into objects…**, which turns each separate shape into its own object inside a group. **Split pixels off (Ctrl/⌘+Shift+J)** cuts the selected pixels out of an object into a new object at the same spot; for a smart object every copy is split the same way, so nothing moves on screen. Drawing on an object with a drawing tool opens it for in-place editing straight away, and **Merge with layer below** (object menu) folds a layer such as a baked *Magic outline* into the one above it, in every frame.
- **Paint inside a shape:** while a pixel selection is active, every drawing tool (Pencil, shapes, Fill, Replace, Dither, Shade, Gradient, Curve) only changes pixels inside it, in every frame the Edit switch covers. Click a shape with the Magic wand, press B and paint: the selection stays when you switch to a drawing tool; Esc deselects. **Lock transparency** (drawing tool options, Shift+L) goes further: strokes and fills only recolour pixels that already have colour, so a silhouette keeps its shape. It also works while editing an object on the canvas, where locked strokes no longer grow the object. The Eraser is not affected.
- **Extra tools:** **Dither** (T) paints a checkerboard and **Shade** (H) steps each pixel one colour along its own palette ramp (detected automatically; *Hue-shift ramp* or *Lightness only*), darker by default; right-click goes the other way and *Click* can be set to lighten. The options show the detected ramp of the current colour. Turn on **Pixel-perfect** for pencil strokes without L-shaped corners. Both tools also work while editing an object on the canvas.
- **Curve (P):** drag from start to end, then drag the curve to bend it through the pointer or drag its two round handles (cubic Bézier; Alt mirrors the other handle for a symmetric arc; the square end points move with their handles). In **Path** mode click points for a smooth Catmull-Rom line through them (drag a point to move it, Backspace removes the last); click the first point, double-click or press Enter to finish; *Closed path* and *Fill inside* close and fill it. Enter, a double-click, *Apply* or clicking away applies; Esc cancels. Curves are pixel-perfect (8-connected, no doubled corners) and use the brush size, mirror, colour and selection, *Anti-alias* (1px), in-place object editing and *All frames*, as one undo step.
- **Transform (K): resize, squash & stretch:** select an object and drag one of its 8 handles (Shift keeps the ratio on corners). **Keep area (squash)** mode keeps width × height equal to the original part area (`other side = round(area ÷ dragged side)`), so a flatter object gets wider; **Squash**, **Stretch** and **Reset** step it by 1 px. The size belongs to the placed object, not its artwork. Pixels are drawn by nearest-neighbour sampling at pixel centres, so the original is never changed and Reset restores it exactly. Note: at non-integer factors individual pixels can merge or repeat. Resized objects can't be edited on the canvas; Reset them first.
- **Rotate & flip (K):** turning 90° (`,` / `.`) and flipping are lossless and work on every selected object (all 8 orientations). A free angle (Angle field, or drag the round handle; Shift snaps to 15°) is drawn with nearest-pixel sampling about the object's centre. The part's artwork never changes, so it is fully reversible. Reset the angle to 0° before resizing with handles. Double-clicking a rotated or resized object edits its **original artwork**: it is shown unrotated at its own size, tagged *Original artwork*, with a pink outline of how it is placed in the frame, while the Live preview shows the rotated result. Applying keeps the angle and size. To fix pixels the rotation drew badly, pick **This frame only** in the edit bar: you then edit the pixels exactly as that frame draws them (tagged *This frame, as drawn*), and applying bakes them into that placement as its own artwork at 0° while other frames keep theirs.
- **Live outline:** a *Live outline* chip shows above the canvas while it is on. The outline isn't stored in the pixels, so erasing an outline pixel explains that and offers to change or turn off the outline.
- **Multi-select objects:** Shift/Ctrl/⌘-click objects on the canvas or in the Objects panel, or press Ctrl/⌘+A with the Object or Transform tool. Copy, cut, paste (into any frame, animation or tab), duplicate, delete, arrow nudges, dragging and turn/flip then apply to all of them at once.
- **Edit switch (canvas toolbar):** *All frames* applies pencil, eraser, shapes, curves, fill, replace, dither and shade strokes, plus object moves and resizes, to every frame of the current animation; *This frame* limits them to the current frame; *Selected* repeats them in the frames picked in the timeline (Shift-click a range, Ctrl/⌘-click to add or remove; with Selected on, a plain click on a picked frame moves to it without dropping the pick). The canvas gets an orange (this frame) or purple (selected frames) border. Effects, plugins, poses, IK and Paste follow the same switch.
- **Workspace layout:** drag the edges of the toolbox, side panel and Frames panel to resize them (arrow keys work on a focused edge; double-click resets). The chevron on the Frames heading minimises it to one slim bar with small thumbnails and ‹ › to keep switching frames. ⇱ on a side-panel heading pops that section out as a floating window: drag its title bar to move it, drag any edge or corner to resize it (or Alt+arrow keys on the focused title bar); ⇲ docks it again. The layout is remembered in this browser.
- **Live preview** has its own animation switcher (‹ select ›) right under the preview.
- **New project** opens a blank canvas form, with a small strip of example projects underneath. It also greets first-time visitors, then offers a one-minute guided tour.

Native saves and PXA 2 retain object names, instance settings, groups and shared artwork. PXA 1/PXS are raster copies that bake object structure. Custom animation/frame orders use PXA `ORDER`/`FRAMEORDER` or versioned PXS payloads. Existing files still import with their original appearance and timing. Use the combined **Outline artwork** action for one outer silhouette; baked-in outlines inside existing parts stay editable in the shared editor's full-sprite context.

## Workspace views & tabs

- **View menu** (tab bar): pick a layout preset for the job – *Standard*, *Draw*, *Animate*, *Rig & pose*, *Colour & shading*, *Review* or *Focus* – or arrange panels yourself: drag panels between the left sidebar, right sidebar and *Hidden* (or drag the ⠿ grip in any panel header; arrow keys move a focused grip), pop panels out as floating windows, show or hide each sidebar, set the Frames timeline to open, minimised or hidden and turn on *Compact panels*. *Save current* keeps your arrangement (sizes and floating positions too) as a custom preset; a changed preset shows `*` and can be updated. ⌘/Ctrl + ⌥/Alt + 1–9 switches views, and every view is in the ⌘K command palette. Stored in this browser (`pixel-studio.views.v1`).
- **Tabs:** right-click a tab (or press the Menu key / Shift F10) for *Rename*, *Duplicate*, *Move left/right*, *Close*, *Close other tabs*, *Close tabs to the right/left*, *Close saved tabs*, *Close all tabs* and *Reopen closed tab*. The ⌄ button lists every open tab (an orange dot marks unsaved changes). Drag tabs to reorder, middle-click or Delete closes, F2 or a double-click renames, ⌥/Alt + ⇧ + ←/→ moves the focused tab. ⌥/Alt + W closes the tab, ⌥/Alt + ⇧ W closes the others and ⌥/Alt + ⇧ T reopens the last closed one. Closed tabs are saved first and stay in *Saved projects*.
- **Moving around:** hold **Space** and drag (or drag with the middle mouse button) to grab and move the view while zoomed in; a quick Space tap still plays / pauses. **⌘/Ctrl + scroll** (or Alt + scroll, or a trackpad pinch) zooms in and out around the pointer.
- **Phones (≤760px):** the canvas fills the screen under a one-row header. The bottom dock opens *Tools*, *Colour*, *Objects*, *Animate* and *Preview* as bottom sheets (picking a tool closes the sheet; touching the canvas closes any sheet). The Frames strip starts minimised. Pinch with two fingers to zoom and pan the artwork (the page itself never zooms); a quick two-finger tap undoes, a three-finger tap redoes.

## Getting started & help

- **Welcome:** the first visit opens New project with example projects (the *Stick puppet · skeleton* example is rigged for Skeleton mode). After it closes, a toast offers the **Basics tour** (*Take the tour* / *Not now*); it is only offered once.
- **Help (?)**: the **?** button in the header (or the **?** key when not typing) opens Help & tours:
  - **Tours** – spotlight tours of the real interface: *Basics* (canvas & zoom, toolbox, palette, frames, Edit switch, objects, Live preview, autosave, export) plus *Objects & parts*, *Animate (motion modes)*, *Skeleton & poses*, *Colour* and *Effects & cleanup*. Completed tours get a tick and can be replayed. In a tour use ← → to step and Esc to stop; collapsed panels are opened for the step and closed again afterwards.
  - **Shortcuts** – every keyboard shortcut, grouped (tools, editing, frames & playback, view, modes) and searchable: a single key such as `b` finds that key, words such as `frame` search the descriptions.
  - **What's new** – recent big features, each with *Show me* for its tour. **Docs** links to the sections of this README.
- **Rich tooltips:** hovering (about 0.4 s) or keyboard-focusing a tool or key action shows its name, shortcut, a one-line description and, for tools such as Pencil, Curve, Shade, Gradient, Select, Wand, Object, Transform and Skeleton, a tiny looping demo. Turn them off (back to plain tooltips) in Help.
- **First-use hints:** the first time you open a motion mode, Skeleton mode, Palette studio, the Curve tool, a floating panel or use the Edit switch, a small hint explains it once (*Got it*). *Reset tips & tours* in Help shows them again. Progress is stored in this browser (`pixel-studio.onboarding.v1`).

## Hosted version

The editor is published at [groot406.github.io/Pixel-studio](https://groot406.github.io/Pixel-studio/) by GitHub Actions. Changes pushed to `main` are built and deployed automatically. The hosted editor supports drawing, importing/exporting, and browser-local projects; AI generation through the local Codex bridge requires the downloadable local edition below.

### Pixel Studio Cloud (SaaS edition)

`npm run cloud` (Node 22.13+) serves the same editor with accounts, metered AI credits (server-side OpenAI/Gemini keys), cloud projects and Lemon Squeezy billing. It shows a **Sign in** button in the header and has no npm dependencies; a `Dockerfile` is included. Configuration, pricing, deployment and the launch checklist are in [docs/saas.md](docs/saas.md).

## Run

Requires Node.js 20 or newer. There are no npm dependencies to install.

```sh
npm start
```

This builds the application, serves it at **http://127.0.0.1:4317/**, and opens your browser. On macOS, double-click `Start-Pixel-Studio.command`. Keep the terminal running; use Ctrl+C to stop.

```sh
npm run dev      # Rebuild browser sources on changes; refresh the browser
npm run build    # Recreate dist/ from src/ and public/
npm test         # Domain, format, HTTP, streaming, and Codex protocol tests
npm run check    # Syntax checks, all tests, then a production build
npm run benchmark # Verify rendered equivalence and compare PXA encodings
```

Development also restarts the Node service when its imported server files change. It prints the URL without opening another browser tab on each restart. To use another port:

```sh
npm run dev -- --port 4318
node local/start.mjs --port 4318 --open
```

Tests bind temporary loopback ports and use a fake Codex process. They do not contact OpenAI or consume model allowance. `dist/` is generated and ignored by Git; edit `src/` and `public/` instead. The build copies browser-native modules without bundling or altering artwork/assets.

## Assistant (chat)

Click **Assistant** (or press **⌘/Ctrl J**) to open a floating chat you can drag and resize. Ask about the open project ("which animations are there?") or tell it what to do: rig the sprite into parts and add a walk cycle, make a new animation, fix outlines with the live outline, swap the palette, run any editor command (the same ones as the command palette), or draw something new in a new tab. It works in steps. It reads the project, acts, looks at the rendered result and corrects itself, showing each step as it goes. Every change is a normal Undo step, and **Undo these changes** reverts a whole reply. A version is saved before each request. **Stop** cancels.

Pixel Studio Local uses your Codex / ChatGPT sign-in (pick the model in the panel settings). The hosted edition asks for an OpenAI API key, which stays in this browser and can optionally be remembered. Tick *Show the assistant the current frame* to send a picture with each message (on by default; needs an image-capable model).

## AI editing

Drawing works without Codex. On macOS, Pixel Studio uses the Codex runtime bundled with `/Applications/ChatGPT.app` when available, keeping its model list in sync with the desktop app. Otherwise it uses the `codex` CLI on your PATH. Sign in with ChatGPT through the desktop app or CLI:

```sh
codex --version
codex login status
codex login
```

The model picker comes from the selected runtime's account-specific catalog. The current desktop runtime includes **GPT-6.1 Sol**, **GPT-6.1 Terra**, and **GPT-6 Astra**, alongside other available models. If you use the standalone CLI, keep it updated; GPT-6.1 Terra requires CLI 0.159.0 or newer. See the [official model documentation](https://learn.chatgpt.com/docs/models). After a runtime update, restart Pixel Studio and refresh the AI connection.

Open **AI edit**, choose an **Action**, describe the change, and generate or paste a result:

- **Edit artwork** uses scoped composition patches for PXA 2 projects and retains the original PXA 1 workflow for older projects.
- **Edit parts / pixels (PXA 2)** changes specific instances, shapes, or pixels without returning the entire document. It also works on raster projects. Shared-part changes are checked against every reference, including hidden and locked layers.
- **Inpaint selection** requires a rectangular selection on an unlocked layer. Select pixels with the Select tool first, then choose current frame or current animation. Only that rectangle on that layer can change. Existing colors, other artwork, layer structure, and timing are protected.
- **Recolor palette** proposes colors for existing slots. It affects the whole project, including the appearance of locked and hidden artwork, while retaining all pixel indices. The preview shows each changed swatch.
- **Palette studio** (Color palette panel) builds palettes from colour theory, shade ramps, popular presets or an analysis of the current palette. Click a swatch to add one colour, *Add to palette* to append the ticked rows, or *Replace palette* to swap the whole palette — every pixel, retained shape and part takes its nearest new colour, and one Undo restores it. Palettes hold up to 64 colours.

Every action provides synchronized before/after previews, frame scrubbing, layer inspection, and changed-pixel highlighting. Inpaint highlights blink unless reduced motion is preferred. Apply accepts the proposal as **one Undo operation**. Incomplete responses, stale requests, invalid spans, and edits outside the allowed scope are rejected.

A PXA 2 proposal offers **Refine with visual preview**: one optional additional generation receives rendered original/proposed contact sheets and can correct the proposal. It uses the same scope validation and review step. This requires an image-capable model and consumes another generation; it is never automatic.

Use **Copy prompt** and **Paste AI result** for a manual workflow. Include the final completion comment from the prompt. The local bridge uses the model selected in the dialog and the existing ChatGPT login; it does not use API keys or fall back to API billing. See the retained [local edition guide](docs/upstream/local-edition.md) for setup details.

## Generate with an image model

General image models only *look* like pixel art: their "pixels" are blurry, uneven blocks. **Generate with an image model** (Import dialog, or the button under the intro of **Start with an idea**) writes a pixel-art prompt for you (subject, size, view, style preset, outline, your palette as a hex list, a flat key-colour background) and turns each result into real pixels: the pixel grid is detected, the key colour removed, the sprite trimmed and every pixel mapped perceptually (OKLab, optional dithering) onto your palette or a new one. Pick a variation and apply it as a new project, layer, frame or pixel object, or ask for a sprite sheet of up to 8 frames and get frames or a new animation. **Redraw the current frame** sends your frame as a reference. Applying is one Undo step.

Providers:

- **Local edition** (`npm start`): the local server calls OpenAI (`gpt-image-1`) or Google Gemini (`gemini-2.5-flash-image`). Set `OPENAI_API_KEY` and/or `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) before starting, or create `~/.pixelstudio/keys.json` with `{"openai": "sk-…", "gemini": "…"}`. Keys stay on your machine and never reach the browser. Image calls are billed to that API account.
- **Web build**: paste your own API key in the dialog. It is kept in memory only, unless you tick **Remember on this device** (stored in this browser's localStorage — anyone with access to this browser profile can read it). Requests go straight from your browser to the provider.
- **Any chatbot** (free): **Copy prompt**, paste it into ChatGPT, Gemini or another image chatbot, then paste (⌘V), drop or upload the resulting image into the dialog.

The Image import dialog uses the same clean-up and can also map onto the **current palette**. Results depend on the model: if no grid is found, switch the sizing to *Pixelate* or type a pixel size. Gemini cannot return transparent backgrounds, so magenta is used as the key colour. Layers, frames and objects always use the project palette and never add colours.

## Plugins and prompt skills

**Plugins & skills** (the puzzle-piece button in the header) installs small JavaScript plugins that add pixel effects, frame/selection/animation/project commands, palettes and **prompt skills**. Install them from the bundled **Gallery** (Drop shadow, Noise / grain dither, Outline glow, Palette cycle animation, Game Boy palette, and a prompt-skill pack: RPG character, Platformer hero, Item icon, Tileset), from a `.js` file (pick or drop it), from pasted code, or from a URL (web build only: the local edition's security policy only connects to its own server, so download the file instead). Before anything outside the gallery is installed you see its manifest, permissions and code, with a reminder to only install plugins you trust. Installed plugins are kept in this browser (IndexedDB) and can be disabled, updated or uninstalled.

Plugin effects and commands appear under **Effects → Plugins** and in the command palette (**⌘/Ctrl K**), which also searches the editor's own buttons. They respect the edit scope, the selection and locked objects like the built-in effects, and every run is one Undo step. Prompt skills appear as **Prompt skill** in the AI prompt builder: they add expert instructions to the prompt and can fill in the size and animation list.

Each plugin runs in its own Web Worker with no page access, and network APIs are stubbed out. It only receives copies of the pixels it works on, and everything it returns is validated (sizes, palette indices, at most 64 colours, frame and pixel limits) before it touches your project; runs that take longer than 5 seconds are stopped. The **Write your own** tab shows the API and copies a ready-made prompt that lets any chatbot write a plugin for you. Full reference: [docs/plugins.md](docs/plugins.md) (generated from `src/plugins/api-doc.js` by `node scripts/sync-plugin-docs.mjs`).

## Use Pixel Studio from AI agents (MCP, CLI, skills)

Claude (Desktop and Code), GitHub Copilot, Cursor, OpenAI Codex and other agents can draw, animate and export sprites with Pixel Studio — headless, from a checkout of this repository (Node.js 20+, no dependencies). In the app, **Help → Docs → Connect an AI agent** shows ready-to-copy configuration with your paths.

- **Plugin for Codex and Claude Code** (skills + MCP server in one install, no checkout needed): `codex plugin marketplace add groot406/Pixel-studio` then `codex plugin add pixel-studio@pixel-studio` (or install *Pixel Studio* from the Plugins directory in Codex / the ChatGPT desktop app); in Claude Code `/plugin marketplace add groot406/Pixel-studio` then `/plugin install pixel-studio@pixel-studio`. From a checkout, `npm run plugin:install` adds it to your personal Codex marketplace. The package in `plugins/pixel-studio` is generated by `npm run plugin`; see [docs/mcp.md](docs/mcp.md#plugin-codex-and-claude-code).
- **MCP server** (`node local/cli.mjs mcp [--root DIR]`, or `npm run mcp`): stdio Model Context Protocol server with tools to read the PXA 2 guide, create/read/validate/write projects, render PNG previews the agent can look at, pixelize images, apply rig templates (walk, run, jump, idle, wave, hover) and palettes, and export PNG, sprite sheets and GIFs. Files are confined to the workspace root (default: the current folder). Tool reference: [docs/mcp.md](docs/mcp.md).
- **Live editor bridge**: while Pixel Studio Local runs (`npm start`) and the editor is open, `editor_get_project` reads the current tab (PXA 2 + preview) and `editor_apply_project` proposes a change — the first edit in a session asks you to **Allow**, and each edit is one Undo step. An **AI agent connected** chip shows in the header while an agent is active.
- **CLI** (`pixelstudio` after `npm link`, or `node local/cli.mjs`): `info`, `validate`, `render <file> -o out.png [--frame n] [--scale n] [--strip]`, `convert <in> <out>`, `pixelize <image.png> -o out.pxa [--colors 16]`, `export <file> --sheet|--gif -o …`, `mcp`, `skills install`, `serve`.
- **Agent skills** (`npm run skills`, or `node local/cli.mjs skills install [--target claude|copilot|codex|cursor|all] [--project]`): installs `skills/pixel-studio` (PXA 2 workflow and pixel-art rules, with the format reference) and `skills/pixel-studio-animate` (rigging, templates, timing) into `~/.claude/skills`, `~/.copilot/skills`, `~/.agents/skills` (Codex) and `~/.cursor/skills` — or `.claude/skills`, `.github/skills`, `.agents/skills`, `.cursor/skills` + `.cursor/rules/pixel-studio.mdc` with `--project` — and prints the MCP snippets.

Connect a client (replace the path with your checkout; `node local/cli.mjs skills config` prints these with absolute paths):

```sh
claude mcp add pixelstudio -- node /path/to/Pixel-studio/local/cli.mjs mcp          # Claude Code
```

```jsonc
// Claude Desktop: claude_desktop_config.json · Cursor: ~/.cursor/mcp.json
{ "mcpServers": { "pixelstudio": { "command": "node", "args": ["/path/to/Pixel-studio/local/cli.mjs", "mcp", "--root", "/Users/me/PixelStudio"] } } }
// VS Code / GitHub Copilot: .vscode/mcp.json
{ "servers": { "pixelstudio": { "type": "stdio", "command": "node", "args": ["/path/to/Pixel-studio/local/cli.mjs", "mcp", "--root", "${workspaceFolder}"] } } }
```

```toml
# OpenAI Codex: ~/.codex/config.toml
[mcp_servers.pixelstudio]
command = "node"
args = ["/path/to/Pixel-studio/local/cli.mjs", "mcp"]
```

Chat assistants without MCP (ChatGPT, Gemini…) can still write PXA 2 from the [format guide](public/pxa-v2-format.txt); the site also serves [`llms.txt`](public/llms.txt).

## Reusable artwork

The **Parts** section in the side panel shows every reusable part as a thumbnail: **drag one onto the canvas** to place it there, or click it to open the **Part library**. The library is a visual browser (search, sort by name, use or size) showing each part's size, colours, number of copies and the animations and frames that use it. From there you can place it (in every frame or only this frame, following the Edit switch), edit its shared artwork, rename it (all copies follow) or delete it once unused. New parts come from a selection (Ctrl/⌘ G). Regular drawing tools write local overrides. Moving an instance rebuilds the cel without leaving trails. Shared edits update its instances; local overrides remain at their canvas coordinates.

**New object** (top of the Objects panel) adds an empty pixel object and picks the Pencil, ready to draw something new; the copy-with-plus button duplicates the selected object. With a placed part selected (and no pixel selection), **Effects** such as *Smooth jaggies* or *Outline* change that object's own part, so the result moves with it: in *All frames* every copy changes, in *This frame* / *Selected* frames only this copy gets its own part. The part grows when an outline needs room. Painting over a part with the drawing tools instead records *Local pixel edits* that stay in place.

The samples include **Golden Key · reusable parts** and **Stick puppet · skeleton** (a rigged PXA 2 figure with key poses). The prompt builder defaults to PXA 2 and also offers PXA 1. Export PXA 2 to retain editable parts; PXA 1 and PXS bake the same layer/frame pixels. Resizing also bakes retained cels. Browser saves preserve the reusable structure.

See the [PXA 2 format, editor workflow, and benchmarks](docs/pxa-v2.md). The benchmarks verify pixel equivalence and report both improvements and regressions; file size alone is not a token count or an art-quality measurement.

## Exporting images and animations

**Export** opens one dialog with five tabs: *AI pixel data* (`.pxa`), *Compact file* (`.pxs`), *PNG image*, *Sprite sheet* and *GIF / APNG*. The three image tabs share these options and remember your last choices on this device:

- **Frames:** the current frame, the current animation, or all animations. **Layers:** all visible layers, or only the selected object layer.
- **Scale:** 1×, 2×, 4×, 8× or any whole number up to 64× — nearest-neighbour, so pixels stay crisp. **Padding** adds empty pixels around every frame; the background is transparent or a colour you pick.
- A live preview (frame boxes for sheets, playback for animations), the output size, and the exact file size of the download. File names use the project and animation names, e.g. `golden-key-sparkle-4x.gif`.

| Format | What you get |
| --- | --- |
| PNG | The current frame. |
| PNG sequence | One numbered PNG per frame (`sparkle-001.png`…) in a ZIP. |
| WebP | A still WebP of the current frame, encoded by the browser (Chrome, Edge, Firefox). Animated WebP is not offered: browsers cannot encode it without a library. |
| Sprite sheet | One PNG laid out as one row per animation, a horizontal or vertical strip, or a grid (auto or *n* columns), with spacing and margin. Metadata files are zipped with the PNG. |
| Animated GIF | GIF89a using the project colours, on/off transparency (disposal “restore to background”), frame timings in 1/100 s (rounding is carried so loops keep their length), loop forever or play once. |
| APNG | Animated PNG with exact millisecond timings and full alpha. Opens in every modern browser. |

With *All animations*, GIF and APNG produce one file per animation in a ZIP.

Sprite sheet metadata:

- **Aseprite JSON (hash or array)** — the schema written by Aseprite's *Export Sprite Sheet*: per frame `frame`, `rotated`, `trimmed`, `spriteSourceSize`, `sourceSize`, `duration` (ms); `meta` with `app`, `version`, `image`, `format`, `size`, `scale` and one `frameTags` entry per animation (`from`/`to`/`direction`). Readers for Aseprite JSON (Phaser, PixiJS, Defold, LibGDX and many engine plugins) load it directly.
- **Godot 4 SpriteFrames (`.tres`)** — one `AtlasTexture` per frame and one animation per Pixel Studio animation, with name, speed (FPS), loop and relative frame durations. Put the PNG and `.tres` in the same folder of your project (the resource references `res://<sheet>.png`; re-point it if you move the PNG) and assign it to an `AnimatedSprite2D`.
- **Unity** — a TexturePacker-style *JSON (Hash)* (frames with pivots plus an `animations` list), which Unity JSON atlas importers accept, and a `-unity.txt` guide. Unity has no built-in JSON atlas import, so the guide gives the exact *Sprite Editor → Slice → Grid By Cell Size* values (cell size, offset = margin, padding = spacing), Pixels Per Unit, and Point filtering. Every layout is a uniform grid, so grid slicing always matches.
- **Generic JSON** — a simple engine-neutral list of frame rectangles, durations and animation ranges.
- **Pixel Studio · re-import** — the `.sheet.json` sidecar read by *Import → Spritesheet* (needs the one-row-per-animation layout without padding, spacing or margin).

Frames are never trimmed or rotated, so `trimmed` is always `false` and every frame has the same size.

## Animation & maths tools

Objects (placed parts) keep their artwork while you pose them, so these tools change poses or paint pixels without redrawing anything by hand. Tools that change several frames follow the **Edit** switch above the canvas (*All frames* / *This frame* / *Selected*).

The **Animate** panel rows open *motion modes*: you work directly on the canvas with ghosts of the result, a mode bar holds the options, and the Live Preview plays the candidate animation. **Enter** applies (one undo step), **Esc** cancels. Modes are unavailable while an object's artwork is edited in place.

**Describe a motion** (top of the **Animate** panel, or **Q**): type what should happen in plain words, such as *make him wave twice*, *jump*, *walk cycle (8 frames)*, *nod*, *shake head*, *bounce 3 times higher*, *spin the key*, *flip around*, *move the key to the right by 10*, *squash and stretch* or *wave, then jump twice and spin*. An offline phrase parser turns it into a **motion plan**, an ordered list of steps (`template`, `bounce`, `move`, `spin`, `turn`, `rotate`, `pose`, `reach`, `shake`, `follow`, `squash`, `ripple`, `hold`, `repeat`, `newAnimation`). The steps run with the tools below on a copy of the project: rig templates, saved poses, bone rotations and IK reach for rigged characters, and tweens, bounces and 3D spins for any object. Targets resolve by object, part or bone name, or by a role such as *head* or *left hand*; *him/her/it* means the selection or the main character. The dialog shows each step as a chip with editable frames, repeats and speed, plus warnings and a live preview (also in the Live Preview). **Apply** adds a new animation, appends to the current one or replaces it, all as one undo step. **Ask AI instead** builds a `PXAMOTION 1` prompt with the plan schema and the project's objects, bones, roles, poses and animations. Copy it into any AI chat and paste the JSON reply, or ask Codex directly in the local edition. Code fences and surrounding text are ignored, and the plan is validated before it previews. Characters without a skeleton fall back to simple motions (a jump becomes a bounce, for example) and show a warning.

| # | Tool | Where in the UI |
|---|------|-----------------|
| 0 | **Skeleton rigging** – join placed parts into a bone tree (saved with the project and in PXA 2 as `BONE` lines), then pose it: drag a part to bend it at its joint (children follow), drag a hand or foot to reach with n-bone IK, drag the root to move the whole figure. Angle snap (Free/5°/15°), RotSprite, optional bend limits, *New key frame*, *Copy/Paste*, *Mirror*, *Swap L/R*, *Reset* to the rest pose, *In-between…* to fill frames between two key poses, a project pose library (`POSE` lines), animation templates (walk, run, jump, idle breathing, wave, hover) and retargeting animations between characters or projects. The Object tool's drag, arrow nudges, rotation and *Animate a move* carry a rigged part's children too. | **Animate** → *Skeleton rig* (or **J**); try the *Stick puppet · skeleton* example |
| 1 | **Tweening with easing** – drag the end ghost (or use arrow keys) to where the object ends, drag the round mid handle to bend the path into an arc; numbered in-between ghosts show the eased positions. Choose frames, easing (Smooth, Speed up, Slow down, Overshoot, Bounce, Elastic, Linear), *Squash & stretch* and *Turn along path*; *To frame N* tweens to a pose the object already has in a later frame. | **Animate** panel → *Animate a move* |
| 2 | **Bounce · squash & stretch** – *Bounce in place* builds a looping bounce from a single frame (drag the height handle; frames and squash amount in the bar); *Add to existing motion* stretches along motion and squashes on impact, keeping the area. | **Animate** → *Bounce · squash & stretch* (also a toggle in *Animate a move*) |
| 3 | **Pivots and motion arcs** – rotation and skew turn about a pivot (joint); with *Stretch at pivot*, resizing adds or drops rows and columns at the pivot so the rest stays pixel-exact; tweens follow a line, an arc or a bézier, optionally turning with the path. | **Transform** panel → *Object pose* → Pivot (drag the pink crosshair on the canvas with the Object/Transform tool; *Centre* resets); path options in the tween dialog |
| 4 | **Spring follow-through** – click the object to follow; the pivot is set to the attachment point (drag it to adjust). Presets Tail, Hair, Cape, Antenna and a *Lag* slider. If the leader does not move, *Animate the leader first* opens a move for it. | **Animate** → *Follow-through* |
| 5 | **Two-bone IK** – click the shoulder on the upper part, the elbow on the lower part, then drag the hand; bones and joints are drawn live. *Flip bend*, frame stepping and *Done* in the bar; the rig is remembered for the session. | **Animate** → *IK limb* |
| 6 | **Smear frames** – one click inserts a trail frame of the selected object (its own colours) towards the next frame, or towards the first frame on the last frame of a loop; *Options* tweak steps, colour and insert/replace. | **Animate** → *Smear into next frame* |
| 7 | **RotSprite rotation & Smooth AA** – clean free rotations, skews, 3D turns, deforms and resizes; *Smooth AA* supersamples 4×4 and adds in-between palette colours at colour boundaries and over the art beneath. Every mode keeps 1px lines and outlines unbroken (no gaps). | **Transform** → *Object pose* → *Sampling* |
| 8 | **Skew** – horizontal/vertical shear about the pivot. | **Transform** → *Object pose* → Skew X / Skew Y |
| 8b | **3D turn (pseudo-3D rotation about the other axes)** – *Turn ↔* rotates about the vertical Y axis (door, coin, a character turning round; past 90° the back shows mirrored), *Tip ↕* about the horizontal X axis, both through the pivot, with optional *Perspective* (far edge shorter, near edge taller). Tweens and in-betweens interpolate it; *3D spin* adds a seamless looping spin with a chosen frame time (or keeps the frame's own). Exactly edge-on (90°) a part shows as a 1-pixel sliver of its nearest edge rather than vanishing. | **Transform** → *Object pose* → Turn ↔ Y / Tip ↕ X / Perspective; Transform tool: drag the blue diamond under the object (sideways turns, up/down tips, Shift snaps to 15°); **Animate** → *3D spin* |
| 9 | **Wave, bulge, pinch and twist** – non-destructive deforms; wave phase can be animated. | **Transform** → *Object pose* → Deform; **Animate** → *Wave motion* (live preview; reports seamless loops) |
| 10 | **Seamless tiles** – wrap-around drawing, faded 3×3 repeat, seam score. | Canvas toolbar → **Tile mode** toggle; the seam count and *Offset ½* appear in a badge on the canvas stage |
| 11 | **Distance-field effects** – outline, selective outline, inner glow, rim light (8-way light picker), auto shade. | **Effects** panel (before/after preview in each dialog; a selection limits the effect) |
| 12 | **Hue-shifted shading ramps** – an OKLCH ramp from the active colour. | **Color palette** → *Shading ramp* |
| 13 | **Colour cycling** – rotate a ramp of palette colours across frames. | **Color palette** → *Colour cycle* |
| 13b | **Palette studio** – colour-theory harmonies on an OKLCH hue wheel (complementary, split, analogous, triadic, tetradic, square, monochromatic), hue-shifted shades/tints/tones with opposite and neutral suggestions, 37 popular pixel-art palettes (PICO-8, DB16/32, Endesga, Sweetie 16, Game Boy, …, values from Lospec) and palette analysis (sort, near-duplicates, value gaps). *Add to palette* dedupes; *Replace palette* recolours every pixel to its nearest new colour (OKLab) in one undo step. | **Color palette** → *Palette studio*; right-click a swatch for *Make ramp*, *Add complement*, *Harmonies*, *Shades & tints*, *Remove colour* |
| 14 | **Ordered dithering** – Bayer dither between two colours. | **Effects** → *Dither* (and the Gradient tool's *Dither* style) |
| 15 | **Pixel-perfect lines** – no L-shaped doubles, clean line slopes, clean up existing lines. | Pencil options → *Pixel-perfect strokes*; Line options → *Clean slopes*; **Effects** → *Clean up lines* |
| 15a | **Curves and paths** – cubic Bézier curves and smooth (Catmull-Rom) paths rasterised pixel-perfect: dense sampling, 8-connected, no L-corners or doubles; closed paths can be filled. | **Curve** tool (P) |
| 15b | **Palette-aware anti-aliasing** – hand-style AA pixels at the stair steps of 1px lines, ellipses and curves, or of any edges, using only palette colours between the two sides (steps with no such colour stay crisp). | Line/Ellipse/Curve options → *Anti-alias*; **Effects** → *Smooth jaggies* |
| 15c | **Palette-aware tools** – the Shade brush steps through automatically detected palette ramps; *Auto outline* picks each outline pixel's colour (the darkest of the adjacent fill's ramp, or one colour; outside/inside, corners); *Pixel cleanup* marks stray pixels, doubled corners, jaggies (uneven steps like 2-1-2-3) and banding on the canvas, with *Fix* per stray/corner and *Fix all safe* (jaggies and banding are only highlighted). | **Shade** tool (H); **Effects** → *Auto outline*, *Pixel cleanup* |

### Frames, timing & onion skin

- **Onion skin** (**O**, canvas toolbar; the arrow beside it or **Shift O** opens its settings): 0–5 ghost frames before and after the current one, the nearest at the chosen opacity and each further one fading. *Tinted* shows previous frames red and next frames green (classic); *True colour* keeps the art's colours. *Key poses only* ghosts just the frames marked as keys, *Loop around* wraps first ↔ last, and *Show* limits ghosts to all layers, the current layer or the selected object. Ghosts also show under motion and Skeleton modes.
- **Key poses**: mark frames as **key** (◆ green), **breakdown** (◆ amber) or **in-between** (•) from the frame's right-click menu or with **M** (cycles). A thin ruler above the frames shows every frame's mark and relative duration; **Alt ←/→** jumps to the previous/next key. *Animate a move*, *To frame N* and Skeleton *In-between…* mark their endpoints as keys and the frames they fill as in-betweens. Marks are saved in projects and in PXA (`FRAME … KEY|BREAKDOWN|INBETWEEN`); PXS files don't keep them.
- **Timing view** (toggle beside the Frames title): each frame is a bar as wide as it lasts. Drag a bar's right edge to change its duration (10 ms steps; **Alt** snaps to whole frames at the animation's fps; **Shift** stretches all selected frames together); a tooltip shows milliseconds and frames. Drag a card itself to reorder (both views); **Esc** cancels a drag.
- **Multi-select**: click, **Shift**-click a range, **Ctrl/⌘**-click to add. Duplicate, Delete, the Duration field and the right-click/⏱ *Timing* menu then work on all selected frames: *Ease in* (speed up), *Ease out* (slow down), *Ease in-out* (redistribute the same total time along an easing curve), *Even out*, *Hold ×2 / ×½*, *Speed ×0.5–×2* (whole animation when one frame is selected), *Reverse*, *Ping-pong* (append reversed) and *Loop in preview* (the Live Preview repeats just that range until you stop it).

### Skeleton rigging

1. Draw each body part as its own part (select pixels, **⌘/Ctrl G**) and place them on the canvas in a rest pose, or open the *Stick puppet · skeleton* example.
2. Press **J** (or **Animate** → *Skeleton rig*). In the **Rig** step click a child part (an upper arm), then click its parent (the torso) right where they join, or drag from the child and drop on the parent. The joint becomes the child's pivot; the first parent becomes the root. Rename bones in the list (names with *L/R* or *left/right* pair limbs for mirroring), add bend limits with *±°*, and press *Set rest pose*.
3. In the **Pose** step, posing affects this frame only (the Edit switch chooses *All frames* if you want). Drag a part to rotate it at its joint, drag a hand or foot to place it with IK (*Limb* solves up to the body, *2/3/All* choose the chain length, Shift switches IK/rotate), drag the root to move the figure.
4. Animate with key poses: *New key frame* (**D**) duplicates the frame to pose the next key; go back to an earlier key and use *In-between…* to choose the later key, how many frames to add and the easing; the Live Preview plays the result before you insert it.
5. **Pose library**: *Save pose* adds the frame's pose (each bone's angle relative to its parent, plus where the figure stands) to the project as a card with a thumbnail; rename it on the card. Click a card to apply it (to this frame, or every frame with *All frames*), the flip button applies it mirrored left ↔ right, *Blend* applies only part of the way toward it and *Position* also moves the figure. With several rigged characters in the frame, chips choose which one the library and the tools below work on.
6. **Templates…** generates a *Walk* or *Run* cycle, a *Jump* (crouch, take-off, airborne, landing squash), *Idle breathing*, a *Wave* or a *Bob / hover* (for any rig) from the rest pose, with an animated preview. Set the frame count, frame length, swing in degrees, bounce or jump height, *Exaggeration* and facing (side views right/left, or front), then make a new animation or replace the current frames. Loops are seamless and feet stay on the ground. Bone roles (torso, head, upper/lower arm and leg L/R…) are found from names (`upper_arm_l`, `ArmL`, `left forearm`, `thigh R`…) or, for unnamed parts, from shape (chains below the hips are legs, left/right by position); fix any in *Bone roles*.
7. **Retarget…** copies an animation from one character onto another: choose the source (any animation × character in this project, or poses copied with *Copy animation poses*, which also works across project tabs and puts JSON on the system clipboard) and the target character. Bones pair up by role, name and alias, similar names, then tree position; each row has a dropdown to fix it. Angles carry over as changes from the rest pose, so different proportions work, and *Scale root motion by leg length* shrinks or grows the figure's travel.
8. **Enter** or *Done* leaves the mode. Every drag or button is one undo step. Joints follow skew, 3D turns and deforms (wave, bulge, twist). Library poses also apply to copied characters (bones match by name, ignoring a " 2" suffix); PXA 1 and the compact `.pxs` file do not keep bones or poses (export PXA 2, which stores poses as `POSE` lines).
| 16 | **Gradient fills** – linear/radial/diamond/angle, bands or dithered, through a palette ramp. | Toolbox → **Gradient** (`N`): drag from → to; options choose shape, style, matrix, repeat, end colour and region (clicked area, selection or whole cel) |

Effects that paint pixels write local edits on object cels, like the drawing tools, and skip cels holding locked objects.

## Saving & history

- **Autosave.** Every change is saved to this browser's IndexedDB about half a second after you stop (never in the middle of a stroke), and again when the tab is hidden or closed. The header status shows *Unsaved*, *Saving…*, *Saved on this device* or *Not saved · Download backup*; click it to open the version history, or, after an error, to download a `.pxa` backup. Each save keeps the previous good copy, which is used if the current record cannot be read.
- **Storage full.** If the browser refuses a save (for example `QuotaExceededError`), the project stays open, a warning offers *Download backup*, and saving is retried. Small recovery copies use `localStorage` and move to IndexedDB when it is full.
- **Crash recovery.** While a project has unsaved changes, a recovery copy is written every few seconds and when the page hides. Open tabs also leave a heartbeat. If Pixel Studio closed without saving newer work, a *Recover unsaved work* banner appears on the next start: *Compare* shows the saved and unsaved first frames, *Restore* applies the work as an undoable change, and *Discard* keeps it as a version instead of deleting it. Edits made in the last second before a crash can be lost.
- **Errors.** An unexpected error shows “Something went wrong — your work is safe” with *Download backup*; the editor keeps running and failed edits roll back.
- **Version history** (header → **History**). *Save version* stores a named snapshot. Automatic snapshots are taken after 5 minutes of active editing or 100 changes, and before risky operations (Replace palette, rig templates, Retarget, AI edits, importing PNGs into the project, restoring a version). Each row shows the first frame, time, frame and animation counts; actions are *Preview* (animated), *Restore* (undoable; the current state is snapshotted first), *Open as copy* in a new tab, *Download* (`.pxa`) and *Delete* (click twice). Named versions are kept until deleted; automatic ones are thinned to all from the last hour, one per hour for a day and one per day for 30 days, within about 24 MB and 300 versions per project. Without IndexedDB, versions last only until reload.

## Source layout

```text
src/
  domain/         Indexed pixels, project validation, selections, drawing tools
  formats/        PXA text, PXS binary, spritesheets, PNG/APNG, GIF, ZIP and export metadata
  storage/        IndexedDB workspace and memory fallback
  features/ai/    Prompt creation, edit validation, patch engine, review dialog
  features/assistant/ In-app assistant: agent loop, editor tools and model providers (panel: editor/assistant-panel.js)
  plugins/        Plugin manifest/result validation, worker sandbox, registry, manager dialog, command palette
  editor/app.js   Editor state, DOM wiring, rendering, history and save ordering
  editor/*.js     Panels and tools wired from app.js (objects, parts, maths tools, tours & help…)
public/           Original HTML, styles, icons, format guide, samples and gallery plugins (public/plugins/)
local/            Loopback HTTP service, Codex adapter, MCP server, CLI, headless core and editor bridge
plugins/          Generated agent plugin (npm run plugin) for Codex and Claude Code, listed by .agents/plugins and .claude-plugin
src/bridge/       Browser side of the agent bridge and the "Connect an AI agent" dialog
skills/           Agent skills (SKILL.md) installed by `pixelstudio skills install`
scripts/          Build, source watching, syntax checks and benchmarks (`npm run bench`)
tests/           Behavioral tests and deterministic protocol fixtures
patches/          Original supplied patch archive
docs/upstream/   Retained upstream guides and original Site file hashes
```

See [architecture and compatibility](docs/architecture.md) for ownership, data contracts, and migration decisions, and [verification](docs/verification.md) for what was tested.

## Existing projects and compatibility

Keep using the same hostname and port to retain your browser workspace. The public Site and localhost have separate storage; export `.pxa` or `.pxs` from the Site and import it here. JSON project versions 1, 2 and 3, PXA 1 and 2, and PXS container version 1 are supported. Existing browser storage keys and the project record layout are unchanged; database version 2 only adds stores for backups, versions and recovery journals.

Limits: canvases up to **2048 × 2048**, **64 colors**, **32 layers**, and **4,194,304 stored pixels** in total (for example 8 layers × 8 frames at 256 × 256, or a single 2048 × 2048 frame). The stored-pixel budget is the real ceiling: it keeps drawing, undo history and autosave fast, so very large canvases leave room for fewer frames and layers. PXS stores canvases up to 256 in one-byte width/height fields (256 as 0) and switches to payload schema 5 with 16-bit dimensions for larger ones; files up to 256 are byte-identical to before. Large projects write bigger recovery journals (about 12 MB at the full budget), which fall back from localStorage to the browser database. The 4 MiB PXA text limit is unchanged, so very large projects should be exported as `.pxs`.

## Troubleshooting

- **Port in use:** stop the other launcher or select another port. Saved browser projects are tied to the original address.
- **Codex disconnected:** check `codex login status`, keep the launcher running, then click Refresh in the AI dialog.
- **Inpaint unavailable:** select a rectangle and unlock the active layer.
- **No durable browser storage:** the editor remains usable, but export your projects before closing.
- **“Not saved” in the header:** the browser storage is full or blocked. Download a backup, then delete old versions or free space; saving retries automatically.
- **Changed source is not visible:** use `npm run dev` and refresh, or restart `npm start`. Opening `public/index.html` directly does not start the module server or local AI bridge.
