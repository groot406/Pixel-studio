import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLayout, fitFloatRect, SIZE_LIMITS } from '../src/editor/panel-layout.js';

test('sanitizeLayout clamps sizes and drops malformed entries', () => {
  const layout = sanitizeLayout({
    sizes: { tools: 9999, details: 10, timeline: 'big', bogus: 300 },
    floating: { preview: { x: 10.4, y: 20, width: 50, height: 400 }, 'bad name!': { x: 0, y: 0, width: 300, height: 300 }, layers: { x: 1 } },
    timelineCollapsed: 'yes',
  });
  assert.deepEqual(layout.sizes, { tools: SIZE_LIMITS.tools[1], details: SIZE_LIMITS.details[0] });
  assert.deepEqual(layout.floating, { preview: { x: 10, y: 20, width: 200, height: 400 } });
  assert.equal(layout.timelineCollapsed, false);
  assert.equal(sanitizeLayout({ timelineCollapsed: true }).timelineCollapsed, true);
  assert.deepEqual(sanitizeLayout(null), { sizes: {}, floating: {}, timelineCollapsed: false });
});

test('fitFloatRect keeps the title bar reachable inside the viewport', () => {
  const viewport = { width: 1000, height: 700 };
  assert.deepEqual(fitFloatRect({ x: 5000, y: -50, width: 300, height: 200 }, viewport), { x: 920, y: 8, width: 300, height: 200 });
  assert.deepEqual(fitFloatRect({ x: -900, y: 900, width: 2000, height: 50 }, viewport), { x: -896, y: 660, width: 984, height: 120 });
});
