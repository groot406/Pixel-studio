import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EASINGS, cubicBezier, ease, tweenPose, tweenFrames, squashStretch, impactSquash, bezierPoint, arcThrough, samplePath,
  pathLengthParam, springFollow, loopSpring, overlapDelay, solveTwoBone, rotateAboutPivot, pivotWorld, motionVector, smearSteps,
} from '../src/domain/motion.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const nearPoint = (p, q, eps = 1e-6) => { near(p.x, q.x, eps); near(p.y, q.y, eps); };

test('easings hit endpoints; monotonic ones never decrease; back/elastic overshoot', () => {
  for (const [name, fn] of Object.entries(EASINGS)) { near(fn(0), 0, 1e-12); near(fn(1), 1, 1e-12); assert.ok(name); }
  for (const name of ['linear', 'easeIn', 'easeOut', 'easeInOut', 'cubicIn', 'cubicOut', 'cubicInOut']) {
    for (let i = 1; i <= 100; i += 1) assert.ok(EASINGS[name](i / 100) >= EASINGS[name]((i - 1) / 100), name);
  }
  assert.ok(EASINGS.backIn(0.2) < 0 && EASINGS.backOut(0.8) > 1 && EASINGS.elasticOut(0.2) > 1);
  assert.equal(ease('easeIn', 2), 1); assert.equal(ease('easeIn', -1), 0);
  assert.throws(() => ease('nope', 0.5));
});

test('cubicBezier matches known curves', () => {
  const lin = cubicBezier(0, 0, 1, 1), ease = cubicBezier(0.25, 0.1, 0.25, 1), inOut = cubicBezier(0.42, 0, 0.58, 1);
  for (const t of [0.1, 0.37, 0.8]) near(lin(t), t, 1e-6);
  near(inOut(0.5), 0.5, 1e-6);
  near(ease(0.5), 0.8024033877399112, 1e-5); // CSS `ease` at 50%
  near(cubicBezier(0.68, -0.6, 0.32, 1.6)(0.5), 0.5, 1e-6);
  assert.equal(ease(0), 0); assert.equal(ease(1), 1);
});

test('tweenPose rounds, keeps sizes ≥ 1 and turns the short way', () => {
  const pose = tweenPose({ id: 'a', x: 0, y: 0, width: 4, height: 2, angle: 170 }, { x: 10, y: -5, width: 0, height: 2, angle: -170 }, 0.5);
  assert.deepEqual(pose, { id: 'a', x: 5, y: -3, width: 2, height: 2, angle: 180 });
  assert.equal(tweenPose({ angle: 170 }, { angle: -170 }, 0.75).angle, -175);
  assert.equal(tweenPose({ angle: -10 }, { angle: 10 }, 0.5).angle, 0);
  assert.equal(tweenPose({ x: 0, width: 1 }, { x: 1, width: 0 }, 1).width, 1);
  const frames = tweenFrames({ x: 0 }, { x: 8 }, 5);
  assert.deepEqual(frames.map(f => f.x), [0, 2, 4, 6, 8]);
  assert.deepEqual(tweenFrames({ x: 0 }, { x: 8 }, 3, { includeEnds: false }).map(f => f.x), [2, 4, 6]);
});

test('squash & stretch preserves area and follows the motion', () => {
  const base = { width: 12, height: 12 };
  assert.deepEqual(squashStretch({ x: 0, y: 0 }, base), { width: 12, height: 12, angle: 0 });
  for (const v of [{ x: 6, y: 0 }, { x: 0, y: -9 }, { x: 3, y: 4 }, { x: -20, y: 2 }, { x: 1, y: 30 }]) {
    const s = squashStretch(v, base);
    assert.ok(Math.abs(s.width * s.height - 144) <= Math.max(s.width, s.height), JSON.stringify(s));
    assert.ok(s.angle >= -45 && s.angle <= 45);
  }
  const fall = squashStretch({ x: 0, y: 12 }, base);
  assert.ok(fall.height > fall.width && fall.angle === 0);
  const run = squashStretch({ x: 100, y: 0 }, base, { max: 0.5 });
  assert.equal(run.width, 18); // capped at 1.5×
  assert.equal(squashStretch({ x: 5, y: 5 }, base).angle, 45);
  const land = impactSquash({ width: 10, height: 10 }, 0.25);
  assert.ok(land.width > 10 && land.height < 10 && Math.abs(land.width * land.height - 100) <= land.width);
  assert.equal(land.dy, 10 - land.height);
});

test('paths: bezier, arcs through three points, constant-speed reparam', () => {
  nearPoint(bezierPoint({ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }, 0.5), { x: 5, y: 7.5 });
  for (const [a, b, c] of [[{ x: 0, y: 0 }, { x: 5, y: -5 }, { x: 10, y: 0 }], [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }], [{ x: 3, y: 1 }, { x: -2, y: 7 }, { x: 9, y: 9 }]]) {
    const arc = arcThrough(a, b, c);
    nearPoint(arc(0), a); nearPoint(arc(1), c);
    const pts = samplePath(arc, 2001);
    assert.ok(pts.some(p => Math.hypot(p.x - b.x, p.y - b.y) < 0.05), 'passes through b');
  }
  const line = arcThrough({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 4, y: 4 });
  nearPoint(line(0.5), { x: 2, y: 2 });
  const eased = samplePath(line, 3, 'easeIn');
  nearPoint(eased[1], { x: 1, y: 1 });
  const curve = t => ({ x: 10 * t * t, y: 0 }), even = pathLengthParam(curve);
  near(even.totalLength, 10, 1e-9);
  near(even(0.5).x, 5, 1e-3); near(even(0.25).x, 2.5, 1e-3);
});

test('springs lag, converge and loop seamlessly', () => {
  const step = [0, ...Array(80).fill(10)], out = springFollow(step);
  assert.ok(out[1] < 10 && out[1] > 0);
  near(out.at(-1), 10, 1e-4);
  assert.ok(Math.max(...springFollow(step, { damping: 0.2 })) > 10, 'underdamped overshoots');
  const spin = loopSpring(Array.from({ length: 8 }, (_, i) => normalize(i * 45)), { angles: true });
  assert.ok(spin.every(a => a > -180 && a <= 180));
  assert.deepEqual(springFollow([170, -170], { angles: true, stiffness: 1, damping: 1 }), [170, -170]);
  assert.deepEqual(overlapDelay([1, 2, 3, 4], 1), [4, 1, 2, 3]);
  assert.deepEqual(overlapDelay([1, 2, 3, 4], 2, { loop: false }), [1, 1, 1, 2]);
});
const normalize = a => (((a % 360) + 360) % 360 > 180 ? (((a % 360) + 360) % 360) - 360 : ((a % 360) + 360) % 360);

test('loopSpring is periodic: the seam matches a further pass', () => {
  const loop = [0, 5, 10, 5, 0, -5, -10, -5];
  const s = loopSpring(loop, { tolerance: 1e-9, maxLoops: 200 });
  const twice = loopSpring([...loop, ...loop], { tolerance: 1e-9, maxLoops: 200 });
  for (let i = 0; i < 8; i += 1) { near(twice[i], s[i], 1e-6); near(twice[i + 8], s[i], 1e-6); }
  // Seam continuity: the step from last to first frame is like any other step, unlike a cold-started spring.
  const steps = s.map((v, i) => Math.abs(v - s[(i + 7) % 8]));
  assert.ok(steps[0] <= Math.max(...steps.slice(1)) + 1e-9);
});

test('two-bone IK reaches reachable targets and clamps the rest', () => {
  const root = { x: 0, y: 0 };
  for (const target of [{ x: 10, y: 0 }, { x: 3, y: 4 }, { x: -6, y: 2 }, { x: 0, y: 2.5 }]) {
    for (const bend of [1, -1]) {
      const r = solveTwoBone(root, target, 6, 4, bend);
      assert.ok(r.reached); nearPoint(r.end, target, 1e-6);
      near(Math.hypot(r.joint.x, r.joint.y), 6);
    }
  }
  const up = solveTwoBone(root, { x: 8, y: 0 }, 5, 5, 1), down = solveTwoBone(root, { x: 8, y: 0 }, 5, 5, -1);
  assert.ok(up.joint.y < 0 && down.joint.y > 0 && Math.sign(up.angle2) === -Math.sign(up.angle1));
  const far = solveTwoBone(root, { x: 0, y: 30 }, 6, 4);
  assert.equal(far.reached, false); nearPoint(far.end, { x: 0, y: 10 }); near(far.angle1, 90); near(far.angle2, 0);
  const close = solveTwoBone(root, { x: 1, y: 0 }, 6, 4);
  assert.equal(close.reached, false); nearPoint(close.end, { x: 2, y: 0 });
});

test('pivot rotation and smear helpers', () => {
  const box = { x: 0, y: 0, width: 10, height: 4 };
  const r = rotateAboutPivot(box, { x: 0, y: 2 }, 90);
  nearPoint(r.centre, { x: 0, y: 7 }); assert.deepEqual({ x: r.x, y: r.y }, { x: -5, y: 5 });
  assert.deepEqual({ x: rotateAboutPivot(box, null, 37).x, y: rotateAboutPivot(box, null, 37).y }, { x: 0, y: 0 });
  assert.deepEqual(pivotWorld({ x: 3, y: 4, transform: 'N' }, { width: 6, height: 2 }), { x: 6, y: 5 });
  assert.deepEqual(pivotWorld({ x: 3, y: 4, transform: 'N', pivot: { x: 1, y: 0 } }, { width: 6, height: 2 }), { x: 4.5, y: 4.5 });
  assert.deepEqual(pivotWorld({ x: 3, y: 4, transform: 'R90' }, { width: 6, height: 2 }), { x: 4, y: 7 });
  assert.deepEqual(motionVector({ x: 0, y: 0 }, { x: 0, y: 5 }), { dx: 0, dy: 5, length: 5, angle: 90 });
  assert.deepEqual(smearSteps({ x: 0, y: 0 }, { x: 8, y: -4 }, 3), [{ x: 2, y: -1 }, { x: 4, y: -2 }, { x: 6, y: -3 }]);
});
