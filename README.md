# Pixel Studio

Pixel Studio is a local pixel-art and animation editor with objects, optional groups, reusable parts, and AI edits you can review before applying. PXA 2 supports shapes, part instances, local pixel overrides, and compact scoped patches. Existing PXA 1 projects and drawing tools remain supported.

The **Objects** panel exposes part instances and pixel artwork, with optional groups. Existing layers open as groups; new projects start with ungrouped pixels. Reorder objects for the current animation (the default), or choose one frame. Select **Object (V)** to pick and drag a part on the canvas; double-click it to open the shared editor. Paint, erase and fill with local Undo/Redo, preview the result in any animation frame, then **Apply to all instances** as one project Undo step. Groups can be added or ungrouped, and instances can move between them. Hidden and locked objects retain their source artwork; shared editing checks every locked reference.

Working with objects:

- **Copy, cut, paste and duplicate** objects with Ctrl/⌘+C, X, V and D, the Objects toolbar, or the right-click menu. The object clipboard is shared between project tabs, so you can copy an object and paste it into another animation or another project. Shift+paste makes an independent copy of shared parts. **Copy to animation…** places a copy in another animation.
- **Drag and drop** rows in the Objects panel to reorder objects, move an instance into a group, or drop it between rows to give it its own stack.
- The selected object gets a bright animated outline on the canvas. Click empty canvas or press Escape to deselect.
- While editing an object on the canvas, paint outside its outline to grow its canvas. The **Select** tool works inside the object: select, move, copy, paste and delete pixels in the draft.
- **Shift+click** with the pencil or eraser draws a straight line from the last point.
- **Drop** .pxa, .pxs or .pixel.json files on the canvas to open them in a new tab; dropped PNGs import.
- **Make object (Ctrl/⌘+G):** select pixels with Select or the **Magic wand** (W, shape or same-color mode; Shift adds, Alt subtracts), then click **Make object** to turn them into a reusable object in this frame or every frame of the animation. Right-click a pixel layer for **Convert to object** or **Split into objects…**, which turns each separate shape into its own object inside a group.
- **Extra tools:** **Dither** (T) paints a checkerboard and **Shade** (H) darkens one palette step per pixel (right-click lightens). Turn on **Pixel-perfect** for pencil strokes without L-shaped corners. Both tools also work while editing an object on the canvas.
- **Transform (K): resize, squash & stretch:** select an object and drag one of its 8 handles (Shift keeps the ratio on corners). **Keep area (squash)** mode keeps width × height equal to the original part area (`other side = round(area ÷ dragged side)`), so a flatter object gets wider; **Squash**, **Stretch** and **Reset** step it by 1 px. The size belongs to the placed object, not its artwork. Pixels are drawn by nearest-neighbour sampling at pixel centres, so the original is never changed and Reset restores it exactly. Note: at non-integer factors individual pixels can merge or repeat. Resized objects can't be edited on the canvas; Reset them first.
- **Rotate & flip (K):** turning 90° (`,` / `.`) and flipping are lossless and work on every selected object (all 8 orientations). A free angle (Angle field, or drag the round handle; Shift snaps to 15°) is drawn with nearest-pixel sampling about the object's centre. The part's artwork never changes, so it is fully reversible. Reset the angle to 0° before resizing with handles. Double-clicking a rotated or resized object edits its **original artwork**: it is shown unrotated at its own size, tagged *Original artwork*, with a pink outline of how it is placed in the frame, while the Live preview shows the rotated result. Applying keeps the angle and size. To fix pixels the rotation drew badly, pick **This frame only** in the edit bar: you then edit the pixels exactly as that frame draws them (tagged *This frame, as drawn*), and applying bakes them into that placement as its own artwork at 0° while other frames keep theirs.
- **Multi-select objects:** Shift/Ctrl/⌘-click objects on the canvas or in the Objects panel, or press Ctrl/⌘+A with the Object or Transform tool. Copy, cut, paste (into any frame, animation or tab), duplicate, delete, arrow nudges, dragging and turn/flip then apply to all of them at once.
- **Edit switch (canvas toolbar):** *All frames* applies pencil, eraser, shapes, fill, replace, dither and shade strokes, plus object moves and resizes, to every frame of the current animation; *This frame only* limits them to the selected frame.
- **Workspace layout:** drag the edges of the toolbox, side panel and Frames panel to resize them (arrow keys work on a focused edge; double-click resets). The chevron on the Frames heading minimises it to one slim bar with small thumbnails and ‹ › to keep switching frames. ⇱ on a side-panel heading pops that section out as a floating window: drag its title bar to move it, drag any edge or corner to resize it (or Alt+arrow keys on the focused title bar); ⇲ docks it again. The layout is remembered in this browser.
- **Live preview** has its own animation switcher (‹ select ›) right under the preview.
- **New project** opens a blank canvas form, with a small strip of example projects underneath. It also greets first-time visitors.

Native saves and PXA 2 retain object names, instance settings, groups and shared artwork. PXA 1/PXS are raster copies that bake object structure. Custom animation/frame orders use PXA `ORDER`/`FRAMEORDER` or versioned PXS payloads. Existing files still import with their original appearance and timing. Use the combined **Outline artwork** action for one outer silhouette; baked-in outlines inside existing parts stay editable in the shared editor's full-sprite context.

## Hosted version

The editor is published at [groot406.github.io/Pixel-studio](https://groot406.github.io/Pixel-studio/) by GitHub Actions. Changes pushed to `main` are built and deployed automatically. The hosted editor supports drawing, importing/exporting, and browser-local projects; AI generation through the local Codex bridge requires the downloadable local edition below.

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

Every action provides synchronized before/after previews, frame scrubbing, layer inspection, and changed-pixel highlighting. Inpaint highlights blink unless reduced motion is preferred. Apply accepts the proposal as **one Undo operation**. Incomplete responses, stale requests, invalid spans, and edits outside the allowed scope are rejected.

A PXA 2 proposal offers **Refine with visual preview**: one optional additional generation receives rendered original/proposed contact sheets and can correct the proposal. It uses the same scope validation and review step. This requires an image-capable model and consumes another generation; it is never automatic.

Use **Copy prompt** and **Paste AI result** for a manual workflow. Include the final completion comment from the prompt. The local bridge uses the model selected in the dialog and the existing ChatGPT login; it does not use API keys or fall back to API billing. See the retained [local edition guide](docs/upstream/local-edition.md) for setup details.

## Reusable artwork

The **Parts** section in the side panel shows every reusable part as a thumbnail: **drag one onto the canvas** to place it there, or click it to open the **Part library**. The library is a visual browser (search, sort by name, use or size) showing each part's size, colours, number of copies and the animations and frames that use it. From there you can place it (in every frame or only this frame, following the Edit switch), edit its shared artwork, rename it (all copies follow) or delete it once unused. New parts come from a selection (Ctrl/⌘ G). Regular drawing tools write local overrides. Moving an instance rebuilds the cel without leaving trails. Shared edits update its instances; local overrides remain at their canvas coordinates.

The samples include **Golden Key · reusable parts**. The prompt builder defaults to PXA 2 and also offers PXA 1. Export PXA 2 to retain editable parts; PXA 1 and PXS bake the same layer/frame pixels. Resizing also bakes retained cels. Browser saves preserve the reusable structure.

See the [PXA 2 format, editor workflow, and benchmarks](docs/pxa-v2.md). The benchmarks verify pixel equivalence and report both improvements and regressions; file size alone is not a token count or an art-quality measurement.

## Animation & maths tools

Objects (placed parts) keep their artwork while you pose them, so these tools change poses or paint pixels without redrawing anything by hand. Tools that change several frames follow the **Edit** switch above the canvas (*All frames* / *This frame*).

| # | Tool | Where in the UI |
|---|------|-----------------|
| 1 | **Tweening with easing** – eased position, size, rotation, skew and wave phase between two key frames (linear, ease, cubic, back, elastic, bounce); a curve preview shows the easing. | **Animate** panel → *Tween to frame…* |
| 2 | **Auto squash & stretch** – stretch along the motion, squash on impact, keeping the area. | **Animate** → *Squash & stretch* (also a checkbox in the tween dialog) |
| 3 | **Pivots and motion arcs** – rotation and skew turn about a pivot (joint); tweens follow a line, an arc or a bézier, optionally turning with the path. | **Transform** panel → *Object pose* → Pivot (drag the pink crosshair on the canvas with the Object/Transform tool; *Centre* resets); path options in the tween dialog |
| 4 | **Spring follow-through** – an object follows a leader's angle or position with spring lag. | **Animate** → *Follow-through* |
| 5 | **Two-bone IK** – upper and lower limb reach a target; set pivots on the joints first. | **Animate** → *IK limb* (*Pick target on canvas*) |
| 6 | **Smear frames** – a motion-trail frame between the current and next frame. | **Animate** → *Smear frame* |
| 7 | **RotSprite rotation** – clean free rotations, skews and deforms. | **Transform** → *Object pose* → *Smooth rotation (RotSprite)* |
| 8 | **Skew** – horizontal/vertical shear about the pivot. | **Transform** → *Object pose* → Skew X / Skew Y |
| 9 | **Wave, bulge, pinch and twist** – non-destructive deforms; wave phase can be animated. | **Transform** → *Object pose* → Deform; **Animate** → *Wave motion* (reports seamless loops) |
| 10 | **Seamless tiles** – wrap-around drawing, faded 3×3 repeat, seam score. | Canvas toolbar → **Tile mode** toggle; the seam count and *Offset ½* appear in a badge on the canvas stage |
| 11 | **Distance-field effects** – outline, selective outline, inner glow, rim light (8-way light picker), auto shade. | **Effects** panel (before/after preview in each dialog; a selection limits the effect) |
| 12 | **Hue-shifted shading ramps** – an OKLCH ramp from the active colour. | **Color palette** → *Shading ramp* |
| 13 | **Colour cycling** – rotate a ramp of palette colours across frames. | **Color palette** → *Colour cycle* |
| 14 | **Ordered dithering** – Bayer dither between two colours. | **Effects** → *Dither* (and the Gradient tool's *Dither* style) |
| 15 | **Pixel-perfect lines** – no L-shaped doubles, clean line slopes, clean up existing lines. | Pencil options → *Pixel-perfect strokes*; Line options → *Clean slopes*; **Effects** → *Clean up lines* |
| 16 | **Gradient fills** – linear/radial/diamond/angle, bands or dithered, through a palette ramp. | Toolbox → **Gradient** (`N`): drag from → to; options choose shape, style, matrix, repeat, end colour and region (clicked area, selection or whole cel) |

Effects that paint pixels write local edits on object cels, like the drawing tools, and skip cels holding locked objects.

## Source layout

```text
src/
  domain/         Indexed pixels, project validation, selections, drawing tools
  formats/        PXA text, PXS binary, spritesheets and metadata
  storage/        IndexedDB workspace and memory fallback
  features/ai/    Prompt creation, edit validation, patch engine, review dialog
  editor/app.js   Editor state, DOM wiring, rendering, history and save ordering
  editor/*.js     Panels and tools wired from app.js (objects, parts, maths tools…)
public/           Original HTML, styles, icons, format guide and samples
local/            Loopback HTTP service and Codex app-server adapter
scripts/          Build, source watching and syntax checks
tests/           Behavioral tests and deterministic protocol fixtures
patches/          Original supplied patch archive
docs/upstream/   Retained upstream guides and original Site file hashes
```

See [architecture and compatibility](docs/architecture.md) for ownership, data contracts, and migration decisions, and [verification](docs/verification.md) for what was tested.

## Existing projects and compatibility

Keep using the same hostname and port to retain your browser workspace. The public Site and localhost have separate storage; export `.pxa` or `.pxs` from the Site and import it here. JSON project versions 1, 2 and 3, PXA 1 and 2, and PXS container version 1 are supported. Existing browser storage keys and the IndexedDB record layout are unchanged.

The editor retains its original **128 × 128 maximum canvas**, **64 colors**, **32 layers**, and **1,048,576 stored pixel** budget. The standalone patch advertised a 256 × 256 engine, but enabling that across the editor would require a deliberate PXS format migration: existing width/height fields are one byte. This integration uses the editor's authoritative limits rather than silently corrupting binary exports.

## Troubleshooting

- **Port in use:** stop the other launcher or select another port. Saved browser projects are tied to the original address.
- **Codex disconnected:** check `codex login status`, keep the launcher running, then click Refresh in the AI dialog.
- **Inpaint unavailable:** select a rectangle and unlock the active layer.
- **No durable browser storage:** the editor remains usable, but export your projects before closing.
- **Changed source is not visible:** use `npm run dev` and refresh, or restart `npm start`. Opening `public/index.html` directly does not start the module server or local AI bridge.
