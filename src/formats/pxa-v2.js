/** PXA 2 codec. Domain operations are independent of this text grammar. */
import { validateProject, MAX_TOTAL_PIXELS } from '../domain/project.js';
import { artworkId, cloneArtwork, pixelSpans, translatePixels, MAX_OPERATIONS, MAX_PARTS, MAX_RENDER_WORK } from '../domain/artwork.js';
import { instancePivot } from '../domain/geometry.js';
import { boxToPart, worldToBox } from '../domain/skeleton.js';

export const PXA2_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz@$';
export const PXA2_MAX_BYTES = 4 * 1024 * 1024;
export const PXA2_COMMAND_GUIDE = `Drawing (all coordinates are x then y):
SPAN x y pixels
RECT x y width height color
ELLIPSE x y width height color
LINE x y end-x end-y color
Rectangles/ellipses are filled, grid-aligned, without antialiasing. Draw commands overwrite in order and must fit their canvas. Shapes use decimal palette indices; -1 erases.
SPAN symbols: ${PXA2_ALPHABET}; dot erases. A{6} repeats six times. No spaces; positive counts. x/y are zero-based.
Within a cel use drawing commands or USE instance-id part-id x y [transform] to place a part (an object).
Object transforms (combine freely; they never change the part itself, so edits to the part still reach every copy):
- Flip/quarter turn: transform N (default) FX FY R90 R180 R270 R90FX R270FX. FX mirrors left-right, FY top-bottom, R90/R180/R270 turn clockwise, R90FX = turn 90° clockwise then mirror. Lossless; applied inside the part bounds, then the transformed top-left sits at x y.
- Resize, squash and stretch: RESIZE instance-id width height (1–128 each) draws the part at that size by nearest-neighbour sampling, measured before the flip/turn. Unequal scaling squashes or stretches (a 16×16 part at RESIZE id 20 12 is squashed). RESIZE to the part's own size resets it.
- Free rotation: ROTATE instance-id degrees (whole degrees, -360..360, stored as -179..180; positive = clockwise; 0 resets) turns the resized, flipped result about its pivot (default: the box centre) by nearest-neighbour sampling. Use TURN for exact 90°/180°/270° turns.
- Pivot: PIVOT instance-id x y (integers -128..256) sets the point that ROTATE, SKEW and TILT turn about: the centre of pixel x y of the flipped/turned, unrotated box, measured from its top-left (the USE x y). PIVOT instance-id CENTER resets to the exact box centre. Example: PIVOT arm 0 3 swings an 8×6 arm about its left edge.
- Skew (shear): SKEW instance-id sx sy (whole degrees, -60..60 each; SKEW id 0 0 resets) slants about the pivot: first x moves by tan(sx)·(y − pivot y), then y moves by tan(sy)·(x − pivot x). SKEW id -15 0 leans the top to the right (positive leans it left); good for running lean, wind and fake perspective.
- 3D turn (pseudo-3D rotation about the other axes): TILT instance-id x y [PERSPECTIVE p] (whole degrees, -180..180 each; TILT id 0 0 resets). y turns the object about a vertical axis through the pivot like a door, coin or a character turning round: its width shrinks by cos(y), at 90 it is edge-on (invisible) and past 90 the back shows (the artwork mirrored); positive y moves the right side away. x tips it about a horizontal axis (head over heels, a card flipping vertically): height shrinks by cos(x), positive x moves the top away. PERSPECTIVE p (0..100, default 30) makes the far edge shorter and the near edge taller; 0 is flat. TILT id 0 180 is a horizontal mirror and TILT id 180 0 a vertical one. A coin spin: TILT coin 0 45, then 0 90, 0 135, ... in successive frames.
- Deform: DEFORM instance-id NONE | WAVE X|Y amplitude wavelength phase | BULGE strength | TWIST degrees, in box space about the box centre. WAVE X shifts each row y sideways by round(amplitude·sin(360°·y/wavelength + phase)); WAVE Y shifts each column vertically the same way (amplitude 1..32, wavelength 2..256, phase 0..359 degrees; the box grows by the amplitude). BULGE strength (-100..100; positive bulges/magnifies the centre, negative pinches) and TWIST degrees (-360..360; full turn at the centre fading to none at the edge) act inside the ellipse that fits the box. NONE, BULGE 0 and TWIST 0 reset. Animate a flag or water by stepping the WAVE phase each frame: FRAME wave_1 100 FROM wave_0, CEL fx, DEFORM flag WAVE X 2 8 45, then phase 90, 135, ...
- Sampling: SAMPLE instance-id NEAREST|ROTSPRITE|AA. NEAREST (default) picks one part pixel per canvas pixel. ROTSPRITE smooths free angles, skew, 3D turns and deforms like the RotSprite algorithm (Scale2x three times to 8×, then sampling). AA (smooth anti-aliasing) takes 4×4 samples per pixel: where two part colours meet it uses the palette colour between them, and partly covered edge pixels blend with the artwork already beneath in the cel. All modes use only palette colours, keep 1px lines and outlines unbroken, and are identical to NEAREST for unrotated, unscaled or quarter-turned objects.
- Order: resize, then flip/quarter turn, then deform, then skew, then 3D turn (TILT), then free rotation about the pivot. x y is the top-left of the unrotated box; with no PIVOT, rotation keeps that box's centre.
To place a transformed object, write its USE line, then RESIZE/ROTATE/PIVOT/SKEW/TILT/DEFORM/SAMPLE lines for the same instance-id in that cel.
Changing an existing object in a later cel (for example after FRAME FROM): AT instance-id x y sets its absolute position. TURN instance-id transform changes its flip/quarter turn. RESIZE, ROTATE, PIVOT, SKEW, TILT, DEFORM and SAMPLE as above. SWAP instance-id part-id changes its part (keeping position and transforms). DROP instance-id removes it. These keep draw order and do not paint trails.
Placement may be off canvas within -128..128 and is clipped; transparent part pixels leave underlying artwork visible. Animate objects by changing AT, TURN, RESIZE (squash and stretch: keep width×height roughly constant), ROTATE about a PIVOT (joints such as shoulders and hips), SKEW, TILT (spins and turns) and DEFORM (for example the WAVE phase) across frames, keeping the same instance-id.
OVERRIDE x y pixels writes final local pixels after all cel operations. Dot explicitly erases the cel pixel; omitted coordinates remain unchanged. Overrides stay in canvas coordinates when instances move.`;

export const PXA2_GUIDE = `PXA 2: uppercase commands, one per line; blank lines and full-line # comments allowed. No Markdown. Finish with END.
Header: PXA 2, SIZE width height, NAME "name", PAL #rrggbb ... (in that order).
LAYER id "name" visible locked declares layers bottom to top, before parts/animations. Flags: 0 or 1.
STACK layer-id ROOT|GROUP optionally follows layer declarations. ROOT exposes that container's objects without a group; GROUP displays an optional isolated group. Omitted STACK keeps legacy layers as groups.
INSTANCE instance-id "name" visible locked optionally sets an existing USE object's name, visibility and lock. Flags are 0 or 1. Hidden instances retain their source artwork. A shared part used by any locked object or group cannot be edited until unlocked.
IDs: 1–100 letters/digits/_/-. Layer, animation and frame IDs must be globally unique. Part IDs are unique in the part library; instance IDs are unique within each cel. Names use JSON quoted strings.
PART id width height starts a reusable part. End it with ENDPART. PART new-id FROM existing-part copies a definition for a local variant; it is not a live link. Parts contain drawing commands only.
${PXA2_COMMAND_GUIDE}
ANIM id "name" fps starts an animation. FRAME id duration-ms CLEAR starts blank; FRAME id duration-ms FROM earlier-frame-id copies that frame across all layers (even across animations). Copies are independent snapshots, but keep shared part references.
ORDER layer-id layer-id ... optionally appears once immediately after ANIM, before its first FRAME. Include every declared layer ID exactly once, bottom to top. This overrides declaration order only for that animation; omitted ORDER uses declaration order. FRAME FROM copies cels, not the source animation's order. Older readers without ORDER support cannot read files containing it.
FRAMEORDER layer-id layer-id ... optionally appears once after FRAME, before CEL. It overrides that frame's bottom-to-top stack with every layer exactly once. Omission uses animation order. FRAME FROM does not inherit frame order.
BONE id layer-id instance-id PARENT parent-bone-id|- [JOINT x y] [LIMIT min max] [REST degrees] [NAME "name"] rigs a skeleton (after the animations, before END). A bone is one object (instance-id in layer-id, the same object in every frame); its joint is that object's PIVOT, pinned to point JOINT x y of the parent's part (part pixels, decimals allowed, 0.5 = a pixel centre). Omit JOINT to use where the child's pivot sits on the parent in the first frame showing both. A root bone uses PARENT - and no JOINT. LIMIT bounds the angle relative to the parent (a root: its own ROTATE), REST is the relative angle of the rest pose. Posing a rig = ROTATE each part per frame (children keep their joints on the parent); place each child so its PIVOT lies on the parent's joint. Example: BONE torso fig body PARENT -, BONE arm fig arm PARENT torso JOINT 2.5 1.5 LIMIT -120 120.
POSE id "name" bone-id=degrees ... [MOVE root-bone-id dx dy] saves a named pose in the pose library (after the BONE lines): each bone's angle relative to its parent (a root: its own ROTATE), whole degrees; MOVE offsets a root's pivot from where it stands in its animation's first frame. Poses are not frames: the editor applies them to frames (Skeleton mode → Poses). Example: POSE crouch "Crouch" body=0 leg-l=40 shin-l=-80 leg-r=-40 shin-r=80 MOVE body 0 3.
CEL layer-id selects a frame's layer. CEL layer-id CLEAR resets that cel. CEL layer-id RASTER selects raw pixels (an empty or already raster cel); SPAN and SHIFT dx dy are allowed until another CEL. SHIFT translates only the selected raster cel, clips edges and clears exposed pixels. RASTER retains compact pixel deltas without creating shared parts.
Limits: canvas/parts 1–128 per dimension; 1–64 colors; 1–32 layers; at most 256 parts; 1–100 animations, 1–256 frames each, 1024 total; 1,048,576 canvas pixel slots across all cels; same budget for part pixels; 32,768 expanded operations and 8,388,608 rendering work units. FPS 1–60; duration 1–60000 ms. Names: project 120, layer/animation 80 characters. Text 4 MiB; line 4096 characters. END is required. Preserve hidden artwork and deliberate blank frames.`;

export function pxa2Lines(text, header = 'PXA 2') {
  if (typeof text !== 'string' || text.length > PXA2_MAX_BYTES || new TextEncoder().encode(text).length > PXA2_MAX_BYTES) throw new Error('PXA text exceeds 4 MiB.');
  const lines = [];
  for (const [i, value] of text.replace(/\r\n?/g, '\n').split('\n').entries()) {
    if (value.length > 4096) throw new Error(`Line ${i + 1}: line exceeds 4096 characters.`);
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const tokens = trimmed.match(/"(?:[^"\\]|\\.)*"|[^\s]+/g) || [];
    lines.push({ tokens, number: i + 1 });
    if (lines.length > MAX_OPERATIONS * 2 + 10000) throw new Error('Too many PXA commands.');
  }
  if (lines[0]?.tokens.join(' ') !== header) throw new Error(`Expected ${header}.`);
  if (lines.at(-1)?.tokens.join(' ') !== 'END') throw new Error('Incomplete PXA document: expected END.');
  return lines.slice(1, -1);
}
export function argumentsCount(tokens, count) {
  if (tokens.length !== count + 1) throw new Error(`${tokens[0]} expects ${count} arguments.`);
}
export function numberToken(value) {
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid integer ${value}.`);
  return Number(value);
}
function quoted(value) {
  if (!value?.startsWith('"')) throw new Error('Names must be quoted.');
  const name = JSON.parse(value);
  if (typeof name !== 'string') throw new Error('Invalid name.');
  return name;
}
export function decodeRun(value, max = 128) {
  const out = [];
  if (typeof value !== 'string' || !value) throw new Error('SPAN needs pixels.');
  const regex = /([0-9A-Za-z@$.])(?:\{([1-9][0-9]*)\})?/gy;
  let offset = 0, match;
  while ((match = regex.exec(value))) {
    const count = Number(match[2] || 1);
    if (out.length + count > max) throw new Error('Expanded SPAN exceeds its row.');
    out.push(...Array(count).fill(match[1] === '.' ? -1 : PXA2_ALPHABET.indexOf(match[1])));
    offset = regex.lastIndex;
  }
  if (offset !== value.length) throw new Error('Invalid pixel run.');
  return out;
}
export function encodeRun(values) {
  let text = '';
  for (let i = 0; i < values.length;) {
    let end = i + 1;
    while (end < values.length && values[end] === values[i]) end++;
    const symbol = values[i] < 0 ? '.' : PXA2_ALPHABET[values[i]], n = end - i;
    const run = `${symbol}{${n}}`;
    text += run.length < n ? run : symbol.repeat(n);
    i = end;
  }
  return text;
}

export function drawingCommand(tokens) {
  const [command, ...args] = tokens;
  if (['SPAN', 'OVERRIDE'].includes(command)) {
    argumentsCount(tokens, 3);
    return { type: 'span', x: numberToken(args[0]), y: numberToken(args[1]), values: decodeRun(args[2]) };
  }
  if (!['RECT', 'ELLIPSE', 'LINE'].includes(command)) return null;
  argumentsCount(tokens, 5);
  const [x, y, a, b, color] = args.map(numberToken);
  return command === 'LINE' ? { type: 'line', x, y, x2: a, y2: b, color }
    : { type: command.toLowerCase(), x, y, width: a, height: b, color };
}
export function partDeclaration(tokens, parts, replace = false) {
  argumentsCount(tokens, 3);
  const id = artworkId(tokens[1]);
  if (!replace && parts.some(p => p.id === id)) throw new Error(`Duplicate part ${id}.`);
  if (!parts.some(p => p.id === id) && parts.length >= MAX_PARTS) throw new Error('Too many parts.');
  if (tokens[2] === 'FROM') {
    const original = parts.find(p => p.id === tokens[3]);
    if (!original) throw new Error(`Unknown part ${tokens[3]}.`);
    return { ...cloneArtwork(original), id };
  }
  return { id, width: numberToken(tokens[2]), height: numberToken(tokens[3]), ops: [] };
}

function deformToken([kind, ...args]) {
  if (kind === 'NONE') return undefined;
  if (kind === 'WAVE') {
    if (!['X', 'Y'].includes(args[0])) throw new Error('WAVE axis must be X or Y.');
    const [amplitude, wavelength, phase] = args.slice(1).map(numberToken);
    return { kind: 'wave', axis: args[0].toLowerCase(), amplitude, wavelength, phase };
  }
  return kind === 'BULGE' ? { kind: 'bulge', strength: numberToken(args[0]) } : { kind: 'twist', angle: numberToken(args[0]) };
}
const deformText = d => !d ? 'NONE' : d.kind === 'wave' ? `WAVE ${d.axis.toUpperCase()} ${d.amplitude} ${d.wavelength} ${d.phase}` : d.kind === 'bulge' ? `BULGE ${d.strength}` : `TWIST ${d.angle}`;
const tiltText = t => !t ? '0 0' : `${t.x} ${t.y}${t.perspective !== undefined ? ` PERSPECTIVE ${t.perspective}` : ''}`;
/** PIVOT/SKEW/TILT/DEFORM/SAMPLE lines that move instance `b`'s effects (absent when omitted) to those of `a`. */
function effectLines(a, b = {}) {
  const q = JSON.stringify, lines = [];
  if (q(a.pivot) !== q(b.pivot)) lines.push(`PIVOT ${a.id} ${a.pivot ? `${a.pivot.x} ${a.pivot.y}` : 'CENTER'}`);
  if (q(a.skew) !== q(b.skew)) lines.push(`SKEW ${a.id} ${a.skew?.x || 0} ${a.skew?.y || 0}`);
  if (q(a.tilt) !== q(b.tilt)) lines.push(`TILT ${a.id} ${tiltText(a.tilt)}`);
  if (q(a.deform) !== q(b.deform)) lines.push(`DEFORM ${a.id} ${deformText(a.deform)}`);
  if (a.sampling !== b.sampling) lines.push(`SAMPLE ${a.id} ${(a.sampling || 'nearest').toUpperCase()}`);
  return lines;
}

/** Apply one cel command to a detached source. Domain validation follows the complete transaction. */
export function applyCelCommand(source, tokens) {
  const draw = drawingCommand(tokens);
  if (draw) { (tokens[0] === 'OVERRIDE' ? source.overrides : source.ops).push(draw); return; }
  const [command, id] = tokens;
  if (command === 'USE') {
    if (![5, 6].includes(tokens.length)) throw new Error('USE expects instance, part, x, y and optional transform.');
    if (source.ops.some(op => op.type === 'use' && op.id === id)) throw new Error(`Duplicate instance ${id}.`);
    source.ops.push({ type: 'use', id: artworkId(id), partId: artworkId(tokens[2]), x: numberToken(tokens[3]), y: numberToken(tokens[4]), transform: tokens[5] || 'N' });
    return;
  }
  if (command === 'INSTANCE') {
    argumentsCount(tokens,4);
    const op=source.ops.find(op=>op.type==='use' && op.id===id);
    if (!op) throw new Error(`Unknown instance ${id}.`);
    if (!['0','1'].includes(tokens[3]) || !['0','1'].includes(tokens[4])) throw new Error('Instance flags must be 0 or 1.');
    op.name=quoted(tokens[2]); op.visible=tokens[3]==='1'; op.locked=tokens[4]==='1';
    return;
  }
  if (!['AT', 'TURN', 'SWAP', 'DROP', 'RESIZE', 'ROTATE', 'PIVOT', 'SKEW', 'TILT', 'DEFORM', 'SAMPLE'].includes(command)) throw new Error(`Unknown command ${command}.`);
  if (command === 'PIVOT') { if (tokens.length !== 3 || tokens[2] !== 'CENTER') argumentsCount(tokens, 3); }
  else if (command === 'DEFORM') { const count = { NONE: 0, WAVE: 4, BULGE: 1, TWIST: 1 }[tokens[2]]; if (count === undefined || tokens.length !== 3 + count) throw new Error('DEFORM expects NONE, WAVE X|Y amplitude wavelength phase, BULGE strength or TWIST degrees.'); }
  else if (command === 'TILT') { if (tokens.length !== 6 || tokens[4] !== 'PERSPECTIVE') argumentsCount(tokens, 3); }
  else argumentsCount(tokens, ['AT', 'RESIZE', 'SKEW'].includes(command) ? 3 : command === 'DROP' ? 1 : 2);
  const op = source.ops.find(op => op.type === 'use' && op.id === id);
  if (!op) throw new Error(`Unknown instance ${id}.`);
  if (command === 'PIVOT') { if (tokens[2] === 'CENTER') delete op.pivot; else op.pivot = { x: numberToken(tokens[2]), y: numberToken(tokens[3]) }; }
  if (command === 'SKEW') op.skew = { x: numberToken(tokens[2]), y: numberToken(tokens[3]) };
  if (command === 'TILT') {
    const tilt = { x: numberToken(tokens[2]), y: numberToken(tokens[3]) };
    if (tokens[4] === 'PERSPECTIVE') tilt.perspective = numberToken(tokens[5]);
    if (tilt.x || tilt.y) op.tilt = tilt; else delete op.tilt;
  }
  if (command === 'DEFORM') { op.deform = deformToken(tokens.slice(2)); if (!op.deform) delete op.deform; }
  if (command === 'SAMPLE') {
    if (!['NEAREST', 'ROTSPRITE', 'AA'].includes(tokens[2])) throw new Error('SAMPLE expects NEAREST, ROTSPRITE or AA.');
    op.sampling = tokens[2].toLowerCase();
  }
  if (command === 'AT') { op.x = numberToken(tokens[2]); op.y = numberToken(tokens[3]); }
  if (command === 'TURN') op.transform = tokens[2];
  if (command === 'ROTATE') op.angle = numberToken(tokens[2]);
  if (command === 'RESIZE') { op.width = numberToken(tokens[2]); op.height = numberToken(tokens[3]); }
  if (command === 'SWAP') op.partId = artworkId(tokens[2]);
  if (command === 'DROP') source.ops.splice(source.ops.indexOf(op), 1);
}

export function decodePXA2(text) {
  const project = { format: 'pixel-studio', version: 3, layers: [], parts: [], animations: [] };
  const frames = new Map(), bones = [], poses = [];
  let animation, frame, source, raster, part, stage = 0, totalFrames = 0, expandedOps = 0, rasterWork = 0;
  const spendRasterWork = count => {
    rasterWork += count;
    if (rasterWork > MAX_RENDER_WORK) throw new Error('Raster decoding work budget exceeded.');
  };
  for (const { tokens: t, number } of pxa2Lines(text)) {
    try {
      const cmd = t[0];
      if (stage < 3) {
        if (cmd !== ['SIZE', 'NAME', 'PAL'][stage]) throw new Error('Expected SIZE, NAME, PAL in order.');
        if (cmd === 'SIZE') { argumentsCount(t, 2); project.width = numberToken(t[1]); project.height = numberToken(t[2]); if (![project.width, project.height].every(n => n >= 1 && n <= 128)) throw new Error('Invalid canvas size.'); }
        if (cmd === 'NAME') { argumentsCount(t, 1); project.name = quoted(t[1]); }
        if (cmd === 'PAL') { project.palette = t.slice(1); if (!project.palette.length || project.palette.length > 64) throw new Error('Invalid palette length.'); }
        stage++; continue;
      }
      if (part) {
        if (cmd === 'ENDPART') { argumentsCount(t, 0); project.parts.push(part); part = null; continue; }
        const op = drawingCommand(t);
        if (!op || cmd === 'OVERRIDE') throw new Error('Expected part drawing command or ENDPART.');
        part.ops.push(op); expandedOps++; continue;
      }
      if (cmd === 'LAYER') {
        if (project.parts.length || animation || project.layers.length >= 32) throw new Error('Declare 1–32 layers before parts/animations.');
        argumentsCount(t, 4);
        if (!['0', '1'].includes(t[3]) || !['0', '1'].includes(t[4])) throw new Error('Layer flags must be 0 or 1.');
        project.layers.push({ id: artworkId(t[1]), name: quoted(t[2]), visible: t[3] === '1', locked: t[4] === '1' });
      } else if (cmd === 'STACK') {
        if (animation || project.parts.length) throw new Error('Declare STACK before parts and animations.');
        argumentsCount(t,2);
        const layer=project.layers.find(l=>l.id===t[1]);
        if (!layer || !['ROOT','GROUP'].includes(t[2]) || layer.group !== undefined) throw new Error('STACK needs a declared layer ID once, and ROOT or GROUP.');
        layer.group=t[2]==='GROUP';
      } else if (cmd === 'PART') {
        if (!project.layers.length || animation) throw new Error('Declare parts after layers and before animations.');
        part = partDeclaration(t, project.parts); expandedOps += part.ops.length;
      } else if (cmd === 'ANIM') {
        if (!project.layers.length || project.animations.length >= 100) throw new Error('Invalid animation count or missing layers.');
        argumentsCount(t, 3);
        if (!/^(?:[1-9][0-9]*)(?:\.[0-9]+)?$/.test(t[3])) throw new Error('Invalid FPS.');
        animation = { id: artworkId(t[1]), name: quoted(t[2]), fps: Number(t[3]), frames: [] };
        project.animations.push(animation); frame = source = raster = null;
      } else if (cmd === 'BONE') {
        if (!animation) throw new Error('Declare BONE after the animations.');
        if (bones.length >= 256) throw new Error('At most 256 bones.');
        bones.push(boneDeclaration(t)); frame = source = raster = null;
      } else if (cmd === 'POSE') {
        if (!bones.length) throw new Error('Declare POSE after the BONE lines.');
        if (poses.length >= 64) throw new Error('At most 64 poses.');
        poses.push(poseDeclaration(t)); frame = source = raster = null;
      } else if (cmd === 'ORDER') {
        if (!animation || animation.frames.length || animation.layerOrder) throw new Error('ORDER is allowed once after ANIM, before its first FRAME.');
        argumentsCount(t, project.layers.length);
        const order = t.slice(1);
        if (new Set(order).size !== project.layers.length || order.some(id => !project.layers.some(l => l.id === id))) throw new Error('ORDER must contain every layer ID exactly once.');
        animation.layerOrder = order;
      } else if (cmd === 'FRAME') {
        if (!animation) throw new Error('FRAME requires ANIM.');
        if (t[3] === 'CLEAR') argumentsCount(t, 3);
        else if (t[3] === 'FROM') argumentsCount(t, 4);
        else throw new Error('FRAME needs CLEAR or FROM frame-id.');
        if (++totalFrames > 1024 || animation.frames.length >= 256 || totalFrames * project.width * project.height * project.layers.length > MAX_TOTAL_PIXELS) throw new Error('Frame/pixel budget exceeded.');
        const previous = t[3] === 'FROM' ? frames.get(t[4]) : null;
        if (t[3] === 'FROM' && !previous) throw new Error(`Unknown earlier frame ${t[4]}.`);
        if (frames.has(t[1])) throw new Error(`Duplicate frame ${t[1]}.`);
        if (previous) expandedOps += previous.cels.reduce((n, c) => n + (c.source ? c.source.ops.length + c.source.overrides.length : 0), 0);
        if (expandedOps > MAX_OPERATIONS) throw new Error('Expanded operation budget exceeded.');
        frame = { id: artworkId(t[1]), duration: numberToken(t[2]), cels: previous ? cloneArtwork(previous.cels) : project.layers.map(l => ({ layerId: l.id, source: { ops: [], overrides: [] } })) };
        animation.frames.push(frame); frames.set(frame.id, frame); source = raster = null;
      } else if (cmd === 'FRAMEORDER') {
        if(!frame || frame.layerOrder || source || raster)throw new Error('FRAMEORDER is allowed once after FRAME, before CEL.');
        argumentsCount(t,project.layers.length);
        const order=t.slice(1);
        if(new Set(order).size!==project.layers.length || order.some(id=>!project.layers.some(l=>l.id===id)))throw new Error('FRAMEORDER must contain every layer ID exactly once.');
        frame.layerOrder=order;
      } else if (cmd === 'CEL') {
        if (!frame || ![2, 3].includes(t.length) || (t.length === 3 && !['CLEAR', 'RASTER'].includes(t[2]))) throw new Error('CEL requires a frame and layer-id, optionally CLEAR.');
        const cel = frame.cels.find(c => c.layerId === t[1]);
        if (!cel) throw new Error(`Unknown layer ${t[1]}.`);
        if (t[2] === 'CLEAR') { expandedOps -= cel.source ? cel.source.ops.length + cel.source.overrides.length : 0; cel.source = { ops: [], overrides: [] }; delete cel.pixels; }
        if (t[2] === 'RASTER') {
          if (cel.source?.ops.length || cel.source?.overrides.length) throw new Error('Clear a retained cel before switching to RASTER.');
          delete cel.source;
          cel.pixels ||= Array(project.width * project.height).fill(-1);
        }
        source = cel.source; raster = source ? null : cel.pixels;
      } else {
        if (raster) {
          if (cmd === 'SHIFT') {
            argumentsCount(t, 2);
            const dx = numberToken(t[1]), dy = numberToken(t[2]);
            if (Math.abs(dx) > project.width || Math.abs(dy) > project.height) throw new Error('SHIFT exceeds canvas bounds.');
            spendRasterWork(raster.length);
            const shifted = translatePixels(raster, project.width, project.height, dx, dy);
            shifted.forEach((v, i) => { raster[i] = v; });
            continue;
          }
          if (cmd !== 'SPAN') throw new Error('A RASTER cel accepts SPAN or SHIFT only.');
          const op = drawingCommand(t);
          if (op.x < 0 || op.y < 0 || op.y >= project.height || op.x + op.values.length > project.width || op.values.some(c => c >= project.palette.length)) throw new Error('Raster SPAN outside its canvas or palette.');
          spendRasterWork(op.values.length);
          op.values.forEach((v, i) => { raster[op.y * project.width + op.x + i] = v; });
        } else {
          if (!source) throw new Error('Select CEL before drawing.');
          const oldCount=source.ops.length+source.overrides.length;
          applyCelCommand(source, t);
          expandedOps+=source.ops.length+source.overrides.length-oldCount;
        }
      }
      if (expandedOps > MAX_OPERATIONS) throw new Error('Expanded operation budget exceeded.');
    } catch (error) { throw new Error(`Line ${number}: ${error.message}`); }
  }
  if (part) throw new Error('Missing ENDPART.');
  return bones.length ? rigBones(validateProject(project), bones, poses) : validateProject(project);
}
function poseDeclaration(t) {
  if (t.length < 4) throw new Error('POSE needs id "name" and bone-id=degrees.');
  const pose = { id: artworkId(t[1]), name: quoted(t[2]), bones: {} };
  for (let i = 3; i < t.length;) {
    if (t[i] === 'MOVE') { (pose.moves ||= {})[artworkId(t[i + 1])] = { x: numberToken(t[i + 2]), y: numberToken(t[i + 3]) }; i += 4; continue; }
    const m = /^([A-Za-z0-9_-]{1,100})=(-?\d+)$/.exec(t[i]);
    if (!m) throw new Error(`Expected bone-id=degrees or MOVE, not ${t[i]}.`);
    pose.bones[m[1]] = numberToken(m[2]); i++;
  }
  return pose;
}
const decimal = value => { if (!/^-?\d+(?:\.\d+)?$/.test(value ?? '')) throw new Error(`Invalid number ${value}.`); return Number(value); };
function boneDeclaration(t) {
  if (t.length < 6 || t[4] !== 'PARENT') throw new Error('BONE needs id layer-id instance-id PARENT parent-id|-.');
  const bone = { id: artworkId(t[1]), layerId: artworkId(t[2]), instanceId: artworkId(t[3]), parent: t[5] === '-' ? null : artworkId(t[5]) };
  for (let i = 6; i < t.length;) {
    const key = t[i];
    if (key === 'JOINT') { bone.anchor = { x: decimal(t[i + 1]), y: decimal(t[i + 2]) }; i += 3; }
    else if (key === 'LIMIT') { bone.limit = { min: numberToken(t[i + 1]), max: numberToken(t[i + 2]) }; i += 3; }
    else if (key === 'REST') { bone.rest = numberToken(t[i + 1]); i += 2; }
    else if (key === 'NAME') { bone.name = quoted(t[i + 1]); i += 2; }
    else throw new Error(`Unknown BONE option ${key}.`);
  }
  return bone;
}
/** Attach decoded bones; a missing JOINT comes from the child's pivot on the parent in the first frame showing both. */
function rigBones(project, bones, poses = []) {
  const opIn = (frame, layerId, id) => frame.cels.find(c => c.layerId === layerId)?.source?.ops.find(op => op.type === 'use' && op.id === id);
  const byId = new Map(bones.map(b => [b.id, b])), partOf = op => project.parts.find(part => part.id === op.partId);
  for (const bone of bones) {
    const parent = byId.get(bone.parent);
    if (bone.anchor || !parent) continue;
    for (const frame of project.animations.flatMap(a => a.frames)) {
      const child = opIn(frame, bone.layerId, bone.instanceId), host = opIn(frame, parent.layerId, parent.instanceId);
      if (!child || !host) continue;
      const a = boxToPart(host, partOf(host), worldToBox(host, partOf(host), instancePivot(child, partOf(child))));
      bone.anchor = { x: Math.round(a.x * 1000) / 1000, y: Math.round(a.y * 1000) / 1000 };
      break;
    }
  }
  return validateProject({ ...project, bones, ...(poses.length ? { poses } : {}) });
}

export function encodeOperation(op) {
  if (op.type === 'span') return `SPAN ${op.x} ${op.y} ${encodeRun(op.values)}`;
  if (op.type === 'use') {
    const use=`USE ${op.id} ${op.partId} ${op.x} ${op.y}${op.transform === 'N' ? '' : ` ${op.transform}`}`;
    const size=(op.width !== undefined ? `\nRESIZE ${op.id} ${op.width} ${op.height}` : '')+(op.angle ? `\nROTATE ${op.id} ${op.angle}` : '')+effectLines(op).map(line => `\n${line}`).join('');
    return (op.name !== undefined || op.visible !== undefined || op.locked !== undefined
      ? `${use}\nINSTANCE ${op.id} ${JSON.stringify(op.name || op.partId)} ${+(op.visible !== false)} ${+Boolean(op.locked)}` : use) + size;
  }
  if (op.type === 'line') return `LINE ${op.x} ${op.y} ${op.x2} ${op.y2} ${op.color}`;
  return `${op.type.toUpperCase()} ${op.x} ${op.y} ${op.width} ${op.height} ${op.color}`;
}
export function encodeSource(source) {
  return [...source.ops.map(encodeOperation), ...source.overrides.map(op => encodeOperation(op).replace(/^SPAN /, 'OVERRIDE '))];
}
function sourceDelta(source, old) {
  if (JSON.stringify(source) === JSON.stringify(old)) return [];
  if (source.ops.length !== old.ops.length || JSON.stringify(source.overrides) !== JSON.stringify(old.overrides)) return null;
  const lines = [];
  for (let i = 0; i < source.ops.length; i++) {
    const a = source.ops[i], b = old.ops[i];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (a.type !== 'use' || b.type !== 'use' || a.id !== b.id) return null;
    if (a.name !== b.name || a.visible !== b.visible || a.locked !== b.locked) return null;
    if (a.width !== b.width || a.height !== b.height) { if (a.width === undefined) return null; lines.push(`RESIZE ${a.id} ${a.width} ${a.height}`); }
    if ((a.angle || 0) !== (b.angle || 0)) lines.push(`ROTATE ${a.id} ${a.angle || 0}`);
    lines.push(...effectLines(a, b));
    if (a.x !== b.x || a.y !== b.y) lines.push(`AT ${a.id} ${a.x} ${a.y}`);
    if (a.partId !== b.partId) lines.push(`SWAP ${a.id} ${a.partId}`);
    if (a.transform !== b.transform) lines.push(`TURN ${a.id} ${a.transform}`);
  }
  return lines;
}
function rasterChanges(pixels, previous, width, height) {
  const candidates = previous ? [[0,0],[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]] : [[0,0]];
  let best;
  for (const [dx,dy] of candidates) {
    const baseline = previous && (dx || dy ? translatePixels(previous, width, height, dx, dy) : previous);
    const spans = pixelSpans(pixels, width, (i,v) => v !== (baseline?.[i] ?? -1));
    const lines = dx || dy ? [`SHIFT ${dx} ${dy}`] : [];
    for (let i=0;i<spans.length;) {
      const row=[];
      const y=spans[i].y;
      while(i<spans.length && spans[i].y===y) row.push(spans[i++]);
      const x=row[0].x, last=row.at(-1), end=last.x+last.values.length;
      const joined=encodeOperation({type:'span',x,y,values:pixels.slice(y*width+x,y*width+end)});
      const split=row.map(encodeOperation);
      lines.push(...(joined.length < split.join('\n').length ? [joined] : split));
    }
    if (!best || lines.join('\n').length < best.join('\n').length) best=lines;
  }
  return best;
}
export function encodePXA2(input) {
  const p = validateProject(input), q = JSON.stringify;
  const lines = ['PXA 2', `SIZE ${p.width} ${p.height}`, `NAME ${q(p.name)}`, `PAL ${p.palette.join(' ')}`];
  for (const l of p.layers) lines.push(`LAYER ${l.id} ${q(l.name)} ${+l.visible} ${+l.locked}`);
  for (const l of p.layers) if(l.group !== undefined) lines.push(`STACK ${l.id} ${l.group?'GROUP':'ROOT'}`);
  for (const part of p.parts || []) lines.push(`PART ${part.id} ${part.width} ${part.height}`, ...part.ops.map(encodeOperation), 'ENDPART');
  let previous;
  for (const a of p.animations) {
    lines.push(`ANIM ${a.id} ${q(a.name)} ${a.fps}`);
    if (a.layerOrder) lines.push(`ORDER ${a.layerOrder.join(' ')}`);
    for (const f of a.frames) {
      const cels = p.layers.map(l => f.cels.find(c => c.layerId === l.id));
      const bodyFor = (oldCels) => cels.flatMap((cel, i) => {
        const id = p.layers[i].id, old = oldCels?.[i];
        if (!cel.source) {
          const baseline = old && !old.source ? old.pixels : null;
          const commands = rasterChanges(cel.pixels, baseline, p.width, p.height);
          const reset = old?.source ? [`CEL ${id} CLEAR`] : [];
          if (!commands.length && baseline) return [];
          return [...reset, `CEL ${id} RASTER`, ...commands];
        }
        const full = [`CEL ${id}${old ? ' CLEAR' : ''}`, ...encodeSource(cel.source)];
        const changes = old?.source ? sourceDelta(cel.source, old.source) : null;
        if (changes?.length === 0) return [];
        const partial = changes ? [`CEL ${id}`, ...changes] : null;
        return partial && partial.join('\n').length < full.join('\n').length ? partial : full;
      });
      const clear = [`FRAME ${f.id} ${f.duration} CLEAR`, ...bodyFor(null)];
      let selected = clear;
      if (previous) {
        const delta = [`FRAME ${f.id} ${f.duration} FROM ${previous.id}`, ...bodyFor(previous.cels)];
        if (delta.join('\n').length < clear.join('\n').length) selected = delta;
      }
      if(f.layerOrder)selected.splice(1,0,`FRAMEORDER ${f.layerOrder.join(' ')}`);
      lines.push(...selected); previous = { id: f.id, cels };

    }
  }
  const num = v => String(Math.round(v * 1000) / 1000);
  for (const b of p.bones || []) lines.push(`BONE ${b.id} ${b.layerId} ${b.instanceId} PARENT ${b.parent || '-'}${b.anchor ? ` JOINT ${num(b.anchor.x)} ${num(b.anchor.y)}` : ''}${b.limit ? ` LIMIT ${b.limit.min} ${b.limit.max}` : ''}${b.rest ? ` REST ${b.rest}` : ''}${b.name !== undefined ? ` NAME ${q(b.name)}` : ''}`);
  for (const pose of p.poses || []) lines.push(`POSE ${pose.id} ${q(pose.name)} ${Object.entries(pose.bones).map(([id, a]) => `${id}=${a}`).join(' ')}${Object.entries(pose.moves || {}).map(([id, m]) => ` MOVE ${id} ${m.x} ${m.y}`).join('')}`);
  const text = [...lines, 'END', ''].join('\n');
  if (new TextEncoder().encode(text).length > PXA2_MAX_BYTES) throw new Error('PXA export exceeds 4 MiB.');
  return text;
}
