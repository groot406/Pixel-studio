export const SIZE = 32;
/**
 * Largest canvas (and part) edge: the browser canvas size at 1× zoom. The real ceiling is the stored-pixel budget
 * below, which keeps memory, undo history and saving fast (one 2048 × 2048 frame, or 64 frames of 256 × 256).
 */
export const MAX_SIZE = 2048;
/** Stored canvas pixels across all cels: 64 cels of 256×256 (or 256 of 128×128). */
export const MAX_TOTAL_PIXELS = 4194304;
/** Pivot pixel range (it may lie outside the box). */
export const PIVOT_MIN = -MAX_SIZE, PIVOT_MAX = 2 * MAX_SIZE;
export const MAX_COLORS = 64;
export const MAX_LAYERS = 320;
export const MAX_ANIMATIONS = 100;
export const MAX_FRAMES_PER_ANIMATION = 256;
export const MAX_TOTAL_FRAMES = 1024;

export function pixelCount(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIZE || height > MAX_SIZE) {
    throw new Error(`Canvas width and height must be whole numbers from 1 to ${MAX_SIZE}.`);
  }
  return width * height;
}
