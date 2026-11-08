/* pixelstudio-plugin
{
  "id": "palette-cycle",
  "name": "Palette cycle animation",
  "version": "1.0.0",
  "description": "Turns the active container into a colour-cycling loop (water, fire, magic), adding frames when needed.",
  "author": "Pixel Studio examples",
  "permissions": ["animation"]
}
*/

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
}

// Scope "animation": the handler receives every frame of the active container and returns the new list of frames.
// Returning more frames than exist adds frames at the end (other containers copy the last frame).
pixelStudio.registerCommand({
  id: 'palette-cycle',
  title: 'Palette cycle animation',
  description: 'Cycle the colours used in this frame into a loop',
  scope: 'animation',
  params: [
    { id: 'frames', label: 'Frames in the loop', type: 'number', min: 2, max: 16, step: 1, default: 6 },
    { id: 'direction', label: 'Direction', type: 'select', options: [{ value: 'up', label: 'Dark → light' }, { value: 'down', label: 'Light → dark' }], default: 'up' },
    { id: 'duration', label: 'Frame duration (ms)', type: 'number', min: 20, max: 1000, step: 10, default: 100 },
  ],
}, ({ frames, frameIndex, palette, params }) => {
  const source = frames[frameIndex].pixels;
  // The colour ramp to cycle: every colour used in the current frame, dark to light.
  const ramp = [...new Set(Array.from(source).filter(v => v >= 0))].sort((a, b) => luminance(palette[a]) - luminance(palette[b]));
  if (ramp.length < 2) throw new Error('Draw with at least two colours first: the cycle moves through the colours used in this frame.');
  const position = new Map(ramp.map((colour, i) => [colour, i]));
  const step = params.direction === 'up' ? 1 : -1, count = Math.max(frames.length, params.frames);
  const result = [];
  for (let k = 0; k < count; k++) {
    // Existing frames keep their own drawing; added frames start from the current frame.
    const base = k < frames.length ? frames[k].pixels : source;
    const shift = ((k * step) % ramp.length + ramp.length) % ramp.length;
    const pixels = Array.from(base, v => (position.has(v) ? ramp[(position.get(v) + shift) % ramp.length] : v));
    result.push({ pixels, duration: params.duration });
  }
  return { frames: result };
});
