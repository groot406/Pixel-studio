import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apportion, easeDurations, evenDurations, scaleDurations, snapDuration, framesAt, formatHold, nextKind, findKey, markKinds,
  onionPlan, moveFrames, reverseFrames, pingPongFrames, playbackRange, nextPlaybackIndex, totalDuration,
} from '../src/domain/timing.js';

const frames = ids => ids.map(id => ({ id }));
const ids = list => list.map(f => f.id).join('');

test('apportion keeps the exact total and the minimum', () => {
  assert.deepEqual(apportion([1, 1, 1], 100), [34, 33, 33]);
  assert.deepEqual(apportion([0, 0], 10), [5, 5]);
  assert.equal(totalDuration(apportion([5, 0.001, 3], 61)), 61);
  assert.ok(apportion([1000, 0.0001], 50).every(d => d >= 1));
  assert.throws(() => apportion([1, 1, 1], 2), /at least 3 ms/);
});

test('easeDurations redistributes the total following the easing', () => {
  const input = [100, 100, 100, 100];
  const easeIn = easeDurations(input, { easing: 'easeIn' });
  assert.equal(totalDuration(easeIn), 400);
  assert.ok(easeIn[0] > easeIn[1] && easeIn[1] > easeIn[2] && easeIn[2] > easeIn[3], `slow start: ${easeIn}`);
  const easeOut = easeDurations(input, { easing: 'easeOut' });
  assert.deepEqual(easeOut, [...easeIn].reverse());
  const inOut = easeDurations([100, 100, 100, 100, 100, 100], { easing: 'easeInOut', total: 900 });
  assert.equal(totalDuration(inOut), 900);
  assert.ok(inOut[0] > inOut[2] && inOut[5] > inOut[3], `slow ends: ${inOut}`);
  assert.deepEqual(evenDurations([50, 300, 100]), [150, 150, 150]);
  assert.deepEqual(evenDurations([50, 300], 101), [51, 50]);
  assert.deepEqual(easeDurations([], {}), []);
  assert.throws(() => easeDurations([100, 100], { easing: 'bounceOut' }), /Timing easing/);
  assert.throws(() => easeDurations([100, 100], { total: 1 }), /Total time/);
});

test('scaling and snapping durations', () => {
  assert.deepEqual(scaleDurations([125, 1, 50000], 2), [250, 2, 60000]);
  assert.deepEqual(scaleDurations([125, 3], 0.5), [63, 2]);
  assert.throws(() => scaleDurations([1], 0), /positive/);
  assert.equal(snapDuration(133), 130);
  assert.equal(snapDuration(2), 10);
  assert.equal(snapDuration(190, { fps: 8 }), 250);
  assert.equal(snapDuration(20, { fps: 8 }), 125);
  assert.equal(framesAt(250, 8), 2);
  assert.equal(formatHold(125, 8), '125 ms · 1 frame at 8 fps');
});

test('frame kinds cycle, mark and navigate between keys', () => {
  assert.deepEqual([undefined, 'key', 'breakdown', 'inbetween'].map(nextKind), ['key', 'breakdown', 'inbetween', undefined]);
  const list = [{ id: 'a', kind: 'key' }, { id: 'b' }, { id: 'c', kind: 'key' }, { id: 'd' }];
  assert.equal(findKey(list, 0, 1), 2);
  assert.equal(findKey(list, 3, 1), 0);
  assert.equal(findKey(list, 1, -1), 0);
  assert.equal(findKey([{ kind: 'key' }, {}], 0, 1), -1);
  const project = { animations: [{ id: 'run', frames: frames(['a', 'b', 'c']) }] };
  markKinds(project, 'run', { key: ['a', 'c'], inbetween: ['b'] });
  assert.deepEqual(project.animations[0].frames.map(f => f.kind), ['key', 'inbetween', 'key']);
});

test('onionPlan picks ghosts with falloff, wrap and keys only', () => {
  const plan = onionPlan(6, 0, { before: 2, after: 1, opacity: 0.5, falloff: 0.5 });
  assert.deepEqual(plan.map(g => [g.index, g.side, g.alpha]), [[4, 'prev', 0.25], [5, 'prev', 0.5], [1, 'next', 0.5]]);
  assert.deepEqual(onionPlan(6, 0, { before: 2, after: 1, wrap: false }).map(g => g.index), [1]);
  assert.deepEqual(onionPlan(3, 1, { before: 3, after: 3 }).map(g => g.index).sort(), [0, 2], 'no frame twice');
  assert.deepEqual(onionPlan(5, 2, { before: 0, after: 0 }), []);
  const kinds = ['key', undefined, 'inbetween', 'key', undefined];
  assert.deepEqual(onionPlan(5, 2, { before: 1, after: 1, keysOnly: true, kinds }).map(g => g.index), [0, 3]);
  assert.deepEqual(onionPlan(3, 1, { keysOnly: true, kinds: [] }).map(g => g.index).sort(), [0, 2], 'no keys marked: plain frames');
});

test('moving, reversing and ping-ponging frames', () => {
  const list = frames(['a', 'b', 'c', 'd', 'e']);
  assert.equal(ids(moveFrames(list, ['b'], 4)), 'acdbe');
  assert.equal(ids(moveFrames(list, ['d', 'b'], 0)), 'bdace');
  assert.equal(ids(moveFrames(list, ['a', 'b'], 5)), 'cdeab');
  assert.equal(ids(reverseFrames(list, ['a', 'c', 'e'])), 'ebcda');
  assert.equal(ids(pingPongFrames(frames(['a', 'b', 'c', 'd']))), 'cb');
  assert.deepEqual(pingPongFrames(frames(['a', 'b'])), []);
});

test('playback ranges loop inside the selection', () => {
  const list = frames(['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(playbackRange(list, ['d', 'b']), { start: 1, end: 3 });
  assert.equal(playbackRange(list, ['c']), null);
  const range = { start: 1, end: 3 };
  assert.deepEqual([0, 1, 2, 3, 4].map(i => nextPlaybackIndex(i, 5, range)), [1, 2, 3, 1, 1]);
  assert.deepEqual([3, 4].map(i => nextPlaybackIndex(i, 5, null)), [4, 0]);
  assert.equal(nextPlaybackIndex(2, 3, range), 0, 'stale range is ignored');
});
