/**
 * The in-app assistant: a small agent loop that asks a language model for one JSON reply at a time, runs the editor
 * tools it requests on the open project and feeds the results back until the model is done. Runs in the browser and
 * in Node (tests); everything editor-specific goes through the `ctx` object:
 *
 *   ctx.project()                → the open project
 *   ctx.view()                   → { animationId, frameId, layerId, tool, color, selectedObject? }
 *   ctx.commit(project, label)   → replace the open project as one undoable change
 *   ctx.select({animationId, frameId, layerId, color, tool})
 *   ctx.openProject(project)     → open in a new tab
 *   ctx.commands()               → [{ key, title, description, group, disabled }] (the command palette's list)
 *   ctx.runCommand(key)          → string | Promise<string>
 *   ctx.undo()                   → undo one step
 *   ctx.render(options)          → Promise<data:image/png URL> (options as renderPngBytes)
 */
import { validateProject } from '../../domain/project.js';
import { PXA2_GUIDE } from '../../formats/pxa-v2.js';
import {
  findAnimation, findFrame, projectSummary, projectToPxa, lintPxa, setOutline, makeParts, setPalette,
  listPalettePresets, applyTemplate, TEMPLATE_IDS,
} from '../../domain/project-ops.js';

export const MAX_STEPS = 10;
const MAX_INLINE_PXA = 24_000, MAX_READ_PXA = 160_000, MAX_RESULT = 6_000;

const clip = (text, max = MAX_RESULT) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text);
const layerRefs = (project, refs) => refs?.length ? refs.map(ref => (project.layers.find(l => l.id === ref || l.name.toLowerCase() === String(ref).toLowerCase()) || (() => { throw new Error(`No layer "${ref}". Layers: ${project.layers.map(l => `${l.id} ("${l.name}")`).join(', ')}.`); })()).id) : undefined;

/** Merge a PXA project into the open one: animations and parts with the same id are replaced, new ones added. */
export function mergeProjects(current, incoming) {
  if (incoming.width !== current.width || incoming.height !== current.height) throw new Error(`Keep SIZE ${current.width} ${current.height} when merging (use mode "replace" to resize).`);
  if (incoming.palette.length !== current.palette.length || incoming.palette.some((c, i) => c !== current.palette[i])) throw new Error('PAL must repeat the open project\'s palette exactly when merging; use set_palette to change colours.');
  const next = structuredClone(current);
  const layerIds = new Set(next.layers.map(l => l.id));
  for (const layer of incoming.layers) if (!layerIds.has(layer.id)) { next.layers.push(structuredClone(layer)); layerIds.add(layer.id); }
  if (incoming.parts?.length) {
    next.version = 3;
    next.parts = next.parts || [];
    for (const part of incoming.parts) {
      const i = next.parts.findIndex(p => p.id === part.id);
      if (i >= 0) next.parts[i] = structuredClone(part); else next.parts.push(structuredClone(part));
    }
  }
  for (const animation of incoming.animations) {
    const i = next.animations.findIndex(a => a.id === animation.id);
    if (i >= 0) next.animations[i] = structuredClone(animation); else next.animations.push(structuredClone(animation));
  }
  const blank = new Array(next.width * next.height).fill(-1), order = new Map(next.layers.map((l, i) => [l.id, i]));
  for (const animation of next.animations) {
    delete animation.layerOrder;
    for (const frame of animation.frames) {
      const have = new Set(frame.cels.map(c => c.layerId));
      for (const layer of next.layers) if (!have.has(layer.id)) frame.cels.push({ layerId: layer.id, pixels: [...blank] });
      frame.cels.sort((a, b) => order.get(a.layerId) - order.get(b.layerId));
      delete frame.layerOrder;
    }
  }
  if (incoming.bones?.length) next.bones = [...(next.bones || []).filter(b => !incoming.bones.some(n => n.id === b.id)), ...structuredClone(incoming.bones)];
  if (incoming.poses?.length) next.poses = [...(next.poses || []).filter(p => !incoming.poses.some(n => n.id === p.id)), ...structuredClone(incoming.poses)];
  if (incoming.outline) next.outline = structuredClone(incoming.outline);
  return validateProject(next);
}

function readPxa(text) {
  const lint = lintPxa(String(text ?? ''));
  if (!lint.ok) {
    const e = lint.errors[0];
    throw new Error(`The PXA is invalid${e.line ? ` at line ${e.line}${e.source ? ` ("${e.source}")` : ''}` : ''}: ${e.message}${lint.hint ? ` Hint: ${lint.hint}` : ''} Fix it and try again.`);
  }
  return lint;
}
const warn = warnings => (warnings?.length ? ` Warnings: ${warnings.join(' ')}` : '');

/** Tool definitions. `args` documents the JSON arguments for the prompt. run() returns a short text result. */
export const TOOLS = [
  { name: 'read_pxa', args: '{ animation?: id|name|index }', description: 'The open project as PXA 2 text (optionally one animation). Read before editing pixels you have not seen.',
    run: (ctx, a) => {
      const text = projectToPxa(ctx.project(), { animation: a.animation });
      if (text.length > MAX_READ_PXA) throw new Error(`The project is ${text.length} characters of PXA; read one animation at a time.`);
      return text;
    } },
  { name: 'write_pxa', args: '{ pxa: string, mode?: "merge"|"replace", label?: string }', changes: true,
    description: 'Apply a complete PXA 2 document. mode "merge" (default) keeps the open project and adds or replaces the document\'s animations, parts, new layers and bones by id (same SIZE and PAL required); "replace" replaces the whole project (keep ids you are not changing). The document is validated first; errors come back with the line.',
    run: (ctx, a) => {
      const lint = readPxa(a.pxa), mode = a.mode === 'replace' ? 'replace' : 'merge';
      const next = mode === 'replace' ? lint.project : mergeProjects(ctx.project(), lint.project);
      ctx.commit(next, a.label || 'Assistant edit');
      const s = projectSummary(next);
      return `Applied (${mode}). Now ${s.animations.length} animation(s): ${s.animations.map(x => `${x.id} ${x.frames}f`).join(', ')}; ${s.parts.length} part(s); ${s.bones.length} bone(s).${warn(lint.warnings)}`;
    } },
  { name: 'new_tab', args: '{ pxa: string }', description: 'Open a complete PXA 2 document as a new project tab (for brand-new artwork; leaves the open project alone).',
    run: (ctx, a) => { const lint = readPxa(a.pxa); ctx.openProject(lint.project); return `Opened "${lint.project.name}" in a new tab; it is now the open project.${warn(lint.warnings)}`; } },
  { name: 'make_parts', args: '{ layers?: [id|name], rig?: boolean }', changes: true,
    description: 'Turn drawn (raster) layers of the current frame into reusable parts and auto-rig them into a skeleton where they touch (rig defaults to true). Needed before skeleton animation of drawn art.',
    run: (ctx, a) => {
      const v = ctx.view(), p = ctx.project();
      const r = makeParts(p, { animation: v.animationId, frame: v.frameId, layers: layerRefs(p, a.layers), rig: a.rig !== false });
      ctx.commit(r.project, 'Make parts');
      const bones = r.project.bones || [];
      return `Made ${r.converted ?? '?'} part(s); ${bones.length} bone(s)${bones.length ? `: ${bones.map(b => `${b.id}${b.parent ? ` (child of ${b.parent})` : ' (root)'}`).join(', ')}` : ''}.`;
    } },
  { name: 'animate', args: `{ template: ${TEMPLATE_IDS.map(t => `"${t}"`).join('|')}, frames?: number, frameMs?: number, amplitude?: number, facing?: "auto"|"left"|"right", mode?: "new"|"replace"|"merge", name?: string }`, changes: true,
    description: 'Generate a skeleton animation from the current frame\'s pose (needs bones; use make_parts first for drawn art). mode "new" (default) adds an animation.',
    run: (ctx, a) => {
      const v = ctx.view();
      const r = applyTemplate(ctx.project(), { ...a, animation: v.animationId, frame: v.frameId });
      ctx.commit(r.project, `Animate: ${a.template}`);
      const anim = r.project.animations.find(x => x.id === r.animationId);
      if (anim) ctx.select({ animationId: anim.id, frameId: anim.frames[0].id });
      return `Created "${anim?.name ?? r.animationId}" with ${anim?.frames.length ?? '?'} frames; it is now selected.`;
    } },
  { name: 'edit_animation', args: '{ animation?: id|name|index, name?: string, fps?: number, frameMs?: number, delete?: true }', changes: true,
    description: 'Rename an animation, set its speed (fps sets every frame to 1000/fps ms; frameMs sets one duration for all frames) or delete it. Defaults to the current animation.',
    run: (ctx, a) => {
      const p = structuredClone(ctx.project()), anim = findAnimation(p, a.animation ?? ctx.view().animationId);
      if (a.delete) {
        if (p.animations.length < 2) throw new Error('A project needs at least one animation.');
        p.animations = p.animations.filter(x => x !== anim);
      } else {
        if (a.name) anim.name = String(a.name).slice(0, 80);
        if (a.fps) { anim.fps = Math.max(1, Math.min(60, Math.round(a.fps))); for (const f of anim.frames) f.duration = Math.round(1000 / anim.fps); }
        if (a.frameMs) for (const f of anim.frames) f.duration = Math.max(1, Math.min(60000, Math.round(a.frameMs)));
      }
      ctx.commit(validateProject(p), a.delete ? 'Delete animation' : 'Edit animation');
      return a.delete ? `Deleted "${anim.name}".` : `"${anim.name}": ${anim.fps} fps, ${anim.frames.length} frames.`;
    } },
  { name: 'outline', args: '{ live?: boolean | { color?: index, style?: "single"|"selective", mode?: "outside"|"inside", corners?: boolean, thickness?: 1|2|3, separate?: boolean, skip?: [layer id] }, strip?: boolean | { colors?: [index], passes?: number, parts?: boolean }, layers?: [id|name] }', changes: true,
    description: 'Remove baked-in outline pixels (strip, all frames, layers and parts) and/or set the live outline that is recomputed on every frame and edit (live false turns it off).',
    run: (ctx, a) => {
      const p = ctx.project(), r = setOutline(p, { live: a.live, strip: a.strip, layers: layerRefs(p, a.layers) });
      ctx.commit(r.project, 'Outline');
      return `${a.strip ? `Removed ${r.removed} baked outline pixel(s)${r.parts ? ` (also in ${r.parts} part(s))` : ''}. ` : ''}Live outline: ${r.outline ? JSON.stringify(r.outline) : 'off'}.`;
    } },
  { name: 'set_palette', args: '{ preset?: id|name, colors?: ["#rrggbb"], remap?: boolean }', changes: true,
    description: 'Replace the palette with a preset or explicit colours. remap (default true) moves every pixel to the nearest new colour; false keeps indices (recolours in place).',
    run: (ctx, a) => { const next = setPalette(ctx.project(), a); ctx.commit(next, 'Palette'); return `Palette now: ${next.palette.join(' ')}.`; } },
  { name: 'palette_presets', args: '{}', description: 'List palette presets (id, name, size).',
    run: () => listPalettePresets().map(p => `${p.id} "${p.name}" ${p.colors.length}`).join('\n') },
  { name: 'select', args: '{ animation?: id|name|index, frame?: id|index, layer?: id|name, color?: index (-1 transparent), tool?: string }',
    description: 'Change what the user has selected in the editor (animation, frame, layer, colour, tool).',
    run: (ctx, a) => {
      const p = ctx.project(), out = {};
      const anim = findAnimation(p, a.animation ?? ctx.view().animationId);
      if (a.animation !== undefined) { out.animationId = anim.id; out.frameId = anim.frames[0].id; }
      if (a.frame !== undefined) out.frameId = findFrame(anim, a.frame).id;
      if (a.layer !== undefined) out.layerId = layerRefs(p, [a.layer])[0];
      if (a.color !== undefined) { if (!Number.isInteger(a.color) || a.color < -1 || a.color >= p.palette.length) throw new Error(`color must be -1 to ${p.palette.length - 1}.`); out.color = a.color; }
      if (a.tool !== undefined) out.tool = String(a.tool);
      ctx.select(out);
      return `Selected ${JSON.stringify(ctx.view())}.`;
    } },
  { name: 'run_command', args: '{ command: key from the COMMANDS list }',
    description: 'Press one of the editor\'s own buttons (listed under COMMANDS). Commands that open a dialog leave it open for the user.',
    run: async (ctx, a) => {
      const command = ctx.commands().find(c => c.key === a.command || c.title.toLowerCase() === String(a.command).toLowerCase());
      if (!command) throw new Error(`No command "${a.command}". Use a key from the COMMANDS list.`);
      if (command.disabled) throw new Error(`"${command.title}" is not available right now: ${command.disabled}`);
      return (await ctx.runCommand(command.key)) || `Ran "${command.title}".`;
    } },
  { name: 'undo', args: '{ steps?: number }', changes: true, description: 'Undo the last change(s) in the editor.',
    run: (ctx, a) => { const n = Math.max(1, Math.min(20, Math.round(a.steps || 1))); for (let i = 0; i < n; i += 1) ctx.undo(); return `Undid ${n} step(s).`; } },
  { name: 'look', args: '{ animation?: id|name|index, frame?: id|index, strip?: boolean }',
    description: 'Render a frame (default: the current one) or a whole animation as a strip; the image is shown to you in the next step. Use it to check your work.',
    run: async (ctx, a) => {
      const v = ctx.view(), p = ctx.project(), anim = findAnimation(p, a.animation ?? v.animationId);
      const frame = a.frame !== undefined ? a.frame : (a.animation === undefined ? v.frameId : undefined);
      const edge = Math.max(p.width * (a.strip ? anim.frames.length : 1), p.height);
      const image = await ctx.render({ animation: anim.id, frame, strip: !!a.strip, scale: Math.max(1, Math.min(16, Math.floor(1000 / edge))), background: 'checker' });
      return { text: `Rendered ${a.strip ? `"${anim.name}" (${anim.frames.length} frames, left to right)` : `a frame of "${anim.name}"`}; the image is attached.`, image };
    } },
];
const TOOL_BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

/** The context block that describes the open project and editor state for this step. */
export function describeEditor(ctx) {
  const p = ctx.project(), v = ctx.view(), s = projectSummary(p);
  const anim = p.animations.find(a => a.id === v.animationId) || p.animations[0];
  const frameIndex = Math.max(0, anim.frames.findIndex(f => f.id === v.frameId));
  const pxa = projectToPxa(p);
  return [
    `PROJECT ${JSON.stringify({ ...s, palette: s.palette.map((c, i) => `${i}:${c}`) })}`,
    `EDITOR ${JSON.stringify({ animation: anim.id, frameIndex, frameId: anim.frames[frameIndex].id, layer: v.layerId, colorIndex: v.color, tool: v.tool, ...(v.selectedObject ? { selectedObject: v.selectedObject } : {}) })}`,
    pxa.length <= MAX_INLINE_PXA ? `OPEN PROJECT AS PXA 2:\n${pxa}` : `The project is too large to include (${pxa.length} characters of PXA); call read_pxa for one animation at a time.`,
  ].join('\n');
}

const RULES = `HOW TO REPLY
Reply with exactly one JSON object and nothing else:
{"message": "short text for the user (plain text, may use - bullets)", "actions": [{"tool": "name", "args": {…}}], "done": true|false}
- To answer a question, reply with a message and no actions.
- To change the project, request actions. They run in order; each change is one undo step for the user.
- done:false means "run my actions and show me the results, I will continue". Use it when you need results, want to check your work with look, or have more steps. done:true (or no actions) ends your turn after the actions run.
- At most 6 actions per reply. If an action fails, the error comes back; fix the cause and retry, or explain.
- Prefer the dedicated tools (make_parts, animate, outline, set_palette, edit_animation) over rewriting PXA. For new or changed artwork, write PXA 2 with write_pxa (mode "merge" to add/replace animations or parts, "replace" for the whole project) or new_tab for a separate new piece.
- Animation that moves body parts needs parts and bones: draw each moving piece as a PART placed with USE and joined with BONE lines, or call make_parts on drawn layers, then animate. Keep frames consistent (same palette, same proportions); avoid baked outer outlines on moving parts and use the live outline instead.
- After making or changing artwork, call look (done:false) to check it, then fix obvious problems before finishing.
- Never invent results; describe what the tools actually reported. Keep the final message short: what changed and what the user can do next.`;

const toolsBlock = () => `TOOLS\n${TOOLS.map(t => `- ${t.name} ${t.args}: ${t.description}`).join('\n')}`;
function commandsBlock(ctx) {
  const list = ctx.commands().filter(c => !c.disabled).slice(0, 120);
  return list.length ? `COMMANDS (for run_command)\n${list.map(c => `${c.key} | ${c.title}${c.description && c.description !== c.group ? ` — ${c.description}` : ''}`).join('\n')}` : '';
}

/**
 * The full prompt for one model call. history: [{role:'user'|'assistant', text}]; steps: this turn's earlier
 * replies and tool results [{reply, results:[{tool, ok, text}]}].
 */
export function buildPrompt(ctx, { history = [], steps = [] } = {}) {
  const convo = history.slice(-16).map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${clip(m.text, 4000)}`).join('\n');
  const work = steps.map((s, i) => `STEP ${i + 1}: you replied ${clip(JSON.stringify(s.reply), 30_000)}\nRESULTS:\n${s.results.map(r => `[${r.tool}] ${r.ok ? 'ok' : 'ERROR'}: ${clip(r.text, r.tool === 'read_pxa' && r.ok ? MAX_READ_PXA : MAX_RESULT)}`).join('\n') || '(no actions)'}`).join('\n\n');
  return [
    'PXACHAT 1',
    'You are the assistant inside Pixel Studio, a pixel-art and sprite-animation editor. The user is looking at the open project in the editor and chatting with you in a side panel.',
    RULES, toolsBlock(), commandsBlock(ctx),
    `PXA 2 FORMAT (for read_pxa, write_pxa, new_tab)\n${PXA2_GUIDE}`,
    describeEditor(ctx),
    `CONVERSATION\n${convo}`,
    work ? `THIS TURN SO FAR\n${work}\n\nContinue: reply with the next JSON object.` : 'Reply to the last USER message with one JSON object.',
  ].filter(Boolean).join('\n\n');
}

/** Read the model's reply: the first JSON object in the text (tolerates fences and stray text). */
export function parseReply(text) {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  if (start < 0) return { message: raw || 'The assistant gave no answer.', actions: [], done: true };
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) { end = i; break; }
  }
  let value;
  try { value = JSON.parse(raw.slice(start, end + 1)); } catch { return { message: raw, actions: [], done: true, invalid: true }; }
  const actions = (Array.isArray(value.actions) ? value.actions : []).filter(a => a && typeof a.tool === 'string').slice(0, 6)
    .map(a => ({ tool: a.tool, args: a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? a.args : {} }));
  return { message: typeof value.message === 'string' ? value.message : '', actions, done: actions.length ? value.done !== false : true };
}

/** Run one tool; never throws. Returns { tool, ok, text, image?, changed }. */
export async function runTool(ctx, action) {
  const tool = TOOL_BY_NAME.get(action.tool);
  if (!tool) return { tool: action.tool, ok: false, text: `Unknown tool "${action.tool}". Tools: ${TOOLS.map(t => t.name).join(', ')}.` };
  try {
    const out = await tool.run(ctx, action.args || {});
    const text = typeof out === 'string' ? out : out?.text ?? 'Done.';
    return { tool: tool.name, ok: true, text, ...(out?.image ? { image: out.image } : {}), changed: !!tool.changes };
  } catch (error) {
    return { tool: tool.name, ok: false, text: String(error?.message || error) };
  }
}

/**
 * One user turn. ask(prompt, images, signal) → model text. onEvent receives
 * {type:'thinking', step} | {type:'reply', reply} | {type:'tool', action, result}.
 * Returns { message, messages, steps, changes } (changes: undoable edits made, net of undo actions).
 */
export async function runTurn({ ctx, ask, history, signal, onEvent = () => {}, maxSteps = MAX_STEPS, initialImage }) {
  const steps = [], messages = [];
  let images = initialImage ? [initialImage] : [], changes = 0;
  const stopped = () => { if (signal?.aborted) throw new DOMException('Stopped.', 'AbortError'); };
  for (let step = 0; step < maxSteps; step += 1) {
    stopped();
    onEvent({ type: 'thinking', step });
    const reply = parseReply(await ask(buildPrompt(ctx, { history, steps }), images.slice(-2), signal));
    if (reply.message) messages.push(reply.message);
    onEvent({ type: 'reply', reply });
    const results = [];
    images = [];
    for (const action of reply.actions) {
      stopped();
      const result = await runTool(ctx, action);
      if (result.ok && result.changed) changes += action.tool === 'undo' ? -Math.max(1, Math.round(action.args?.steps || 1)) : 1;
      if (result.image) images.push(result.image);
      results.push(result);
      onEvent({ type: 'tool', action, result });
    }
    steps.push({ reply: { message: reply.message, actions: reply.actions, done: reply.done }, results: results.map(({ tool, ok, text }) => ({ tool, ok, text })) });
    if (!reply.actions.length || (reply.done && results.every(r => r.ok))) break;
    if (step === maxSteps - 1) messages.push(`(I stopped after ${maxSteps} steps. Ask me to continue if there is more to do.)`);
  }
  return { message: messages.at(-1) || 'Done.', messages, steps, changes: Math.max(0, changes) };
}
