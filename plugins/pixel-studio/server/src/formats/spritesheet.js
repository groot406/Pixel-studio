/** Spritesheets use one animation per row and one frame per column. */
import {
  MAX_COLORS, MAX_SIZE, MAX_TOTAL_PIXELS,
  paletteFromRgba, mapRgbaToPalette, validateProject,
} from '../domain/project.js';

const MAX_ROWS = 100;
const MAX_COLUMNS = 256;
const MAX_FRAMES = 1024;
const MAX_SOURCE_PIXELS = 32 * 1024 * 1024;
const MAX_SOURCE_EDGE = 16384;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return value;
}

function canvasDimension(value, label) {
  positiveInteger(value, label);
  if (value > MAX_SIZE) throw new Error(`${label} must be from 1 to ${MAX_SIZE} pixels.`);
  return value;
}

function nameValue(value, label, limit = 80) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error(`${label} must contain 1–${limit} characters.`);
  }
  return value.trim();
}

function fpsValue(value, label) {
  if (!Number.isFinite(value) || value < 1 || value > 60) {
    throw new Error(`${label} must be from 1 to 60 FPS.`);
  }
  return value;
}

function checkedPalette(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_COLORS) {
    throw new Error(`The spritesheet palette must contain 1–${MAX_COLORS} colors.`);
  }
  return Array.from(value, (color) => {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
      throw new Error('Every spritesheet palette color must be a six-digit hex color, such as #ffcc66.');
    }
    return color.toLowerCase();
  });
}

function safeProduct(a, b, label) {
  const value = a * b;
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is too large.`);
  return value;
}

/**
 * Check sheet geometry before reading or allocating its pixels.
 * Padding is not counted against project allocation limits here: callers can
 * supply smaller per-row frame counts when slicing. Source images share the
 * browser decoder limit of 32 megapixels and 16,384 pixels along either edge.
 * Cell dimensions can exceed MAX_SIZE here to inspect magnified exports;
 * slicing additionally enforces the logical canvas and included-frame limits.
 */
export function inspectSheet(imageWidth, imageHeight, cellWidth, cellHeight) {
  positiveInteger(imageWidth, 'PNG width');
  positiveInteger(imageHeight, 'PNG height');
  positiveInteger(cellWidth, 'Frame width');
  positiveInteger(cellHeight, 'Frame height');
  if (imageWidth % cellWidth !== 0) {
    throw new Error(`PNG width (${imageWidth} px) must be an exact multiple of the frame width (${cellWidth} px).`);
  }
  if (imageHeight % cellHeight !== 0) {
    throw new Error(`PNG height (${imageHeight} px) must be an exact multiple of the frame height (${cellHeight} px).`);
  }
  const rows = imageHeight / cellHeight;
  const columns = imageWidth / cellWidth;
  if (rows > MAX_ROWS) throw new Error(`A spritesheet can contain at most ${MAX_ROWS} animation rows.`);
  if (columns > MAX_COLUMNS) throw new Error(`A spritesheet can contain at most ${MAX_COLUMNS} frame columns.`);
  const frameCount = rows * columns;
  if (imageWidth > MAX_SOURCE_EDGE || imageHeight > MAX_SOURCE_EDGE) {
    throw new Error(`A spritesheet PNG can be at most ${MAX_SOURCE_EDGE.toLocaleString('en-US')} pixels along either edge.`);
  }
  if (imageWidth > MAX_SOURCE_PIXELS / imageHeight) {
    throw new Error(`A spritesheet PNG can contain at most ${MAX_SOURCE_PIXELS.toLocaleString('en-US')} source pixels. Use a smaller sheet.`);
  }
  return { rows, columns, frameCount };
}

function checkFrameBudget(counts, width, height) {
  const frames = counts.reduce((total, count) => total + count, 0);
  if (frames > MAX_FRAMES) {
    throw new Error(`The selected animation rows can contain at most ${MAX_FRAMES.toLocaleString('en-US')} frames in total. Reduce the per-row frame counts.`);
  }
  if (frames * width * height > MAX_TOTAL_PIXELS) {
    throw new Error(`The selected frames can contain at most ${MAX_TOTAL_PIXELS.toLocaleString('en-US')} pixels in total. Reduce the per-row frame counts or frame dimensions.`);
  }
  return frames;
}

function checkedRgba(rgba, imageWidth, imageHeight) {
  const expected = imageWidth * imageHeight * 4;
  if ((!Array.isArray(rgba) && !ArrayBuffer.isView(rgba)) || rgba.length !== expected) {
    throw new Error(`PNG pixel data must contain exactly ${expected.toLocaleString('en-US')} RGBA values for a ${imageWidth} × ${imageHeight} image.`);
  }
  for (let index = 0; index < rgba.length; index += 1) {
    if (!Number.isInteger(rgba[index]) || rgba[index] < 0 || rgba[index] > 255) {
      throw new Error('PNG pixel data must contain only whole RGBA values from 0 to 255.');
    }
  }
}

function rowOptions(value, rows, label) {
  if (!Array.isArray(value) || value.length > rows) {
    throw new Error(`${label} must be an array with at most ${rows} entries, one for each animation row.`);
  }
  return value;
}

function cellHasVisiblePixels(rgba, imageWidth, cellWidth, cellHeight, row, column) {
  for (let y = 0; y < cellHeight; y += 1) {
    const start = ((row * cellHeight + y) * imageWidth + column * cellWidth) * 4;
    for (let x = 0; x < cellWidth; x += 1) {
      if (rgba[start + x * 4 + 3] >= 128) return true;
    }
  }
  return false;
}

/**
 * Slice native-resolution RGBA pixels into an indexed project.
 * Fully transparent cells and empty rows are omitted by default. Set
 * skipEmptyFrames:false to keep deliberately blank frames and animations.
 * Names, per-row FPS, frame counts, and durations refer to SOURCE row/column
 * indices, so filtering never assigns a neighboring frame's timing or name.
 * A supplied palette keeps its order, duplicates, and unused slots; otherwise
 * one global palette is extracted from retained cells and capped at MAX_COLORS.
 *
 * Enlarged exports must first be reduced by metadata.scale with smoothing off.
 * The result is normalized by core validation, including v2 layer migration.
 */
export function sliceSpritesheet(rgba, imageWidth, imageHeight, options = {}) {
  if (!object(options)) throw new Error('Spritesheet import options must be an object.');
  const {
    cellWidth, cellHeight, name = 'Imported spritesheet',
    animationNames = [], frameCounts = [], fps = 8, palette,
    animationFps = [], frameDurations = [], skipEmptyFrames = true,
  } = options;
  canvasDimension(cellWidth, 'Frame width');
  canvasDimension(cellHeight, 'Frame height');
  const { rows, columns } = inspectSheet(imageWidth, imageHeight, cellWidth, cellHeight);
  const projectName = nameValue(name, 'Project name', 120);
  const speed = fpsValue(fps, 'Playback speed');
  if (typeof skipEmptyFrames !== 'boolean') throw new Error('Skip empty frames must be true or false.');
  rowOptions(animationNames, rows, 'Animation names');
  rowOptions(frameCounts, rows, 'Frame counts');
  rowOptions(animationFps, rows, 'Animation playback speeds');
  rowOptions(frameDurations, rows, 'Animation frame durations');
  const names = [];
  const counts = [];
  const speeds = [];
  const durations = [];
  for (let row = 0; row < rows; row += 1) {
    names.push(nameValue(animationNames[row] === undefined ? `Animation ${row + 1}` : animationNames[row], `Animation ${row + 1} name`));
    const count = frameCounts[row] === undefined ? columns : frameCounts[row];
    if (!Number.isInteger(count) || count < 1 || count > columns) {
      throw new Error(`Animation ${row + 1} must contain from 1 to ${columns} frames.`);
    }
    counts.push(count);
    const rowSpeed = fpsValue(animationFps[row] === undefined ? speed : animationFps[row], `Animation ${row + 1} playback speed`);
    speeds.push(rowSpeed);
    const sourceDurations = frameDurations[row] === undefined ? [] : frameDurations[row];
    if (!Array.isArray(sourceDurations) || sourceDurations.length > columns) {
      throw new Error(`Animation ${row + 1} frame durations must be an array with at most ${columns} entries, indexed by source column.`);
    }
    durations.push(Array.from({ length: columns }, (_, column) => {
      const duration = sourceDurations[column] === undefined ? Math.round(1000 / rowSpeed) : sourceDurations[column];
      if (!Number.isInteger(duration) || duration < 1 || duration > 60000) {
        throw new Error(`Frame ${column + 1} in animation ${row + 1} needs a duration from 1 to 60,000 milliseconds.`);
      }
      return duration;
    }));
  }
  // When blanks are retained, the requested counts are already the final counts.
  if (!skipEmptyFrames) checkFrameBudget(counts, cellWidth, cellHeight);
  checkedRgba(rgba, imageWidth, imageHeight);
  let colors = palette === undefined ? undefined : checkedPalette(palette);
  // Inspect alpha before allocating cell buffers or enforcing project limits.
  // Large padded sheets can therefore import a small set of visible frames.
  const selected = [];
  for (let row = 0; row < rows; row += 1) {
    const columnsToKeep = [];
    for (let column = 0; column < counts[row]; column += 1) {
      if (!skipEmptyFrames || cellHasVisiblePixels(rgba, imageWidth, cellWidth, cellHeight, row, column)) {
        columnsToKeep.push(column);
      }
    }
    if (columnsToKeep.length) selected.push({ row, columns: columnsToKeep });
  }
  if (!selected.length) {
    throw new Error('The selected spritesheet frames are all transparent. There are no visible frames to import.');
  }
  const includedFrames = checkFrameBudget(selected.map(({ columns: kept }) => kept.length), cellWidth, cellHeight);
  const cells = [];
  for (const { row, columns: kept } of selected) {
    const frames = [];
    for (const column of kept) {
      const cell = new Uint8ClampedArray(cellWidth * cellHeight * 4);
      for (let y = 0; y < cellHeight; y += 1) {
        const source = ((row * cellHeight + y) * imageWidth + column * cellWidth) * 4;
        const target = y * cellWidth * 4;
        for (let channel = 0; channel < cellWidth * 4; channel += 1) {
          cell[target + channel] = rgba[source + channel];
        }
      }
      frames.push({ column, rgba: cell });
    }
    cells.push({ row, frames });
  }
  if (colors === undefined) {
    const combined = new Uint8ClampedArray(includedFrames * cellWidth * cellHeight * 4);
    let offset = 0;
    for (const { frames } of cells) {
      for (const { rgba: cell } of frames) {
        combined.set(cell, offset);
        offset += cell.length;
      }
    }
    colors = paletteFromRgba(combined, MAX_COLORS);
  }
  return validateProject({
    format: 'pixel-studio',
    version: 1,
    name: projectName,
    width: cellWidth,
    height: cellHeight,
    palette: colors,
    animations: cells.map(({ row, frames }) => ({
      id: `sheet-animation-${row + 1}`,
      name: names[row],
      fps: speeds[row],
      frames: frames.map(({ rgba: cell, column }) => ({
        id: `sheet-frame-${row + 1}-${column + 1}`,
        duration: durations[row][column],
        pixels: mapRgbaToPalette(cell, colors, cellWidth, cellHeight),
      })),
    })),
  });
}

/**
 * Describe the flattened PNG layout and preserve palette order and timing.
 * Layer structure belongs to the project data file, not this PNG sidecar.
 */
export function createSheetMetadata(project, scale = 1) {
  const clean = validateProject(project);
  positiveInteger(scale, 'Export scale');
  const rows = clean.animations.length;
  const columns = Math.max(...clean.animations.map((animation) => animation.frames.length));
  const cellWidth = safeProduct(clean.width, scale, 'Export frame width');
  const cellHeight = safeProduct(clean.height, scale, 'Export frame height');
  const imageWidth = safeProduct(cellWidth, columns, 'Export PNG width');
  const imageHeight = safeProduct(cellHeight, rows, 'Export PNG height');
  inspectSheet(imageWidth, imageHeight, cellWidth, cellHeight);
  return {
    format: 'pixel-studio-spritesheet',
    version: 1,
    name: clean.name,
    width: clean.width,
    height: clean.height,
    cellWidth,
    cellHeight,
    scale,
    rows,
    columns,
    palette: [...clean.palette],
    animations: clean.animations.map((animation) => ({
      name: animation.name,
      fps: animation.fps,
      frameCount: animation.frames.length,
      durations: animation.frames.map((frame) => frame.duration),
    })),
  };
}

/**
 * Validate an optional JSON sidecar against the selected PNG and return only
 * known, copied fields. Source geometry must meet decoder limits. Project
 * allocation limits are checked by sliceSpritesheet after its alpha-based
 * filtering; metadata alone cannot determine how many frames will be retained.
 */
export function validateSheetMetadata(input, pngWidth, pngHeight) {
  if (!object(input) || input.format !== 'pixel-studio-spritesheet' || input.version !== 1) {
    throw new Error('This is not a supported Pixel Studio spritesheet metadata file (version 1).');
  }
  const name = nameValue(input.name, 'Project name', 120);
  const width = canvasDimension(input.width, 'Logical frame width');
  const height = canvasDimension(input.height, 'Logical frame height');
  const scale = positiveInteger(input.scale, 'Spritesheet scale');
  const cellWidth = positiveInteger(input.cellWidth, 'Spritesheet cell width');
  const cellHeight = positiveInteger(input.cellHeight, 'Spritesheet cell height');
  if (cellWidth !== safeProduct(width, scale, 'Spritesheet cell width') || cellHeight !== safeProduct(height, scale, 'Spritesheet cell height')) {
    throw new Error('Spritesheet cell dimensions must equal the logical frame dimensions multiplied by scale.');
  }
  const rows = positiveInteger(input.rows, 'Animation row count');
  const columns = positiveInteger(input.columns, 'Frame column count');
  positiveInteger(pngWidth, 'PNG width');
  positiveInteger(pngHeight, 'PNG height');
  const expectedWidth = safeProduct(cellWidth, columns, 'Expected PNG width');
  const expectedHeight = safeProduct(cellHeight, rows, 'Expected PNG height');
  inspectSheet(expectedWidth, expectedHeight, cellWidth, cellHeight);
  if (pngWidth !== expectedWidth || pngHeight !== expectedHeight) {
    throw new Error(`The metadata describes a ${expectedWidth} × ${expectedHeight} PNG, but the selected image is ${pngWidth} × ${pngHeight}.`);
  }
  const palette = checkedPalette(input.palette);
  if (!Array.isArray(input.animations) || input.animations.length !== rows) {
    throw new Error(`The metadata must describe exactly ${rows} animation rows.`);
  }
  const animations = Array.from(input.animations, (animation, row) => {
    if (!object(animation)) throw new Error(`Animation ${row + 1} metadata must be an object.`);
    const animationName = nameValue(animation.name, `Animation ${row + 1} name`);
    const fps = fpsValue(animation.fps, `“${animationName}” playback speed`);
    const frameCount = animation.frameCount;
    if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > columns) {
      throw new Error(`“${animationName}” must contain from 1 to ${columns} frames.`);
    }
    if (!Array.isArray(animation.durations) || animation.durations.length !== frameCount) {
      throw new Error(`“${animationName}” needs exactly ${frameCount} frame durations.`);
    }
    const durations = Array.from(animation.durations, (duration) => {
      if (!Number.isInteger(duration) || duration < 1 || duration > 60000) {
        throw new Error(`“${animationName}” frame durations must be from 1 to 60,000 milliseconds.`);
      }
      return duration;
    });
    return { name: animationName, fps, frameCount, durations };
  });
  return {
    format: 'pixel-studio-spritesheet', version: 1,
    name, width, height, cellWidth, cellHeight, scale, rows, columns, palette, animations,
  };
}
