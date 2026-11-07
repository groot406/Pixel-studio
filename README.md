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

Open **Part library / place part** below Objects to extract selected pixels into a part, place it in another frame, move or rotate an instance, make an independent copy, or open the shared artwork editor. Regular drawing tools write local overrides. Moving an instance rebuilds the cel without leaving trails. Shared edits update its instances; local overrides remain at their canvas coordinates.

The samples include **Golden Key · reusable parts**. The prompt builder defaults to PXA 2 and also offers PXA 1. Export PXA 2 to retain editable parts; PXA 1 and PXS bake the same layer/frame pixels. Resizing also bakes retained cels. Browser saves preserve the reusable structure.

See the [PXA 2 format, editor workflow, and benchmarks](docs/pxa-v2.md). The benchmarks verify pixel equivalence and report both improvements and regressions; file size alone is not a token count or an art-quality measurement.

## Source layout

```text
src/
  domain/         Indexed pixels, project validation, selections, drawing tools
  formats/        PXA text, PXS binary, spritesheets and metadata
  storage/        IndexedDB workspace and memory fallback
  features/ai/    Prompt creation, edit validation, patch engine, review dialog
  editor/app.js   Editor state, DOM wiring, rendering, history and save ordering
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
