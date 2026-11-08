/* pixelstudio-plugin
{
  "id": "noise-grain",
  "name": "Noise / grain dither",
  "version": "1.0.0",
  "description": "Sprinkles film-grain style noise over the art using the neighbouring darker or lighter palette colour.",
  "author": "Pixel Studio examples",
  "permissions": ["pixels"]
}
*/

// Relative brightness of a #rrggbb colour (0–255).
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
}
function distance(a, b) {
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  return Math.hypot(((x >> 16) & 255) - ((y >> 16) & 255), ((x >> 8) & 255) - ((y >> 8) & 255), (x & 255) - (y & 255));
}
// For each palette colour, the most similar colour that is darker (or lighter); itself when none exists.
function shadeMap(palette, darker) {
  return palette.map((colour, i) => {
    let best = i, bestDistance = Infinity;
    palette.forEach((other, j) => {
      const ok = darker ? luminance(other) < luminance(colour) - 4 : luminance(other) > luminance(colour) + 4;
      if (ok && distance(colour, other) < bestDistance) { best = j; bestDistance = distance(colour, other); }
    });
    return best;
  });
}
// A tiny seeded random generator, so the same seed always gives the same grain.
function random(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6d2b79f5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}

pixelStudio.registerEffect({
  id: 'noise-grain',
  title: 'Noise / grain dither',
  description: 'Film grain from neighbouring shades',
  params: [
    { id: 'amount', label: 'Amount %', type: 'number', min: 1, max: 60, step: 1, default: 20 },
    { id: 'tone', label: 'Grain', type: 'select', options: [{ value: 'both', label: 'Darker and lighter' }, { value: 'darker', label: 'Darker only' }, { value: 'lighter', label: 'Lighter only' }], default: 'both' },
    { id: 'seed', label: 'Seed', type: 'number', min: 1, max: 999, step: 1, default: 7 },
  ],
}, ({ pixels, palette, params, frameIndex }) => {
  const dark = shadeMap(palette, true), light = shadeMap(palette, false);
  // Mix in the frame index so every frame of an animation gets its own grain.
  const next = random(params.seed * 7919 + frameIndex), out = Array.from(pixels);
  for (let i = 0; i < out.length; i++) {
    if (out[i] < 0 || next() * 100 >= params.amount) continue;
    const useDark = params.tone === 'darker' || (params.tone === 'both' && next() < 0.5);
    out[i] = useDark ? dark[out[i]] : light[out[i]];
  }
  return { pixels: out };
});
