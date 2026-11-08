# Pixel Studio plugins and prompt skills

<!-- Generated from src/plugins/api-doc.js by scripts/sync-plugin-docs.mjs — edit that file, not this one. -->

Plugins add effects, commands, palettes and AI prompt skills to Pixel Studio. Install them from **Plugins & skills**
(the puzzle button in the header): from the built-in gallery, a `.js` file (picker or drag and drop), pasted code, or a
URL (web build only: the local edition’s Content-Security-Policy allows network requests to itself only). The
**Write your own** tab shows this reference and copies a prompt that lets any chatbot write a plugin for you.

Example plugins live in [`public/plugins/`](../public/plugins/) and are listed in `public/plugins/index.json`.

## File format

A plugin is ONE plain JavaScript file (a classic script, not an ES module: no `import`/`export`). It starts with a
JSON manifest inside a comment, followed by code that calls the global `pixelStudio` object:

```js
/* pixelstudio-plugin
{
  "id": "my-effect",
  "name": "My effect",
  "version": "1.0.0",
  "description": "What it does, in one sentence.",
  "author": "Your name",
  "permissions": ["pixels"]
}
*/
pixelStudio.registerEffect({ id: 'my-effect', title: 'My effect' }, ({ width, height, pixels }) => {
  return { pixels: Array.from(pixels, v => v) };
});
```

- `id`: lowercase letters, digits, `.`, `-`, `_` (max 64). Installing a file with the same id updates the plugin.
- `version`: `major.minor.patch` (shown in the plugin manager; higher versions are offered as updates).
- `permissions`: what the plugin may do. Pixel Studio refuses registrations that need a permission you did not list:
  - `pixels`: Change pixels of the active container (effects, frame and selection commands).
  - `animation`: Rewrite the active container across the animation and add frames.
  - `palette`: Append colours to the palette and offer palette presets.
  - `project`: Read the whole project and replace it (one undo step).
  - `prompt`: Add prompt skills (presets) to the AI prompt builder.
- Maximum file size 256 KB; at most 32 registrations of each kind; at most 12 parameters per command.

## Sandbox

Each plugin runs in its own Web Worker: no DOM, no access to the editor, its storage or other plugins. `fetch`,
`XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts` and similar are replaced by functions that throw.
Handlers receive copies of plain data and must return plain data; every result is checked (sizes, palette indices,
palette limits) before it touches the project, and is applied as ONE undo step. A run that takes longer than
5 s is stopped (the worker is terminated and restarted on the next run). Throw an `Error` to show
its message to the user.

## API

### pixelStudio.registerEffect(definition, handler)
Adds an entry to the Effects panel (under “Plugins”) and to the command palette (Ctrl/⌘ K). Effects work on pixels:
`scope` is `'frame'` (default) or `'selection'`. Needs the `pixels` permission.

### pixelStudio.registerCommand(definition, handler)
Adds a command to the command palette and the Effects panel’s plugin list. `scope`:
- `'frame'` / `'selection'` (permission `pixels`): like an effect. Selection commands require a selection.
- `'animation'` (permission `animation`): rewrite the active container in every frame of the animation.
- `'project'` (permission `project`): read and replace the whole project as PXA text.

### Definition
```js
{
  id: 'outline-glow',            // unique within the plugin
  title: 'Outline glow',         // max 60 characters
  description: 'Short hint',     // optional, max 200
  scope: 'frame',                // see above
  params: [                      // optional; Pixel Studio builds the dialog for you
    { id: 'size', label: 'Size', type: 'number', min: 1, max: 4, step: 1, default: 1 },
    { id: 'mode', label: 'Mode', type: 'select', options: [{ value: 'soft', label: 'Soft' }, 'hard'], default: 'soft' },
    { id: 'tint', label: 'Colour', type: 'color', default: 'darkest' },   // palette index; default: index, 'active', 'darkest' or 'lightest'
    { id: 'dither', label: 'Dither', type: 'boolean', default: true },
  ],
}
```

### Handler context (one argument, plain data; the handler may be async)
- Always: `width`, `height` (1–256), `palette` (array of `#rrggbb`, up to 64), `params` (chosen values by id),
  `activeColor` (palette index or -1), `scope`.
- `frame` / `selection`: `pixels` — an Int16Array of width × height palette indices, row by row, `-1` = transparent;
  `frameIndex`, `frameCount`; `selection` — null or `{ x, y, width, height, mask }` (mask: Uint8Array, 1 = selected).
  In the editor’s “every frame” edit scope the handler is called once per frame (frames holding locked objects are skipped).
  Only pixels inside the selection are applied.
- `animation`: `frames` — `[{ pixels, duration }]` for the active container in every frame, `frameIndex` (current frame).
- `project`: `pxa` — the whole project as PXA text (the same format the AI prompt builder uses).

### Handler result
- `frame` / `selection`: `{ pixels }` — array or typed array of exactly width × height integers from -1 to palette length - 1.
- `animation`: `{ frames }` — at least as many entries as there are frames; each is a pixel array or `{ pixels, duration }`
  (duration 1–60000 ms). Extra entries add frames at the end (other containers copy the last frame).
- `project`: `{ project: 'PXA text' }`.
- Optional `palette` (frame, selection and animation scopes; needs the `palette` permission): the current palette,
  unchanged and in order, followed by new colours, max 64 in total. Pixels may then use the new indices.

### pixelStudio.registerPromptSkill({ id, title, description, instructions, animations?, width?, height? })
Adds a preset to the AI prompt builder (“Prompt skill”). `instructions` (max 4000 characters) are added to the prompt as
expert guidance; optional `animations` (`[{ name, frameCount, fps }]`), `width` and `height` fill in the plan.
Needs the `prompt` permission.

### pixelStudio.registerPalette({ name, colors })
Adds a palette (1–64 `#rrggbb` colours) to Palette studio’s presets (filter “From plugins”). Needs the `palette` permission.

### pixelStudio.log(...values)
Writes a line to the browser console, prefixed with the plugin id.

## Tips
- Never modify the input arrays in place and return them; build a new array (`Array.from(pixels)`).
- Work only with palette indices; to add a colour, return `palette` with the colour appended and use its new index.
- Keep handlers fast and deterministic (seed your random numbers) so previews match the applied result.
