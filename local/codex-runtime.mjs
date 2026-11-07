import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

const DESKTOP_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

async function canExecute(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Match the installed desktop app's model catalog on macOS. A separately
 * installed CLI can lag behind it. Other installations continue to use PATH.
 * These dependencies are local/test inputs, never browser-controlled options.
 */
export async function resolveCodexCommand({ platform = process.platform, isExecutable = canExecute } = {}) {
  if (platform === 'darwin' && await isExecutable(DESKTOP_CODEX)) return DESKTOP_CODEX;
  return 'codex';
}
