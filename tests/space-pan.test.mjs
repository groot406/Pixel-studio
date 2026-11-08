import test from 'node:test';
import assert from 'node:assert/strict';
import { panScroll } from '../src/editor/space-pan.js';

test('grabbing moves the view opposite to the drag, like dragging paper', () => {
  assert.deepEqual(panScroll({x: 100, y: 50}, {x: 10, y: 10}, {x: 40, y: 0}), {x: 70, y: 60});
});
