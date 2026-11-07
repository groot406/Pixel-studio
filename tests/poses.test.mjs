import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateProject } from '../src/domain/project.js';
import { instancePivot } from '../src/domain/geometry.js';
import { rotateBone, rigView, relPose } from '../src/domain/skeleton.js';
import {
  savePose, applyPose, renamePose, deletePose, framePose, nameRole, matchBones, rigDescriptor, detectRoles, copyAnimationPoses,
  retargetAnimation, readPoseClip, characters,
} from '../src/domain/poses.js';
import { encodePXA2, decodePXA2 } from '../src/formats/pxa-v2.js';

const puppet = async () => { const p = decodePXA2(await readFile(new URL('../public/samples/puppet.pxa', import.meta.url), 'utf8')); delete p.poses; return p; };
const NAMES = { body: 'Chest', head: 'Skull', 'arm-l': 'ArmL', 'hand-l': 'ForeArm_L', 'arm-r': 'ArmR', 'hand-r': 'ForeArm_R', 'leg-l': 'thigh left', 'shin-l': 'calf left', 'leg-r': 'thigh right', 'shin-r': 'calf right' };
/** The puppet plus a second, differently named copy `b-…` standing `dx` pixels to the right in every frame. */
async function twoPuppets(dx = 30) {
  const p = await puppet();
  for (const a of p.animations) for (const f of a.frames) {
    const ops = f.cels[0].source.ops;
    ops.push(...ops.filter(o => o.type === 'use').map(o => ({ ...structuredClone(o), id: `b-${o.id}`, x: o.x + dx })));
  }
  p.bones.push(...p.bones.map(b => ({ ...structuredClone(b), id: `b-${b.id}`, instanceId: `b-${b.instanceId}`, parent: b.parent && `b-${b.parent}`, name: NAMES[b.id] })));
  return validateProject(p);
}
const frameAt = (p, a, k) => ({ animationId: p.animations[a].id, frameId: p.animations[a].frames[k].id });
const opOf = (p, a, k, id) => p.animations[a].frames[k].cels[0].source.ops.find(o => o.id === id);
const rels = (p, a, k) => relPose(p, p.animations[a].frames[k]);
const gaps = (p, a, k) => rigView(p, p.animations[a].id, p.animations[a].frames[k].id).filter(v => v.anchor).map(v => Math.hypot(v.joint.x - v.anchor.x, v.joint.y - v.anchor.y));

test('the pose library saves, applies (frame scope), blends, mirrors, renames and deletes poses', async () => {
  let p = await puppet();
  p = rotateBone(p, { ...frameAt(p, 0, 0), boneId: 'arm-l', angle: 60 }).project;
  p = rotateBone(p, { ...frameAt(p, 0, 0), boneId: 'shin-l', delta: -30 }).project;
  const saved = savePose(p, { ...frameAt(p, 0, 0), name: 'Reach' });
  p = saved.project;
  assert.equal(saved.poseId, 'reach');
  assert.deepEqual(p.poses[0].bones['arm-l'], 60);
  assert.deepEqual(p.poses[0].moves, { body: { x: 0, y: 0 } });
  const before = rels(p, 1, 0), applied = applyPose(p, { ...frameAt(p, 1, 0), poseId: 'reach' }).project;
  for (const [id, a] of Object.entries(p.poses[0].bones)) assert.equal(rels(applied, 1, 0).get(id), a);
  assert.deepEqual(rels(applied, 1, 1), rels(p, 1, 1), 'only the chosen frame changes');
  assert.ok(gaps(applied, 1, 0).every(g => g <= .75));
  const half = applyPose(p, { ...frameAt(p, 1, 0), poseId: 'reach', amount: .5 }).project;
  assert.equal(rels(half, 1, 0).get('arm-l'), Math.round((before.get('arm-l') + 60) / 2));
  const mirrored = applyPose(p, { ...frameAt(p, 1, 0), poseId: 'reach', mirror: true }).project;
  assert.equal(rels(mirrored, 1, 0).get('arm-r'), -60, 'the left arm pose lands on the right arm, reflected');
  assert.equal(rels(mirrored, 1, 0).get('shin-r'), p.poses[0].bones['shin-l'] * -1);
  p = renamePose(p, 'reach', 'Big reach');
  assert.equal(p.poses[0].name, 'Big reach');
  assert.equal(savePose(p, { ...frameAt(p, 0, 0), name: 'Reach' }).poseId, 'reach-2');
  assert.equal(deletePose(p, 'reach').poses, undefined);
  assert.throws(() => applyPose(p, { ...frameAt(p, 0, 0), poseId: 'gone' }), /no longer/);
});

test('poses keep only known bones, carry root moves and round-trip through PXA 2 POSE lines', async () => {
  let p = await puppet();
  const a = p.animations[0], moved = structuredClone(p);
  for (const op of moved.animations[0].frames[2].cels[0].source.ops) op.y += 3;
  p = savePose(validateProject(moved), { ...frameAt(moved, 0, 2), name: 'Crouch "low"' }).project;
  assert.deepEqual(p.poses[0].moves, { body: { x: 0, y: 3 } });
  const text = encodePXA2(p);
  assert.match(text, /\nPOSE crouch-low "Crouch \\"low\\"" body=0 head=0 .* MOVE body 0 3\n/);
  assert.deepEqual(decodePXA2(text).poses, p.poses);
  assert.throws(() => decodePXA2(text.replace('body=0 head', 'body=x head')), /bone-id=degrees/);
  const back = applyPose(p, { animationId: a.id, frameId: a.frames[0].id, poseId: 'crouch-low' }).project;
  const pivot = k => { const op = opOf(back, 0, k, 'body'); return instancePivot(op, back.parts.find(x => x.id === op.partId)); };
  assert.equal(pivot(0).y - instancePivot(opOf(p, 0, 0, 'body'), p.parts.find(x => x.id === 'torso')).y, 3, 'MOVE puts the root back at its offset');
  const stray = validateProject({ ...p, poses: [{ id: 'x', name: 'X', bones: { nope: 5, head: 10 } }] });
  assert.deepEqual(stray.poses[0].bones, { head: 10 });
  assert.equal(validateProject({ ...p, poses: [{ id: 'x', name: 'X', bones: { nope: 5 } }] }).poses, undefined);
  assert.deepEqual(framePose(p, { ...frameAt(p, 0, 0), rootBoneId: 'body' }).bones.head, 0);
});

test('bone names match across naming styles, with a tree fallback', () => {
  assert.deepEqual(['ArmL', 'upper_arm_l', 'left arm', 'mixamorig:LeftArm'].map(n => nameRole(n)), Array(4).fill({ kind: 'upperArm', side: 'L' }));
  assert.deepEqual(nameRole('LeftForeArm'), { kind: 'lowerArm', side: 'L' });
  assert.deepEqual(nameRole('Hip_R'), { kind: 'upperLeg', side: 'R' });
  assert.deepEqual(nameRole('Hips'), { kind: 'root', side: null });
  const bone = (id, name, parent, x = 0) => ({ id, name, parent, x, y: 0 });
  const source = [bone('a', 'Body', null), bone('b', 'upper arm L', 'a', -1), bone('c', 'lower arm L', 'b'), bone('d', 'tail', 'a', 5), bone('e', 'Antenna 1', 'a', 1)];
  const target = [bone('A', 'torso', null), bone('B', 'ArmL', 'A', -1), bone('C', 'ForeArmL', 'B'), bone('D', 'Tail', 'A', 5), bone('E', 'feeler', 'A', 1)];
  const { map, how } = matchBones(source, target);
  assert.deepEqual(map, { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E' });
  assert.equal(how.e, 'tree', 'unnamed siblings pair by position under matched parents');
});

test('retargeting copies an animation onto a differently named character by rest-pose deltas', async () => {
  const p = await twoPuppets();
  assert.deepEqual(characters(p, p.animations[0].id, p.animations[0].frames[0].id).map(c => c.id), ['body', 'b-body']);
  const clip = readPoseClip(JSON.parse(JSON.stringify(copyAnimationPoses(p, { animationId: p.animations[0].id, rootBoneId: 'body' }))));
  assert.equal(clip.frames.length, p.animations[0].frames.length);
  const target = { animationId: p.animations[1].id, frameId: p.animations[1].frames[0].id, rootBoneId: 'b-body' };
  const out = retargetAnimation(p, { clip, ...target, mode: 'new', name: 'Jack B' });
  assert.deepEqual(out.mapping, Object.fromEntries(p.bones.filter(b => !b.id.startsWith('b-')).map(b => [b.id, `b-${b.id}`])));
  const k = out.project.animations.findIndex(a => a.id === out.animationId);
  assert.equal(out.project.animations[k].name, 'Jack B');
  for (let f = 0; f < clip.frames.length; f++) {
    const got = rels(out.project, k, f);
    for (const [id, angle] of Object.entries(clip.frames[f].bones)) assert.equal(got.get(`b-${id}`), angle);
    assert.ok(gaps(out.project, k, f).every(g => g <= .75));
  }
  const rested = structuredClone(p);
  rested.bones.find(b => b.id === 'b-arm-l').rest = 30;
  const shifted = retargetAnimation(validateProject(rested), { clip, ...target, mode: 'merge' });
  assert.equal(rels(shifted.project, 1, 1).get('b-arm-l'), 30 + clip.frames[1].bones['arm-l'], 'angles apply relative to the target rest pose');
  assert.equal(shifted.project.animations[1].frames.length, clip.frames.length, 'merge fills the current animation');
  const moving = structuredClone(clip);
  moving.frames[1].move = { x: 8, y: -4 };
  moving.legLength *= 2;
  const scaled = retargetAnimation(p, { clip: moving, ...target, mode: 'merge' }).project, home = instancePivot(opOf(p, 1, 0, 'b-body'), p.parts.find(x => x.id === 'torso'));
  const c = instancePivot(opOf(scaled, 1, 1, 'b-body'), p.parts.find(x => x.id === 'torso'));
  assert.deepEqual([c.x - home.x, c.y - home.y], [4, -2], 'root motion scales by the leg-length ratio');
  assert.throws(() => retargetAnimation(p, { clip, ...target, mapping: { nope: 'b-body' } }), /No bones match/);
  assert.throws(() => readPoseClip({ format: 'other' }), /not a copied/);
});

test('roles come from names, or from shape when parts are unnamed', async () => {
  const p = await puppet(), at = { ...frameAt(p, 0, 0), rootBoneId: 'body' };
  const named = detectRoles(rigDescriptor(p, at));
  assert.equal(named.facing, 'front');
  assert.deepEqual(named.roles, { root: 'body', head: 'head', upperArmL: 'arm-l', lowerArmL: 'hand-l', upperArmR: 'arm-r', lowerArmR: 'hand-r', upperLegL: 'leg-l', lowerLegL: 'shin-l', upperLegR: 'leg-r', lowerLegR: 'shin-r' });
  const anon = structuredClone(p);
  anon.bones.forEach((b, i) => { b.name = `Shape ${i}`; });
  assert.deepEqual(detectRoles(rigDescriptor(validateProject(anon), at)).roles, named.roles);
});
