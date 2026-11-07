import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { instancePivot, instanceBox } from '../src/domain/geometry.js';
import { rigView, relPose } from '../src/domain/skeleton.js';
import { TEMPLATES, templatePose, generateTemplate } from '../src/domain/templates.js';
import { decodePXA2 } from '../src/formats/pxa-v2.js';

const puppet = async () => decodePXA2(await readFile(new URL('../public/samples/puppet.pxa', import.meta.url), 'utf8'));
const close = (a, b) => Object.keys({ ...a, ...b }).every(k => Math.abs((a[k] || 0) - (b[k] || 0)) < 1e-6);
const generate = (p, template, opts = {}) => {
  const out = generateTemplate(p, { animationId: p.animations[0].id, frameId: p.animations[0].frames[0].id, rootBoneId: 'body', template, ...opts });
  return { ...out, animation: out.project.animations.find(a => a.id === out.animationId) };
};
const torso = (p, frame) => { const op = frame.cels[0].source.ops.find(o => o.id === 'body'); return instancePivot(op, p.parts.find(x => x.id === op.partId)); };
const lowest = (p, frame) => Math.max(...frame.cels[0].source.ops.filter(o => o.type === 'use').map(o => { const b = instanceBox(o, p.parts.find(x => x.id === o.partId)); return b.y + b.height; }));

test('every template loops seamlessly: the pose after the last frame is the first one', () => {
  for (const id of Object.keys(TEMPLATES)) for (const facing of ['right', 'left', 'front']) {
    const a = templatePose(id, 0, { facing }), b = templatePose(id, 1, { facing });
    assert.ok(close(a.angles, b.angles) && Math.abs(a.lift - b.lift) < 1e-6, `${id} ${facing}`);
  }
  assert.ok(Object.values(templatePose('jump', 0).angles).every(v => Math.abs(v) < 1e-9), 'the jump starts and ends at rest');
});

test('walk and run swing left and right limbs in antiphase, arms against legs', () => {
  for (const id of ['walk', 'run']) for (let k = 0; k < 16; k++) {
    const t = k / 16, now = templatePose(id, t).angles, half = templatePose(id, (t + .5) % 1).angles;
    assert.ok(Math.abs(now.upperLegL - half.upperLegR) < 1e-6, `${id} legs at ${t}`);
    assert.ok(Math.abs(now.upperArmL - half.upperArmR) < 1e-6, `${id} arms at ${t}`);
    if (id === 'walk') assert.ok(now.upperLegL * now.upperLegR <= 1e-9 && now.upperLegL * now.upperArmL <= 1e-9);
  }
  const left = templatePose('walk', .25, { facing: 'left' }).angles, right = templatePose('walk', .25, { facing: 'right' }).angles;
  assert.equal(left.upperLegL, -right.upperLegL, 'facing left mirrors the swing');
});

test('idle breathing stays subtle', () => {
  for (let k = 0; k <= 8; k++) for (const facing of ['front', 'right']) {
    const pose = templatePose('idle', k / 8, { facing });
    assert.ok(Object.values(pose.angles).every(v => Math.abs(v) <= 5) && pose.lift <= 1);
  }
});

test('a generated walk is a new looping animation with the feet kept on the ground', async () => {
  const p = await puppet(), { animation, project, roles } = generate(p, 'walk', { facing: 'right', bounce: 0, frames: 8 });
  assert.equal(animation.name, 'Walk');
  assert.equal(animation.frames.length, 8);
  assert.equal(roles.upperLegL, 'leg-l');
  assert.equal(project.animations.length, p.animations.length + 1);
  const ground = lowest(project, animation.frames[0]);
  for (const frame of animation.frames) {
    assert.equal(lowest(project, frame), ground, 'a foot touches the ground every frame');
    assert.ok(rigView(project, animation.id, frame.id).filter(v => v.anchor).every(v => Math.hypot(v.joint.x - v.anchor.x, v.joint.y - v.anchor.y) <= .75));
  }
  const legs = animation.frames.map(f => relPose(project, f).get('leg-l'));
  assert.ok(Math.max(...legs) - Math.min(...legs) >= 40, 'the stride swings the legs');
  assert.ok(new Set(animation.frames.map(f => torso(project, f).y)).size > 1, 'the body bobs as the legs spread');
});

test('a jump crouches, takes off, stays airborne with the root raised and lands', async () => {
  const p = await puppet(), { animation, project } = generate(p, 'jump', { bounce: 10 });
  assert.equal(animation.frames.length, TEMPLATES.jump.frames);
  const rest = torso(project, animation.frames[0]).y, ys = animation.frames.map(f => torso(project, f).y - rest);
  assert.ok(ys.filter(dy => dy <= -5).length >= 2, `airborne frames ${ys}`);
  assert.ok(Math.min(...ys) <= -9 && Math.max(...ys) >= 2, 'peak height and crouch');
  const air = ys.indexOf(Math.min(...ys));
  assert.ok(ys.slice(0, air).some(dy => dy >= 2) && ys.slice(air).some(dy => dy >= 2), 'crouches before take-off and squashes on landing');
  const replaced = generate(p, 'idle', { mode: 'replace', frames: 6, frameMs: 200 });
  assert.equal(replaced.project.animations[0].frames.length, 6);
  assert.equal(replaced.project.animations[0].fps, 5);
  assert.throws(() => generate(p, 'walk', { roles: { root: 'body' } }), /No arms, legs or head/);
  const hover = generate(p, 'hover', { roles: { root: 'body' }, bounce: 4 });
  assert.ok(Math.min(...hover.animation.frames.map(f => torso(hover.project, f).y)) < torso(p, p.animations[0].frames[0]).y);
});
