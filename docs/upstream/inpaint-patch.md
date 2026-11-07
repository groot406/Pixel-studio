# Pixel Studio — AI Inpaint + Palette Recolor core

This is a **source integration patch**, NOT a published update to the Pixel Studio website. The editable project/repository was not available in this session. It is a dependency-free tested engine that can be integrated into Pixel Studio's existing selection tool, project state, AI-edit dialog, and Local Codex bridge.

## Features

- **AI Inpaint:** A rectangular selection sets a hard pixel mask. Supports editing a single active frame or the same selection in all frames of the active animation. Only the selected, unlocked layer can be modified. All other pixels, animations, layers, frame durations, canvas size and palette colors are preserved.
- **AI Palette Recolor:** An AI-generated palette-only patch proposes new hex colors for existing palette slots. No indexed pixel slots change. The change applies project-wide because the palette is shared. The preview lists every changed swatch.
- **Before/after preview:** Both functions return a *new project* (no original mutation). Feed the original and proposal to the editor's existing renderer and animation preview; show the `changedPixels` / `swatches` summary. Apply the proposed project in a **single existing Undo transaction**.
- **Staleness protection:** Each AI response includes the project fingerprint. A response is rejected if the project has changed since generation began. For stronger concurrency guarantees, combine with your existing project revision and tab ID checks.
- Works for **256 × 256**, up to 32 palette colors, 32 layers, with a bounded AI preview allocation.

## How to integrate

Import the functions into the local Pixel Studio frontend:

```js
import {
  buildInpaintPrompt, previewInpaint,
  buildRecolorPrompt, previewRecolor, projectFingerprint
} from './ai-edit-core.mjs';

// Adapter: convert Pixel Studio's editor state to normalized indexed data.
// See typedef in ai-edit-core.mjs. Pixel slot -1 means transparent.
const project = editorToNormalizedProject(activeTab);
const pxa = exportToPXA(activeTab);
const request = {
  scope: 'frame', // or 'animation'
  animationIndex: activeAnimationIndex,
  frameIndex: activeFrameIndex,
  layerIndex: activeLayerIndex,
  selection: {x: 8, y: 6, width: 12, height: 10}
};
const prompt = buildInpaintPrompt({
  project, request, description: 'Add a golden crown', originalPxa: pxa
});
// Existing local Codex path, preserving selected model (Sol, Astra, etc.)
const response = await localCodex.generate({model: selectedModel, prompt});
// No pixels are changed before review.
const proposed = previewInpaint(project, response.text, request);
showExistingBeforeAfterDialog(project, proposed.project, proposed.changedPixels);
// Apply as ONE undoable state change only when the user accepts:
// existingEditorHistory.commit(normalizedToEditor(proposed.project));
```

Recolor is analogous:

```js
const prompt = buildRecolorPrompt({project, description: 'Warm autumn colors, retain contrast'});
const response = await localCodex.generate({model: selectedModel, prompt});
const proposal = previewRecolor(project, response.text);
showPaletteSwatchesAndBeforeAfter(project, proposal.project, proposal.swatches);
// Commit as one Undo action only after explicit confirmation.
```

For the public site, copy the generated prompt to ChatGPT and paste the text into the same validators. **No paid API endpoint is required for copy/paste.** On localhost, use the existing local Codex bridge and signed-in user's allowance.

## Inpaint AI patch format (not JSON)

```text
PXAINPAINT 1
SIZE 32 32
RECT 6 8 12 10
BASE <16-digit fingerprint provided in prompt>
TARGET 0 2 1
SPAN 8 8 1{4}2..
SPAN 9 9 1{3}
```

Coordinates are absolute (`x, y`), left/top inclusive. `SPAN y x pixel-string` writes only the listed pixels inside the selection and uses 0–9, A–Z palette slot codes; `.` clears pixels to transparent, and `A{5}` expands to five identical pixels. Omitted cells remain unchanged. All changes outside the RECT or allowed animation-frame-layer targets cause an error before preview/apply.

**Current limitation:** The engine uses the existing rectangular selection, not a freehand/lasso polygon mask. The exported PXA context relies on Pixel Studio's own full PXA exporter. Project state requires an adapter, which must match the host app's internal data structures.

## Palette AI patch format

```text
PXAPALETTE 1
BASE <16-digit fingerprint provided in prompt>
SET 0 #3C2722
SET 1 #CA6844
SET 2 #FFE2B0
```

A `SET` updates an existing slot's hex color. No new slots or pixel index changes are allowed. The UI should warn users that a shared palette affects all artwork that uses the changed slots.

## Tests

```bash
node --test test.mjs
```

These cover masked edits, scope confinement, rejection of invalid spans and stale results, repeat run-lengths, palette-only recolors, transparent compositing, and 256 × 256 handling.

## UI recommended

Add two actions to **AI edit**: **Inpaint selection** and **Recolor palette**. Disable Inpaint unless a non-empty selection and an unlocked layer are active. Show a frame/animation scope selector; always display the rectangle dimensions. On generation failure, do not change state. In the review dialog, show original/proposal side-by-side with a blinking changed-pixel mask and synchronized playback. Show changed palette swatches for Recolor. Apply as one undoable action, and do not auto-apply.
