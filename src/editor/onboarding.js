/**
 * Onboarding content and pure logic: the keyboard shortcut map (also drives the editor's tool keys), guided tour
 * steps, rich tooltip texts, first-use hints, "What's new", progress storage and card placement. No DOM access, so
 * tests can import it; tour.js and help-center.js render it.
 */

export const ONBOARDING_KEY = 'pixel-studio.onboarding.v1';
export const DOCS_URL = 'https://github.com/groot406/Pixel-studio';

export const SHORTCUT_GROUPS = [['tools', 'Tools'], ['editing', 'Editing'], ['frames', 'Frames & playback'], ['view', 'View'], ['modes', 'Modes']];

/** Every keyboard shortcut. Entries with `tool` are the toolbox keys the editor listens for (see TOOL_KEYS). */
export const SHORTCUTS = [
  { keys: 'V', action: 'Select / move objects', group: 'tools', tool: 'object' },
  { keys: 'K', action: 'Transform: resize, squash, rotate, flip', group: 'tools', tool: 'resize' },
  { keys: 'B', action: 'Pencil', group: 'tools', tool: 'pencil' },
  { keys: 'E', action: 'Eraser', group: 'tools', tool: 'eraser' },
  { keys: 'L', action: 'Straight line', group: 'tools', tool: 'line' },
  { keys: 'P', action: 'Curve / path', group: 'tools', tool: 'curve' },
  { keys: 'F', action: 'Flood fill', group: 'tools', tool: 'fill' },
  { keys: 'N', action: 'Gradient', group: 'tools', tool: 'gradient' },
  { keys: 'U', action: 'Replace color', group: 'tools', tool: 'replace' },
  { keys: 'I', action: 'Eyedropper', group: 'tools', tool: 'eyedropper' },
  { keys: 'R', action: 'Rectangle / square', group: 'tools', tool: 'rectangle' },
  { keys: 'C', action: 'Ellipse / circle', group: 'tools', tool: 'ellipse' },
  { keys: 'S', action: 'Select / move pixels', group: 'tools', tool: 'select' },
  { keys: 'W', action: 'Magic wand · Shift adds, Alt subtracts', group: 'tools', tool: 'wand' },
  { keys: 'T', action: 'Dither brush', group: 'tools', tool: 'dither' },
  { keys: 'H', action: 'Shade along palette ramps · right-click reverses', group: 'tools', tool: 'shade' },
  { keys: '[ / ]', action: 'Smaller / larger brush', group: 'tools' },
  { keys: 'Alt', action: 'Hold to pick a color with any tool', group: 'tools' },
  { keys: '⌘/Ctrl + Z', action: 'Undo', group: 'editing' },
  { keys: '⌘/Ctrl + ⇧ + Z', action: 'Redo (also ⌘/Ctrl + Y)', group: 'editing' },
  { keys: '⇧ + L', action: 'Lock transparency: drawing only recolours existing pixels', group: 'editing' },
  { keys: 'Esc', action: 'Deselect pixels (drawing tools stay inside a selection)', group: 'editing' },
  { keys: '⌘/Ctrl + A', action: 'Select all pixels (all objects with Object or Transform)', group: 'editing' },
  { keys: '⌘/Ctrl + C / X / V', action: 'Copy / cut / paste pixels, or the selected object', group: 'editing' },
  { keys: '⌘/Ctrl + ⇧ + V', action: 'Paste object as an independent copy', group: 'editing' },
  { keys: '⌘/Ctrl + D', action: 'Duplicate selected object', group: 'editing' },
  { keys: '⌘/Ctrl + G', action: 'Make object from selection', group: 'editing' },
  { keys: '⌘/Ctrl + S', action: 'Export pixel data', group: 'editing' },
  { keys: 'Arrows / ⇧ + arrows', action: 'Nudge selection or object by 1 / 8 pixels', group: 'editing' },
  { keys: 'Delete', action: 'Clear selected pixels or delete the object', group: 'editing' },
  { keys: 'Enter / Esc', action: 'Deselect pixels (Esc also deselects objects)', group: 'editing' },
  { keys: ', / .', action: 'Turn selected objects 90° (Transform)', group: 'editing' },
  { keys: '⇧ + click', action: 'Straight pencil / eraser line from the last point; add objects to the selection', group: 'editing' },
  { keys: '⇧ + drag', action: 'Square, circle or 45° line', group: 'editing' },
  { keys: '⌘/Ctrl + K', action: 'Command palette: search actions and plugin commands', group: 'editing' },
  { keys: '⌘/Ctrl + J', action: 'Assistant: ask about or change the project in chat', group: 'editing' },
  { keys: '⌥/Alt + W · ⌥/Alt + ⇧ W', action: 'Close tab · close other tabs (right-click a tab for more)', group: 'editing' },
  { keys: '⌥/Alt + ⇧ T', action: 'Reopen the last closed tab', group: 'editing' },
  { keys: '← / →', action: 'Previous / next frame', group: 'frames' },
  { keys: 'D', action: 'Duplicate frame (all selected frames)', group: 'frames' },
  { keys: 'M', action: 'Mark frame: key → breakdown → in-between → none', group: 'frames' },
  { keys: '⌥/Alt + ← / →', action: 'Jump to the previous / next key pose', group: 'frames' },
  { keys: '⇧ / Ctrl + click frame', action: 'Select a range / several frames (right-click for timing)', group: 'frames' },
  { keys: 'Drag bar edge (Timing view)', action: 'Change duration · Alt snaps to whole frames · ⇧ all selected', group: 'frames' },
  { keys: 'Space (tap)', action: 'Play / pause the preview', group: 'frames' },
  { keys: 'G', action: 'Toggle pixel grid', group: 'view' },
  { keys: 'O / ⇧ O', action: 'Onion skin on / off · onion settings', group: 'view' },
  { keys: 'Hold Space + drag', action: 'Grab and move the canvas view (or drag with the middle mouse button)', group: 'view' },
  { keys: '+ / −', action: 'Zoom in / out', group: 'view' },
  { keys: '⌘/Ctrl + scroll', action: 'Zoom at the pointer (also Alt + scroll, or pinch a trackpad)', group: 'view' },
  { keys: '0', action: 'Fit canvas to view', group: 'view' },
  { keys: '⌘/Ctrl + ⌥/Alt + 1–9', action: 'Switch workspace view (Draw, Animate, Rig…; View menu to customise)', group: 'view' },
  { keys: '?', action: 'Help, tours and this shortcut sheet', group: 'view' },
  { keys: 'J', action: 'Skeleton mode on / off', group: 'modes' },
  { keys: 'Q', action: 'Describe a motion: “wave twice”, “bounce 3 times”', group: 'modes' },
  { keys: 'Enter', action: 'Apply a motion mode · leave Skeleton mode · apply a curve', group: 'modes' },
  { keys: 'Esc', action: 'Cancel a motion mode or curve', group: 'modes' },
  { keys: 'D (Skeleton)', action: 'New key frame', group: 'modes' },
  { keys: '← / → (Skeleton)', action: 'Previous / next frame while posing', group: 'modes' },
  { keys: 'Backspace (Path)', action: 'Remove the last path point', group: 'modes' },
  { keys: '⌘/Ctrl + Enter', action: 'Apply edits to an object edited on the canvas (Esc cancels)', group: 'modes' },
];

/** Single-letter tool keys: { b: 'pencil', … }. */
export const TOOL_KEYS = Object.fromEntries(SHORTCUTS.filter(s => s.tool).map(s => [s.keys.toLowerCase(), s.tool]));

const keyTokens = keys => keys.toLowerCase().split(/[\s+/]+/).filter(Boolean);
/**
 * Shortcuts grouped for the sheet, filtered by `query`: every word must match. One-character words match a key
 * exactly (so "b" finds the Pencil, not every action with a b); longer words also match the action text.
 */
export function groupShortcuts(query = '', list = SHORTCUTS) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const labels = Object.fromEntries(SHORTCUT_GROUPS);
  const matches = s => words.every(w => keyTokens(s.keys).includes(w) || (w.length > 1 && `${s.keys} ${s.action} ${labels[s.group]}`.toLowerCase().includes(w)));
  return SHORTCUT_GROUPS.map(([id, label]) => ({ id, label, items: list.filter(s => s.group === id && matches(s)) })).filter(g => g.items.length);
}

/**
 * Guided tours. A step's `target` is a CSS selector (null: centred card); `fallback` is used when the target is not
 * on screen; steps whose targets cannot be shown are skipped.
 */
export const TOURS = [
  { id: 'basics', title: 'Basics', summary: 'Canvas, tools, palette, frames and saving', steps: [
    { target: '#canvas-stage', title: 'Your canvas', demo: 'zoom', text: 'Draw here with the active tool; right-click erases. Zoom with + and − (or the buttons below the canvas), and 0 fits it to the view.' },
    { target: '.tool-grid', title: 'Toolbox', demo: 'pencil', text: 'Every tool has a one-key shortcut in its corner. Hover a tool for a quick demo; its options (size, mirror, anti-alias…) appear underneath.' },
    { target: '.palette-section', title: 'Colour palette', demo: 'palette', text: 'Click a swatch to paint with it. Editing a colour recolours it in every frame; right-click a swatch for more, or open Palette studio.' },
    { target: '.timeline', title: 'Frames', demo: 'frames', text: 'Frames play left to right, each with its own duration. D duplicates, ← → step. In the Timing view drag a frame’s edge to retime it; right-click to ease or mark keys.' },
    { target: '#edit-scope', title: 'The Edit switch', demo: 'scope', text: 'All frames repeats strokes and object moves in every frame; This frame keeps them to this one; Selected uses the frames you Shift/Ctrl-click in the timeline.' },
    { target: '.objects-section', title: 'Objects', demo: 'move', text: 'Artwork lives in objects. With the Object tool (V), click one to select it and drag to move it; double-click to edit its pixels in place.' },
    { target: '.preview-section', title: 'Live preview', demo: 'preview', text: 'Your animation plays here while you draw. Switch animations under the preview, change the FPS, or press Space to pause.' },
    { target: '#save-status', title: 'Autosave & history', text: 'Work saves itself on this device; this status shows when. Click it (or History) to save named versions and restore older ones.' },
    { target: '#export-button', title: 'Export', demo: 'export', text: 'PNG images, sprite sheets, GIF/APNG animations, or editable .pxa / .pxs files to keep working elsewhere.' },
    { target: '#help-button', title: 'Help is one key away', text: 'Press ? any time for every shortcut, more tours (objects, animation, skeletons, colour, effects) and what’s new.' },
  ] },
  { id: 'objects', title: 'Objects & parts', summary: 'Select, move, reuse and transform artwork', steps: [
    { target: '[data-tool="object"]', title: 'Object tool (V)', demo: 'move', text: 'Click artwork to select its object, Shift-click for several, then drag to move or nudge with the arrow keys. Double-click edits it in place.' },
    { target: '#object-list', title: 'Objects list', text: 'Every object in this frame, top to bottom. Drag rows to reorder or drop them into a group; right-click a row for its menu.' },
    { target: '[data-tool="wand"]', title: 'Make your own objects', demo: 'wand', text: 'Select pixels with Select (S) or the Magic wand (W), then press Make object (⌘/Ctrl G) to turn them into a movable, reusable part.' },
    { target: '.parts-section', title: 'Parts', demo: 'move', text: 'Parts are reusable artwork. Drag one onto the canvas to place another copy; editing a part updates every copy.' },
    { target: '#manage-parts', fallback: '#open-part-library', title: 'Part library', text: 'Browse every part, place it in this frame or the whole animation, and rotate or flip placed copies.' },
    { target: '[data-tool="resize"]', title: 'Transform (K)', demo: 'transform', text: 'Resize, squash and stretch, rotate (Shift snaps to 15°) and 3D-turn objects with handles; , and . turn 90°. The shared artwork never changes.' },
    { target: '#edit-scope', title: 'Where changes land', demo: 'scope', text: 'Object moves and transforms follow the Edit switch: every frame of the animation, this frame only, or the frames selected in the timeline.' },
  ] },
  { id: 'animate', title: 'Animate (motion modes)', summary: 'Moves, bounces, follow-through, waves and smears', steps: [
    { target: '.animate-section', title: 'Animate panel', text: 'Pick a motion, then work right on the canvas. The rows unlock once the frame has a placed object (drag one in from Parts).' },
    { target: '#animate-describe', title: 'Describe a motion (Q)', demo: 'preview', text: 'Type “make him wave twice” or “bounce 3 times, then spin”. It becomes rig, template and maths steps with a live preview. Ask AI handles the rest.' },
    { target: '#animate-tween', title: 'Animate a move', demo: 'tween', text: 'Drag the end ghost to where the object should go and bend the path with the round mid handle; the bar sets frames and easing.' },
    { target: '#animate-squash', title: 'Bounce · squash & stretch', demo: 'bounce', text: 'Build a looping bounce from a single frame, or add squash and stretch to an existing move. The area stays the same.' },
    { target: '#animate-follow', title: 'Follow-through & IK', demo: 'follow', text: 'Follow-through makes tails, hair and capes lag behind what they hang from. IK limb: click shoulder and elbow, then drag the hand.' },
    { target: '#animate-wave', title: 'Wave & 3D spin', demo: 'wave', text: 'Ripple a flag, water or hair, or spin a coin and flip a card. Both dialogs preview the result live before you apply.' },
    { target: '#animate-smear', title: 'Smear frames', text: 'One click inserts a motion-trail frame of the selected object towards the next frame.' },
    { target: '#motion-bar', fallback: '#canvas-stage', title: 'Apply or cancel', text: 'While a mode is open its bar sits over the canvas and the Live Preview plays the result. Enter applies as one undo step; Esc cancels.' },
  ] },
  { id: 'skeleton', title: 'Skeleton & poses', summary: 'Rig parts into bones, pose and in-between', steps: [
    { target: '#animate-skeleton', title: 'Skeleton rig (J)', demo: 'skeleton', text: 'Join placed parts into bones, then pose them like a puppet. Try it on the “Stick puppet · skeleton” example from New project.' },
    { target: '#rig-bar', fallback: '#canvas-stage', title: 'Rig step', demo: 'rig', text: 'Click a child part (an upper arm), then its parent (the torso) right where they join. The joint becomes the child’s pivot.' },
    { target: '#canvas-stage', title: 'Pose step', demo: 'skeleton', text: 'Drag a part to rotate it at its joint; drag a hand or foot to reach with IK. Posing changes this frame unless the Edit switch says All frames.' },
    { target: '.timeline', title: 'Key poses & in-betweens', demo: 'frames', text: 'New key frame (D) copies the frame to pose the next key; In-between… fills and marks the frames between keys (◆ key, • in-between). M marks a frame, Alt ←/→ jumps keys.' },
    { target: '#rig-bar', fallback: '#animate-skeleton', title: 'Poses, templates & retarget', demo: 'preview', text: 'The skeleton bar saves poses as cards, builds walk, run, jump, idle, wave and hover cycles (Templates…) and copies motion between characters (Retarget…).' },
  ] },
  { id: 'colour', title: 'Colour', summary: 'Palette studio, shading ramps and anti-aliasing', steps: [
    { target: '#palette-grid', title: 'Your palette', demo: 'palette', text: 'Click a swatch to paint with it; right-click for more. Changing a colour (picker or hex) updates it everywhere, and Swap exchanges two colours.' },
    { target: '#palette-studio', title: 'Palette studio', demo: 'wheel', text: 'Harmonies on a hue wheel, hue-shifted shades and tints, popular pixel-art palettes (PICO-8, Sweetie 16, Endesga…) and an analysis of yours.' },
    { target: '#shading-ramp', title: 'Shading ramp', demo: 'ramp', text: 'Adds a hue-shifted ramp of darker and lighter colours around the active colour, ready for shading.' },
    { target: '[data-tool="shade"]', title: 'Shade brush (H)', demo: 'shade', text: 'Steps each pixel one colour along its own palette ramp: darker by default, right-click goes the other way.' },
    { target: '[data-tool="gradient"]', title: 'Gradient (N)', demo: 'gradient', text: 'Drag to fill with palette colours: linear, radial, diamond or angle, as hard bands or dithered.' },
    { target: '[data-tool="curve"]', title: 'Anti-aliasing', demo: 'aa', text: 'Line, Ellipse and Curve offer Anti-alias: in-between palette colours soften the stair steps. Effects → Smooth jaggies does it for existing art.' },
    { target: '#colour-cycle', title: 'Colour cycle', demo: 'cycle', text: 'Rotate a ramp of palette colours across frames for water, fire and glowing lights.' },
  ] },
  { id: 'effects', title: 'Effects & cleanup', summary: 'Outlines, light, dithering and tidy lines', steps: [
    { target: '.effects-section', title: 'Effects', text: 'Pixel effects for the active pixel object. Each dialog shows a before/after preview, and a selection limits the effect.' },
    { target: '#effect-outline', title: 'Outlines', demo: 'outline', text: 'Outline adds one colour; Selective outline darkens each fill’s own edge; Auto outline picks the darkest colour of each fill’s ramp.' },
    { target: '#effect-rimLight', title: 'Light & shade', demo: 'shade', text: 'Inner glow, Rim light (choose where the light comes from) and Auto shade add bevel shading from your palette ramps.' },
    { target: '#effect-cleanup', title: 'Clean up lines', demo: 'corner', text: 'Removes doubled L-shaped corner pixels from 1 px lines; Smooth jaggies anti-aliases edges with palette colours.' },
    { target: '#effect-check', title: 'Pixel cleanup', text: 'Marks stray pixels, doubled corners, jaggies and banding on the canvas, with a Fix for each stray or corner and Fix all safe.' },
    { target: '#magic-outline', title: 'Live outline', demo: 'outline', text: 'A live outline that follows every edit and animation frame, plus a cleaner that removes baked-in outlines.' },
  ] },
];

/** Rich tooltips: `text: null` shows the element's own (possibly changing) title. */
export const TIPS = [
  { sel: '[data-tool="object"]', name: 'Object', keys: 'V', demo: 'move', text: 'Select objects (Shift-click for several), drag to move. Double-click edits one in place.' },
  { sel: '[data-tool="resize"]', name: 'Transform', keys: 'K', demo: 'transform', text: 'Resize, squash, rotate, 3D-turn and flip objects with handles.' },
  { sel: '[data-tool="pencil"]', name: 'Pencil', keys: 'B', demo: 'pencil', text: 'Draw pixels. Pixel-perfect strokes drop doubled corners; Shift-click draws a line.' },
  { sel: '[data-tool="eraser"]', name: 'Eraser', keys: 'E', text: 'Erase pixels. Right-click erases with the other brushes too.' },
  { sel: '[data-tool="line"]', name: 'Line', keys: 'L', demo: 'aa', text: 'Drag a straight line; Shift snaps to 45°. Options: Clean slopes, Anti-alias.' },
  { sel: '[data-tool="curve"]', name: 'Curve', keys: 'P', demo: 'curve', text: 'Drag a line, then drag it to bend. Path mode draws through clicked points.' },
  { sel: '[data-tool="fill"]', name: 'Fill', keys: 'F', text: 'Fill a connected area with the active colour.' },
  { sel: '[data-tool="gradient"]', name: 'Gradient', keys: 'N', demo: 'gradient', text: 'Drag to fill with palette colours: linear, radial, diamond or angle.' },
  { sel: '[data-tool="replace"]', name: 'Replace', keys: 'U', text: 'Click a colour to replace every match in this frame of the object.' },
  { sel: '[data-tool="eyedropper"]', name: 'Picker', keys: 'I', text: 'Pick a colour from the artwork. Hold Alt to pick with any tool.' },
  { sel: '[data-tool="rectangle"]', name: 'Rectangle', keys: 'R', text: 'Drag a rectangle; Shift makes a square.' },
  { sel: '[data-tool="ellipse"]', name: 'Ellipse', keys: 'C', text: 'Drag an ellipse; Shift makes a circle.' },
  { sel: '[data-tool="select"]', name: 'Select', keys: 'S', demo: 'select', text: 'Drag to select pixels, drag inside to move. Make object turns them into a part.' },
  { sel: '[data-tool="wand"]', name: 'Magic wand', keys: 'W', demo: 'wand', text: 'Click a shape (or colour) to select it; Shift adds, Alt subtracts.' },
  { sel: '[data-tool="dither"]', name: 'Dither', keys: 'T', text: 'Paint a checkerboard pattern with the active colour.' },
  { sel: '[data-tool="shade"]', name: 'Shade', keys: 'H', demo: 'shade', text: 'Step pixels darker along their palette ramp; right-click goes lighter.' },
  { sel: '#animate-skeleton', name: 'Skeleton rig', keys: 'J', demo: 'skeleton', text: 'Join placed parts into bones, then pose them like a puppet.' },
  { sel: '#animate-describe', name: 'Describe a motion', keys: 'Q', demo: 'preview', text: 'Type a motion in plain words, preview it, then apply.' },
  { sel: '#animate-tween', name: 'Animate a move', demo: 'tween', text: 'Drag a ghost to where the object ends; bend the path into an arc.' },
  { sel: '#palette-studio', name: 'Palette studio', demo: 'wheel', text: 'Harmonies, shades, popular palettes and palette analysis.' },
  { sel: '#shading-ramp', name: 'Shading ramp', demo: 'ramp', text: 'Add a hue-shifted ramp around the active colour.' },
  { sel: '#colour-cycle', name: 'Colour cycle', demo: 'cycle', text: 'Animate a colour ramp across frames: water, fire, glowing lights.' },
  { sel: '#edit-scope [data-scope="wide"]', name: 'Edit: all frames', demo: 'scope', text: null },
  { sel: '#edit-scope [data-scope="frame"]', name: 'Edit: this frame', demo: 'scope', text: null },
  { sel: '#edit-scope [data-scope="selected"]', name: 'Edit: selected frames', demo: 'scope', text: 'Strokes and object changes repeat in the frames selected in the timeline (Shift/Ctrl-click frames).' },
  { sel: '#help-button', name: 'Help & tours', keys: '?', text: 'Guided tours, every shortcut, what’s new and the docs.' },
  { sel: '#export-button', name: 'Export', text: 'PNG, sprite sheet, GIF/APNG, or editable .pxa / .pxs files.' },
  { sel: '#import-button', name: 'Import', text: 'Open .pxa, .pxs or JSON projects, PNG images and sprite sheets.' },
  { sel: '#open-version-history', name: 'Version history', text: 'Save named versions, then preview or restore them.' },
  { sel: '#toggle-grid', name: 'Pixel grid', keys: 'G', text: 'Show or hide the grid.' },
  { sel: '#toggle-onion', name: 'Onion skin', keys: 'O', text: 'See nearby frames as faint ghosts while you draw: previous frames red, next frames green. The arrow beside it sets how many, colours and which objects.' },
  { sel: '#toggle-tile', name: 'Tile mode', text: 'Strokes wrap around the edges; the repeat shows around the canvas.' },
  { sel: '#undo', name: 'Undo', keys: '⌘/Ctrl Z', text: 'Step back one change.' },
  { sel: '#redo', name: 'Redo', keys: '⌘/Ctrl ⇧ Z', text: 'Step forward again.' },
  { sel: '#zoom-in', name: 'Zoom in', keys: '+', text: 'Bigger pixels.' },
  { sel: '#zoom-out', name: 'Zoom out', keys: '−', text: 'Smaller pixels.' },
  { sel: '#zoom-fit', name: 'Fit canvas', keys: '0', text: 'Fit the canvas to the view.' },
  { sel: '#timeline-view', name: 'Thumbnails / Timing', text: 'Timing shows each frame as a bar as wide as it lasts. Drag a bar’s right edge to change its duration.' },
  { sel: '#timing-menu', name: 'Timing menu', text: 'Ease in or out, even out, hold, speed up or slow down the selected frames (or all), and loop them in the preview.' },
  { sel: '#onion-settings', name: 'Onion skin settings', keys: '⇧ O', text: 'How many frames before and after, opacity, tinted or true colour, key poses only, and whether to ghost all layers, this layer or the selected object.' },
  { sel: '#duplicate-frame', name: 'Duplicate frame', keys: 'D', text: 'Copy this frame to keep drawing the next one.' },
  { sel: '#play-toggle', name: 'Play / pause', keys: 'Space', text: 'Start or stop the live preview.' },
  { sel: '#magic-outline', name: 'Live outline', demo: 'outline', text: 'A live outline that always follows the artwork; can also strip baked outlines.' },
];

/** One-time hints shown the first time a complex feature opens. */
export const HINTS = {
  motion: { title: 'Motion mode', text: 'Drag the ghosts and handles on the canvas; the bar holds the options and the Live Preview plays the result. Enter applies, Esc cancels.' },
  skeleton: { title: 'Skeleton mode', text: 'Rig: click a child part, then its parent where they join. Pose: drag parts to bend them. Enter or Done leaves.' },
  'palette-studio': { title: 'Palette studio', text: 'Each tab builds colours a different way. Nothing changes your palette until you add or replace colours.' },
  curve: { title: 'Curve tool', text: 'Drag from start to end, then drag the line to bend it (or its round handles). Enter applies, Esc cancels.' },
  floating: { title: 'Floating panel', text: 'Drag the title bar to move it and any edge to resize it. ⇲ docks it back into the sidebar.' },
  'edit-scope': { title: 'Edit switch', text: 'All frames repeats strokes and object moves in every frame of this animation; This frame changes only the current frame; Selected changes the frames picked in the timeline.' },
};

export const WHATS_NEW = [
  { title: 'Describe a motion (Q)', text: 'Type “make him wave twice”, “jump” or “bounce 3 times”: Pixel Studio builds it from rig poses, templates and maths tools, with a preview. Ask AI for anything else.', tour: 'animate' },
  { title: 'Onion skin & timing', text: 'Coloured onion ghosts for several frames, key-pose markers, a Timing view where you drag frame edges, multi-select and ease in/out timing.' },
  { title: 'Version history & crash recovery', text: 'Named versions, automatic snapshots and a “Recover unsaved work” banner after a crash.' },
  { title: 'Curve & path tool (P)', text: 'Bendable Bézier curves and smooth paths, drawn pixel-perfect, with optional fill and anti-aliasing.', tour: 'colour' },
  { title: 'Palette-aware tools', text: 'Shade brush, Auto outline, Smooth jaggies and the Pixel cleanup checker.', tour: 'effects' },
  { title: 'Skeleton rigging', text: 'Bones, IK posing, key frames with in-betweens, a pose library, walk/run templates and retargeting.', tour: 'skeleton' },
  { title: 'Palette studio', text: 'Harmonies, hue-shifted shades, popular palettes and palette analysis.', tour: 'colour' },
  { title: 'Motion modes', text: 'Animate moves, bounces, follow-through, IK limbs, waves, 3D spins and smears right on the canvas.', tour: 'animate' },
  { title: '3D turn & pose', text: 'Turn and tip objects in pseudo-3D, skew and deform them around a pivot.', tour: 'objects' },
  { title: 'Flexible workspace', text: 'Resize the sidebars and Frames panel, minimise frames, and pop panels out as floating windows (⇱).' },
];

export const DOCS = [
  ['Getting started & help', '#getting-started--help'],
  ['Objects & reusable artwork', '#reusable-artwork'],
  ['Animation & maths tools', '#animation--maths-tools'],
  ['Skeleton rigging', '#skeleton-rigging'],
  ['Exporting images and animations', '#exporting-images-and-animations'],
  ['Saving & history', '#saving--history'],
  ['AI editing', '#ai-editing'],
];

/**
 * The next step to show from index `from` moving `dir` (±1): the first whose target (or fallback) `find(selector)`
 * returns truthy, or with no target. Returns { index, selector } (selector null for centred steps) or null at the end.
 */
export function resolveStep(steps, from, dir, find) {
  for (let i = from; i >= 0 && i < steps.length; i += dir) {
    const step = steps[i];
    if (!step.target) return { index: i, selector: null };
    for (const selector of [step.target, step.fallback].filter(Boolean)) if (find(selector)) return { index: i, selector };
  }
  return null;
}

/** Stored onboarding progress; anything malformed falls back to a fresh start. */
export function sanitizeOnboarding(raw) {
  const pick = value => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter(([, v]) => Number.isFinite(v) || v === true));
  return { tours: pick(raw?.tours), hints: pick(raw?.hints), offered: raw?.offered === true, tooltips: raw?.tooltips !== false };
}
export function readOnboarding(storage) {
  try { return sanitizeOnboarding(JSON.parse(storage?.getItem(ONBOARDING_KEY) || 'null')); } catch { return sanitizeOnboarding(null); }
}
/** Read, change and write progress in one step; storage failures keep the in-memory result. */
export function updateOnboarding(storage, change) {
  const data = readOnboarding(storage);
  change(data);
  try { storage?.setItem(ONBOARDING_KEY, JSON.stringify(data)); } catch { /* Private mode: progress just is not remembered. */ }
  return data;
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
/**
 * Place a card of `card` {width,height} next to `target` {left,top,right,bottom} inside `viewport` {width,height}.
 * Tries `order` (default: beside tall targets, above/below wide ones); if no side fits, the card sits inside the
 * viewport's bottom area. Returns {x, y, side, arrow} where arrow is the pointer offset along the card edge.
 */
export function placeCard(target, card, viewport, { gap = 14, margin = 12, order } = {}) {
  const { width: cw, height: ch } = card, { width: vw, height: vh } = viewport;
  if (!target) return { x: Math.round((vw - cw) / 2), y: Math.round((vh - ch) / 2), side: 'center', arrow: 0 };
  const tw = target.right - target.left, th = target.bottom - target.top;
  const sides = order || (th > tw ? ['right', 'left', 'bottom', 'top'] : ['bottom', 'top', 'right', 'left']);
  const room = { right: vw - target.right, left: target.left, bottom: vh - target.bottom, top: target.top };
  const cx = target.left + tw / 2, cy = target.top + th / 2;
  for (const side of sides) {
    const horizontal = side === 'left' || side === 'right';
    if (room[side] < (horizontal ? cw : ch) + gap + margin) continue;
    const x = horizontal ? (side === 'right' ? target.right + gap : target.left - gap - cw) : clamp(cx - cw / 2, margin, vw - cw - margin);
    const y = horizontal ? clamp(cy - ch / 2, margin, vh - ch - margin) : (side === 'bottom' ? target.bottom + gap : target.top - gap - ch);
    const arrow = horizontal ? clamp(cy - y, 16, ch - 16) : clamp(cx - x, 16, cw - 16);
    return { x: Math.round(x), y: Math.round(y), side, arrow: Math.round(arrow) };
  }
  return { x: Math.round(clamp(cx - cw / 2, margin, vw - cw - margin)), y: Math.round(vh - ch - margin), side: 'inside', arrow: 0 };
}
