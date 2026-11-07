import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SHORTCUTS, TOOL_KEYS, TOURS, TIPS, DOCS, groupShortcuts, resolveStep, readOnboarding, updateOnboarding, sanitizeOnboarding, placeCard, ONBOARDING_KEY } from '../src/editor/onboarding.js';
import { DEMO_NAMES, demoMarkup } from '../src/editor/demos.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const memory = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), data }; };

test('tool shortcuts match the toolbox keycaps', () => {
  const toolbox = Object.fromEntries([...html.matchAll(/data-tool="(\w+)"[^>]*>[\s\S]*?<kbd>(\w)<\/kbd>/g)].map(m => [m[2].toLowerCase(), m[1]]));
  assert.deepEqual(TOOL_KEYS, toolbox);
  assert.equal(new Set(SHORTCUTS.map(s => `${s.group}|${s.keys}`)).size, SHORTCUTS.length);
});

test('shortcut search matches single keys exactly and words anywhere', () => {
  assert.deepEqual(groupShortcuts('').map(g => g.id), ['tools', 'editing', 'frames', 'view', 'modes']);
  const b = groupShortcuts('b').flatMap(g => g.items);
  assert.deepEqual(b.map(s => s.action), ['Pencil']);
  assert.deepEqual(groupShortcuts('?').flatMap(g => g.items).map(s => s.group), ['view']);
  const zoom = groupShortcuts('ZOOM in');
  assert.deepEqual(zoom.map(g => g.id), ['view']);
  assert.ok(groupShortcuts('frame').some(g => g.id === 'frames'));
  assert.deepEqual(groupShortcuts('nothing-like-this'), []);
});

test('every tour, tip and demo points at something real', () => {
  const missing = [];
  const selectors = [...TOURS.flatMap(t => t.steps.flatMap(s => [s.target, s.fallback])), ...TIPS.map(t => t.sel)].filter(Boolean);
  for (const sel of selectors) {
    for (const [, id] of sel.matchAll(/#([\w-]+)/g)) if (!html.includes(`id="${id}"`)) missing.push(sel);
    for (const [, cls] of sel.matchAll(/(?:^|\s)\.([\w-]+)/g)) if (!new RegExp(`class="[^"]*\\b${cls}\\b`).test(html)) missing.push(sel);
    for (const [attr] of sel.matchAll(/data-\w+="[\w-]+"/g)) if (!html.includes(attr)) missing.push(sel);
  }
  assert.deepEqual(missing, []);
  const demos = [...TOURS.flatMap(t => t.steps), ...TIPS].map(s => s.demo).filter(Boolean);
  assert.deepEqual(demos.filter(name => !DEMO_NAMES.includes(name)), []);
  for (const name of DEMO_NAMES) assert.match(demoMarkup(name), /^<svg class="onb-demo"[\s\S]*<\/svg>$/);
  assert.equal(demoMarkup('nope'), '');
  for (const tour of TOURS) assert.ok(tour.steps.every(s => s.title && s.text.length < 200), tour.id);
});

test('docs links point at README headings', () => {
  const slugs = [...readme.matchAll(/^#+ (.+)$/gm)].map(m => `#${m[1].trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-')}`);
  assert.deepEqual(DOCS.map(([, anchor]) => anchor).filter(a => !slugs.includes(a)), []);
});

test('resolveStep skips missing targets, uses fallbacks and stops at the ends', () => {
  const steps = [{ target: '#a' }, { target: '#gone' }, { target: '#hidden', fallback: '#c' }, { target: null }, { target: '#gone' }];
  const find = sel => ['#a', '#c'].includes(sel);
  assert.deepEqual(resolveStep(steps, 0, 1, find), { index: 0, selector: '#a' });
  assert.deepEqual(resolveStep(steps, 1, 1, find), { index: 2, selector: '#c' });
  assert.deepEqual(resolveStep(steps, 3, 1, find), { index: 3, selector: null });
  assert.equal(resolveStep(steps, 4, 1, find), null);
  assert.deepEqual(resolveStep(steps, 1, -1, find), { index: 0, selector: '#a' });
  assert.equal(resolveStep(steps, -1, -1, find), null);
});

test('onboarding progress survives malformed storage and remembers changes', () => {
  const storage = memory();
  assert.deepEqual(readOnboarding(storage), { tours: {}, hints: {}, offered: false, tooltips: true });
  storage.setItem(ONBOARDING_KEY, '{not json');
  assert.equal(readOnboarding(storage).offered, false);
  updateOnboarding(storage, p => { p.tours.basics = 5; p.hints.curve = 6; p.offered = true; p.tooltips = false; });
  assert.deepEqual(readOnboarding(storage), { tours: { basics: 5 }, hints: { curve: 6 }, offered: true, tooltips: false });
  assert.deepEqual(sanitizeOnboarding({ tours: { a: 'x', b: 2 }, hints: [], offered: 'yes' }), { tours: { b: 2 }, hints: {}, offered: false, tooltips: true });
  const failing = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.equal(updateOnboarding(failing, p => { p.offered = true; }).offered, true);
  assert.equal(readOnboarding(null).tooltips, true);
});

test('placeCard picks a side with room, clamps to the viewport and falls back inside', () => {
  const view = { width: 1000, height: 700 }, card = { width: 300, height: 200 };
  assert.deepEqual(placeCard(null, card, view), { x: 350, y: 250, side: 'center', arrow: 0 });
  const tall = placeCard({ left: 10, top: 100, right: 210, bottom: 600 }, card, view);
  assert.equal(tall.side, 'right'); assert.equal(tall.x, 224);
  const wide = placeCard({ left: 0, top: 650, right: 1000, bottom: 690 }, card, view);
  assert.equal(wide.side, 'top'); assert.equal(wide.y, 650 - 14 - 200);
  const corner = placeCard({ left: 950, top: 10, right: 990, bottom: 30 }, card, view);
  assert.equal(corner.side, 'bottom'); assert.equal(corner.x, 1000 - 300 - 12); assert.equal(corner.arrow, 282);
  assert.equal(placeCard({ left: 0, top: 0, right: 1000, bottom: 700 }, card, view).side, 'inside');
  assert.equal(placeCard({ left: 400, top: 300, right: 420, bottom: 320 }, card, view, { order: ['left'] }).side, 'left');
});
