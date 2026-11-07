import { MAX_AI_FILE_BYTES } from '../../formats/pxa.js';

export const MAX_EDIT_INSTRUCTION_LENGTH = 6000;
export const completionMarkerFor = id => `# PIXEL_STUDIO_EDIT_COMPLETE ${id}`;

export function validateDescription(instruction) {
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > MAX_EDIT_INSTRUCTION_LENGTH) {
    throw new Error(`Describe the edit in 1–${MAX_EDIT_INSTRUCTION_LENGTH.toLocaleString('en-US')} characters.`);
  }
  return instruction.trim();
}

export function* lines(text) {
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n' && text[index] !== '\r') continue;
    yield text.slice(start, index).trim();
    if (text[index] === '\r' && text[index + 1] === '\n') index += 1;
    start = index + 1;
  }
  yield text.slice(start).trim();
}

export function requireCompleteResponse(text, marker) {
  if (typeof text !== 'string') throw new Error('Paste the complete AI pixel-data response as text.');
  if (text.length > MAX_AI_FILE_BYTES) throw new Error('AI pixel data exceeds the 4 MiB text limit.');
  let lastLine = '';
  let markers = 0;
  for (const line of lines(text)) {
    if (line) lastLine = line;
    if (/^#\s*PIXEL_STUDIO_EDIT_COMPLETE(?:\s|$)/.test(line)) markers += 1;
  }
  if (lastLine !== marker || markers !== 1) {
    throw new Error('The AI response is incomplete or belongs to another edit. Include the exact completion comment from this edit prompt as its final line.');
  }
}

