import test from 'node:test';
import assert from 'node:assert/strict';
import { curvePixels, pathPixels, sampleCubic, samplePath, straightHandles, bendThrough, mirrorHandle, cubicPoint, polygonFill, rasterizeSamples, distanceToSamples } from '../src/domain/curves.js';

const key = p => `${p.x},${p.y}`;
const adjacent = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) === 1;
/** A clean 1px stroke: consecutive pixels 8-adjacent, no repeats, no doubled L-corner (a, b, c with a–c diagonal). */
function assertClean(points, { closed = false } = {}) {
  assert.equal(new Set(points.map(key)).size, points.length, 'no duplicate pixels');
  const loop = closed ? [...points, points[0], points[1]] : points;
  for (let i = 1; i < loop.length; i++) assert.ok(adjacent(loop[i - 1], loop[i]), `8-connected at ${key(loop[i])}`);
  for (let i = 2; i < loop.length; i++) {
    const [a, b, c] = loop.slice(i - 2, i + 1);
    const corner = Math.abs(a.x - c.x) === 1 && Math.abs(a.y - c.y) === 1;
    assert.ok(!corner, `no L-corner at ${key(b)}`);
  }
}

test('a cubic curve keeps its endpoints and rasterises cleanly', () => {
  const p0 = { x: 1, y: 20 }, p3 = { x: 30, y: 18 };
  for (const [c1, c2] of [[{ x: 5, y: 0 }, { x: 25, y: 0 }], [{ x: 20, y: 40 }, { x: 5, y: -10 }], straightHandles(p0, p3)]) {
    const points = curvePixels(p0, c1, c2, p3);
    assert.deepEqual(points[0], p0);
    assert.deepEqual(points.at(-1), p3);
    assertClean(points);
  }
});

test('straight handles give the straight line; bendThrough passes through the dragged point', () => {
  const p0 = { x: 0, y: 0 }, p3 = { x: 9, y: 0 };
  assert.deepEqual(curvePixels(p0, ...straightHandles(p0, p3), p3).map(p => p.y), Array(10).fill(0));
  const c = bendThrough(p0, p3, { x: 4.5, y: 6 }), mid = cubicPoint(p0, c, c, p3, 0.5);
  assert.ok(Math.abs(mid.x - 4.5) < 1e-9 && Math.abs(mid.y - 6) < 1e-9);
  assert.deepEqual(mirrorHandle(p0, p3, { x: 2, y: 5 }), { x: 7, y: 5 });
});

test('samples are dense and include the exact endpoints', () => {
  const samples = sampleCubic({ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 20, y: -20 }, { x: 30, y: 0 });
  for (let i = 1; i < samples.length; i++) assert.ok(Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y) < 1);
  assert.deepEqual(samples.at(-1), { x: 30, y: 0 });
  assert.throws(() => sampleCubic({ x: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }), /finite/);
});

test('a smooth path goes through every clicked point', () => {
  const clicks = [{ x: 2, y: 2 }, { x: 12, y: 9 }, { x: 22, y: 3 }, { x: 30, y: 14 }];
  const points = pathPixels(clicks), keys = new Set(points.map(key));
  for (const c of clicks) assert.ok(keys.has(key(c)), `passes ${key(c)}`);
  assert.deepEqual(points[0], clicks[0]);
  assert.deepEqual(points.at(-1), clicks.at(-1));
  assertClean(points);
  assert.deepEqual(pathPixels([{ x: 0, y: 0 }, { x: 3, y: 0 }]), [0, 1, 2, 3].map(x => ({ x, y: 0 })));
});

test('a closed path closes cleanly, also across the seam', () => {
  const clicks = [{ x: 10, y: 2 }, { x: 18, y: 10 }, { x: 10, y: 18 }, { x: 2, y: 10 }];
  const points = pathPixels(clicks, { closed: true });
  assertClean(points, { closed: true });
  assert.ok(adjacent(points.at(-1), points[0]));
  const samples = samplePath(clicks, { closed: true });
  assert.deepEqual(samples.at(-1), clicks[0]);
  const fill = polygonFill(samples, 20, 20), inside = new Set(fill.map(key));
  assert.ok(inside.has('10,10') && !inside.has('0,0') && !inside.has('19,19'));
});

test('repeated pixels from a self-crossing stroke are dropped', () => {
  const points = rasterizeSamples([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 2 }, { x: 2, y: -2 }]);
  assert.equal(new Set(points.map(key)).size, points.length);
  assert.ok(distanceToSamples([{ x: 0, y: 0 }, { x: 10, y: 0 }], { x: 5, y: 3 }) === 3);
});
