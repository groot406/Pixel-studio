import { writeFile } from 'node:fs/promises';
import { AI_FORMAT_GUIDE } from '../src/formats/pxa.js';
import { PXA2_GUIDE } from '../src/formats/pxa-v2.js';
import { skillReference } from '../local/skill-reference.mjs';
await writeFile(new URL('../public/pxa-format.txt',import.meta.url),AI_FORMAT_GUIDE+'\n');
await writeFile(new URL('../public/pxa-v2-format.txt',import.meta.url),PXA2_GUIDE+'\n');
await writeFile(new URL('../skills/pixel-studio/reference/pxa2-format.md',import.meta.url),skillReference());
import { buildPlugin } from './build-plugin.mjs';
await buildPlugin();
