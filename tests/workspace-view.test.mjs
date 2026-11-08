import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_VIEWS, PANEL_IDS, movePanel, normalizeView, normalizeViewStore, sameArrangement } from '../src/domain/workspace-view.js';

const all = view => [...view.left, ...view.right, ...view.hidden].sort();

test('views always place every panel exactly once, dropping unknown and duplicate ids', () => {
  const view = normalizeView({ left: ['palette', 'palette', 'bogus'], right: ['tools'], hidden: ['tools', 'parts'], floating: { parts: { x: 1, y: 1, width: 9, height: 9 }, tools: null } });
  assert.deepEqual(all(view), [...PANEL_IDS].sort());
  assert.deepEqual(view.left.slice(0, 1), ['palette']);
  assert.ok(view.right.includes('tools'), 'first placement wins');
  assert.deepEqual(view.floating, { tools: null }, 'hidden panels cannot float');
  for (const preset of BUILTIN_VIEWS) assert.deepEqual(all(preset.view), [...PANEL_IDS].sort(), preset.id);
});

test('moving panels between sidebars and hiding them', () => {
  let view = movePanel(normalizeView({}), 'preview', 'left', 0);
  assert.equal(view.left[0], 'preview');
  assert.ok(!view.right.includes('preview'));
  view = movePanel({ ...view, floating: { preview: null } }, 'preview', 'hidden');
  assert.ok(view.hidden.includes('preview'));
  assert.deepEqual(view.floating, {});
  assert.ok(!sameArrangement(view, normalizeView({})));
  assert.ok(sameArrangement(normalizeView({ sizes: { tools: 300 } }), normalizeView({})), 'sizes do not count as a different arrangement');
});

test('stored presets are sanitized', () => {
  const store = normalizeViewStore({ active: 'custom-a', custom: [{ id: 'custom-a', name: '  Tiles ', view: { timeline: 'nope', sizes: { tools: 9999 } } }, { id: 'evil', name: 'x' }, { id: 'custom-a', name: 'dupe' }] });
  assert.equal(store.custom.length, 1);
  assert.equal(store.custom[0].name, 'Tiles');
  assert.equal(store.custom[0].view.timeline, 'open');
  assert.equal(store.custom[0].view.sizes.tools, 440);
  assert.equal(store.active, 'custom-a');
  assert.equal(normalizeViewStore({ active: 'gone' }).active, null);
});
