/* pixelstudio-plugin
{
  "id": "outline-glow",
  "name": "Outline glow",
  "version": "1.0.0",
  "description": "A two-ring glow around the artwork: a bright inner ring and a softer, optionally dithered outer ring.",
  "author": "Pixel Studio examples",
  "permissions": ["pixels"]
}
*/

// Distance (in 4-connected steps, up to `max`) from every transparent pixel to the nearest opaque one.
function distances(pixels, width, height, max) {
  const dist = new Array(pixels.length).fill(Infinity);
  let frontier = [];
  pixels.forEach((v, i) => { if (v >= 0) { dist[i] = 0; frontier.push(i); } });
  for (let d = 1; d <= max && frontier.length; d++) {
    const next = [];
    for (const i of frontier) {
      const x = i % width, y = (i - x) / width;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const j = ny * width + nx;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && dist[j] === Infinity) { dist[j] = d; next.push(j); }
      }
    }
    frontier = next;
  }
  return dist;
}

pixelStudio.registerEffect({
  id: 'outline-glow',
  title: 'Outline glow',
  description: 'Bright inner ring, soft outer ring',
  params: [
    { id: 'inner', label: 'Inner ring', type: 'color', default: 'lightest' },
    { id: 'outer', label: 'Outer ring', type: 'color', default: 'active' },
    { id: 'size', label: 'Outer ring width', type: 'number', min: 1, max: 3, step: 1, default: 1 },
    { id: 'dither', label: 'Dither the outer ring', type: 'boolean', default: true },
  ],
}, ({ width, height, pixels, params }) => {
  const dist = distances(pixels, width, height, 1 + params.size), out = Array.from(pixels);
  for (let i = 0; i < out.length; i++) {
    const d = dist[i], x = i % width, y = (i - x) / width;
    if (d === 1) out[i] = params.inner;
    else if (d > 1 && d !== Infinity && (!params.dither || (x + y) % 2 === 0)) out[i] = params.outer;
  }
  return { pixels: out };
});
