import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneProject, sameValue, shareUnchanged, pushHistory, historyProject, size } from '../src/domain/history.js';
import { validateProject, compositeFrame } from '../src/domain/project.js';
import { partPixels } from '../src/domain/artwork.js';
import { makeStressProject } from '../scripts/stress-project.mjs';

const stress = () => validateProject(makeStressProject({ width: 24, height: 24, layers: 3, frames: 4, instances: 6 }));
const json = value => JSON.parse(JSON.stringify(value));

test('cloneProject and sameValue match JSON copy and comparison semantics', () => {
  const project = stress(), copy = cloneProject(project);
  assert.deepEqual(copy, json(project));
  copy.animations[0].frames[0].cels[0].pixels[0] = 3;
  assert.notEqual(project.animations[0].frames[0].cels[0].pixels[0], 3);
  assert.ok(sameValue({ a: 1, b: undefined }, { a: 1 }));
  assert.ok(!sameValue({ a: [1, 2] }, { a: [1, 2, 3] }));
  assert.ok(!sameValue([1], { 0: 1 }));
  assert.ok(!sameValue(project, copy));
  assert.ok(sameValue(project, json(project)));
});

test('shareUnchanged reuses unchanged subtrees and counts only new values', () => {
  const before = stress(), after = cloneProject(before);
  after.animations[0].frames[1].cels[0].pixels[5] = 2;
  const owned = { count: 0 }, shared = shareUnchanged(after, before, owned);
  assert.ok(sameValue(shared, after));
  assert.equal(shared.animations[0].frames[0], before.animations[0].frames[0]);
  assert.notEqual(shared.animations[0].frames[1].cels[0].pixels, before.animations[0].frames[1].cels[0].pixels);
  assert.equal(shared.animations[0].frames[1].cels[1], before.animations[0].frames[1].cels[1]);
  assert.equal(owned.count, 24 * 24);
  const reordered = cloneProject(before);
  reordered.animations[0].frames.reverse();
  assert.equal(shareUnchanged(reordered, before).animations[0].frames[0], before.animations[0].frames.at(-1));
});

test('undo history shares structure yet every restored project is independent and exact', () => {
  let project = stress();
  const undo = [], expected = [];
  for (let step = 0; step < 6; step++) {
    const before = { project: cloneProject(project) };
    expected.push(json(project));
    project.animations[0].frames[step % 4].cels[step % 3].pixels[step] = step % 16;
    project.name = `Step ${step}`;
    pushHistory(undo, before);
  }
  assert.equal(undo.filter(entry => entry.shared).length, 5);
  assert.ok(undo.slice(1, -1).reduce((sum, e) => sum + e.cost, 0) < size(project));
  for (let step = 5; step >= 0; step--) {
    project = historyProject(undo.pop());
    assert.deepEqual(json(project), expected[step]);
    project.animations[0].frames[0].cels[0].pixels.fill(9);
  }
});

test('pushHistory drops the oldest entries beyond the entry limit or the value cap, keeping the newest top', () => {
  const project = stress(), undo = [];
  for (let i = 0; i < 5; i++) pushHistory(undo, { project: { ...cloneProject(project), name: `v${i}` } }, { limit: 3 });
  assert.deepEqual(undo.map(e => e.project.name), ['v2', 'v3', 'v4']);
  const top = { project: cloneProject(project) };
  pushHistory(undo, top, { maxValues: size(project) * 1.5 });
  assert.equal(undo.at(-1), top);
  assert.ok(undo.length <= 2);
  assert.ok(undo.reduce((sum, e) => sum + e.cost, 0) <= size(project) * 1.5 || undo.length === 1);
});

test('part pixel cache follows part edits and object renders update with them', () => {
  const project = stress(), part = project.parts[0];
  assert.equal(partPixels(part), partPixels(cloneProject(part)));
  const first = compositeFrame(project, project.animations[0].frames[0]);
  const edited = cloneProject(project);
  edited.parts[0].ops = [{ type: 'rect', x: 0, y: 0, width: part.width, height: part.height, color: 1 }];
  assert.notEqual(partPixels(edited.parts[0]), partPixels(part));
  assert.ok(partPixels(edited.parts[0]).every(v => v === 1));
  const clean = validateProject(edited);
  assert.notDeepEqual(compositeFrame(clean, clean.animations[0].frames[0]), first);
  assert.throws(() => { 'use strict'; partPixels(part)[0] = 4; }, TypeError);
});
