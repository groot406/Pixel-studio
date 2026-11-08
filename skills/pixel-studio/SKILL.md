---
name: pixel-studio
description: Create, edit, render and export pixel-art sprites and sprite animations with Pixel Studio (PXA 2 text format, .pxa/.pxs files). Use when the user asks for pixel art, sprites, game characters, tiles, icons, sprite sheets or GIF animations, or mentions Pixel Studio, .pxa or .pxs files.
---

# Pixel Studio

Pixel Studio projects are plain-text **PXA 2** documents (`.pxa`): a palette, layers, reusable parts
(objects), animations with frames, and an optional skeleton. You write PXA text, Pixel Studio validates and
renders it. The full grammar is in [reference/pxa2-format.md](reference/pxa2-format.md) — read it before
writing PXA.

## Tools

Prefer the **Pixel Studio MCP tools** when they are available (`pixel_guide`, `create_project`, `read_project`,
`validate_pxa`, `write_project`, `render_png`, `image_to_pixels`, `make_parts`, `outline`, `apply_template`, `set_palette`, `export`,
and the live `editor_*` tools). If `set_workspace` is listed (the Pixel Studio plugin in Codex, whose server starts
outside your project), call it first with the absolute path of your working directory so files land in the project.
Without MCP, use the CLI from the Pixel Studio checkout:

```sh
pixelstudio info sprite.pxa                 # summary: size, palette, animations, frames, parts, bones
pixelstudio render sprite.pxa -o sprite.png --scale 8 [--frame 2] [--animation walk] [--strip]
pixelstudio convert sprite.pxa sprite.pxs   # .pxa ⇄ .pxs ⇄ .pixel.json
pixelstudio pixelize photo.png -o sprite.pxa --colors 16
pixelstudio rig sprite.pxa                  # drawn layers → parts + auto-rigged skeleton
pixelstudio outline sprite.pxa --strip --live  # remove baked outlines, use a live one
pixelstudio export sprite.pxa --sheet -o sheet.png   # or --gif -o anim.gif
```

(`pixelstudio` is `node <checkout>/local/cli.mjs` when it is not installed globally.)

## Workflow

1. **Read the guide** (`pixel_guide` or the reference file). Look at a sample (`pixelstudio://samples/key-v2`)
   if you have never written PXA before.
2. **Plan** the canvas (16×16 icons, 32×32 characters, 48–64 px for detailed sprites), a palette of 4–16
   colours, and the parts. Reuse a part with `USE` instead of drawing the same pixels twice.
   **Characters, creatures, vehicles and anything that may move are built from rigged parts by default** —
   even when only a still image was asked for — so the user can pose and animate them in the editor:
   one `PART` per moving piece (head, torso, each upper/lower arm and leg, tail, weapon, shield, cape), placed
   with `USE` + `PIVOT` on one layer, then one `BONE` per instance (see the `pixel-studio-animate` skill).
   Never merge pieces that move separately (e.g. "sword and arm" or "cloak, armour and boots") into one layer.
   Use `CEL … RASTER` / `SPAN` only for static art: tiles, icons, backgrounds, effects.
3. **Write** the complete document with `write_project` (or `create_project` and then edit). It validates
   first and returns line-precise errors without touching the file; fix exactly the reported line.
4. **Render and look**: `render_png` with `scale` 6–10 (and `strip: true` for animations). Actually inspect the
   image: silhouette, contrast, symmetry, stray pixels, frames that pop.
5. **Iterate** on the PXA text — change only what is wrong — until it reads well at 1× scale.
   If `validate_pxa`/`write_project` warns "No parts" or "not rigged", fix it: rewrite the pieces as parts, or
   call `make_parts` (CLI: `pixelstudio rig`) to turn drawn layers into parts and auto-rig them where they
   touch. Check the bones it reports and rename them (`head`, `arm-l`, `leg-r`…) so templates find the limbs.
   For anything that animates, draw parts **without** an outer outline and add `OUTLINE <dark index>` (or
   `OUTLINE AUTO`) after the layers: the live outline is recomputed for every frame, so rotated or moved
   parts never get broken or doubled outlines. `outline` with `strip: true, live: true` fixes existing art.
6. **Export** what the user needs: PNG, sprite sheet (+JSON), GIF.

When the user has Pixel Studio Local open, `editor_get_project` returns their current tab and
`editor_apply_project` proposes your change in the editor (the user approves it; it is one undo step).

## Pixel-art rules

- **Limited palette.** 4–16 colours; each material gets 2–4 shades (shadow, base, light, highlight). Shift hue
  in ramps (shadows cooler/more saturated, highlights warmer), don't just darken.
- **Readable silhouette first.** Fill it in one colour and check it reads at 1×. Exaggerate heads, hands and
  key props; small sprites need big shapes.
- **Outlines.** A dark 1-px outline (often a dark tinted colour, not pure black) separates the sprite from
  any background. Selective outlining (lighter outline on the lit side) looks softer.
- **Consistent light source** (usually top-left). Shade with clusters, not noise; avoid pillow shading
  (shading inward from every edge) and banding (parallel stair-steps of different colours).
- **Clean lines.** No jaggies: 1-px lines should step in regular runs (1-1-1, 2-2-2, 2-1-2), never doubled
  corners. Remove orphan pixels.
- **Transparent background** unless the user wants a scene; keep the sprite off the canvas edge.
- Index `0` is not special — transparency is `.` in SPAN or `-1` in shapes.

## Animation rules

- Draw **key poses** first (contact, passing, extremes), then breakdowns/in-betweens. Mark them with the
  FRAME role token (`KEY`, `BREAKDOWN`, `INBETWEEN`).
- Prefer **parts + transforms** over redrawing: move with `AT`, rotate limbs about a `PIVOT` (shoulder,
  hip), squash & stretch with `RESIZE` keeping area roughly constant, spins with `TILT`.
- **Timing**: idle 150–250 ms/frame (4–8 frames), walk 90–120 ms (8 frames), run 60–80 ms (6–8 frames),
  attacks: short anticipation (100–150 ms), very fast strike (40–60 ms), longer hold/recovery (150+ ms). Vary
  durations per frame — holds sell impact.
- **Loops** must match: the last frame should flow into the first, not duplicate it.
- Keep the **ground line** fixed for walking/idle cycles; bob the body 1 px, not the feet.
- For rigged characters use `apply_template` (walk, run, jump, idle, wave, hover) and then refine; see the
  `pixel-studio-animate` skill.
