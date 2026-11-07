/**
 * Reusable rigs (src/domain/skeleton.js): the project pose library (`project.poses`), bone roles found by name and
 * shape, bone matching between rigs, pose clips (a character's animation as relative angles + root moves) and
 * retargeting them onto another rig by rest-pose deltas. `writePoseFrames` is shared with templates.js.
 * Every exported operation is pure: (project, options) → { project, … }.
 */
import { validateProject, makeLayeredFrame, uid } from './project.js';
import { instancePivot, instanceBox, instanceImage } from './geometry.js';
import { renderParts } from './artwork.js';
import { normalizeAngle, angleDelta, roundInt } from './motion.js';
import { placed, relPose, layoutFrame, sidePairs, subtree } from './skeleton.js';

export const MAX_POSES = 64;
export const POSE_CLIP_FORMAT = 'pixel-studio-poses';

function animationOf(p, animationId) {
  const animation = p.animations.find(a => a.id === animationId);
  if (!animation) throw new Error('This animation no longer exists.');
  return animation;
}
function frameOf(animation, frameId) {
  const frame = animation.frames.find(f => f.id === frameId);
  if (!frame) throw new Error('This frame no longer exists.');
  return frame;
}
const rootPivot = (p, frame, rootId) => { const s = placed(p, frame).get(rootId); return s && !s.parent ? instancePivot(s.op, s.part) : null; };
const slug = text => String(text || 'pose').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pose';
const restOf = bone => bone.rest || 0;

/** Root bones placed in a frame: the characters you can pose, retarget or animate. */
export function characters(project, animationId, frameId) {
  const frame = frameOf(animationOf(project, animationId), frameId), map = placed(project, frame);
  return (project.bones || []).filter(b => !b.parent && map.has(b.id)).map(b => ({ id: b.id, name: b.name || b.id, count: subtree(project, b.id).size }));
}

// ---- Pose library -------------------------------------------------------------------------------------------------

/**
 * A frame's pose: relative angles of the placed bones (of one character with `rootBoneId`) and each root's move from
 * its place in the animation's first frame.
 */
export function framePose(project, { animationId, frameId, rootBoneId }) {
  const animation = animationOf(project, animationId), frame = frameOf(animation, frameId), rels = relPose(project, frame);
  const keep = rootBoneId ? subtree(project, rootBoneId) : null, bones = {}, moves = {};
  for (const [id, s] of placed(project, frame)) {
    if (keep && !keep.has(id)) continue;
    bones[id] = normalizeAngle(roundInt(rels.get(id)));
    const home = !s.bone.parent && rootPivot(project, animation.frames[0], id);
    if (home) { const c = instancePivot(s.op, s.part); moves[id] = { x: roundInt(c.x - home.x), y: roundInt(c.y - home.y) }; }
  }
  if (!Object.keys(bones).length) throw new Error('Rig and place some parts in this frame first.');
  return { bones, ...(Object.keys(moves).length ? { moves } : {}) };
}
/** Save the frame's pose to the library under `name`. Returns { project, poseId }. */
export function savePose(project, { name, ...opts }) {
  const p = validateProject(project), pose = framePose(p, opts), poses = p.poses || [], text = String(name ?? '').trim().slice(0, 60) || `Pose ${poses.length + 1}`;
  if (poses.length >= MAX_POSES) throw new Error(`The pose library holds at most ${MAX_POSES} poses.`);
  const ids = new Set(poses.map(x => x.id)), base = slug(text);
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  p.poses = [...poses, { id, name: text, ...pose }];
  return { project: validateProject(p), poseId: id };
}
function poseById(p, poseId) {
  const pose = (p.poses || []).find(x => x.id === poseId);
  if (!pose) throw new Error('This pose is no longer in the library.');
  return pose;
}
/** Rename a library pose. */
export function renamePose(project, poseId, name) {
  const p = validateProject(project), text = String(name ?? '').trim().slice(0, 60);
  if (!text) throw new Error('Give the pose a name.');
  poseById(p, poseId).name = text;
  return validateProject(p);
}
/** Remove a library pose. */
export function deletePose(project, poseId) {
  const p = validateProject(project);
  poseById(p, poseId);
  p.poses = p.poses.filter(x => x.id !== poseId);
  return validateProject(p);
}
/** A pose flipped left-right: L/R pairs (see sidePairs) swap, every angle and each root's sideways move negate. */
export function mirroredPose(project, pose) {
  const other = new Map(sidePairs(project).flatMap(([a, b]) => [[a, b], [b, a]])), bones = {};
  for (const [id, a] of Object.entries(pose.bones)) bones[other.get(id) || id] = normalizeAngle(-a);
  const moves = pose.moves && Object.fromEntries(Object.entries(pose.moves).map(([id, m]) => [id, { x: -m.x || 0, y: m.y }]));
  return { ...pose, bones, ...(moves ? { moves } : {}) };
}
/**
 * Apply a library pose (`poseId`) or a pose object to `frameIds` (or `frameId`): each bone turns `amount` (0..1) of the
 * short way toward the pose, `mirror` flips it first, `move` also carries roots to their saved offset. Returns { project }.
 */
export function applyPose(project, { poseId, pose, mirror = false, amount = 1, move = true, animationId, frameId, frameIds }) {
  const p = validateProject(project), animation = animationOf(p, animationId);
  if (!p.bones?.length) throw new Error('Rig the parts first.');
  let goal = pose || poseById(p, poseId);
  if (mirror) goal = mirroredPose(p, goal);
  const t = Math.max(0, Math.min(1, Number(amount))), wanted = new Set(frameIds || [frameId]), frames = animation.frames.filter(f => wanted.has(f.id));
  if (!frames.length) throw new Error('Choose a frame to pose.');
  for (const frame of frames) {
    const map = placed(p, frame), rels = relPose(p, frame), roots = {};
    for (const [id, a] of Object.entries(goal.bones)) if (rels.has(id)) { const now = rels.get(id); rels.set(id, now + angleDelta(now, a) * t); }
    if (move) for (const [id, m] of Object.entries(goal.moves || {})) {
      const s = map.get(id), home = rootPivot(p, animation.frames[0], id);
      if (!s || s.parent || !home) continue;
      const c = instancePivot(s.op, s.part);
      roots[id] = { x: c.x + (home.x + m.x - c.x) * t, y: c.y + (home.y + m.y - c.y) * t };
    }
    layoutFrame(p, frame, rels, roots);
  }
  return { project: validateProject(p) };
}

// ---- Bone roles ---------------------------------------------------------------------------------------------------

/** Humanoid roles a template or retarget can drive, with labels. L/R are as seen on screen (L = left side). */
export const ROLES = [
  ['root', 'Hips / root'], ['spine', 'Chest'], ['head', 'Head'],
  ['upperArmL', 'Upper arm L'], ['lowerArmL', 'Lower arm L'], ['handL', 'Hand L'],
  ['upperArmR', 'Upper arm R'], ['lowerArmR', 'Lower arm R'], ['handR', 'Hand R'],
  ['upperLegL', 'Upper leg L'], ['lowerLegL', 'Lower leg L'], ['footL', 'Foot L'],
  ['upperLegR', 'Upper leg R'], ['lowerLegR', 'Lower leg R'], ['footR', 'Foot R'],
];
const ROLE_IDS = new Set(ROLES.map(([id]) => id));
/** Name → lower-case words: camelCase, digits and separators split ("upperArm_L" → upper arm l). */
export function nameTokens(name) {
  return String(name || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
const SIDES = { l: 'L', left: 'L', lft: 'L', r: 'R', right: 'R', rt: 'R', rgt: 'R' };
const KINDS = [
  ['hand', /\b(hand|wrist|fist|palm|fingers?)\b/], ['foot', /\b(foot|feet|toes?|ankle|boot|shoe)\b/],
  ['lowerArm', /\b(fore ?arm|lower ?arm|low ?arm|elbow|arm (lower|low|2|b))\b/],
  ['upperArm', /\b(upper ?arm|up ?arm|biceps?|humerus|shoulder|arm)\b/],
  ['lowerLeg', /\b(shin|calf|calves|lower ?leg|low ?leg|knee|leg (lower|low|2|b)|crus)\b/],
  ['upperLeg', /\b(thigh|upper ?leg|up ?leg|femur|leg)\b/],
  ['head', /\b(head|skull|face|helmet)\b/], ['neck', /\bneck\b/],
  ['spine', /\b(spine|chest|torso|body|trunk|abdomen|belly|ribs?|back)\b/],
  ['root', /\b(hips?|pelvis|root|waist|cog)\b/],
];
/** What a bone's name says: { kind (upperArm, lowerLeg, head, spine, root, …), side ('L'|'R'|null) }. */
export function nameRole(name) {
  const tokens = nameTokens(name), side = tokens.map(t => SIDES[t]).find(Boolean) || null, text = tokens.filter(t => !SIDES[t]).join(' ');
  if (side && /\bhips?\b/.test(text)) return { kind: 'upperLeg', side };
  const kind = KINDS.find(([, re]) => re.test(text))?.[0] || null;
  return { kind, side };
}
const LIMB = { upperArm: 'arm', lowerArm: 'arm', hand: 'arm', upperLeg: 'leg', lowerLeg: 'leg', foot: 'leg', head: 'head', neck: 'head' };

/**
 * Rig of one character as seen in a frame: [{id, name, parent, depth, rest, x, y (joint), length, box}], tree order.
 * `length` runs from the joint to the first child's joint (a leaf: to the far end of its part).
 */
export function rigDescriptor(project, { animationId, frameId, rootBoneId }) {
  const frame = frameOf(animationOf(project, animationId), frameId), map = placed(project, frame), keep = subtree(project, rootBoneId);
  if (!map.has(rootBoneId)) throw new Error('This character is not in the frame.');
  const list = [], depth = new Map();
  for (const [id, s] of map) {
    if (!keep.has(id)) continue;
    depth.set(id, s.parent ? depth.get(s.bone.parent) + 1 : 0);
    const j = instancePivot(s.op, s.part), box = instanceBox(s.op, s.part);
    list.push({ id, name: s.bone.name || id, parent: s.parent ? s.bone.parent : null, depth: depth.get(id), rest: restOf(s.bone), x: j.x, y: j.y, box });
  }
  for (const b of list) {
    const kid = list.find(k => k.parent === b.id);
    b.length = kid ? Math.hypot(kid.x - b.x, kid.y - b.y) : Math.max(...[[b.box.x, b.box.y], [b.box.x + b.box.width, b.box.y], [b.box.x, b.box.y + b.box.height], [b.box.x + b.box.width, b.box.y + b.box.height]].map(([x, y]) => Math.hypot(x - b.x, y - b.y)));
  }
  return list;
}

/**
 * Find humanoid roles in a rig descriptor by names first, then shape: chains hanging from the root (or a chest with
 * several children) are arms when they join the upper half of their parent's part, legs below and the head when they
 * point up from the top middle; the side comes from the name or the joint's x, upper/lower/hand from chain depth.
 * Returns { roles: {role: boneId}, facing: 'front'|'side' }.
 */
export function detectRoles(rig) {
  const roles = {}, byId = new Map(rig.map(b => [b.id, b])), kids = id => rig.filter(b => b.parent === id);
  const named = new Map(rig.map(b => [b.id, nameRole(b.name)]));
  const root = rig.find(b => !b.parent);
  if (!root) return { roles, facing: 'side' };
  roles.root = root.id;
  let chest = kids(root.id).find(b => named.get(b.id).kind === 'spine') || null;
  if (!chest && named.get(root.id).kind === 'root') chest = kids(root.id).find(b => kids(b.id).length >= 2 && b.y < root.y) || null;
  if (chest) roles.spine = chest.id;
  const chainOf = start => { const out = [start]; for (let at = start; ;) { const next = kids(at.id).sort((a, b) => subCount(b) - subCount(a))[0]; if (!next || out.length >= 3) break; out.push(next); at = next; } return out; };
  const subCount = b => 1 + kids(b.id).reduce((n, k) => n + subCount(k), 0);
  const chains = [];
  for (const host of [root, chest].filter(Boolean)) for (const start of kids(host.id)) {
    if (start === chest) continue;
    const name = named.get(start.id), box = host.box, ry = (start.y - box.y) / Math.max(1, box.height), cx = box.x + box.width / 2;
    const chain = chainOf(start), up = start.box.y + start.box.height / 2 < start.y - 1;
    let limb = LIMB[name.kind];
    if (!limb) limb = up && ry < .4 && Math.abs(start.x - cx) <= box.width * .3 ? 'head' : host === chest ? 'arm' : ry < .5 ? 'arm' : 'leg';
    chains.push({ limb, chain, side: name.side, x: start.x, cx });
  }
  const heads = chains.filter(c => c.limb === 'head');
  if (heads.length) { const c = heads.sort((a, b) => a.chain[0].y - b.chain[0].y)[0].chain; roles.head = (named.get(c[0].id).kind === 'neck' && c[1] ? c[1] : c[0]).id; }
  for (const limb of ['arm', 'leg']) {
    const list = chains.filter(c => c.limb === limb).sort((a, b) => a.x - b.x).slice(0, 2);
    const sides = list.map(c => c.side);
    if (list.length === 2 && (!sides[0] || !sides[1] || sides[0] === sides[1])) { list[0].side = 'L'; list[1].side = 'R'; }
    else if (list.length === 1 && !list[0].side) list[0].side = list[0].x <= list[0].cx ? 'L' : 'R';
    const names = limb === 'arm' ? ['upperArm', 'lowerArm', 'hand'] : ['upperLeg', 'lowerLeg', 'foot'];
    for (const c of list) c.chain.forEach((b, i) => { roles[names[i] + c.side] = b.id; });
  }
  const spread = (a, b) => roles[a] && roles[b] ? Math.abs(byId.get(roles[a]).x - byId.get(roles[b]).x) : 0;
  const width = root.box.width, facing = spread('upperArmL', 'upperArmR') >= width * .5 || spread('upperLegL', 'upperLegR') >= width * .3 ? 'front' : 'side';
  return { roles, facing };
}
/** Keep only known roles mapped to bones of the rig. */
export function cleanRoles(rig, roles) {
  const ids = new Set(rig.map(b => b.id));
  return Object.fromEntries(Object.entries(roles || {}).filter(([role, id]) => ROLE_IDS.has(role) && ids.has(id)));
}

// ---- Matching -----------------------------------------------------------------------------------------------------

const canonical = name => { const t = nameTokens(name).map(x => SIDES[x] ? `#${SIDES[x]}` : x); return t.join(' '); };
const bigrams = s => { const out = new Map(), t = s.replace(/\s+/g, ''); for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); out.set(k, (out.get(k) || 0) + 1); } return out; };
/** Dice similarity of two names (0..1) on letter pairs, side words removed. */
export function nameSimilarity(a, b) {
  const strip = n => nameTokens(n).filter(t => !SIDES[t]).join(''), x = bigrams(strip(a)), y = bigrams(strip(b));
  let common = 0, total = 0;
  for (const [k, n] of x) { common += Math.min(n, y.get(k) || 0); total += n; }
  for (const n of y.values()) total += n;
  return total ? 2 * common / total : 0;
}
/**
 * Pair source bones with target bones: same role, then the same name, the same kind and side ("ArmL" = "upper arm
 * left"), a similar name on the same side, then tree position (unmatched children of matched parents, left to right).
 * Each target is used once. `source`/`target` are rig descriptors, optionally with `role`. Returns { map, how }.
 */
export function matchBones(source, target) {
  const map = {}, how = {}, used = new Set();
  const take = (s, t, why) => { if (!t || used.has(t.id) || map[s.id]) return; map[s.id] = t.id; how[s.id] = why; used.add(t.id); };
  const free = () => target.filter(t => !used.has(t.id));
  for (const s of source) if (s.role) take(s, target.find(t => t.role === s.role), 'role');
  for (const s of source) take(s, free().find(t => canonical(t.name) === canonical(s.name) && canonical(s.name)), 'name');
  for (const s of source) { const a = nameRole(s.name); if (a.kind) take(s, free().find(t => { const b = nameRole(t.name); return b.kind === a.kind && b.side === a.side; }), 'name'); }
  for (const s of source) {
    if (map[s.id]) continue;
    const side = nameRole(s.name).side, best = free().filter(t => nameRole(t.name).side === side).map(t => [t, nameSimilarity(s.name, t.name)]).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= .6) take(s, best[0], 'similar');
  }
  const sourceRoot = source.find(s => !s.parent), targetRoot = target.find(t => !t.parent);
  if (sourceRoot && targetRoot) take(sourceRoot, used.has(targetRoot.id) ? null : targetRoot, 'tree');
  for (const s of source) {
    if (map[s.id] || !s.parent || !map[s.parent]) continue;
    const siblings = source.filter(x => x.parent === s.parent).sort((a, b) => a.x - b.x || a.y - b.y);
    const options = target.filter(t => t.parent === map[s.parent]).sort((a, b) => a.x - b.x || a.y - b.y);
    const at = siblings.indexOf(s), t = options[Math.round(at * (options.length - 1) / Math.max(1, siblings.length - 1))] || options[at];
    take(s, t && !used.has(t.id) ? t : free().find(x => x.parent === map[s.parent]), 'tree');
  }
  return { map, how };
}

// ---- Pose clips and retargeting -------------------------------------------------------------------------------------

/** Leg length (hip to foot) of a rig with roles; without legs half its joint height. */
export function legLength(rig, roles = {}) {
  const len = id => rig.find(b => b.id === id)?.length || 0;
  const leg = Math.max(...['L', 'R'].map(s => len(roles[`upperLeg${s}`]) + len(roles[`lowerLeg${s}`])));
  if (leg > 0) return leg;
  const ys = rig.flatMap(b => [b.box.y, b.box.y + b.box.height]);
  return Math.max(1, (Math.max(...ys) - Math.min(...ys)) / 2);
}
/**
 * A character's animation as a pose clip (for the clipboard and retargeting): its rig (names, rest angles, roles),
 * leg length and per frame the relative angles and the root's move from the first frame.
 */
export function copyAnimationPoses(project, { animationId, rootBoneId, frameId }) {
  const animation = animationOf(project, animationId), first = animation.frames[0];
  const root = rootBoneId || characters(project, animationId, frameId || first.id)[0]?.id;
  if (!root) throw new Error('Rig a character first.');
  const rig = rigDescriptor(project, { animationId, frameId: frameId || first.id, rootBoneId: root }), { roles } = detectRoles(rig), roleOf = new Map(Object.entries(roles).map(([r, id]) => [id, r]));
  const keep = new Set(rig.map(b => b.id)), home = rootPivot(project, first, root);
  return {
    format: POSE_CLIP_FORMAT, version: 1, name: animation.name, fps: animation.fps, rootBoneId: root, legLength: legLength(rig, roles),
    bones: rig.map(b => ({ id: b.id, name: b.name, parent: b.parent, rest: b.rest, ...(roleOf.has(b.id) ? { role: roleOf.get(b.id) } : {}), x: b.x, y: b.y })),
    frames: animation.frames.map(f => {
      const rels = relPose(project, f), c = rootPivot(project, f, root);
      return { duration: f.duration, bones: Object.fromEntries([...rels].filter(([id]) => keep.has(id)).map(([id, a]) => [id, normalizeAngle(roundInt(a))])), move: c && home ? { x: c.x - home.x, y: c.y - home.y } : { x: 0, y: 0 } };
    }),
  };
}
/** Check a pose clip (for example parsed from clipboard text). */
export function readPoseClip(value) {
  const ok = value?.format === POSE_CLIP_FORMAT && Array.isArray(value.bones) && value.bones.length && Array.isArray(value.frames) && value.frames.length && value.frames.length <= 256
    && value.bones.every(b => typeof b?.id === 'string' && Number.isFinite(b.rest ?? 0)) && value.frames.every(f => f && typeof f.bones === 'object' && Number.isInteger(f.duration) && f.duration >= 1 && f.duration <= 60000);
  if (!ok) throw new Error('This is not a copied animation pose clip.');
  return value;
}

/** Canvas row just below an instance's lowest drawn pixel. */
function bottomPixel(op, part) {
  const box = instanceBox(op, part), { pixels, width } = instanceImage(op, part);
  for (let i = pixels.length - 1; i >= 0; i--) if (pixels[i] >= 0) return box.y + Math.floor(i / width) + 1;
  return -Infinity;
}

/**
 * Write posed frames for one character. Each entry {duration, rels: Map(boneId → relative angle), move: {x, y}, ground?,
 * lift?} poses a copy of the base frame (`animationId`/`frameId`): its root pivot goes to the base's plus `move`; with
 * `ground` the figure is then shifted so its lowest pixel rests where its rest pose would stand, raised by `lift`.
 * `mode` 'new' adds an animation `name` after the current one, 'replace' swaps the current animation's frames, 'merge'
 * poses the current animation's frames in order (adding copies of the last as needed) and leaves the rest of each frame.
 * Returns { project, animationId, frameIds }.
 */
export function writePoseFrames(project, { animationId, frameId, rootBoneId, frames, mode = 'new', name, fps }) {
  const p = validateProject(project), animation = animationOf(p, animationId), base = frameOf(animation, frameId);
  if (!frames?.length) throw new Error('There are no poses to write.');
  if (frames.length > 256) throw new Error('At most 256 frames.');
  const home = rootPivot(p, base, rootBoneId);
  if (!home) throw new Error('Show the whole character in this frame first.');
  const keep = subtree(p, rootBoneId), bones = (p.bones || []).filter(b => keep.has(b.id));
  let images = null;
  const lowest = frame => { let y = -Infinity; for (const [id, s] of placed(p, frame)) if (keep.has(id)) { y = Math.max(y, bottomPixel(s.op, (images ||= renderParts(p.parts)).get(s.op.partId))); } return y; };
  let ground = null;
  if (frames.some(f => f.ground)) {
    const rest = makeLayeredFrame(p, base);
    layoutFrame(p, rest, new Map(bones.map(b => [b.id, restOf(b)])), { [rootBoneId]: home });
    ground = lowest(rest);
  }
  const copies = () => frames.map(f => ({ ...makeLayeredFrame(p, base), duration: f.duration }));
  let list, outId = animation.id;
  if (mode === 'new') {
    const ids = new Set(p.animations.map(a => a.id)), stem = slug(name || 'animation');
    outId = stem;
    for (let n = 2; ids.has(outId) || p.animations.some(a => a.frames.some(f => f.id === outId)) || p.layers.some(l => l.id === outId); n++) outId = `${stem}-${n}`;
    list = copies();
    p.animations.splice(p.animations.indexOf(animation) + 1, 0, { id: outId, name: String(name || 'Animation').slice(0, 80), fps: fps ?? animation.fps, ...(animation.layerOrder ? { layerOrder: [...animation.layerOrder] } : {}), frames: list });
  } else if (mode === 'replace') {
    list = animation.frames = copies();
    if (fps) animation.fps = fps;
  } else {
    while (animation.frames.length < frames.length) animation.frames.push({ ...makeLayeredFrame(p, animation.frames.at(-1)), duration: animation.frames.at(-1).duration });
    list = animation.frames.slice(0, frames.length);
    frames.forEach((f, k) => { if (f.duration) list[k].duration = f.duration; });
  }
  frames.forEach((f, k) => {
    const goal = { x: home.x + (f.move?.x || 0), y: home.y + (f.move?.y || 0) };
    layoutFrame(p, list[k], f.rels, { [rootBoneId]: goal });
    if (ground === null || !f.ground) return;
    const dy = ground - lowest(list[k]) - (f.lift || 0);
    if (dy) layoutFrame(p, list[k], f.rels, { [rootBoneId]: { x: goal.x, y: goal.y + dy } });
  });
  return { project: validateProject(p), animationId: outId, frameIds: list.map(f => f.id) };
}

/** Default bone mapping of a clip onto character `rootBoneId`: { rig (target descriptor), roles, map, how } (see matchBones). */
export function retargetMapping(project, { clip, rootBoneId, animationId, frameId }) {
  readPoseClip(clip);
  const rig = rigDescriptor(project, { animationId, frameId, rootBoneId }), { roles } = detectRoles(rig), roleOf = new Map(Object.entries(roles).map(([r, id]) => [id, r]));
  return { rig, roles, ...matchBones(clip.bones, rig.map(b => ({ ...b, role: roleOf.get(b.id) }))) };
}
/**
 * Retarget a pose clip onto the character `rootBoneId` (as shown in `animationId`/`frameId`): `mapping` {sourceId:
 * targetId} — default matchBones — turns each target bone by the source bone's change from its rest angle, so
 * proportions may differ; root moves scale by the leg-length ratio with `scaleMoves`. Writes frames as writePoseFrames
 * (`mode`, `name`). Returns { project, animationId, frameIds, mapping }.
 */
export function retargetAnimation(project, { clip, mapping, rootBoneId, animationId, frameId, mode = 'new', name, scaleMoves = true }) {
  const p = validateProject(project), { rig, roles, map: found } = retargetMapping(p, { clip, rootBoneId, animationId, frameId }), map = mapping || found;
  const srcRest = new Map(clip.bones.map(b => [b.id, b.rest || 0])), tgtRest = new Map(rig.map(b => [b.id, b.rest]));
  const pairs = Object.entries(map).filter(([s, t]) => srcRest.has(s) && tgtRest.has(t));
  if (!pairs.length) throw new Error('No bones match. Pick target bones in the mapping.');
  const scale = scaleMoves && clip.legLength > 0 ? legLength(rig, roles) / clip.legLength : 1;
  const frames = clip.frames.map(f => ({
    duration: f.duration,
    rels: new Map(pairs.filter(([s]) => Number.isFinite(f.bones[s])).map(([s, t]) => [t, tgtRest.get(t) + normalizeAngle(f.bones[s] - srcRest.get(s))])),
    move: { x: (f.move?.x || 0) * scale, y: (f.move?.y || 0) * scale },
  }));
  const out = writePoseFrames(p, { animationId, frameId, rootBoneId, frames, mode, name: name || clip.name, fps: clip.fps });
  return { ...out, mapping: Object.fromEntries(pairs) };
}
