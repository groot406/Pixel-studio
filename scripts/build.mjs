import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const projectDirectory = fileURLToPath(new URL('../', import.meta.url));

/** Keep native browser modules and original assets intact; dist is disposable. */
export async function buildSite(destination = resolve(projectDirectory, 'dist')) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(resolve(projectDirectory, 'public'), destination, { recursive: true });
  await cp(resolve(projectDirectory, 'src'), resolve(destination, 'src'), { recursive: true });
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildSite();
  process.stdout.write('Built Pixel Studio into dist/.\n');
}
