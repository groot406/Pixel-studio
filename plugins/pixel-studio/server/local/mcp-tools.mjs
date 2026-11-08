/**
 * Pixel Studio MCP tools, resources and prompts. File access is confined to one workspace root; editor_* tools talk
 * to a running local edition through the bridge (see bridge.mjs).
 */
import { readFile, realpath, stat, access } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PXA2_GUIDE } from '../src/formats/pxa-v2.js';
import { AI_FORMAT_GUIDE } from '../src/formats/pxa.js';
import { buildCreationPrompt } from '../src/features/ai/prompt-builder.js';
import { decodeAIProject } from '../src/formats/pxa.js';
import {
  loadProject, saveProject, writeBytes, projectSummary, projectToPxa, lintPxa, renderPng, exportProject, writeExport,
  imageToProject, listPalettePresets, setPalette, applyTemplate, makeParts, createProject, TEMPLATE_IDS, formatOf,
} from './headless.mjs';
import { callBridge, readBridgeInfo } from './bridge.mjs';

const REPO = fileURLToPath(new URL('../', import.meta.url));
export const PACKAGE_VERSION = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')).version;
const MAX_INLINE_IMAGE_EDGE = 1024;

export class ToolError extends Error {}

/** Resolve `input` inside `root`; rejects traversal and symlinks that leave the workspace. */
export async function resolveInside(root, input, { mustExist = false } = {}) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new ToolError('Give a file path (relative to the workspace root).');
  const target = resolve(root, input);
  const inside = path => path === root || path.startsWith(root + sep);
  if (!inside(target)) throw new ToolError(`Path "${input}" is outside the workspace root ${root}. Use a path inside it.`);
  let existing = target;
  for (;;) {
    try { await access(existing); break; } catch { const parent = dirname(existing); if (parent === existing) break; existing = parent; }
  }
  const real = await realpath(existing).catch(() => existing);
  if (!inside(real)) throw new ToolError(`Path "${input}" resolves outside the workspace root through a symbolic link.`);
  if (mustExist && existing !== target) throw new ToolError(`File not found: ${input} (workspace root: ${root}).`);
  return target;
}

const text = value => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });
const image = png => ({ type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' });

function inlineScale(project, scale) {
  const edge = Math.max(project.width, project.height);
  if (scale !== undefined) return Math.max(1, Math.min(Number(scale), Math.floor(MAX_INLINE_IMAGE_EDGE / edge) || 1));
  return Math.max(1, Math.min(12, Math.floor(384 / edge)));
}

async function preview(project, options = {}) {
  const r = await renderPng(project, { background: 'checker', ...options, scale: inlineScale(project, options.scale) });
  return { r, content: image(r.png) };
}

function lintReport(result) {
  if (result.ok) return null;
  const e = result.errors[0];
  return `PXA is invalid${e.line ? ` at line ${e.line}${e.located ? ' (located by bisection)' : ''}` : ''}: ${e.message}${e.source ? `\n  > ${e.source}` : ''}${result.hint ? `\nHint: ${result.hint}` : ''}\nFix the problem and call the tool again with the complete corrected document.`;
}

const path = description => ({ type: 'string', description });
const animationArg = { type: ['string', 'integer'], description: 'Animation id, name, or 0-based index. Default: the first animation.' };
const frameArg = { type: ['string', 'integer'], description: 'Frame id or 0-based index within the animation. Default: 0.' };
const scaleArg = { type: 'integer', minimum: 1, maximum: 64, description: 'Integer pixel scale (nearest neighbour). Default picks a readable size.' };
const outArg = path('Output file path inside the workspace. Defaults to overwriting the input project.');

/** Tool definitions: name → { description, inputSchema, annotations, run(args, ctx) }. */
function toolTable() {
  return {
    pixel_guide: {
      title: 'Pixel Studio format guide',
      description: 'Return the PXA 2 text format guide (how to write Pixel Studio projects: palette, layers, parts, animations, frames, drawing commands, skeleton bones). Read this before writing or editing PXA. topic "workflow" returns the recommended agent workflow and pixel-art rules; "pxa1" the legacy raster format; "prompting" a full creation prompt template.',
      inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: ['pxa2', 'workflow', 'pxa1', 'prompting'], default: 'pxa2' } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: async ({ topic = 'pxa2' }) => [text(await guide(topic))],
    },
    list_palette_presets: {
      title: 'List palette presets',
      description: 'List the built-in pixel-art palettes (PICO-8, Sweetie 16, Endesga 32, Game Boy…) with their hex colours. Use an id with create_project or set_palette.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: async () => [text(listPalettePresets().map(p => `${p.id} — ${p.name}${p.author ? ` by ${p.author}` : ''} (${p.colors.length}): ${p.colors.join(' ')}`).join('\n'))],
    },
    create_project: {
      title: 'Create project',
      description: 'Create a new blank Pixel Studio project file (.pxa text recommended, or .pxs/.pixel.json) with a canvas size, palette and an empty animation. Returns the PXA 2 text to start drawing in; then edit it and save with write_project.',
      inputSchema: {
        type: 'object', required: ['path'], additionalProperties: false,
        properties: {
          path: path('New file path inside the workspace, e.g. "sprites/hero.pxa".'),
          name: { type: 'string', maxLength: 120, description: 'Project name.' },
          width: { type: 'integer', minimum: 1, maximum: 256, default: 32 }, height: { type: 'integer', minimum: 1, maximum: 256, default: 32 },
          palette: { description: 'Palette preset id (see list_palette_presets) or an array of #rrggbb colours (1–64). Default: Pixel Studio 16-colour palette.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          animation: { type: 'string', description: 'First animation name. Default "Idle".' },
          frames: { type: 'integer', minimum: 1, maximum: 256, default: 1 }, fps: { type: 'integer', minimum: 1, maximum: 60, default: 8 },
          overwrite: { type: 'boolean', default: false },
        },
      },
      run: async (a, ctx) => {
        const file = await ctx.resolve(a.path);
        if (!a.overwrite && await exists(file)) throw new ToolError(`${a.path} already exists. Pass overwrite: true or choose another path.`);
        const project = createProject({ name: a.name || basename(a.path).replace(/\.(pixel\.json|pxa|pxs|json)$/i, ''), width: a.width ?? 32, height: a.height ?? 32, palette: a.palette, frames: a.frames ?? 1, fps: a.fps ?? 8, animation: a.animation || 'Idle' });
        await saveProject(file, project);
        return [text(`Created ${ctx.rel(file)} (${project.width}×${project.height}, ${project.palette.length} colours). Current PXA 2:\n\n${projectToPxa(project)}`)];
      },
    },
    project_info: {
      title: 'Project info',
      description: 'Summarise a project file: size, palette, layers, parts/objects, animations (frames, fps, durations), skeleton bones and poses.',
      inputSchema: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: path('Project file (.pxa, .pxs, .pixel.json).') } },
      annotations: { readOnlyHint: true },
      run: async (a, ctx) => [text(projectSummary((await ctx.load(a.path)).project))],
    },
    read_project: {
      title: 'Read project as PXA',
      description: 'Read a project file (.pxa, .pxs or .pixel.json) and return it as PXA 2 text you can edit. Pass animation to get only that animation (smaller; write_project then replaces the file with only that animation, so merge carefully).',
      inputSchema: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: path('Project file.'), animation: animationArg } },
      annotations: { readOnlyHint: true },
      run: async (a, ctx) => [text(projectToPxa((await ctx.load(a.path)).project, { animation: a.animation }))],
    },
    validate_pxa: {
      title: 'Validate PXA',
      description: 'Check PXA text without saving. Returns precise errors (line, message, offending source line, hint) or a summary plus warnings (unused colours, blank frames).',
      inputSchema: { type: 'object', required: ['pxa'], additionalProperties: false, properties: { pxa: { type: 'string', description: 'Complete PXA document text.' } } },
      annotations: { readOnlyHint: true },
      run: async a => {
        const result = lintPxa(a.pxa), report = lintReport(result);
        if (report) throw new ToolError(report);
        return [text({ valid: true, summary: result.summary, warnings: result.warnings })];
      },
    },
    write_project: {
      title: 'Write project',
      description: 'Validate PXA text and save it to a project file. .pxa keeps your text exactly; .pxs/.pixel.json are converted. On invalid input nothing is written and the error names the line and problem. On success returns a summary, warnings and a PNG preview of the first frame (look at it and iterate).',
      inputSchema: {
        type: 'object', required: ['path', 'pxa'], additionalProperties: false,
        properties: {
          path: path('Target file inside the workspace (.pxa recommended).'), pxa: { type: 'string', description: 'Complete PXA 2 document ending with END.' },
          overwrite: { type: 'boolean', default: true }, preview: { type: 'boolean', default: true, description: 'Return a PNG preview.' },
          previewAnimation: animationArg,
        },
      },
      run: async (a, ctx) => {
        const file = await ctx.resolve(a.path);
        if (a.overwrite === false && await exists(file)) throw new ToolError(`${a.path} already exists.`);
        const result = lintPxa(a.pxa), report = lintReport(result);
        if (report) throw new ToolError(report);
        if (formatOf(file) === 'pxa') await writeBytes(file, Buffer.from(a.pxa.endsWith('\n') ? a.pxa : `${a.pxa}\n`, 'utf8'));
        else if (formatOf(file) === 'png') throw new ToolError('Use export to write PNG images; write_project saves projects (.pxa, .pxs, .pixel.json).');
        else await saveProject(file, result.project);
        const out = [text(`Saved ${ctx.rel(file)}.\n${JSON.stringify({ summary: shortSummary(result.summary), warnings: result.warnings }, null, 2)}`)];
        if (a.preview !== false) out.push((await preview(result.project, { animation: a.previewAnimation, strip: true })).content);
        return out;
      },
    },
    render_png: {
      title: 'Render PNG',
      description: 'Render a frame (or a whole animation as a horizontal strip with strip: true) to a PNG you can look at. Returns the image inline; also writes it when out is given. Transparent areas show as a light checkerboard unless background is set.',
      inputSchema: {
        type: 'object', required: ['path'], additionalProperties: false,
        properties: {
          path: path('Project file.'), animation: animationArg, frame: frameArg, strip: { type: 'boolean', default: false, description: 'Render every frame of the animation side by side.' },
          scale: scaleArg, background: { type: 'string', description: '"checker" (default inline), "transparent" (default for files) or #rrggbb.' },
          out: path('Optional PNG output path inside the workspace.'),
        },
      },
      run: async (a, ctx) => {
        const { project } = await ctx.load(a.path), result = [];
        if (a.out) {
          const out = await ctx.resolve(a.out);
          const r = await renderPng(project, { animation: a.animation, frame: a.frame, strip: a.strip, scale: a.scale, background: a.background || 'transparent' });
          await writeBytes(out, r.png);
          result.push(text(`Wrote ${ctx.rel(out)} (${r.width}×${r.height}).`));
        }
        const { r, content } = await preview(project, { animation: a.animation, frame: a.frame, strip: a.strip, scale: a.scale, background: a.background || 'checker' });
        result.unshift(text(`${r.animation.name}: ${r.frames.map(f => `frame ${f.index} (${f.duration} ms)`).join(', ')} at ${r.scale}×.`));
        result.push(content);
        return result;
      },
    },
    image_to_pixels: {
      title: 'Image to pixel art',
      description: 'Convert a PNG (for example AI-generated "pixel art" or an upscaled sprite) into a clean pixel project: detects the pixel grid (or use pixelSize), removes the flat background, trims, and quantizes to a limited palette. Saves the project when out is given and returns PXA text plus a preview.',
      inputSchema: {
        type: 'object', required: ['image'], additionalProperties: false,
        properties: {
          image: path('PNG file inside the workspace.'), out: path('Optional project output path (.pxa/.pxs/.pixel.json).'),
          colors: { type: 'integer', minimum: 1, maximum: 64, default: 16, description: 'Maximum palette colours.' },
          palette: { description: 'Map onto this palette instead (preset id is not accepted here; give #rrggbb colours).', type: 'array', items: { type: 'string' } },
          pixelSize: { type: 'number', minimum: 1, description: 'Known size of one art pixel in the image (e.g. 8 for an 8× upscale). Default: auto-detect.' },
          maxSize: { type: 'integer', minimum: 1, maximum: 256, default: 128, description: 'Downscale larger results to this many pixels on the long edge.' },
          removeBackground: { type: 'boolean', default: true }, name: { type: 'string' },
        },
      },
      run: async (a, ctx) => {
        const source = await ctx.resolve(a.image, { mustExist: true });
        const r = await imageToProject(await readFile(source), { colors: a.colors ?? 16, palette: a.palette, pixelSize: a.pixelSize, maxSize: a.maxSize ?? 128, background: a.removeBackground !== false, name: a.name || basename(source, extname(source)) });
        const lines = [`Pixelized ${ctx.rel(source)} (${r.source.width}×${r.source.height}) → ${r.project.width}×${r.project.height}, ${r.project.palette.length} colours${r.grid?.scale > 1 ? `, detected pixel size ${Math.round(r.grid.scale * 100) / 100}` : ''}${r.removed ? `, removed ${r.removed} background pixels` : ''}.`];
        if (a.out) { const out = await ctx.resolve(a.out); await saveProject(out, r.project); lines.push(`Saved ${ctx.rel(out)}.`); }
        lines.push('', projectToPxa(r.project));
        return [text(lines.join('\n')), (await preview(r.project)).content];
      },
    },
    apply_template: {
      title: 'Apply animation template',
      description: `Generate a procedural animation (${TEMPLATE_IDS.join(', ')}) for a rigged character (a project with BONE lines that join placed parts, like the "Stick puppet" sample). Adds a new animation by default (mode "new"), or replaces/merges into an existing one. Returns a preview strip.`,
      inputSchema: {
        type: 'object', required: ['path', 'template'], additionalProperties: false,
        properties: {
          path: path('Rigged project file.'), template: { type: 'string', enum: TEMPLATE_IDS }, out: outArg,
          animation: { ...animationArg, description: 'Animation whose frame is the base pose (and the one replaced/merged). Default: first.' }, frame: frameArg,
          rootBone: { type: 'string', description: 'Root bone id or name of the character. Default: the first root bone.' },
          frames: { type: 'integer', minimum: 2, maximum: 64 }, frameMs: { type: 'integer', minimum: 16, maximum: 2000 },
          amplitude: { type: 'number', description: 'Swing in degrees (template default if omitted).' }, bounce: { type: 'number', description: 'Bounce/jump height in pixels.' },
          exaggeration: { type: 'number', minimum: 0, maximum: 3 }, facing: { type: 'string', enum: ['auto', 'left', 'right', 'front'] },
          mode: { type: 'string', enum: ['new', 'replace', 'merge'], default: 'new' }, name: { type: 'string', description: 'Name of the new animation.' },
        },
      },
      run: async (a, ctx) => {
        const { project } = await ctx.load(a.path);
        const r = applyTemplate(project, a), out = await ctx.resolve(a.out || a.path);
        await saveProject(out, r.project);
        return [text(`Generated ${a.template} as animation "${r.animationId}" (${r.frameIds.length} frames, facing ${r.facing}) in ${ctx.rel(out)}. Bone roles: ${Object.entries(r.roles).map(([role, id]) => `${role}=${id}`).join(', ')}.`), (await preview(r.project, { animation: r.animationId, strip: true })).content];
      },
    },
    make_parts: {
      title: 'Make parts and auto-rig',
      description: 'Turn drawn (RASTER) layers into reusable parts — one placed part per layer, identical drawings shared between frames — and, unless rig is false, auto-rig them into a skeleton: the torso/body (or largest part) becomes the root and every other part is jointed where it touches its neighbour. Pixels stay identical. Use this when a character was drawn as raster layers so it can be posed and animated with apply_template.',
      inputSchema: {
        type: 'object', required: ['path'], additionalProperties: false,
        properties: {
          path: path('Project file.'), out: outArg,
          layers: { type: 'array', items: { type: 'string' }, description: 'Layer ids or names to convert. Default: every layer with drawn pixels.' },
          rig: { type: 'boolean', default: true, description: 'Join the parts into a skeleton.' },
          animation: { ...animationArg, description: 'Animation whose frame is used to find the joints. Default: first.' }, frame: frameArg,
        },
      },
      run: async (a, ctx) => {
        const { project } = await ctx.load(a.path);
        const r = makeParts(project, a), out = await ctx.resolve(a.out || a.path);
        await saveProject(out, r.project);
        const lines = [
          r.converted.length ? `Converted ${r.converted.length} layer${r.converted.length === 1 ? '' : 's'} to parts: ${r.converted.map(c => `${c.instanceId}${c.parts > 1 ? ` (${c.parts} drawings)` : ''}`).join(', ')}.` : 'No drawn layers to convert.',
          r.attached.length ? `Rigged under root bone "${r.rootBoneId}": ${r.attached.map(b => `${b.bone} → ${b.parent}`).join(', ')}.` : a.rig === false ? 'Not rigged (rig false).' : 'No new bones were needed.',
          `Saved ${ctx.rel(out)}. Next: apply_template (${TEMPLATE_IDS.slice(0, 4).join(', ')}…) to animate it. Tip: separate layers per limb give finer poses.`,
        ];
        return [text(lines.join('\n')), (await preview(r.project)).content];
      },
    },
    set_palette: {
      title: 'Set palette',
      description: 'Replace a project palette with a preset or explicit colours. remap true (default) moves every pixel to the nearest new colour; remap false keeps colour indices (recolours by slot).',
      inputSchema: {
        type: 'object', required: ['path'], additionalProperties: false,
        properties: {
          path: path('Project file.'), out: outArg, preset: { type: 'string', description: 'Preset id, e.g. "pico-8", "sweetie-16", "endesga-32".' },
          colors: { type: 'array', items: { type: 'string' }, description: 'Explicit #rrggbb colours (1–64).' }, remap: { type: 'boolean', default: true },
        },
      },
      run: async (a, ctx) => {
        const { project } = await ctx.load(a.path);
        const r = setPalette(project, { preset: a.preset, colors: a.colors, remap: a.remap !== false }), out = await ctx.resolve(a.out || a.path);
        await saveProject(out, r.project);
        return [text(`Palette set (${r.project.palette.length} colours, ${r.changed} used colours changed) in ${ctx.rel(out)}.`), (await preview(r.project)).content];
      },
    },
    export: {
      title: 'Export image',
      description: 'Export a project with the editor\'s exporter: "png" (one frame), "spritesheet" (all animations, one row each, plus Aseprite-style JSON), "gif" or "apng" (one animation), "sequence" (zip of PNG frames). Writes into the workspace.',
      inputSchema: {
        type: 'object', required: ['path', 'format', 'out'], additionalProperties: false,
        properties: {
          path: path('Project file.'), format: { type: 'string', enum: ['png', 'spritesheet', 'gif', 'apng', 'sequence'] },
          out: path('Output file (or a directory ending in /, or a .zip for the bundle).'),
          animation: animationArg, frame: frameArg, scale: { type: 'integer', minimum: 1, maximum: 64, default: 1 },
          scope: { type: 'string', enum: ['animation', 'project'], description: 'Sheets default to the whole project, GIF/APNG to one animation.' },
          layout: { type: 'string', enum: ['rows', 'horizontal', 'vertical', 'grid'], default: 'rows' }, spacing: { type: 'integer', minimum: 0, maximum: 256 }, padding: { type: 'integer', minimum: 0, maximum: 256 },
          metadata: { type: 'string', enum: ['none', 'aseprite-hash', 'aseprite-array', 'godot', 'unity', 'generic', 'pixel-studio'], default: 'aseprite-hash' },
          background: { type: 'string', description: '#rrggbb, default transparent.' },
        },
      },
      run: async (a, ctx) => {
        const { project } = await ctx.load(a.path), out = await ctx.resolve(a.out);
        const kind = a.format === 'spritesheet' ? 'sheet' : a.format;
        if (kind === 'sequence' && extname(out).toLowerCase() !== '.zip' && !/[\\/]$/.test(a.out)) throw new ToolError('A PNG sequence needs out ending in .zip or a directory ending in /.');
        const result = await exportProject(project, { kind, scope: a.scope, animation: a.animation, frame: a.frame, scale: a.scale ?? 1, layout: a.layout, spacing: a.spacing ?? 0, padding: a.padding ?? 0, metadata: a.metadata, background: a.background || null });
        const written = await writeExport(result, out);
        return [text(`Wrote ${written.map(p => ctx.rel(p)).join(', ')}.`)];
      },
    },
    editor_status: {
      title: 'Editor status',
      description: 'Check whether Pixel Studio Local is running and an editor tab is open for live editing (editor_* tools).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: async (_a, ctx) => {
        const info = await readBridgeInfo(ctx.bridgeDirectory);
        if (!info) return [text({ running: false, help: 'Pixel Studio Local is not running. Ask the user to run `npm start` in the Pixel Studio folder (or `pixelstudio serve`) and open the printed URL.' })];
        const status = await callBridge('status', {}, { directory: ctx.bridgeDirectory });
        return [text({ running: true, url: info.url, editorOpen: status.editorConnected, editors: status.editors, ...(status.editorConnected ? {} : { help: `Open ${info.url} in a browser.` }) })];
      },
    },
    editor_get_project: {
      title: 'Get editor project',
      description: 'Get the project open in the user\'s Pixel Studio editor (the active tab) as PXA 2 text, plus a PNG preview of the current frame. Requires Pixel Studio Local running with the editor open.',
      inputSchema: { type: 'object', properties: { preview: { type: 'boolean', default: true }, strip: { type: 'boolean', default: false, description: 'Preview the whole current animation.' } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: async (a, ctx) => {
        const r = await callBridge('get_project', {}, { directory: ctx.bridgeDirectory });
        const out = [text(`Editor tab "${r.name}" — current animation ${r.animationId}, frame ${r.frameId}.\n\n${r.pxa}`)];
        if (a.preview !== false) out.push((await preview(decodeAIProject(r.pxa), { animation: r.animationId, frame: a.strip ? undefined : r.frameId, strip: !!a.strip })).content);
        return out;
      },
    },
    editor_apply_project: {
      title: 'Apply project in editor',
      description: 'Send a complete PXA 2 document to the open editor. mode "replace" (default) replaces the active tab as ONE undo step (the user can press Undo); "new-tab" opens it in a new tab. The user is asked to allow agent edits the first time. Validate first; invalid PXA is rejected with line-precise errors.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          pxa: { type: 'string', description: 'Complete PXA document. Either pxa or path is required.' }, path: path('Project file to send instead of pxa.'),
          mode: { type: 'string', enum: ['replace', 'new-tab'], default: 'replace' }, message: { type: 'string', maxLength: 200, description: 'Short note shown to the user, e.g. "Added a blink to Idle".' },
        },
      },
      run: async (a, ctx) => {
        let pxa = a.pxa;
        if (!pxa && a.path) pxa = projectToPxa((await ctx.load(a.path)).project);
        if (!pxa) throw new ToolError('Give pxa text or a project path.');
        const result = lintPxa(pxa), report = lintReport(result);
        if (report) throw new ToolError(report);
        const r = await callBridge('apply_project', { pxa, mode: a.mode || 'replace', message: a.message || '' }, { directory: ctx.bridgeDirectory });
        return [text(r?.message || 'Applied in the editor.'), (await preview(result.project, { strip: true })).content];
      },
    },
    editor_open_file: {
      title: 'Open file in editor',
      description: 'Open a project file from the workspace in a new editor tab.',
      inputSchema: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: path('Project file (.pxa, .pxs, .pixel.json, or a PNG to pixelize).') } },
      run: async (a, ctx) => {
        const { project } = await ctx.load(a.path);
        const r = await callBridge('apply_project', { pxa: projectToPxa(project), mode: 'new-tab', message: `Opened ${basename(a.path)} from your AI agent.` }, { directory: ctx.bridgeDirectory });
        return [text(r?.message || 'Opened in a new tab.')];
      },
    },
  };
}

/** Light JSON Schema check (required, unknown keys, type, enum, numeric bounds) so mistakes get a clear message. */
function checkArgs(schema, args) {
  const props = schema.properties || {}, allowed = Object.keys(props).join(', ') || 'none';
  for (const key of schema.required || []) if (args[key] === undefined) throw new ToolError(`Missing required argument "${key}". Arguments: ${allowed}.`);
  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    if (!spec) { if (schema.additionalProperties === false) throw new ToolError(`Unknown argument "${key}". Arguments: ${allowed}.`); continue; }
    if (value === undefined || value === null) continue;
    const types = [].concat(spec.type || []), actual = Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    if (types.length && !types.some(t => t === actual || (t === 'number' && actual === 'integer'))) throw new ToolError(`Argument "${key}" must be ${types.join(' or ')}.`);
    if (spec.enum && !spec.enum.includes(value)) throw new ToolError(`Argument "${key}" must be one of: ${spec.enum.join(', ')}.`);
    if (typeof value === 'number' && ((spec.minimum !== undefined && value < spec.minimum) || (spec.maximum !== undefined && value > spec.maximum))) throw new ToolError(`Argument "${key}" must be from ${spec.minimum ?? '-∞'} to ${spec.maximum ?? '∞'}.`);
  }
}

function shortSummary(s) {
  return { name: s.name, size: `${s.width}x${s.height}`, colors: s.palette.length, layers: s.layers.length, parts: s.parts.length, animations: s.animations.map(a => `${a.id} "${a.name}" ${a.frames}f@${a.fps}fps`), bones: s.bones.length };
}

async function exists(file) { try { await stat(file); return true; } catch { return false; } }

const samplesDir = join(REPO, 'public', 'samples');
async function sampleList() {
  const index = JSON.parse(await readFile(join(samplesDir, 'index.json'), 'utf8'));
  return index.filter(s => s.aiFile).map(s => ({ id: s.id, name: s.name, description: s.description, file: s.aiFile }));
}

export async function guide(topic) {
  if (topic === 'pxa1') return AI_FORMAT_GUIDE;
  if (topic === 'workflow') return (await readFile(join(REPO, 'skills', 'pixel-studio', 'SKILL.md'), 'utf8')).replace(/^---[\s\S]*?---\s*/, '');
  if (topic === 'prompting') {
    return `Template prompt Pixel Studio builds for "create a new sprite" requests (replace the bracketed brief). Use it as guidance for what a good PXA creation looks like.\n\n${buildCreationPrompt({
      formatVersion: 2, name: 'My sprite', description: '[Describe the subject, pose, view (side/front/three-quarter) and mood]', width: 32, height: 32,
      paletteMode: 'auto', maxColors: 16, animations: [{ name: 'Idle', frameCount: 4, fps: 6 }], style: '[Optional art direction]',
    })}`;
  }
  if (topic && topic !== 'pxa2') throw new ToolError(`Unknown guide topic "${topic}".`);
  return PXA2_GUIDE;
}

const RESOURCES = [
  { uri: 'pixelstudio://guide/pxa2', name: 'pxa2-guide', title: 'PXA 2 format guide', description: 'The complete PXA 2 grammar for Pixel Studio projects.', mimeType: 'text/plain', read: () => guide('pxa2') },
  { uri: 'pixelstudio://guide/workflow', name: 'workflow', title: 'Agent workflow and pixel-art rules', description: 'How to create and iterate on sprites with these tools.', mimeType: 'text/markdown', read: () => guide('workflow') },
  { uri: 'pixelstudio://guide/prompting', name: 'prompting', title: 'Creation prompt template', description: 'The prompt Pixel Studio uses to ask AI models for new sprites.', mimeType: 'text/plain', read: () => guide('prompting') },
  { uri: 'pixelstudio://guide/pxa1', name: 'pxa1-guide', title: 'PXA 1 (legacy) format guide', description: 'Legacy raster-only format.', mimeType: 'text/plain', read: () => guide('pxa1') },
];

export function createMcpHandlers({ root, bridgeDirectory, log = () => {} }) {
  const tools = toolTable();
  const ctx = {
    root, bridgeDirectory,
    resolve: (p, options) => resolveInside(root, p, options),
    rel: p => relative(root, p) || '.',
    async load(p) {
      const file = await resolveInside(root, p, { mustExist: true });
      return loadProject(file);
    },
  };
  return {
    listTools: () => Object.entries(tools).map(([name, t]) => ({ name, title: t.title, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })),
    async callTool(name, args = {}) {
      const tool = tools[name];
      if (!tool) return null;
      try {
        checkArgs(tool.inputSchema, args || {});
        return { content: await tool.run(args || {}, ctx) };
      } catch (error) {
        log(`tool ${name} failed: ${error instanceof ToolError ? error.message : error.stack || error.message}`);
        return { content: [text(error.message || String(error))], isError: true };
      }
    },
    async listResources() {
      const samples = (await sampleList()).map(s => ({ uri: `pixelstudio://samples/${s.id}`, name: `sample-${s.id}`, title: `Sample: ${s.name}`, description: `${s.description} (PXA source)`, mimeType: 'text/plain' }));
      return [...RESOURCES.map(({ read, ...r }) => r), ...samples];
    },
    async readResource(uri) {
      const fixed = RESOURCES.find(r => r.uri === uri);
      if (fixed) return [{ uri, mimeType: fixed.mimeType, text: await fixed.read() }];
      const match = /^pixelstudio:\/\/samples\/([a-z0-9-]+)$/.exec(uri);
      const sample = match && (await sampleList()).find(s => s.id === match[1]);
      if (!sample) return null;
      return [{ uri, mimeType: 'text/plain', text: await readFile(join(samplesDir, sample.file), 'utf8') }];
    },
    listPrompts: () => PROMPTS.map(({ build, ...p }) => p),
    getPrompt(name, args = {}) {
      const prompt = PROMPTS.find(p => p.name === name);
      if (!prompt) return null;
      for (const a of prompt.arguments) if (a.required && !args[a.name]) throw new ToolError(`Missing prompt argument "${a.name}".`);
      return { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text: prompt.build(args) } }] };
    },
  };
}

const PROMPTS = [
  {
    name: 'draw-sprite', title: 'Draw a sprite', description: 'Create a new pixel-art sprite file with Pixel Studio tools.',
    arguments: [
      { name: 'subject', description: 'What to draw, e.g. "a knight with a blue cape, side view".', required: true },
      { name: 'size', description: 'Canvas size, e.g. 32x32 (default).' }, { name: 'palette', description: 'Palette preset id or "auto".' },
      { name: 'path', description: 'Output file (default sprites/<name>.pxa).' },
    ],
    build: a => {
      const [w, h] = String(a.size || '32x32').split(/[x×, ]+/).map(Number);
      return `Draw ${a.subject} as pixel art with the Pixel Studio tools.
1. Call pixel_guide (topic "pxa2") and read it fully. Optionally read pixelstudio://samples/key-v2 for a small example.
2. Plan: ${w || 32}×${h || w || 32} canvas, palette ${a.palette && a.palette !== 'auto' ? `"${a.palette}" (create_project palette)` : 'of 8–16 hand-picked colours with hue-shifted ramps'}; a dark (not black) outline, a readable silhouette, 3–4 shades per material, light from the top-left.
3. create_project at ${a.path || 'sprites/<short-name>.pxa'}, then write the complete PXA 2 document with write_project. Use reusable PARTs for repeated or animatable pieces.
4. Look at the returned preview. Fix anatomy, stray pixels, pillow shading and banding; write again. Repeat until it reads clearly at 1×.
5. Report the file path and show the final render (render_png).`;
    },
  },
  {
    name: 'animate-sprite', title: 'Animate a sprite', description: 'Add an animation to an existing Pixel Studio project.',
    arguments: [
      { name: 'path', description: 'Project file in the workspace.', required: true },
      { name: 'motion', description: 'The motion, e.g. "walk cycle", "idle breathing", "sword swing".', required: true },
      { name: 'frames', description: 'Frame count (default: pick per motion).' },
    ],
    build: a => `Animate ${a.path}: ${a.motion}${a.frames ? ` in ${a.frames} frames` : ''}.
1. project_info ${a.path}. If it has bones and the motion is walk, run, jump, idle, wave or hover, try apply_template first and review the preview strip.
2. Otherwise read_project, then add a new ANIM with FRAME ... FROM earlier frames and change only what moves (AT, ROTATE about PIVOTs, RESIZE for squash and stretch, or redrawn RASTER cels). Keep instance ids stable across frames.
3. Animation rules: strong key poses first, then breakdowns; ease in/out with timing (hold keys longer, 60–150 ms per frame); overlapping action on hair/tails/cloth; loops must not repeat the first frame at the end.
4. write_project, then render_png with strip: true to review every frame side by side; iterate.
5. export a GIF (format "gif") so the user can see it move.`,
  },
];
