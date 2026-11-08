import test from 'node:test';
import assert from 'node:assert/strict';
import { pinchStep, isTap } from '../src/editor/mobile-layout.js';

test('pinch: spreading fingers zooms, moving both pans', () => {
  const start = [{ x: 100, y: 100 }, { x: 200, y: 100 }];
  assert.deepEqual(pinchStep(start, [{ x: 50, y: 100 }, { x: 250, y: 100 }]), { factor: 2, dx: 0, dy: 0 });
  assert.deepEqual(pinchStep(start, [{ x: 110, y: 130 }, { x: 210, y: 130 }]), { factor: 1, dx: 10, dy: 30 });
});

test('two-finger tap is quick and still; one finger or a pinch is not', () => {
  assert.equal(isTap({ fingers: 2, duration: 150, moved: 3 }), true);
  assert.equal(isTap({ fingers: 1, duration: 150, moved: 0 }), false);
  assert.equal(isTap({ fingers: 2, duration: 150, moved: 40 }), false);
  assert.equal(isTap({ fingers: 3, duration: 600, moved: 0 }), false);
});
