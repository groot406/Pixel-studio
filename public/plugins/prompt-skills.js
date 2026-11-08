/* pixelstudio-plugin
{
  "id": "prompt-skills-starter",
  "name": "Prompt skills: RPG character, Platformer hero, Item icon, Tileset",
  "version": "1.0.0",
  "description": "Four ready-made prompt skills for the AI prompt builder. Pick one under “Prompt skill”.",
  "author": "Pixel Studio examples",
  "permissions": ["prompt"]
}
*/
// A prompt skill adds expert instructions (and optionally an animation plan and canvas size) to the AI prompt builder.
// Nothing runs on your artwork: the text is added to the prompt you copy into a chatbot.

pixelStudio.registerPromptSkill({
  id: 'rpg-character',
  title: 'RPG character',
  description: 'Top-down ¾ view walker with four-direction readability',
  width: 32, height: 32,
  instructions: 'Draw a top-down three-quarter view RPG character that reads at 1× zoom: big head (about a third of the height), clear silhouette, a dark one-pixel outline with selective outlining on lit edges, light from the top left. Keep feet on the same baseline in every frame. Walk cycles: contact, passing, contact, passing with a one-pixel body bob on passing frames. Attack frames: anticipation, a smear frame, impact, recovery.',
  animations: [
    { name: 'Idle down', frameCount: 2, fps: 4 }, { name: 'Walk down', frameCount: 4, fps: 8 },
    { name: 'Walk up', frameCount: 4, fps: 8 }, { name: 'Walk right', frameCount: 4, fps: 8 },
    { name: 'Attack right', frameCount: 4, fps: 10 },
  ],
});

pixelStudio.registerPromptSkill({
  id: 'platformer-hero',
  title: 'Platformer hero',
  description: 'Side-view hero with run, jump and fall',
  width: 32, height: 32,
  instructions: 'Draw a side-view platformer hero facing right with a strong, readable silhouette and exaggerated poses. Use squash on landing and stretch on take-off. Run cycle of 6 frames with arms opposite to legs and a forward lean. Jump: crouch anticipation, stretch up; Fall: limbs spread. Keep the hitbox (feet and torso) in the same place so the sprite does not jitter in a game engine.',
  animations: [
    { name: 'Idle', frameCount: 4, fps: 6 }, { name: 'Run', frameCount: 6, fps: 12 },
    { name: 'Jump', frameCount: 2, fps: 8 }, { name: 'Fall', frameCount: 2, fps: 8 },
  ],
});

pixelStudio.registerPromptSkill({
  id: 'item-icon',
  title: 'Item icon',
  description: 'Inventory icon: centred, bold, readable at 1×',
  width: 16, height: 16,
  instructions: 'Draw a single inventory item icon, centred with one transparent pixel of margin on every side. Strong dark outline, at most 8 colours, a clear highlight in the top left and shadow bottom right, no background. Exaggerate the defining feature so the item is recognisable at 16 × 16. Optionally add a 4-frame shine loop that sweeps a one-pixel highlight across the item.',
  animations: [{ name: 'Icon', frameCount: 1, fps: 8 }, { name: 'Shine', frameCount: 4, fps: 10 }],
});

pixelStudio.registerPromptSkill({
  id: 'tileset',
  title: 'Tileset',
  description: 'Seamless 16 px tiles: ground, edges, corners',
  width: 64, height: 64,
  instructions: 'Create a 4 × 4 grid of seamless 16 × 16 terrain tiles on a 64 × 64 canvas: centre fill (two variants), four edges, four outer corners, four inner corners and two decoration tiles. Every tile must tile seamlessly with its neighbours; keep light from the top left and avoid pixels that only make sense at a tile border. No outlines inside the fill; use hue-shifted ramps and sparse texture clusters (2–3 pixels) instead of noise.',
  animations: [{ name: 'Tiles', frameCount: 1, fps: 8 }],
});
