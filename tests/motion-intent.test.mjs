import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodePXA2 } from '../src/formats/pxa-v2.js';
import { runMotionPlan, normalizePlan, describeStep, motionTargets, resolveTarget } from '../src/domain/motion-intent.js';
import { parseMotionText } from '../src/domain/motion-phrases.js';
import { buildMotionPrompt, parseMotionResponse } from '../src/features/ai/motion-prompt.js';

const load = async name => decodePXA2(await readFile(new URL(`../public/samples/${name}.pxa`, import.meta.url), 'utf8'));
const [puppet, key] = await Promise.all([load('puppet'), load('key-v2')]);
const ctx = p => ({ animationId: p.animations[0].id, frameId: p.animations[0].frames[0].id });
const run = (p, steps, opts = {}) => { const out = runMotionPlan(p, { steps }, { ...ctx(p), ...opts }); return { ...out, animation: out.project.animations.find(a => a.id === out.animationId) }; };
const opIn = (frame, id) => frame.cels.flatMap(c => c.source?.ops || []).find(o => o.type === 'use' && o.id === id);
const keyId = motionTargets(key, ctx(key)).objects[0].instanceId;
const xs = (r, id) => r.animation.frames.map(f => opIn(f, id).x);
const ys = (r, id) => r.animation.frames.map(f => opIn(f, id).y);

test('motion targets list objects, characters with roles, bones and poses', () => {
  const t = motionTargets(puppet, ctx(puppet));
  assert.equal(t.characters[0].rootBoneId, 'body');
  assert.equal(t.characters[0].roles.head, 'head');
  assert.ok(t.bones.some(b => b.id === 'arm-r' && b.role === 'upperArmR'));
  assert.ok(t.poses.some(p => p.name === 'Kick'));
  const scene = t;
  assert.equal(resolveTarget(scene, 'him', { want: 'character', project: puppet }).boneId, 'body');
  assert.equal(resolveTarget(scene, 'his head', { want: 'bone' }).boneId, 'head');
  assert.equal(resolveTarget(scene, 'left hand', { want: 'bone' }).boneId, 'hand-l');
  assert.equal(resolveTarget(motionTargets(key, ctx(key)), 'the key').instanceId, keyId);
  assert.throws(() => resolveTarget(scene, 'banana'), /No object, part or bone called “banana”.*Try/);
});

test('template ops build rig cycles in a new animation and leave the source untouched', () => {
  const before = JSON.stringify(puppet);
  const wave = run(puppet, [{ op: 'template', name: 'wave', times: 2 }]), walk = run(puppet, [{ op: 'template', name: 'walk', frames: 8 }]);
  assert.equal(walk.animation.frames.length, 8);
  assert.equal(wave.animation.frames.length, 2 * run(puppet, [{ op: 'template', name: 'wave' }]).animation.frames.length);
  assert.equal(wave.project.animations.length, puppet.animations.length + 1);
  assert.equal(JSON.stringify(puppet), before);
  const angles = wave.animation.frames.map(f => opIn(f, 'arm-r').angle ?? 0).concat(wave.animation.frames.map(f => opIn(f, 'arm-l').angle ?? 0));
  assert.ok(new Set(angles.map(a => Math.round(a))).size > 2, 'an arm swings');
  const jump = run(key, [{ op: 'template', name: 'jump' }]);
  assert.match(jump.warnings[0], /no skeleton/);
  assert.ok(Math.min(...ys(jump, keyId)) < ys(jump, keyId)[0], 'falls back to a bounce');
});

test('bounce, move, spin, turn, rotate and hold ops on an object', () => {
  const bounce = run(key, [{ op: 'bounce', height: 6, times: 3 }]);
  assert.equal(bounce.animation.frames.length, 24);
  assert.equal(Math.min(...ys(bounce, keyId)), opIn(key.animations[0].frames[0], keyId).y - 6);
  const move = run(key, [{ op: 'move', target: 'key', by: { x: 6, y: 0 } }]);
  assert.equal(xs(move, keyId).at(-1) - xs(move, keyId)[0], 6);
  const to = run(key, [{ op: 'move', target: 'key', to: { x: 4 } }]);
  assert.equal(ys(to, keyId).at(-1), ys(to, keyId)[0], 'a partial "to" keeps the other axis');
  const spin = run(key, [{ op: 'spin', target: 'the key', frames: 6 }]);
  assert.ok(spin.animation.frames.length >= 5);
  const rot = run(key, [{ op: 'rotate', degrees: 360, frames: 8 }]);
  assert.ok(rot.animation.frames.some(f => Math.abs(Math.abs(opIn(f, keyId).angle) - 180) < 1), 'a full turn passes 180°');
  const turn = run(key, [{ op: 'turn', degrees: 180 }]);
  assert.ok(turn.animation.frames.length > 2);
  const hold = run(key, [{ op: 'bounce' }, { op: 'hold', frames: 3 }]);
  assert.equal(hold.animation.frames.length, 8 + 3);
});

test('rig ops: rotate a bone, pose, reach, shake', () => {
  const nod = run(puppet, [{ op: 'rotate', target: 'head', degrees: 12, yoyo: true, frames: 3 }], { mode: 'append' });
  const head = nod.animation.frames.map(f => opIn(f, 'head').angle ?? 0), base = head[0];
  assert.ok(Math.max(...head.map(a => Math.abs(a - base))) > 11);
  assert.ok(Math.abs(head.at(-1) - base) < 1e-6, 'yoyo comes back');
  const pose = run(puppet, [{ op: 'pose', name: 'kick', yoyo: true }]);
  assert.ok(pose.animation.frames.length >= 6);
  const reach = run(puppet, [{ op: 'reach', target: 'right hand', by: { x: 4, y: -10 } }]);
  assert.notDeepEqual(opIn(reach.animation.frames.at(-1), 'arm-r'), opIn(reach.animation.frames[0], 'arm-r'));
  assert.ok(run(puppet, [{ op: 'shake', target: 'head' }]).animation.frames.length > 4);
  assert.throws(() => run(puppet, [{ op: 'pose', name: 'moonwalk' }]), /Step 1 \(Pose “moonwalk”\)/);
});

test('chaining, repeat, squash and the apply modes', () => {
  const chain = run(key, [{ op: 'move', target: 'key', by: { x: 6, y: 0 } }, { op: 'move', target: 'key', by: { x: 0, y: 4 } }]);
  assert.deepEqual([xs(chain, keyId).at(-1) - xs(chain, keyId)[0], ys(chain, keyId).at(-1) - ys(chain, keyId)[0]], [6, 4]);
  const once = run(key, [{ op: 'move', by: { x: 6, y: 0 }, yoyo: true }]).animation.frames.length;
  const rep = run(key, [{ op: 'move', by: { x: 6, y: 0 }, yoyo: true }, { op: 'repeat', times: 3 }]);
  assert.ok(rep.animation.frames.length >= 3 * (once - 1));
  assert.equal(rep.summary[1].label, 'Repeat ×3');
  const sq = run(key, [{ op: 'move', by: { x: 6, y: 0 } }, { op: 'squash', strength: 1 }]);
  assert.ok(sq.animation.frames.some(f => opIn(f, keyId).width), 'squash scales frames');
  const n = key.animations[0].frames.length;
  const append = run(key, [{ op: 'bounce' }], { mode: 'append' });
  assert.equal(append.animationId, key.animations[0].id);
  assert.equal(append.animation.frames.length, n + 8);
  const replace = run(key, [{ op: 'bounce' }], { mode: 'replace' });
  assert.equal(replace.animation.frames.length, 8);
  assert.equal(replace.project.animations.length, key.animations.length);
  const two = run(key, [{ op: 'bounce' }, { op: 'newAnimation', name: 'Spin' }, { op: 'spin' }]);
  assert.equal(two.project.animations.length, key.animations.length + 2);
  assert.equal(two.animation.name, 'Spin');
});

test('plans are validated with readable errors', () => {
  assert.throws(() => normalizePlan({}), /list of steps/);
  assert.throws(() => normalizePlan({ steps: [] }), /no steps/);
  assert.throws(() => normalizePlan([{ op: 'teleport' }]), /unknown motion “teleport”/);
  assert.throws(() => normalizePlan([{ op: 'move' }]), /needs "by"/);
  assert.throws(() => normalizePlan([{ op: 'move', by: { x: 1 }, easing: 'wobbly' }]), /unknown easing/);
  assert.throws(() => run(key, [{ op: 'bounce' }, { op: 'move', target: 'banana', by: { x: 1 } }]), /Step 2 \(Move\): No object, part or bone called “banana”/);
  const plan = normalizePlan([{ op: 'wave', times: 99 }, { op: 'nod' }, { op: 'flip' }, { op: 'move', by: { x: 1 }, easing: 'ease in-out', speed: 'slow' }]);
  assert.deepEqual(plan.steps.map(s => s.op), ['template', 'rotate', 'spin', 'move']);
  assert.equal(plan.steps[0].times, 16);
  assert.equal(plan.steps[3].easing, 'easeInOut');
  assert.equal(describeStep(plan.steps[0]), 'Wave ×16');
  assert.equal(describeStep(plan.steps[3]), 'Move · → 1 px · 6 frames · ease in out · slow');
});

test('the phrase parser understands common requests', () => {
  const poses = ['Arms up', 'Crouch', 'Wave', 'Kick'], parse = t => parseMotionText(t, { poses, width: 48, height: 48 });
  const cases = {
    'make him wave twice': [{ op: 'template', name: 'wave', times: 2 }],
    'Jump!': [{ op: 'template', name: 'jump' }],
    'walk cycle (8 frames)': [{ op: 'template', name: 'walk', frames: 8 }],
    'run fast': [{ op: 'template', name: 'run', speed: 1.6 }],
    'idle breathing': [{ op: 'template', name: 'idle' }],
    'bounce 3 times': [{ op: 'bounce', height: 8, times: 3 }],
    'make the key bounce three times': [{ op: 'bounce', height: 8, target: 'key', times: 3 }],
    'bounce higher and slow': [{ op: 'bounce', height: 13, speed: .6 }],
    'spin the key': [{ op: 'spin', axis: 'y', target: 'key' }],
    'do a backflip': [{ op: 'spin', axis: 'x', turns: -1 }],
    'flip around': [{ op: 'turn', axis: 'y', degrees: 180 }],
    'turn around': [{ op: 'turn', axis: 'y', degrees: 180 }],
    'nod': [{ op: 'rotate', target: 'head', degrees: 12, yoyo: true, frames: 3 }],
    'move the key to the right': [{ op: 'move', by: { x: 12, y: 0 }, target: 'key' }],
    'move the key to the left by 10': [{ op: 'move', by: { x: -10, y: 0 }, target: 'key' }],
    'slide up 5 px': [{ op: 'move', by: { x: 0, y: -5 } }],
    'fall down': [{ op: 'move', by: { x: 0, y: 12 }, easing: 'easeIn' }],
    'look left': [{ op: 'rotate', target: 'head', degrees: -15, yoyo: true }],
    'raise his left arm': [{ op: 'reach', target: 'left hand', by: { x: 0, y: -12 } }],
    'arms up': [{ op: 'pose', name: 'Arms up', yoyo: true }],
    'hold for 4 frames': [{ op: 'hold', frames: 4 }],
    'squash and stretch': [{ op: 'bounce', height: 4, squash: 1 }],
    'the scarf follows the head': [{ op: 'follow', leader: 'head', target: 'scarf' }],
  };
  for (const [text, steps] of Object.entries(cases)) assert.deepEqual(parse(text).plan.steps, steps, text);
  assert.deepEqual(parse('shake head 2 times').plan.steps.map(s => s.op), ['rotate', 'rotate', 'repeat']);
  assert.deepEqual(parse('wave, then jump twice and spin').plan.steps.map(s => s.op + (s.times || '')), ['template', 'template2', 'spin']);
  assert.deepEqual(parse('bounce then squash and stretch').plan.steps.map(s => s.op), ['bounce', 'squash']);
  assert.deepEqual(parse('bounce and repeat 3 times').plan.steps.at(-1), { op: 'repeat', times: 3 });
  assert.deepEqual(parse('new animation called happy, wave').plan.steps.map(s => s.op), ['newAnimation', 'template']);
  const odd = parse('sing a song and bounce');
  assert.deepEqual(odd.unknown, ['sing a song']);
  assert.deepEqual(odd.plan.steps.map(s => s.op), ['bounce']);
  for (const text of Object.keys(cases).filter(t => !/scarf|arms up/.test(t))) normalizePlan(parse(text).plan);
});

test('parsed phrases run on the samples', () => {
  for (const [p, text] of [[puppet, 'make him wave twice'], [puppet, 'nod then shake head'], [puppet, 'walk to the right'], [key, 'bounce 3 times, then spin the key'], [key, 'move the key to the right and back']]) {
    const t = motionTargets(p, ctx(p)), { plan, unknown } = parseMotionText(text, { poses: t.poses.map(x => x.name), width: t.width, height: t.height });
    assert.deepEqual(unknown, [], text);
    assert.ok(run(p, plan.steps).animation.frames.length > 4, text);
  }
});

test('the AI prompt lists the schema and targets; replies are parsed robustly', () => {
  const prompt = buildMotionPrompt(puppet, ctx(puppet), 'make him wave');
  assert.match(prompt, /^PXAMOTION 1/);
  for (const bit of ['bounce:', 'template:', 'spin:', 'role head', 'upperArmR=arm-r', '“Kick”', 'canvas 48×48', 'make him wave']) assert.ok(prompt.includes(bit), bit);
  const plan = { steps: [{ op: 'bounce', times: 2 }] };
  assert.equal(parseMotionResponse(JSON.stringify(plan)).steps[0].times, 2);
  assert.equal(parseMotionResponse('Sure! Here it is:\n```json\n{"steps":[{"op":"spin","turns":2},],}\n```\nEnjoy {not json}').steps[0].turns, 2);
  assert.equal(parseMotionResponse('PXAMOTION 1\n[{"op":"hold","frames":3,"note":"a } in a string"}] trailing').steps[0].frames, 3);
  assert.throws(() => parseMotionResponse('no plan here'), /No JSON motion plan/);
  assert.throws(() => parseMotionResponse('{"steps":[{"op":"explode"}]}'), /unknown motion/);
});
