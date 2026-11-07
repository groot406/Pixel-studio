import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { buildSite, projectDirectory } from './build.mjs';

/** Rebuild in order, including a final pass when files change during a build. */
export function watchSite() {
  let timer;
  let queue = Promise.resolve();
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      queue = queue.then(() => buildSite()).then(() => {
        process.stdout.write('Rebuilt Pixel Studio. Refresh the browser to see changes.\n');
      }).catch(error => process.stderr.write(`Build failed: ${error.message}\n`));
    }, 100);
  };
  const watchers = ['src', 'public'].map(directory => watch(resolve(projectDirectory, directory), { recursive: true }, rebuild));
  return async () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    await queue;
  };
}
