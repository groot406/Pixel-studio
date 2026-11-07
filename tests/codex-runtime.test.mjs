import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexCommand } from '../local/codex-runtime.mjs';

test('macOS uses the desktop runtime for the current model catalog', async () => {
  const inspected = [];
  const command = await resolveCodexCommand({ platform: 'darwin', isExecutable: async path => { inspected.push(path); return true; } });
  assert.equal(command, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex');
  assert.deepEqual(inspected, [command]);
});

test('macOS without an executable desktop runtime falls back to the installed CLI', async () => {
  assert.equal(await resolveCodexCommand({ platform: 'darwin', isExecutable: async () => false }), 'codex');
});

test('other platforms keep using PATH without inspecting macOS application directories', async () => {
  for (const platform of ['linux', 'win32']) {
    assert.equal(await resolveCodexCommand({ platform, isExecutable: async () => { assert.fail('Unexpected desktop lookup'); } }), 'codex');
  }
});
