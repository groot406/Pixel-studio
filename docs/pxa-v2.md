# PXA 2

PXA 2 combines reusable pixel-art parts with raster cels and a scoped AI patch protocol. PXA 1 remains supported. The file version and internal project version are separate: PXA 2 loads into project schema 3.

The editor's **Objects** panel lists shared part instances and pixel artwork. Optional groups replace visible layer controls; existing layers open as groups. Object edits default to the current animation, with a current-frame option. Use Object (**V**) to select and drag an instance on the main canvas; double-click it or press Enter to open the shared artwork editor. Paint, erase or fill in part coordinates, inspect any frame in the full-sprite preview, then **Apply to all instances**. That Apply is one project Undo step. The editor has separate draft Undo/Redo and Cancel. Locked references disable shared Apply. Main-canvas painting remains local pixel editing.

For cohesive artwork, edit overlaps while looking at the full-sprite preview. **Outline artwork** outlines the combined visible silhouette in every frame; it does not invent separate contours for each part. Existing outlines baked into part pixels are preserved and can be edited in the shared editor. The outline command creates raster artwork and must be regenerated after silhouette changes.

## Try it

Run `npm start`, load **Golden Key · reusable parts**, and open **Reusable parts** beneath Layers. The key body is shared by five frames; the glint and sparkle are separate reusable parts.

- Create a part from a rectangular selection or the current layer.
- Place a part in the current frame and change its position or transform.
- **Make instance independent** creates a part copy for that instance.
- Paint the part preview and apply to change its shared definition. References on locked layers prevent shared editing, including hidden references.
- Paint on the main canvas to create local overrides. Explicit erasures survive shared edits and save/reload. Overrides stay in canvas coordinates when a part moves.
- **Flatten this cel** removes its retained source and keeps its pixels. Canvas resizing also bakes retained cels, with a notice before applying. Undo restores the prior structure.

Existing pixel transforms preserve the rendered result using local overrides. Use the Parts controls when the intent is to transform an instance itself. Layer/frame duplication retains independent compositions referencing the same part definitions.

The creation prompt builder defaults to PXA 2 and offers PXA 1. **Edit artwork** uses patches automatically for schema 3 projects. **Edit parts / pixels (PXA 2)** also works on old raster projects. Existing inpaint and palette actions remain available.

## Language and semantics

The complete command reference is generated from `PXA2_GUIDE` in `src/formats/pxa-v2.js` into `public/pxa-v2-format.txt`. Run `npm run formats` after changing it; tests reject drift. The drawing section is shared with AI patch instructions.

PXA 2 uses **x then y**, including SPAN. PXA 1 retains its original **y then x** SPAN order. The version header selects the parser; coordinate order is never guessed.

```text
PXA 2
SIZE 16 16
NAME "Sparkle"
PAL #ffdc70 #ffffff
LAYER effects "Effects" 1 0
PART star 5 5
RECT 2 0 1 5 0
RECT 0 2 5 1 0
SPAN 2 2 1
ENDPART
ANIM idle "Idle" 8
FRAME idle_0 125 CLEAR
CEL effects
USE glint star 3 4
FRAME idle_1 125 FROM idle_0
CEL effects
AT glint 7 4
END
```

Parts contain filled rectangles/ellipses, integer lines, and exact pixel spans. Parts do not contain other parts. Cels contain ordered drawing operations and instances. This keeps reference expansion finite and easy to inspect. Instance placement supports translation, horizontal/vertical flips and clockwise quarter turns (`N FX FY R90 R180 R270 R90FX R270FX`), with the transformed top-left at the placement coordinates. Optional per-instance commands follow the `USE` line (or change an existing instance in a later cel). None of them changes the part; defaults are not stored or written:

- `RESIZE instance-id width height` (1–128) draws the part at that size by nearest-neighbour sampling, measured before the flip/turn. Unequal scaling gives squash and stretch. The part's own size resets it.
- `ROTATE instance-id degrees` (whole degrees, −360…360, stored as −179…180, positive is clockwise, 0 resets) turns the result about its pivot. Exact quarter turns belong in the lossless transform.
- `PIVOT instance-id x y` (integers −128…256) sets the pivot to the centre of pixel x y of the flipped/turned, unrotated box, relative to the `USE` position. `PIVOT instance-id CENTER` resets it to the exact box centre (the default).
- `SKEW instance-id sx sy` (whole degrees, −60…60 each; `0 0` resets) shears about the pivot: x first moves by tan(sx)·(y − pivot y), then y by tan(sy)·(x − pivot x).
- `TILT instance-id x y [PERSPECTIVE p]` (whole degrees, −180…180 each; `0 0` resets) is a pseudo-3D turn about the axes lying in the picture, through the pivot. `y` turns about the vertical axis (a door, a coin, a character turning round): the width shrinks by cos(y), at ±90 the object is edge-on and disappears, past 90 its back shows (the artwork mirrored); positive y moves the right side away. `x` tips about the horizontal axis: the height shrinks by cos(x); positive x moves the top away. The plane turns by y, then by x, and is projected as (X, Y)/(1 + k·Z) with k = p/(200·R), R the distance from the pivot to the farthest (skewed) corner: `PERSPECTIVE p` (0–100, default 30, not written when 30) makes the far edge shorter and the near edge taller, 0 is flat. `TILT id 0 180` (or `180 0`) without perspective equals a horizontal (vertical) mirror. Stepping y by 360/n across n frames spins a coin seamlessly.
- `DEFORM instance-id NONE | WAVE X|Y amplitude wavelength phase | BULGE strength | TWIST degrees` bends the box about its centre. `WAVE X` shifts each row y sideways by round(amplitude·sin(360°·y/wavelength + phase)); `WAVE Y` shifts columns vertically (amplitude 1–32, wavelength 2–256, phase 0–359; the box grows by the amplitude). `BULGE` (−100…100) samples radius r^(2^(strength/100)) inside the ellipse fitting the box: positive bulges, negative pinches. `TWIST` (−360…360) turns by degrees·(1 − r): fully at the centre, not at the edge. `NONE`, `BULGE 0` and `TWIST 0` reset. Stepping the wave phase across `FRAME FROM` frames animates flags, water and heat haze with one short line per frame.
- `SAMPLE instance-id NEAREST|ROTSPRITE`. `NEAREST` (default) shows one part pixel per canvas pixel. `ROTSPRITE` upscales the part 8× with three Scale2x (EPX) passes, cached per part, and picks the sub-pixel at each destination pixel centre, so free angles, skew, 3D turns and deforms keep smoother pixel-art edges using only existing palette indices. Without a free angle, skew, 3D turn or deform it equals `NEAREST`. Its 8× image costs 64 rendering work units per part pixel, once per part.

Composition order is resize, then flip/quarter turn, then deform, then skew, then 3D turn (`TILT`), then free rotation about the pivot; rendering inverse-maps each pixel centre through these steps in reverse. `AT`, `TURN`, `SWAP` and the commands above keep the instance's other properties and draw order; frame deltas after `FRAME FROM` write only the commands that changed.

Part references are live: changing the definition updates its instances. `PART copy FROM original` creates an independent definition. Frame `FROM` copies an earlier composition, including across animations; it does not make later frame placements follow edits to an earlier frame. `AT` changes a placement rather than painting translated pixels over an old image.

Transparent pixels in a part leave underlying cel artwork visible. Drawing with transparency erases the selected cel's pixels. Final `OVERRIDE` spans are applied after composition: omitted coordinates have no override, while an explicit dot erases. Lower project layers remain visible through the resulting transparency.

`CEL id RASTER` supports ordinary pixel cels, SPAN deltas and layer-local SHIFT. Export selects between clear frames and previous-frame deltas by text length. It does not infer shared editing intent from identical raster images. Authored source and stable identities are preserved; transport compaction does not invent part links.

`ORDER layer-id layer-id ...` optionally follows `ANIM`, before its first `FRAME`. Include every layer exactly once, bottom to top. Omission uses the `LAYER` declaration order. Each animation can use a different stack with the same shared layer definitions. `FRAME FROM` copies cels without copying the source animation's order. PXA 1 supports the same optional command using layer declaration indices instead of IDs. Older readers without `ORDER` support reject files using this extension. PXS uses versioned raster payload schema 3 for explicit animation orders and still reads legacy schema 2.

`FRAMEORDER layer-id ...` follows a frame declaration before its first `CEL`, overriding only that frame's complete stack. PXA 1 uses declaration indices for the same command. `FRAME FROM` does not inherit frame order. PXS payload schema 4 preserves frame orders and still reads schema 2/3.

`BONE id layer-id instance-id PARENT parent-id|- [JOINT x y] [LIMIT min max] [REST degrees] [NAME "name"]` rigs a skeleton. Bone lines follow the animations, before `END`. A bone is one placed object, identified by its container and instance ID (the same object in every frame). Its joint is the object's `PIVOT`, pinned to point `JOINT x y` on the parent's part, in part pixels (decimals allowed; 0.5 is a pixel centre). Because the joint lives in part space, it follows the parent through moves, turns, flips, resizes and rotation. A root uses `PARENT -` and has no `JOINT`; an omitted `JOINT` is derived from where the child's pivot sits on the parent in the first frame showing both. `LIMIT` bounds the angle relative to the parent (for a root, its own angle). `REST` is the relative rest angle. A frame's pose is simply its `ROTATE`/`AT` values; the editor keeps each child's pivot on its parent's joint. Bones whose object no longer exists are dropped, cycles and orphans become roots, and roots without children are removed. PXA 1 and PXS do not store bones.

`STACK layer-id ROOT|GROUP` optionally follows layer declarations and precedes parts/animations. ROOT exposes a container's objects without a group; GROUP presents an isolated group. Omission preserves the legacy group behavior. `INSTANCE instance-id "name" visible locked` sets an existing `USE` object's metadata. Flags must be 0 or 1. Hidden objects retain their artwork. `AT`, `TURN` and `SWAP` preserve metadata; metadata changes use a full cel snapshot during export. These optional extensions require an updated PXA 2 reader; older files still load without migration loss. PXA 1/PXS bake the visible per-container result and cannot preserve independent instance metadata or optional group presentation.

Original limits remain: 128 × 128 canvas, 64 palette slots, 32 layers and 1,048,576 canvas pixel slots. Additional budgets bound part pixels, source operations and expanded rendering work. Unknown references, invalid IDs, nested parts, invalid geometry, truncated files and excess expansion are rejected.

## Project model and ownership

- `domain/artwork.js` owns operation validation, deterministic rendering, raster translation and local override commits. `domain/geometry.js` holds the existing integer geometry shared with drawing tools.
- `domain/project.js` owns project validation and allocation budgets. Schema 3 has a `parts` library; a cel can have a retained `source` or ordinary pixels. For a retained cel, source is authoritative and validation rebuilds its pixel buffer. Supplied cached pixels cannot override source.
- `domain/parts.js` coordinates explicit extraction, placement, forking, shared painting and flattening.
- `formats/pxa-v2.js` translates text and domain operations. `formats/pxa.js` routes explicit versions and retains the PXA 1 codec.
- `features/ai/composition-edit.js` owns request scope, shared-reference checks and atomic proposals. Rendering and parsing do not depend on AI permission policy.
- The editor's transaction boundary captures changes made by existing pixel tools as local overrides, validates the project, then records one history entry and saves it. Part edits update source directly. Invalid commits restore the preceding project.
- IndexedDB uses its existing record layout. Its project validator now retains schema 3 source, parts and IDs. Undo/Redo snapshots contain both source and the derived buffers.

PXA 2 and native JSON schema 3 preserve structure. PXA 1/PXS exports bake each layer/frame to indexed pixels while preserving its appearance and timing; PNG exports combine visible layers. The export dialog identifies this loss of reusable structure.

## AI patches and visual refinement

`PXAPATCH 2` requires a BASE fingerprint, explicit `TARGET animation frame layer` commands, END, and the request-specific completion marker. A target accepts cel drawing and placement operations. PART blocks replace definitions or fork existing ones. Palette, layer structure, animation structure and timing remain protected by this editing mode.

The host checks every original reference before accepting a shared-part edit, including protected frames and hidden/locked layers. It also compares the resulting protected cels. A local fork plus SWAP is the supported way to make an exception. Fingerprints include source and part definitions, so an invisible structural change also makes an old response stale. Review reports structure changes even if no pixel changes.

Prompts include selected frames and only their required part definitions. Other frames stay in the host for validation. Source data is read-only context; patches cannot expand their own authority.

After a PXA 2 proposal, **Refine with visual preview** optionally requests one further generation using rendered original/proposed contact sheets. At most 16 frames are sampled, including both ends of long animations. Images include only artwork and numbered tiles; the prompt identifies the frame IDs and explains the preview background. The correction still passes the same scope/lock checks, and Apply compares the final proposal with the original project. Failure or cancellation retains the first proposal.

The local bridge accepts at most two inline PNGs, each at most 1 MiB and 1024 × 1024. It creates its own temporary image paths, passes them as `localImage` inputs, then removes them with the session. Browser-supplied paths and remote image URLs are rejected. Model image support comes from the runtime catalog. The existing ChatGPT login route and disabled tool execution remain in place. The input contract is documented in [Codex app-server Turns](https://developers.openai.com/codex/app-server#turns) and was checked against the installed runtime's generated schema.

## Benchmarks

Run `npm run benchmark` for dependency-free byte counts and local decoding timings. It verifies matching rendered artwork before reporting results. The authored Key fixture preserves the original artwork exactly; no AI generation is involved.

Optional token measurement uses an isolated Python environment:

```sh
python3 -m venv /tmp/pixelstudio-tokenizer
/tmp/pixelstudio-tokenizer/bin/pip install tiktoken
npm run benchmark -- --write --tokenizer-python /tmp/pixelstudio-tokenizer/bin/python
```

`--write` refreshes `docs/pxa-v2-benchmark.json` and the authored Key sample. Token counts use [tiktoken's o200k_base encoding](https://github.com/openai/tiktoken) as a reproducible proxy, not the selected Codex model's measured billing. Request IDs in the benchmark are fixed. Timings vary by machine/run; neither file bytes nor decoding speed establish model generation latency.

Recorded proxy token counts:

| File | PXA 1 | PXA 2 | Reduction |
| --- | ---: | ---: | ---: |
| Golden Key, raster | 789 | 658 | 16.6% |
| Campfire, raster | 1,703 | 1,851 | -8.7% |
| Panda, raster | 1,985 | 1,713 | 13.7% |
| Red Panda, raster | 3,902 | 3,741 | 4.1% |
| Golden Key, authored parts | 789 | 608 | 22.9% |
| Sparkle, authored parts | 600 | 218 | 63.7% |

For moving the key one pixel right in one frame:

| Workflow | Input tokens | Output tokens | Total |
| --- | ---: | ---: | ---: |
| PXA 1 full-frame edit | 1,529 | 335 | 1,864 |
| Existing inpaint | 1,076 | 419 | 1,495 |
| PXA 2 instance patch | 936 | 44 | 980 |

The patch uses 47.4% fewer total text tokens than a full-frame edit and 34.4% fewer than inpainting on this fixture. Source files are not universally smaller: the campfire is a counterexample. Visual refinement adds an image-bearing generation and is excluded from these text-only measurements. No live model-quality or generation-latency improvement has been measured.

## Verification

`npm run check` covers syntax, Node behavioral/contract tests and the production build. Tests cover the original samples, exact v1/v2/PXS rendering, source persistence, local erasures, independent copies, transform geometry, budget boundaries, shared edits into hidden locked cels, stale/truncated patches, image transport and subprocess cleanup.

Browser checks cover part movement, frame isolation, Undo/Redo, main-canvas painting, shared painting, local override precedence, save/reload and exact v1 export. AI generation is tested with deterministic responses and a fake subprocess; it does not consume model allowance.

Nested parts, tweening, per-instance palette remapping and automatic semantic decomposition are outside this initial version. Existing artwork can remain raster or be explicitly extracted into parts.
