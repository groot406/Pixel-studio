/* pixelstudio-plugin
{
  "id": "drop-shadow",
  "name": "Drop shadow",
  "version": "1.0.0",
  "description": "Casts a hard, one-colour pixel shadow behind the artwork.",
  "author": "Pixel Studio examples",
  "permissions": ["pixels"]
}
*/
// A plugin is a plain script. The `pixelStudio` object is the whole API; this file runs in its own Web Worker with no
// DOM and no network, and only ever sees a copy of the pixels it is asked to change.

pixelStudio.registerEffect({
  id: 'drop-shadow',
  title: 'Drop shadow',
  description: 'Hard shadow behind the art',
  params: [
    { id: 'dx', label: 'Offset right', type: 'number', min: -4, max: 4, step: 1, default: 1 },
    { id: 'dy', label: 'Offset down', type: 'number', min: -4, max: 4, step: 1, default: 1 },
    { id: 'color', label: 'Shadow colour', type: 'color', default: 'darkest' },
  ],
}, ({ width, height, pixels, params }) => {
  // `pixels` holds palette indices, row by row; -1 is transparent.
  const out = Array.from(pixels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] < 0) continue;
      const tx = x + params.dx, ty = y + params.dy;
      if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
      // Only fill transparent pixels, so the shadow stays behind the art.
      if (pixels[ty * width + tx] < 0) out[ty * width + tx] = params.color;
    }
  }
  return { pixels: out };
});
