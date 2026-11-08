import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAIProject } from '../src/formats/pxa.js';
import { runTurn, parseReply, buildPrompt, mergeProjects } from '../src/features/assistant/agent.js';

const PXA = `PXA 2
SIZE 8 8
NAME "Blob"
PAL #000000 #ff0000
LAYER art "Art" 1 0
ANIM idle "Idle" 8
FRAME i1 125 CLEAR
CEL art RASTER
SPAN 2 2 1111
END`;

function editor(pxa = PXA) {
  const log = [];
  let project = decodeAIProject(pxa), view = { animationId: 'idle', frameId: 'i1', layerId: 'art', tool: 'pencil', color: 0 };
  return {
    log,
    project: () => project,
    view: () => view,
    commit: next => { log.push('commit'); project = next; },
    select: v => { view = { ...view, ...v }; },
    openProject: p => { log.push(`open ${p.name}`); project = p; },
    commands: () => [{ key: 'flip-h', title: 'Flip horizontally', description: 'Tool', group: 'Tool', disabled: '' }],
    runCommand: key => { log.push(`run ${key}`); return `Ran ${key}.`; },
    undo: () => log.push('undo'),
    render: async () => 'data:image/png;base64,AAAA',
  };
}

const scripted = replies => {
  const prompts = [];
  return { prompts, ask: async (prompt, images) => { prompts.push({ prompt, images }); return replies.shift(); } };
};

test('a turn runs the requested tools, feeds results back and stops when done', async () => {
  const ctx = editor();
  const walk = `PXA 2\nSIZE 8 8\nNAME "Blob"\nPAL #000000 #ff0000\nLAYER art "Art" 1 0\nANIM hop "Hop" 8\nFRAME h1 100 CLEAR\nCEL art RASTER\nSPAN 2 3 1111\nFRAME h2 100 CLEAR\nCEL art RASTER\nSPAN 2 1 1111\nEND`;
  const model = scripted([
    JSON.stringify({ message: 'Adding a hop.', actions: [{ tool: 'write_pxa', args: { pxa: walk } }, { tool: 'look', args: { animation: 'hop', strip: true } }], done: false }),
    '```json\n{"message": "Added a 2-frame hop.", "done": true}\n```',
  ]);
  const events = [];
  const result = await runTurn({ ctx, ask: model.ask, history: [{ role: 'user', text: 'make it hop' }], onEvent: e => events.push(e.type) });
  assert.equal(result.message, 'Added a 2-frame hop.');
  assert.deepEqual(ctx.project().animations.map(a => a.id), ['idle', 'hop'], 'merged without losing the existing animation');
  assert.equal(result.changes, 1);
  assert.equal(model.prompts.length, 2);
  assert.match(model.prompts[0].prompt, /^PXACHAT 1\n/);
  assert.match(model.prompts[0].prompt, /flip-h \| Flip horizontally/);
  assert.match(model.prompts[1].prompt, /\[write_pxa\] ok: Applied \(merge\)/);
  assert.deepEqual(model.prompts[1].images, ['data:image/png;base64,AAAA'], 'look attaches its render to the next step');
  assert.ok(events.includes('tool'));
});

test('a failed action gets another step even when the model said done', async () => {
  const ctx = editor();
  const model = scripted([
    JSON.stringify({ message: 'Rigging.', actions: [{ tool: 'animate', args: { template: 'walk' } }], done: true }),
    JSON.stringify({ message: 'It needs parts first.', actions: [{ tool: 'run_command', args: { command: 'flip-h' } }] }),
  ]);
  const result = await runTurn({ ctx, ask: model.ask, history: [] });
  assert.match(model.prompts[1].prompt, /\[animate\] ERROR: This project has no skeleton/);
  assert.equal(result.message, 'It needs parts first.');
  assert.deepEqual(ctx.log, ['run flip-h']);
});

test('replies are read leniently and plain answers end the turn', () => {
  assert.deepEqual(parseReply('Sure! {"message":"Hi {there}","actions":[]} trailing'), { message: 'Hi {there}', actions: [], done: true });
  assert.deepEqual(parseReply('Just text'), { message: 'Just text', actions: [], done: true });
  assert.equal(parseReply('{"message":"x","actions":[{"tool":"look"}]}').done, true);
  assert.equal(parseReply('{"message":"x","actions":[{"tool":"look"}],"done":false}').done, false);
});

test('merging keeps the palette contract and adds new layers to existing frames', () => {
  const ctx = editor();
  assert.throws(() => mergeProjects(ctx.project(), decodeAIProject(PXA.replace('#ff0000', '#00ff00'))), /PAL must repeat/);
  const extra = decodeAIProject(PXA.replace('LAYER art "Art" 1 0', 'LAYER art "Art" 1 0\nLAYER fx "FX" 1 0').replace('ANIM idle', 'ANIM spin').replace(/FRAME i1/, 'FRAME s1'));
  const merged = mergeProjects(ctx.project(), extra);
  assert.deepEqual(merged.layers.map(l => l.id), ['art', 'fx']);
  assert.equal(merged.animations[0].frames[0].cels.length, 2);
  assert.match(buildPrompt({ ...ctx, project: () => merged }, { history: [{ role: 'user', text: 'hi' }] }), /USER: hi/);
});
