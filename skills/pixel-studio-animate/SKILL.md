---
name: pixel-studio-animate
description: Rig and animate Pixel Studio sprites — skeleton bones, poses, walk/run/jump/idle/wave/hover templates, frame timing and squash & stretch in the PXA 2 format. Use when the user wants a character or object in a .pxa project to move, loop, walk, run, jump, breathe, wave or bob.
---

# Pixel Studio animation

Use together with the `pixel-studio` skill (PXA 2 grammar: `reference/pxa2-format.md` in that skill, or the
`pixel_guide` MCP tool).

## 1. Build the character from parts

Animation in PXA 2 needs each moving piece to be its own **part** placed with `USE`: torso, head,
upper/lower arms, upper/lower legs, tail, weapon. Do this from the start for every character — raster
(`RASTER`/`SPAN`) layers cannot be posed. If a project was already drawn as raster layers, call `make_parts`
(CLI: `pixelstudio rig file.pxa`): it turns each layer into a part (identical frames share one) and auto-rigs
them where they touch, with the torso/body or largest piece as root. It can only bend where layers are split,
so split arms, legs and props into their own layers or parts first for a fully poseable figure. Leave the outer outline off
the parts and use a live `OUTLINE <index>` line instead (tool `outline`, `strip: true` removes baked outlines) so it stays clean in every pose. Draw the parts in the rest pose, facing the camera or to
the side, and give each instance a `PIVOT` at its joint (top-centre of a limb, bottom-centre of a head):

```
CEL fig
USE leg-l upperleg 20 28
PIVOT leg-l 1 0
USE body torso 20 17
USE head head 20 9
PIVOT head 3 7
```

## 2. Rig it with bones

After the animations, before `END`, add one `BONE` per moving instance. The root (usually the torso/hips) has
`PARENT -`; children name their parent and, optionally, the `JOINT` point on the parent's part:

```
BONE body fig body PARENT - NAME "torso"
BONE head fig head PARENT body JOINT 3.5 -0.5 LIMIT -30 30
BONE arm-l fig arm-l PARENT body JOINT -1.5 1.5 LIMIT -160 160
BONE leg-l fig leg-l PARENT body JOINT 1.5 11.5
BONE shin-l fig shin-l PARENT leg-l JOINT 1.5 6.5 LIMIT -150 0
```

Name bones clearly (`head`, `arm-l`, `forearm-r`, `leg-l`, `shin-r`, `tail`): templates detect limb roles
from the names. See `pixelstudio://samples/puppet` (Stick puppet) for a complete rig.

## 3. Generate motion with templates

`apply_template` (MCP) builds a complete looping animation from the rig:

| template | frames | ms/frame | notes |
|----------|--------|----------|-------|
| walk  | 8  | 110 | contact/passing poses, 1-px bob, feet on the ground |
| run   | 8  | 75  | bigger swing, 2-px bounce, forward lean |
| jump  | 12 | 80  | anticipation crouch, lift, tuck, landing squash |
| idle  | 8  | 160 | subtle breathing |
| wave  | 8  | 110 | one arm waves |
| hover | 8  | 120 | bob without ground contact (flyers, ghosts, items) |

Options: `frames`, `frameMs`, `amplitude` (swing in degrees), `bounce` (px), `exaggeration` (0.5–2),
`facing` (`auto`, `left`, `right`, `front`), `mode` (`new` animation, `replace` or `merge` into the current one). Render the
result with `render_png` and `strip: true`, then refine individual frames in PXA.

## 4. Pose by hand

Each frame copies the previous one (`FRAME f2 110 FROM f1`) and changes only what moves:
`ROTATE arm-l -40` turns a bone about its pivot (children follow their joints), `AT body 20 18` moves the root.
Save reusable poses with `POSE crouch "Crouch" body=0 leg-l=40 shin-l=-80 MOVE body 0 3`.

## Timing and principles

- Plan **key poses**, then **breakdowns**, then **in-betweens**; tag frames `KEY` / `BREAKDOWN` / `INBETWEEN`.
- **Anticipation → action → follow-through**: crouch before a jump, overshoot and settle after a swing.
- **Squash & stretch** with `RESIZE` (keep width × height about constant); 1–2 px is plenty at sprite scale.
- **Arcs**: hands, heads and tails move on curves, not straight lines.
- **Ease** with timing: longer durations on extremes (holds), shorter in the middle of fast moves.
- **Overlapping action**: hair, tails and capes lag one frame behind the body.
- Typical durations: idle 150–250 ms, walk 90–120 ms, run 60–80 ms, attack strike 40–60 ms.
- Keep the loop seamless and the ground line fixed; check the strip render frame by frame for popping.
