import test from 'node:test';
import assert from 'node:assert/strict';
import { panScroll } from '../src/editor/space-pan.js';
import { wheelZoomStep, wheelPixels } from '../src/editor/wheel-zoom.js';

test('grabbing moves the view opposite to the drag, like dragging paper', () => {
  assert.deepEqual(panScroll({x: 100, y: 50}, {x: 10, y: 10}, {x: 40, y: 0}), {x: 70, y: 60});
});

test('wheel zoom steps once per notch, faster when zoomed in, within the limits', () => {
  assert.equal(wheelZoomStep(4, -20, 32), null);
  assert.equal(wheelZoomStep(4, -100, 32), 6);
  assert.equal(wheelZoomStep(20, -50, 32), 24);
  assert.equal(wheelZoomStep(2, 50, 32), 1);
  assert.equal(wheelZoomStep(1, 300, 32), 1);
  assert.equal(wheelZoomStep(30, -400, 32), 32);
  assert.equal(wheelPixels({ deltaY: 3, deltaMode: 1 }), 48);
});
