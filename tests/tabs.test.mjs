import test from 'node:test';
import assert from 'node:assert/strict';
import { tabsToClose, nextActiveTab, moveTab, pushClosed, MAX_CLOSED_TABS } from '../src/domain/tabs.js';

const ids = ['a', 'b', 'c', 'd'];
test('tabsToClose picks the right group', () => {
  assert.deepEqual(tabsToClose(ids, 'b', 'this'), ['b']);
  assert.deepEqual(tabsToClose(ids, 'b', 'others'), ['a', 'c', 'd']);
  assert.deepEqual(tabsToClose(ids, 'b', 'right'), ['c', 'd']);
  assert.deepEqual(tabsToClose(ids, 'b', 'left'), ['a']);
  assert.deepEqual(tabsToClose(ids, 'b', 'all'), ids);
  assert.deepEqual(tabsToClose(ids, 'b', 'saved', id => id !== 'c'), ['a', 'b', 'd']);
  assert.deepEqual(tabsToClose(ids, 'zz', 'others'), []);
});
test('nextActiveTab keeps the active tab or picks the nearest survivor, right first', () => {
  assert.equal(nextActiveTab(ids, 'b', ['c']), 'b');
  assert.equal(nextActiveTab(ids, 'b', ['b']), 'c');
  assert.equal(nextActiveTab(ids, 'b', ['b', 'c', 'd']), 'a');
  assert.equal(nextActiveTab(ids, 'b', ids), null);
});
test('moveTab and the closed stack', () => {
  assert.deepEqual(moveTab(ids, 'a', 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveTab(ids, 'd', -5), ['d', 'a', 'b', 'c']);
  assert.deepEqual(pushClosed(['x', 'a'], ['a', 'b']), ['x', 'a', 'b']);
  assert.equal(pushClosed([], Array.from({ length: 30 }, (_, i) => `t${i}`)).length, MAX_CLOSED_TABS);
});
