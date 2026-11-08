// Prompts for general image models (Gemini 2.5 Flash Image, gpt-image-1, any chatbot) that make
// their output easy to turn into real pixels: one flat key-colour background, hard square blocks,
// a known grid size, and optionally a fixed palette, a sprite-sheet row or a reference sprite.

export const IMAGE_SIZES = [16, 24, 32, 48, 64, 96, 128];
export const IMAGE_VIEWS = {
  side: 'side view (profile), facing right',
  front: 'front view, facing the viewer',
  'three-quarter': 'three-quarter (3/4) view',
  'top-down': 'top-down view, as in a classic RPG',
  isometric: 'isometric view (2:1 pixel lines)',
};
export const IMAGE_STYLES = {
  snes: { label: '16-bit SNES', text: '16-bit SNES-era pixel art, rich but limited colours with hue-shifted shading' },
  nes: { label: 'NES 8-bit', text: '8-bit NES-era pixel art, very few colours per sprite, bold simple shapes' },
  gameboy: { label: 'Game Boy · 4 shades', text: 'original Game Boy pixel art using exactly 4 shades of green (#0f380f, #306230, #8bac0f, #9bbc0f)' },
  indie: { label: 'Modern indie', text: 'modern indie-game pixel art, clean readable shapes, soft hue-shifted shading, limited palette' },
  onebit: { label: '1-bit', text: '1-bit pixel art: only pure black and pure white pixels, no grey' },
  gba: { label: '32-bit GBA', text: 'Game Boy Advance era pixel art, vibrant colours, smooth hand-placed shading' },
};
export const IMAGE_BACKGROUNDS = {
  magenta: { label: 'Magenta #FF00FF · best for removal', hex: '#ff00ff', text: 'a solid, perfectly flat magenta (#FF00FF) background with no gradient, shadow, floor or texture' },
  white: { label: 'Plain white', hex: '#ffffff', text: 'a plain, perfectly flat white (#FFFFFF) background with no shadow, floor or texture' },
  transparent: { label: 'Transparent · OpenAI only', hex: null, text: 'a fully transparent background' },
};

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Defaults and bounds for every option; unknown values fall back rather than throw. */
export function normalizeImageOptions(options = {}) {
  const subject = String(options.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  return {
    subject,
    size: clampInt(options.size, 8, 256, 32),
    view: options.view in IMAGE_VIEWS ? options.view : 'side',
    style: options.style in IMAGE_STYLES ? options.style : 'snes',
    outline: options.outline !== false,
    palette: options.usePalette && Array.isArray(options.palette)
      ? options.palette.filter(c => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 64).map(c => c.toUpperCase()) : [],
    background: options.background in IMAGE_BACKGROUNDS ? options.background : 'magenta',
    frames: clampInt(options.frames, 1, 16, 1),
    reference: !!options.reference,
  };
}

/** Build one prompt. Returns a plain string suitable for any image model or chatbot. */
export function buildImagePrompt(options = {}) {
  const o = normalizeImageOptions(options);
  if (!o.subject) throw new Error('Describe what to draw first.');
  const style = IMAGE_STYLES[o.style].text, view = IMAGE_VIEWS[o.view];
  const lines = [];
  if (o.reference) lines.push(`Redraw the attached pixel-art sprite as: ${o.subject}. Keep its proportions, pose, colours and pixel scale unless asked otherwise; the reference is upscaled with nearest-neighbour, so each square block in it is one pixel.`);
  else if (o.frames > 1) lines.push(`A pixel-art sprite sheet of ${o.subject}: exactly ${o.frames} animation frames in a single horizontal row, evenly spaced in equal-width cells, the same character size and ground line in every frame, showing a smooth looping motion.`);
  else lines.push(`Pixel-art sprite of ${o.subject}.`);
  lines.push(`Style: ${style}. ${view[0].toUpperCase()}${view.slice(1)}.`);
  const grid = o.frames > 1 ? `each frame about ${o.size}×${o.size} pixels` : `a ${o.size}×${o.size} pixel grid`;
  lines.push(`Draw it as true low-resolution pixel art on ${grid}, scaled up so every pixel is a clear, equal-sized square block. Crisp hard pixel edges, no anti-aliasing, no blur, no gradients between blocks, no dithering noise, no sub-pixel detail.`);
  lines.push(o.outline ? 'Use a clean dark 1-pixel outline around the sprite.' : 'No outline: shape the sprite with its fill colours only.');
  if (o.palette.length) lines.push(`Use only these colours (hex): ${o.palette.join(', ')}. Do not introduce any other colours.`);
  lines.push(`${o.frames > 1 ? 'Every frame is' : 'A single subject,'} centred with some empty margin, on ${IMAGE_BACKGROUNDS[o.background].text}.`);
  lines.push('No text, no letters, no signature, no watermark, no border, no frame, no UI, no drop shadow.');
  return lines.join('\n');
}
