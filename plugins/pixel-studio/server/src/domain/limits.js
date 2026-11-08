export const SIZE = 32;
/** Largest canvas (and part) edge. */
export const MAX_SIZE = 256;
/** Stored canvas pixels across all cels: 64 cels of 256×256 (or 256 of 128×128). */
export const MAX_TOTAL_PIXELS = 4194304;
/** Pivot pixel range (it may lie outside the box). */
export const PIVOT_MIN = -MAX_SIZE, PIVOT_MAX = 2 * MAX_SIZE;
export const MAX_COLORS = 64;
export const MAX_LAYERS = 32;

export function pixelCount(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIZE || height > MAX_SIZE) {
    throw new Error(`Canvas width and height must be whole numbers from 1 to ${MAX_SIZE}.`);
  }
  return width * height;
}
