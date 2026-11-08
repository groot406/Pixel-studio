/**
 * The plugin API reference — one source for the “Write your own” tab, the “Copy AI prompt to write a plugin” button and
 * docs/plugins.md (regenerate with `node scripts/sync-plugin-docs.mjs`; tests/plugins.test.mjs checks they match).
 */
import { PERMISSIONS, MAX_PLUGIN_BYTES, MAX_REGISTRATIONS, MAX_PARAMS } from './validate.js';
import { RUN_TIMEOUT_MS } from './protocol.js';
import { MAX_SIZE, MAX_COLORS } from '../domain/limits.js';

export const PLUGIN_API_DOC = `## File format

A plugin is ONE plain JavaScript file (a classic script, not an ES module: no \`import\`/\`export\`). It starts with a
JSON manifest inside a comment, followed by code that calls the global \`pixelStudio\` object:

\`\`\`js
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
\`\`\`

- \`id\`: lowercase letters, digits, \`.\`, \`-\`, \`_\` (max 64). Installing a file with the same id updates the plugin.
- \`version\`: \`major.minor.patch\` (shown in the plugin manager; higher versions are offered as updates).
- \`permissions\`: what the plugin may do. Pixel Studio refuses registrations that need a permission you did not list:
${Object.entries(PERMISSIONS).map(([id, text]) => `  - \`${id}\`: ${text}.`).join('\n')}
- Maximum file size ${MAX_PLUGIN_BYTES / 1024} KB; at most ${MAX_REGISTRATIONS} registrations of each kind; at most ${MAX_PARAMS} parameters per command.

## Sandbox

Each plugin runs in its own Web Worker: no DOM, no access to the editor, its storage or other plugins. \`fetch\`,
\`XMLHttpRequest\`, \`WebSocket\`, \`EventSource\`, \`importScripts\` and similar are replaced by functions that throw.
Handlers receive copies of plain data and must return plain data; every result is checked (sizes, palette indices,
palette limits) before it touches the project, and is applied as ONE undo step. A run that takes longer than
${RUN_TIMEOUT_MS / 1000} s is stopped (the worker is terminated and restarted on the next run). Throw an \`Error\` to show
its message to the user.

## API

### pixelStudio.registerEffect(definition, handler)
Adds an entry to the Effects panel (under “Plugins”) and to the command palette (Ctrl/⌘ K). Effects work on pixels:
\`scope\` is \`'frame'\` (default) or \`'selection'\`. Needs the \`pixels\` permission.

### pixelStudio.registerCommand(definition, handler)
Adds a command to the command palette and the Effects panel’s plugin list. \`scope\`:
- \`'frame'\` / \`'selection'\` (permission \`pixels\`): like an effect. Selection commands require a selection.
- \`'animation'\` (permission \`animation\`): rewrite the active container in every frame of the animation.
- \`'project'\` (permission \`project\`): read and replace the whole project as PXA text.

### Definition
\`\`\`js
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
\`\`\`

### Handler context (one argument, plain data; the handler may be async)
- Always: \`width\`, \`height\` (1–${MAX_SIZE}), \`palette\` (array of \`#rrggbb\`, up to ${MAX_COLORS}), \`params\` (chosen values by id),
  \`activeColor\` (palette index or -1), \`scope\`.
- \`frame\` / \`selection\`: \`pixels\` — an Int16Array of width × height palette indices, row by row, \`-1\` = transparent;
  \`frameIndex\`, \`frameCount\`; \`selection\` — null or \`{ x, y, width, height, mask }\` (mask: Uint8Array, 1 = selected).
  In the editor’s “every frame” edit scope the handler is called once per frame (frames holding locked objects are skipped).
  Only pixels inside the selection are applied.
- \`animation\`: \`frames\` — \`[{ pixels, duration }]\` for the active container in every frame, \`frameIndex\` (current frame).
- \`project\`: \`pxa\` — the whole project as PXA text (the same format the AI prompt builder uses).

### Handler result
- \`frame\` / \`selection\`: \`{ pixels }\` — array or typed array of exactly width × height integers from -1 to palette length - 1.
- \`animation\`: \`{ frames }\` — at least as many entries as there are frames; each is a pixel array or \`{ pixels, duration }\`
  (duration 1–60000 ms). Extra entries add frames at the end (other containers copy the last frame).
- \`project\`: \`{ project: 'PXA text' }\`.
- Optional \`palette\` (frame, selection and animation scopes; needs the \`palette\` permission): the current palette,
  unchanged and in order, followed by new colours, max ${MAX_COLORS} in total. Pixels may then use the new indices.

### pixelStudio.registerPromptSkill({ id, title, description, instructions, animations?, width?, height? })
Adds a preset to the AI prompt builder (“Prompt skill”). \`instructions\` (max 4000 characters) are added to the prompt as
expert guidance; optional \`animations\` (\`[{ name, frameCount, fps }]\`), \`width\` and \`height\` fill in the plan.
Needs the \`prompt\` permission.

### pixelStudio.registerPalette({ name, colors })
Adds a palette (1–${MAX_COLORS} \`#rrggbb\` colours) to Palette studio’s presets (filter “From plugins”). Needs the \`palette\` permission.

### pixelStudio.log(...values)
Writes a line to the browser console, prefixed with the plugin id.

## Tips
- Never modify the input arrays in place and return them; build a new array (\`Array.from(pixels)\`).
- Work only with palette indices; to add a colour, return \`palette\` with the colour appended and use its new index.
- Keep handlers fast and deterministic (seed your random numbers) so previews match the applied result.
`;

/** A ready-to-paste chatbot prompt for writing a plugin that does `idea`. */
export function pluginAuthorPrompt(idea = '') {
  return `You are writing a plugin for Pixel Studio, a browser pixel-art and animation editor.
Write ONE complete plugin file that does the following:
${idea.trim() || '<describe what the plugin should do>'}

Follow the API reference below exactly. Return only the JavaScript file (starting with the /* pixelstudio-plugin */
manifest comment), no explanation. Use the smallest set of permissions that works. Comment the code briefly.

# Pixel Studio plugin API (version 1)

${PLUGIN_API_DOC}`;
}

/** The full docs/plugins.md. */
export function pluginDocsMarkdown() {
  return `# Pixel Studio plugins and prompt skills

<!-- Generated from src/plugins/api-doc.js by scripts/sync-plugin-docs.mjs — edit that file, not this one. -->

Plugins add effects, commands, palettes and AI prompt skills to Pixel Studio. Install them from **Plugins & skills**
(the puzzle button in the header): from the built-in gallery, a \`.js\` file (picker or drag and drop), pasted code, or a
URL (web build only: the local edition’s Content-Security-Policy allows network requests to itself only). The
**Write your own** tab shows this reference and copies a prompt that lets any chatbot write a plugin for you.

Example plugins live in [\`public/plugins/\`](../public/plugins/) and are listed in \`public/plugins/index.json\`.

${PLUGIN_API_DOC}`;
}
