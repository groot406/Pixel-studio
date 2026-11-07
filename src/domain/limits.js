export const SIZE = 32;
export const MAX_SIZE = 128;
export const MAX_TOTAL_PIXELS = 1048576;
export const MAX_COLORS = 64;
export const MAX_LAYERS = 32;

export function pixelCount(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIZE || height > MAX_SIZE) {
    throw new Error(`Canvas width and height must be whole numbers from 1 to ${MAX_SIZE}.`);
  }
  return width * height;
}
