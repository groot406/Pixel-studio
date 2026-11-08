/**
 * Browser plugin workers: one dedicated Web Worker per plugin, created from a Blob URL that holds the protocol prelude
 * (protocol.js workerMain) followed by the plugin code. Needs `worker-src blob:` when a Content-Security-Policy is set.
 * Returns the endpoint shape PluginHost expects.
 */
export function spawnBrowserWorker(source) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  let worker;
  try { worker = new Worker(url, { name: 'pixel-studio-plugin' }); }
  catch (error) { URL.revokeObjectURL(url); throw new Error(`${error.message} (this page’s security policy may block plugin workers)`); }
  return {
    post: (message, transfer = []) => worker.postMessage(message, transfer),
    terminate: () => { worker.terminate(); URL.revokeObjectURL(url); },
    onMessage: fn => { worker.onmessage = event => fn(event.data); },
    onError: fn => {
      worker.onerror = event => { event.preventDefault?.(); fn(new Error(event.message ? `The plugin crashed: ${event.message}` : 'The plugin worker could not start (blocked by the page’s security policy, or a syntax error in the plugin).')); };
      worker.onmessageerror = () => fn(new Error('The plugin sent data that cannot be read.'));
    },
  };
}
