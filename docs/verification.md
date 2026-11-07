# Verification — 7 November 2026

## Automated

`npm run check` passes: JavaScript syntax checks, 83 Node tests, and a clean build. The tests cover:

- Inpaint confinement to rectangle, frame/animation, and unlocked layer; immutable source; unchanged timing and unrelated artwork.
- Palette-only changes, all reported swatches, all 64 palette slots, fractional FPS, cel identities, and the editor's maximum canvas size.
- Incomplete/stale/wrong-request responses, malformed runs, out-of-bounds spans, unknown palette slots, and no-op proposals.
- All four original samples through JSON migration, PXA text, and PXS binary round trips; hidden layers, blank frames, duplicate colors, checksum rejection, and spritesheet metadata.
- Existing scoped AI editing and locked-pixel protection.
- HTTP asset/module resolution, same-origin/token checks, unsupported inputs, escaping symlinks, concurrent generation rejection, and cancellation.
- Desktop runtime discovery, CLI fallback, and forwarding the selected GPT-6.1 or Astra model to Codex.
- NDJSON completion handling and the Codex subprocess protocol, using a deterministic fixture. Tests neither contact OpenAI nor consume model allowance.
- PXA 2 part definitions, source persistence, frame snapshots, transforms, erasing overrides, raster cels, bounded reference expansion, and repeated SHIFT work limits.
- Scoped composition patches, shared references in hidden/locked cels, independent forks, structural-only changes, stale sources, and the explicit composition action on raster projects.
- Part extraction/placement, local drawing, shared painting without accidental overrides, and flattening.
- One optional visual-refinement pass, bounded frame sampling, PNG transport, application-owned image paths, and temporary-image cleanup.

## Original design and features

Original source hashes are retained in `upstream/site-sha256.json`. The original samples and icons are retained; PXA 2 adds a reusable-parts Key sample and a second format guide. The editor adds parts controls, PXA version selectors, composition editing and optional visual refinement. Its original layout and visual identity remain. Parts layout rules are scoped to `src/editor/parts-dialog.css`; a few existing muted text colors were darkened to address contrast findings.

The PXA 1/PXS codecs retain their output semantics. Integer geometry was extracted for reuse by both pixel tools and retained artwork. Existing drawing buffers commit as local overrides on retained cels. The storage record layout and keyboard tools remain; project validation now also accepts schema 3. The AI entry point checks the document revision and source snapshot before Apply.

## Browser checks

Using the in-app browser and the local service:

- Original Panda project renders after source reorganization with its palette, three animations, and original frame durations.
- The narrow responsive layout matches the original export. A desktop viewport was also exercised; no browser errors or warnings were reported. This is not an automated screenshot-diff suite.
- The local Codex connection reports connected and offers its installed model catalog.
- Inpaint is unavailable without a selection. A selected frame produces a validated one-pixel proposal with the correct layer, before/after previews, and highlight control.
- An inpaint response missing its completion marker is rejected before Apply becomes available.
- Palette recolor reports the changed swatch and all 14 affected Panda frames before applying.
- Apply changes the artwork; one Undo restores it; Redo reapplies it. Test edits were undone.
- Reload retains the saved original artwork, palette, animation count, and frame timing.

Live model generation was not invoked; generation and cancellation were exercised through deterministic protocol fixtures. The verified editor screenshot is in `output/screenshots/pixel-studio.jpg` (ignored by Git).

## PXA 2 browser checks

Playwright exercised the local preview on port 4318 with an isolated browser workspace:

- Imported the reusable-parts Key, moved one instance, and checked frame isolation and Undo/Redo.
- Painted a main-canvas pixel; save/reload retained both part references and the local override.
- Painted the shared definition; other references updated while the local override kept precedence.
- Exported PXA 1 and compared every rendered cel with the PXA 2 source.
- Copied and pasted a composition patch through both the automatic PXA 2 action and explicit **Edit parts / pixels** action.
- Mocked a refinement response, verified two inline PNG previews, applied the correction, and restored the original with one Undo. No live model call was made.
- Switched the creation prompt builder between PXA 2 (default) and PXA 1.
- Checked parts controls at 1440 × 1000 and 390 × 844. Visual inspection caught clipped action buttons; wrapping fixed them. The final check verified all controls stayed inside the dialog. Screenshots: `output/playwright/pxa-v2-parts-desktop.png` and `output/playwright/pxa-v2-parts-mobile.png`.

The design detector reported six contrast findings across five existing selectors (the count badge appeared twice). These were real color issues: brand subtext, badges, sidebar text and the canvas-size control now use the existing darker green `#5e6f55`; modal subheadings use it too. Against the affected backgrounds, contrast is at least 4.7:1. The static detector could not resolve the build-relative parts stylesheet from `public/`; the built page loads it correctly and the browser layout check covers it.

The subsequent stop-hook findings were compared with the pre-PXA-2 snapshot. All remaining flagged styles predate this change. Two false-positive rules were suppressed only for `public/index.html`, through the Impeccable CLI with recorded evidence: `wide-tracking` applies to short uppercase labels rather than body text, and `cramped-padding` misses computed insets/centering or treats canvas fallback text as visible content. Browser bounds verified a 25px project-info inset, centered toolbar/footer controls, a centered preview with an inset counter, and the intentionally edge-to-edge drawing canvas. Existing small-text findings, the modal border/shadow advisory, and the spritesheet error accent remain unsuppressed for a separately scoped UI pass. This is not a claim of complete WCAG conformance.

## PXA 2 benchmarks

`npm run benchmark -- --tokenizer-python /private/tmp/pixelstudio-tokenizer/bin/python --write` verified matching rendered artwork and recorded byte counts, local decode timing, and optional `o200k_base` proxy tokens. The authored Key uses 22.9% fewer file tokens; the one-frame instance edit uses 34.4% fewer total text tokens than the existing inpaint workflow. Campfire raster encoding uses 8.7% more tokens. Full results and reproduction instructions are in [pxa-v2.md](pxa-v2.md) and [pxa-v2-benchmark.json](pxa-v2-benchmark.json).

These are deterministic representation comparisons. Live model quality, generation latency, model-specific billing and image-refinement cost were not measured.

## Objects and shared artwork

The Objects extension adds automated coverage for legacy group presentation without pixel/ID/timing changes, scoped instance and container ordering, frame stack overrides, pose-preserving movement, visibility/locks, transparent and transformed hit testing, shared editing with local overrides, hidden locked references, group transfer/removal, independent variants, and native/PXA/PXS round trips. Hit tests match the renderer for all six transforms on a non-square part. AI patches cannot edit a group or shared definition protected by a locked instance.

An isolated Playwright workspace on port 4329 verified:

- Existing reusable-parts Key import, object selection and double-click shared editing on the main canvas.
- Shared draft painting, local Undo/Redo, Apply across both animations, and one project Undo/Redo for the shared edit.
- Object reordering, arrow nudging and actual pointer dragging, with one-step Undo.
- Independent pixel painting above part instances without unexpectedly selecting the part underneath.
- Adding/ungrouping groups, moving an instance into a group, frame-specific container order, and PXA 2 `STACK`/`FRAMEORDER` export readback.
- Save/reload retaining group structure and object selection.
- Desktop (1440 × 1100) and mobile (390 × 844) layout. The mobile shared editor now scrolls its editing/context content independently of dirty status, Cancel and Apply. Bounds readback placed Apply's bottom at 778.8px inside the 844px viewport, with content ending above the footer and no horizontal overflow.

Captures are in `.impeccable/review/objects-desktop.png`, `objects-mobile.png`, `shared-desktop.png`, and `shared-mobile.png`. The finish reviewer scored the mobile-footer correction resolved and returned **ship** for that fix. The design documenter confirmed that this extension preserves the incumbent visual system. Existing base-shell small-text/type-hierarchy and modal-style detector findings remain outside this feature's scope. Build-relative module stylesheets cannot be resolved from `public/` by the static detector; the built browser loaded them and the changed styles were inspected directly. No live model generation was used for these checks.

## Runtime

The launcher rebuilds from source and binds to loopback. Development mode rebuilds after a source-file change. Build output remains disposable. This setup is local; it has not been pushed or deployed to the hosted Site.

## Compatibility limit

The canvas ceiling is now 256 × 256 (4,194,304 stored pixels); PXS keeps one-byte dimensions and stores 256 as 0 (`tests/formats.test.mjs`). The integrated patch retains the editor's 64 colors and fractional FPS instead of imposing the standalone patch's narrower assumptions.

## Model catalog update

The PATH CLI was 0.147.0 and returned only the GPT-5.6 family. The installed ChatGPT desktop runtime is 0.167.0-alpha.3.2. Pixel Studio now prefers that runtime on macOS; standalone installations retain the PATH CLI. The live default connection was checked for `gpt-6.1-sol`, `gpt-6.1-terra`, and `gpt-6-astra`. Availability still comes from `model/list`, including account-specific filtering. No generation was invoked during this catalog check.
