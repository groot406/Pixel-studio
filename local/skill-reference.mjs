/** The PXA 2 reference shipped with the pixel-studio agent skill (kept in sync by `npm run formats`). */
import { PXA2_GUIDE } from '../src/formats/pxa-v2.js';

export function skillReference() {
  return `# PXA 2 format reference

Generated from Pixel Studio's format guide by \`npm run formats\`; do not edit by hand.
Write documents exactly in this grammar (plain text, no Markdown fences in the file).

\`\`\`text
${PXA2_GUIDE}
\`\`\`
`;
}
