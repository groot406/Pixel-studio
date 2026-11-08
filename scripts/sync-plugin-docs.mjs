import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectDirectory } from './build.mjs';
import { pluginDocsMarkdown } from '../src/plugins/api-doc.js';

/** Regenerate docs/plugins.md from the single API reference in src/plugins/api-doc.js. */
await writeFile(resolve(projectDirectory, 'docs/plugins.md'), pluginDocsMarkdown());
process.stdout.write('Wrote docs/plugins.md.\n');
