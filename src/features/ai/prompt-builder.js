import { PXA2_GUIDE } from '../../formats/pxa-v2.js';
/** Standalone instructions for creating a PXA project without example artwork. */
import { MAX_SIZE, MAX_COLORS, MAX_LAYERS, MAX_TOTAL_PIXELS } from '../../domain/project.js';
import { AI_FORMAT_GUIDE } from '../../formats/pxa.js';

const MAX_ANIMATIONS = 100;
const MAX_FRAMES_PER_ANIMATION = 256;
const MAX_TOTAL_FRAMES = 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value, label, limit, required = true) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new Error(`${label} must contain ${required ? '1' : '0'}–${limit.toLocaleString('en-US')} characters.`);
  }
  return value.trim();
}

function wholeNumber(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a whole number from ${minimum} to ${maximum.toLocaleString('en-US')}.`);
  }
  return value;
}

function readPalette(config) {
  if (config.paletteMode === 'auto') {
    return { palette: [], maxColors: wholeNumber(config.maxColors, 'Maximum colors', 1, MAX_COLORS) };
  }
  if (config.paletteMode !== 'current') throw new Error('Choose an automatic palette or the current palette.');
  if (!Array.isArray(config.palette) || config.palette.length < 1 || config.palette.length > MAX_COLORS) {
    throw new Error(`The current palette must contain 1–${MAX_COLORS} colors.`);
  }
  const palette = Array.from(config.palette, color => {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
      throw new Error('Palette colors must be six-digit hex colors, such as #ffcc66.');
    }
    return color.toLowerCase();
  });
  return { palette, maxColors: palette.length };
}

/**
 * Validate without changing the draft. Numeric fields must already be numbers.
 * Returns cloned arrays, trimmed text, normalized hex colors, totalFrames,
 * maxLayers, and an integer duration on every animation.
 */
export function validatePromptConfig(config) {
  if (!object(config)) throw new Error('Provide a pixel-art description and an animation plan.');
  const formatVersion=config.formatVersion ?? 2;
  if (![1,2].includes(formatVersion)) throw new Error('Choose PXA 1 or 2.');
  const name = text(config.name, 'Project name', 120);
  const description = text(config.description, 'Artwork description', 6000);
  const width = wholeNumber(config.width, 'Canvas width', 1, MAX_SIZE);
  const height = wholeNumber(config.height, 'Canvas height', 1, MAX_SIZE);
  const { palette, maxColors } = readPalette(config);
  const style = config.style === undefined ? '' : text(config.style, 'Additional art direction', 2000, false);
  if (!Array.isArray(config.animations) || config.animations.length < 1 || config.animations.length > MAX_ANIMATIONS) {
    throw new Error(`Add 1–${MAX_ANIMATIONS} animations to the plan.`);
  }
  const names = new Set();
  const animations = Array.from(config.animations, (animation, index) => {
    if (!object(animation)) throw new Error(`Animation ${index + 1} needs a name, frame count, and FPS.`);
    const name = text(animation.name, `Animation ${index + 1} name`, 80);
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`Animation names must be unique. “${name}” is used more than once.`);
    names.add(key);
    const frameCount = wholeNumber(animation.frameCount, `Frame count for “${name}”`, 1, MAX_FRAMES_PER_ANIMATION);
    const fps = animation.fps;
    if (!Number.isFinite(fps) || fps < 1 || fps > 60) {
      throw new Error(`FPS for “${name}” must be a number from 1 to 60.`);
    }
    return { name, frameCount, fps, duration: Math.round(1000 / fps) };
  });
  const totalFrames = animations.reduce((total, animation) => total + animation.frameCount, 0);
  if (totalFrames > MAX_TOTAL_FRAMES) {
    throw new Error(`The plan can contain at most ${MAX_TOTAL_FRAMES.toLocaleString('en-US')} frames in total.`);
  }
  const pixelsPerLayer = width * height * totalFrames;
  if (pixelsPerLayer > MAX_TOTAL_PIXELS) {
    throw new Error(`This plan needs ${pixelsPerLayer.toLocaleString('en-US')} pixels per layer, above the ${MAX_TOTAL_PIXELS.toLocaleString('en-US')} limit. Reduce the canvas size or frame count.`);
  }
  return {
    formatVersion, name, description, width, height, paletteMode: config.paletteMode, maxColors, palette, animations, style,
    totalFrames, maxLayers: Math.min(MAX_LAYERS, Math.floor(MAX_TOTAL_PIXELS / pixelsPerLayer)),
  };
}

function quote(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Build a complete creation prompt. No source project or example is included. */
export function buildCreationPrompt(config) {
  const plan = validatePromptConfig(config);
  const palette = plan.paletteMode === 'current'
    ? `Use this exact fixed palette, in this exact slot order. Do not add, remove, reorder, or change colors:\nPAL ${plan.palette.join(' ')}`
    : `Choose a cohesive palette of 1–${plan.maxColors} opaque colors for this artwork. Write those colors as six-digit hex values on the PAL line and use that same palette for every frame. Transparency does not use a palette slot.`;
  if (plan.formatVersion === 2) return `Create finished pixel art: ${plan.description}
${plan.style ? `Art direction: ${plan.style}` : ''}
Return a complete PXA 2 document only, ending with END. No Markdown or placeholders.
SIZE ${plan.width} ${plan.height}
NAME ${quote(plan.name)}
${palette}
Build an ordered object stack. Use one ROOT container by default (LAYER art "Artwork" 1 0, followed by STACK art ROOT); add GROUP containers only for meaningful visibility/locking groups, at most ${plan.maxLayers} containers total. Define reusable parts for repeated shapes, character features and effects; place them with USE and animate with AT/SWAP. Parts can be shared across groups and animations. Use stable instance IDs across frames so animation-wide object editing can track appearances. Use pixel spans for precise silhouettes and shading. RASTER cels are available for freeform artwork. Avoid forcing organic poses into rigid pieces; redraw local details or use pose variants where needed.
Treat overlapping parts as components of one finished drawing. Do not give every component a separate closed outline: those contours create seams at overlaps. Leave joining edges open or covered by the adjacent form, preserve intentional interior detail, and keep one coherent outer silhouette. Check every requested pose for joins and contour continuity.
Animation plan, in exact order:
${plan.animations.map((a,i)=>`ANIM anim_${i} ${quote(a.name)} ${a.fps}: ${a.frameCount} frames of ${a.duration} ms`).join('\n')}
Use stable readable IDs. Preserve all requested frame counts and durations, including intentional holds. Use crisp whole pixels, readable silhouettes and solid palette colors. Keep the subject aligned, recognizable and fully inside the canvas. Leave background transparent; no checkerboard, antialiasing or labels.
${PXA2_GUIDE}
`;
  const animationLines = plan.animations.map((animation, index) =>
    `${index + 1}. ANIM ${quote(animation.name)} ${animation.fps} — exactly ${animation.frameCount} FRAME entries, each ${animation.duration} ms.`
  ).join('\n');
  const layerLimit = plan.maxLayers === 1
    ? 'This canvas and frame count permit exactly one layer within the stored-pixel limit.'
    : `If additional editable layers are needed, use no more than ${plan.maxLayers} layers in total. This bound accounts for the canvas size and every requested frame.`;

  return `Create a NEW Pixel Studio pixel-art project from the brief below. Start from an empty canvas; no source project, example artwork, or reference image is required.
Return exactly one complete PXA 1 document, without Markdown fences, explanation, or an image. Create the actual artwork as pixel data, not an empty template.

ARTWORK BRIEF
${plan.description}${plan.style ? `\n\nADDITIONAL ART DIRECTION\n${plan.style}` : ''}

PROJECT REQUIREMENTS
Use this exact project name and canvas size:
SIZE ${plan.width} ${plan.height}
NAME ${quote(plan.name)}
The final document must start with PXA 1, then SIZE, NAME, and PAL in that order, as specified by the format guide below.

PALETTE
${palette}

LAYERS
Use one visible, unlocked layer named "Artwork" by default:
LAYER 0 "Artwork" 1 0
${layerLimit}
Declare all layers before the first animation. The limit counts every pixel slot in every layer and frame, including transparent pixels.

ANIMATION PLAN — EXACT ORDER
${animationLines}
Create exactly ${plan.animations.length} ANIM sections with ${plan.totalFrames} FRAME entries in total. Preserve the names, capitalization, order, frame counts, FPS, and per-frame durations above. Do not add extra animations, omit frames, or pad shorter animations with blank frames. Spritesheet rows follow this animation order; columns follow the frame order within each animation.
Each requested frame must contain finished artwork; do not substitute blank placeholders. The first frame of each animation must use CLEAR. Later frames may use CLEAR or PREV; PREV only refers to the preceding frame in the same animation. Write intentional poses and motion appropriate to each animation, not duplicate placeholder frames. Intentional holds may use unchanged PREV frames. Keep the subject's scale, alignment, palette, and identifying details consistent across frames. Keep intended loops smooth.

PIXEL-ART REQUIREMENTS
Design directly on the ${plan.width} × ${plan.height} logical pixel grid. Use whole, grid-aligned pixels, crisp edges, clear silhouettes, and readable clusters of solid color. Do not use antialiasing, blur, or gradients. Keep empty background areas transparent; do not paint a checkerboard, editor grid, frame borders, or labels. Keep the complete subject inside the canvas unless the brief explicitly requests otherwise.

PXA 1 FORMAT GUIDE
${AI_FORMAT_GUIDE}

CHECK BEFORE RETURNING
Verify the exact canvas dimensions, project name, palette rule, ordered animation names, frame counts, FPS, and durations. Verify the total frame and layer budgets. Use only valid palette symbols or transparency; keep every SPAN inside its row, declare each layer, and select CEL after each FRAME before writing SPAN. Use CLEAR at the start of every animation. Return the complete importable PXA 1 document only, with no placeholders, ellipses, Markdown, or explanation.
`;
}
