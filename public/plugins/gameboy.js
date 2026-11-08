/* pixelstudio-plugin
{
  "id": "gameboy-palette",
  "name": "Game Boy palette",
  "version": "1.0.0",
  "description": "Adds the classic four-green DMG palette and a command that remaps the art onto it by brightness.",
  "author": "Pixel Studio examples",
  "permissions": ["pixels", "palette"]
}
*/

const GAME_BOY = ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'];

// Shows up in Palette studio's preset list (filter “From plugins”).
pixelStudio.registerPalette({ name: 'Game Boy (DMG)', colors: GAME_BOY });

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
}

pixelStudio.registerCommand({
  id: 'gameboy-remap',
  title: 'Remap to Game Boy greens',
  description: 'Four shades by brightness; appends the greens to the palette',
  scope: 'frame',
  params: [{ id: 'brightness', label: 'Brightness', type: 'number', min: -2, max: 2, step: 1, default: 0 }],
}, ({ pixels, palette, params }) => {
  // A plugin may append colours: return the current palette unchanged, followed by the new ones.
  const next = palette.slice();
  const slots = GAME_BOY.map(colour => {
    const at = next.indexOf(colour);
    if (at >= 0) return at;
    if (next.length >= 64) throw new Error('The palette is full (64 colours). Remove a few colours first.');
    next.push(colour);
    return next.length - 1;
  });
  const out = Array.from(pixels, v => {
    if (v < 0) return v;
    const level = Math.floor(luminance(palette[v]) / 64) + params.brightness;
    return slots[Math.max(0, Math.min(3, level))];
  });
  return { pixels: out, palette: next };
});
