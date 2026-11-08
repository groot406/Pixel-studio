import test from 'node:test';
import assert from 'node:assert/strict';
import { viewTransform, zoomView, panView } from '../src/editor/zoom-preview.js';

test('preview zoom keeps the pixel under the cursor in place and the view stays on the content', () => {
  const fit = { zoom: 1, cx: 0.5, cy: 0.5 };
  assert.deepEqual(viewTransform(fit, 10, 20, 400, 400), { fit: 14.4, scale: 14.4, x: 128, y: 56 }, 'fit centres the content with room for the toolbar');
  const zoomed = zoomView(fit, 2, 150, 100, 10, 20, 400, 400), before = viewTransform(fit, 10, 20, 400, 400), after = viewTransform(zoomed, 10, 20, 400, 400);
  assert.equal(after.scale, 28.8);
  assert.ok(Math.abs((150 - before.x) / before.scale - (150 - after.x) / after.scale) < 1e-9);
  assert.ok(Math.abs((100 - before.y) / before.scale - (100 - after.y) / after.scale) < 1e-9);
  assert.equal(zoomView(fit, 1000, 200, 200, 10, 20, 400, 400).zoom, 64 / 14.4, 'one image pixel is at most 64 screen pixels');
  assert.deepEqual(panView(zoomed, 1e6, -1e6, 10, 20, 400, 400), { zoom: 2, cx: 0, cy: 1 }, 'panning stops at the content edge');
});
