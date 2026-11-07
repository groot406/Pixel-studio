import test from 'node:test';
import assert from 'node:assert/strict';
import { versionMeta, packProject, unpackProject, thinVersions, trackActivity, snapshotDue, orphanedJournals, versionTime, MINUTE, HOUR, DAY, AUTO_CHANGES } from '../src/domain/versions.js';
import { blankProject, validateProject, compositeFrame } from '../src/domain/project.js';
import { makeStressProject } from '../scripts/stress-project.mjs';
import { memoryStore, openProjectStore } from '../src/storage/workspace.js';

const now = Date.UTC(2025, 5, 15, 12, 30);
const auto = (id, age) => ({ id, kind: 'auto', createdAt: now - age, bytes: 10 });

test('versionMeta summarises a project with a first-frame thumbnail', () => {
  const project = blankProject('Hero');
  project.animations[0].frames[0].cels[0].pixels[3] = 2;
  const meta = versionMeta(project, { id: 'v1', documentId: 'd1', kind: 'named', name: '  Before recolour ', createdAt: now, bytes: 99 });
  assert.equal(meta.name, 'Before recolour');
  assert.deepEqual([meta.frameCount, meta.animationCount, meta.width, meta.bytes], [1, 1, project.width, 99]);
  assert.deepEqual(meta.thumbnail.pixels, compositeFrame(project, project.animations[0].frames[0]));
  assert.notEqual(meta.thumbnail.palette, project.palette);
});

test('thinVersions keeps named versions, the last hour, then one per hour for a day and one per day for a month', () => {
  const versions = [
    { id: 'named-old', kind: 'named', createdAt: now - 90 * DAY, bytes: 10 },
    auto('recent-a', 5 * MINUTE), auto('recent-b', 50 * MINUTE),
    auto('hour-new', 2 * HOUR + 10 * MINUTE), auto('hour-old', 2 * HOUR + 20 * MINUTE),
    auto('other-hour', 5 * HOUR),
    auto('day-new', 3 * DAY), auto('day-old', 3 * DAY + 5 * MINUTE),
    auto('ancient', 40 * DAY),
  ];
  assert.deepEqual(thinVersions(versions, now).sort(), ['ancient', 'day-old', 'hour-old']);
});

test('thinVersions drops the oldest automatic versions first when over the storage cap', () => {
  const versions = [{ id: 'named', kind: 'named', createdAt: now - DAY, bytes: 50 }, auto('a', MINUTE), auto('b', 2 * MINUTE), auto('c', 3 * MINUTE)];
  assert.deepEqual(thinVersions(versions, now, { maxBytes: 75 }), ['c']);
  assert.deepEqual(thinVersions(versions, now, { maxCount: 2 }).sort(), ['b', 'c']);
  assert.deepEqual(thinVersions([{ id: 'n', kind: 'named', createdAt: 0, bytes: 1e9 }], now), []);
});

test('auto snapshots follow active editing time and change counts, ignoring idle pauses', () => {
  let tracker;
  for (let i = 0; i < 4; i++) tracker = trackActivity(tracker, now + i * 2 * HOUR);
  assert.equal(tracker.activeMs, 3 * MINUTE);
  assert.ok(!snapshotDue(tracker));
  for (let i = 1; i <= 3; i++) tracker = trackActivity(tracker, now + 6 * HOUR + i * 50_000);
  assert.ok(snapshotDue(tracker));
  assert.ok(snapshotDue({ changes: AUTO_CHANGES, activeMs: 0 }));
  assert.ok(!snapshotDue(undefined));
});

test('orphaned journals are those whose session stopped beating', () => {
  const entries = [{ documentId: 'a', sessionId: 'live' }, { documentId: 'b', sessionId: 'dead' }, { documentId: 'c', sessionId: 'gone' }, { documentId: 'd', sessionId: 'me' }];
  const beats = { live: now - 2000, dead: now - 60_000 };
  assert.deepEqual(orphanedJournals(entries, beats, now, { sessionId: 'me' }).map(e => e.documentId), ['b', 'c']);
});

test('packProject is lossless (IDs included) and run-length encodes pixels', () => {
  for (const project of [validateProject(blankProject('Raster')), validateProject(makeStressProject({ width: 32, height: 32, layers: 2, frames: 3, instances: 4 }))]) {
    const text = packProject(project);
    assert.deepEqual(unpackProject(text), JSON.parse(JSON.stringify(project)));
    assert.ok(text.length < JSON.stringify(project).length / 2);
  }
  assert.deepEqual(unpackProject(packProject({ name: '#r:1', list: [1, 1, 1, 1, 1, 1, 1, 2.5], ints: [-1, -1, -1, -1, 3, 3, 3, 3, 0] })), { name: '#r:1', list: [1, 1, 1, 1, 1, 1, 1, 2.5], ints: [-1, -1, -1, -1, 3, 3, 3, 3, 0] });
});

test('versionTime reads naturally', () => {
  assert.equal(versionTime(now - 10_000, now), 'just now');
  assert.equal(versionTime(now - 12 * MINUTE, now), '12 min ago');
  assert.match(versionTime(now - 3 * HOUR, now), /^Today \d\d:\d\d$/);
  assert.match(versionTime(now - 3 * DAY, now), /^12 Jun \d\d:\d\d$/);
});

test('the workspace store keeps packed versions and a last good copy of each project (memory fallback)', async () => {
  const store = await openProjectStore();
  assert.equal(store.available, false);
  const project = validateProject(blankProject('Saved'));
  const data = packProject(project);
  const meta = await store.saveVersion({ ...versionMeta(project, { id: 'v1', documentId: 'doc', kind: 'named', name: 'One', createdAt: 1 }), data });
  await store.saveVersion({ ...versionMeta(project, { id: 'v2', documentId: 'doc', createdAt: 2 }), data });
  await store.saveVersion({ ...versionMeta(project, { id: 'v3', documentId: 'other', createdAt: 3 }), data });
  assert.equal(meta.bytes, data.length);
  assert.deepEqual((await store.listVersions('doc')).map(v => v.id), ['v2', 'v1']);
  assert.deepEqual(unpackProject(await store.getVersionData('v1')), project);
  await store.deleteVersions(['v1']);
  assert.deepEqual((await store.listVersions('doc')).map(v => v.id), ['v2']);
  assert.equal(await store.getVersionData('v1'), null);
  await assert.rejects(store.saveVersion({ id: 'bad', documentId: 'doc', kind: 'weird', createdAt: 1, data }));

  const docs = memoryStore();
  await docs.saveDocument({ id: 'doc', project });
  await docs.saveDocument({ id: 'doc', project: { ...project, name: 'Second' } });
  assert.equal((await docs.getDocument('doc')).project.name, 'Second');
  await docs.saveJournal({ documentId: 'doc', sessionId: 's', updatedAt: 5, data });
  assert.equal((await docs.listJournals()).length, 1);
  await docs.deleteJournal('doc');
  assert.equal((await docs.listJournals()).length, 0);
});
