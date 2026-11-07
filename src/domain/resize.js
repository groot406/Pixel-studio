/** Pure maths for resizing an object's on-canvas box with handles. Boxes are canvas pixels: {x, y, width, height}. */
import { MAX_SIZE } from './limits.js';

export const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const clampSize = v => Math.min(MAX_SIZE, Math.max(1, v));

/**
 * The other side of a box whose area is kept: other = round(area / side), at least 1 pixel.
 * This is squash & stretch: halving the height of a 8×8 box gives 16×4, so flattening pushes the artwork sideways.
 */
export function keepAreaSide(area, side) {
  return clampSize(Math.round(area / clampSize(side)));
}

/**
 * New box after dragging `handle` by (dx, dy) whole pixels.
 * - Free: the dragged edges move, the opposite edges stay.
 * - `keepRatio` (corners): the width follows the drag and the height keeps the start ratio, anchored at the opposite corner.
 * - `keepArea`: the dragged side follows the drag and the other side is keepAreaSide(area, side).
 *   Dragging top/bottom (or a corner) keeps the opposite edge fixed and centres the width.
 *   Dragging left/right keeps the opposite edge fixed and the bottom on the ground.
 */
export function resizeBox(box, handle, dx, dy, { keepArea = false, keepRatio = false, area = box.width * box.height } = {}) {
  if (!RESIZE_HANDLES.includes(handle)) throw new Error('Unknown resize handle.');
  const north = handle.includes('n'), south = handle.includes('s'), west = handle.includes('w'), east = handle.includes('e');
  const right = box.x + box.width, bottom = box.y + box.height;
  if (keepArea) {
    if (north || south) {
      const height = clampSize(box.height + (north ? -dy : dy)), width = keepAreaSide(area, height);
      return { x: box.x + Math.floor((box.width - width) / 2), y: north ? bottom - height : box.y, width, height };
    }
    const width = clampSize(box.width + (west ? -dx : dx)), height = keepAreaSide(area, width);
    return { x: west ? right - width : box.x, y: bottom - height, width, height };
  }
  let width = clampSize(box.width + (west ? -dx : east ? dx : 0));
  let height = clampSize(box.height + (north ? -dy : south ? dy : 0));
  if (keepRatio && (north || south) && (west || east)) height = clampSize(Math.round(width * box.height / box.width));
  return { x: west ? right - width : box.x, y: north ? bottom - height : box.y, width, height };
}
