/**
 * Procedural animation templates for rigs (walk, run, jump, idle breathing, wave, bob/hover). A template is a pure
 * function of loop time t ∈ [0, 1] → angle changes per humanoid role (see poses.js ROLES) from the rest pose, plus a
 * lift; generateTemplate turns it into frames with writePoseFrames, keeping the feet on the ground where it applies.
 * Angles: positive turns clockwise; a limb hanging down swings its end to screen-left for positive angles.
 */
import { validateProject } from './project.js';
import { ease } from './motion.js';
import { rigDescriptor, detectRoles, cleanRoles, writePoseFrames } from './poses.js';

/** Template defaults: frame count, frame duration (ms), amplitude (degrees), bounce or jump height (px). */
export const TEMPLATES = {
  walk: { name: 'Walk', label: 'Walk cycle', frames: 8, frameMs: 110, amplitude: 28, bounce: 1, ground: true },
  run: { name: 'Run', label: 'Run cycle', frames: 8, frameMs: 75, amplitude: 40, bounce: 2, ground: true },
  jump: { name: 'Jump', label: 'Jump', frames: 12, frameMs: 80, amplitude: 1, bounce: 10, ground: true },
  idle: { name: 'Idle', label: 'Idle breathing', frames: 8, frameMs: 160, amplitude: 3, bounce: 0, ground: true },
  wave: { name: 'Wave', label: 'Wave', frames: 8, frameMs: 110, amplitude: 30, bounce: 0, ground: true },
  hover: { name: 'Hover', label: 'Bob / hover', frames: 8, frameMs: 120, amplitude: 8, bounce: 2, ground: false },
};
const TAU = Math.PI * 2, pos = v => Math.max(0, v);
/** Key poses of a jump: crouch (knees bent), lift (0..1 of the height), arms (−1 back … 1 up), tuck (knees up). */
const JUMP_KEYS = [
  { t: 0, crouch: 0, lift: 0, arms: 0, tuck: 0 }, { t: .2, crouch: 1, lift: 0, arms: -1, tuck: 0 },
  { t: .32, crouch: -.1, lift: .45, arms: 1, tuck: 0 }, { t: .46, crouch: 0, lift: 1, arms: .8, tuck: .7 },
  { t: .6, crouch: 0, lift: .6, arms: .5, tuck: .1 }, { t: .72, crouch: 1.15, lift: 0, arms: -.3, tuck: 0 },
  { t: .86, crouch: .35, lift: 0, arms: 0, tuck: 0 }, { t: 1, crouch: 0, lift: 0, arms: 0, tuck: 0 },
];
function jumpKey(t) {
  const n = JUMP_KEYS.findIndex(k => k.t > t), i = n < 0 ? JUMP_KEYS.length - 1 : Math.max(0, n - 1), a = JUMP_KEYS[i], b = JUMP_KEYS[Math.min(i + 1, JUMP_KEYS.length - 1)];
  const e = b.t > a.t ? ease('easeInOut', (t - a.t) / (b.t - a.t)) : 0, mix = k => a[k] + (b[k] - a[k]) * e;
  return { crouch: mix('crouch'), lift: mix('lift'), arms: mix('arms'), tuck: mix('tuck') };
}

/**
 * One template pose at loop time t: { angles: {role: degrees from rest}, lift (px up), swing(depth) for rigs without
 * roles }. `facing`: 'right' | 'left' (side views) or 'front'.
 */
export function templatePose(id, t, { amplitude, bounce, exaggeration = 1, facing = 'right' } = {}) {
  const def = TEMPLATES[id];
  if (!def) throw new Error('Unknown animation template.');
  const x = exaggeration, A = (amplitude ?? def.amplitude) * x, B = (bounce ?? def.bounce) * x, p = TAU * t;
  const F = facing === 'left' ? 1 : -1, front = facing === 'front', a = {};
  const pair = (role, l, r) => { a[`${role}L`] = l; a[`${role}R`] = r; };
  let lift = 0;
  if (id === 'walk' || id === 'run') {
    const run = id === 'run';
    if (front) {
      const upL = pos(Math.sin(p)), upR = pos(-Math.sin(p)), k = run ? 1.3 : 1;
      pair('upperLeg', .45 * A * upL * k, -.45 * A * upR * k);
      pair('lowerLeg', -1.1 * A * upL * k, 1.1 * A * upR * k);
      pair('upperArm', .3 * A * upR + (run ? .2 * A : 0), -.3 * A * upL - (run ? .2 * A : 0));
      pair('lowerArm', -(run ? 1.4 : .25) * A * (run ? 1 : upR), (run ? 1.4 : .25) * A * (run ? 1 : upL));
      a.root = .1 * A * Math.sin(p); a.head = -.6 * a.root;
      lift = B * Math.sin(p) ** 2;
    } else {
      const swing = q => Math.sin(q) + (run ? .12 : 0), knee = q => (run ? .3 : .15) + (run ? 1.6 : 1.4) * pos(Math.cos(q)) ** (run ? 1 : 1.5);
      pair('upperLeg', F * A * swing(p), F * A * swing(p + Math.PI));
      pair('lowerLeg', -F * A * knee(p), -F * A * knee(p + Math.PI));
      pair('upperArm', F * .8 * A * Math.sin(p + Math.PI), F * .8 * A * Math.sin(p));
      pair('lowerArm', F * A * (run ? 1.7 : .25 + .3 * pos(Math.sin(p + Math.PI))), F * A * (run ? 1.7 : .25 + .3 * pos(Math.sin(p))));
      a.spine = -F * (run ? 9 : 3) * x;
      a.head = F * (run ? 4 : 1.5) * x * Math.sin(2 * p);
      lift = run ? B * Math.sin(p) ** 2 : B * Math.cos(p) ** 2;
    }
  } else if (id === 'jump') {
    const k = jumpKey(t), c = k.crouch * x, arms = k.arms;
    if (front) {
      pair('upperLeg', 50 * c + 30 * k.tuck * x, -50 * c - 30 * k.tuck * x);
      pair('lowerLeg', -100 * c - 60 * k.tuck * x, 100 * c + 60 * k.tuck * x);
      const up = arms > 0 ? 150 * arms * Math.min(1, x) : -25 * arms * x;
      pair('upperArm', up, -up); pair('lowerArm', arms > 0 ? -15 * arms : 0, arms > 0 ? 15 * arms : 0);
      a.head = 0;
    } else {
      pair('upperLeg', F * (45 * c + 60 * k.tuck * x), F * (45 * c + 60 * k.tuck * x));
      pair('lowerLeg', -F * (85 * c + 90 * k.tuck * x), -F * (85 * c + 90 * k.tuck * x));
      pair('foot', F * 40 * c, F * 40 * c);
      const up = arms > 0 ? F * 150 * arms * Math.min(1, x) : -F * 45 * -arms * x;
      pair('upperArm', up, up); pair('lowerArm', F * 20 * Math.abs(arms), F * 20 * Math.abs(arms));
      a.spine = -F * 18 * pos(k.crouch) * x;
    }
    lift = B * k.lift;
  } else if (id === 'idle') {
    const b = (1 - Math.cos(p)) / 2;
    if (front) { pair('upperArm', A * b, -A * b); pair('lowerArm', -.5 * A * b, .5 * A * b); }
    else { pair('upperArm', F * .6 * A * b, F * .6 * A * b); a.spine = -F * .5 * A * b; }
    a.head = .6 * A * Math.sin(p - .8);
    lift = Math.round(B * b);
  } else if (id === 'wave') {
    const s = Math.sin(p), raise = front ? -140 : F * 140;
    a.upperArmR = raise + (front ? -1 : F) * 6 * x * Math.sin(p + .7);
    a.lowerArmR = (front ? -10 : F * 10) + A * s;
    a.head = 3 * x * s; a.root = 1.5 * x * Math.sin(p + .5);
  } else if (id === 'hover') {
    a.root = .25 * A * Math.sin(p);
    lift = B * (1 - Math.cos(p)) / 2;
    return { angles: a, lift, swing: depth => (depth > 0 ? A * Math.sin(p - .9 * depth) : 0) };
  }
  return { angles: a, lift };
}

/**
 * Generate template `template` for character `rootBoneId` (as posed in `animationId`/`frameId`, the base frame) with
 * `roles` (default detectRoles) and params frames, frameMs, amplitude, bounce, exaggeration, facing ('auto' picks
 * front or right). `mode` 'new' (default) adds an animation, 'replace' or 'merge' change the current one (see
 * writePoseFrames). Frames sample t = k/frames, so playback loops without a repeated frame. Returns { project,
 * animationId, frameIds, roles, facing }.
 */
export function generateTemplate(project, { animationId, frameId, rootBoneId, template, roles, frames, frameMs, amplitude, bounce, exaggeration = 1, facing = 'auto', mode = 'new', name }) {
  const def = TEMPLATES[template];
  if (!def) throw new Error('Unknown animation template.');
  const p = validateProject(project), rig = rigDescriptor(p, { animationId, frameId, rootBoneId }), found = detectRoles(rig);
  const use = roles ? cleanRoles(rig, roles) : found.roles, side = facing === 'auto' ? (found.facing === 'front' ? 'front' : 'right') : facing;
  const n = Math.max(2, Math.min(64, Math.round(frames ?? def.frames))), ms = Math.max(16, Math.min(2000, Math.round(frameMs ?? def.frameMs)));
  const roleOf = new Map(Object.entries(use).map(([r, id]) => [id, r]));
  if (template !== 'hover' && !['upperLegL', 'upperLegR', 'upperArmL', 'upperArmR', 'head'].some(r => use[r])) throw new Error('No arms, legs or head found: assign bone roles first, or use Bob / hover.');
  const list = Array.from({ length: n }, (_, k) => {
    const pose = templatePose(template, k / n, { amplitude, bounce, exaggeration, facing: side });
    const lean = use.spine ? 0 : pose.angles.spine || 0;
    const rels = new Map(rig.map(b => {
      const role = roleOf.get(b.id), delta = role && pose.angles[role] !== undefined ? pose.angles[role] : pose.swing ? pose.swing(b.depth) : 0;
      return [b.id, b.rest + delta + (role === 'root' ? lean : 0)];
    }));
    return { duration: ms, rels, move: { x: 0, y: def.ground ? 0 : -pose.lift }, ground: def.ground, lift: pose.lift };
  });
  const out = writePoseFrames(p, { animationId, frameId, rootBoneId, frames: list, mode, name: name || def.name, fps: Math.max(1, Math.min(60, Math.round(1000 / ms))) });
  return { ...out, roles: use, facing: side };
}
