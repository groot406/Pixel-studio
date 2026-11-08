import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import {
  validateProject, compositeFrame, getAnimationLayers, moveAnimationLayer,
  insertProjectLayer, removeProjectLayer, canMergeLayerDown, mergeLayerDown,
} from '../src/domain/project.js';
import { decodeAIProject, encodeAIProject } from '../src/formats/pxa.js';
import { encodePixelProject, decodePixelProject } from '../src/formats/pxs.js';
import { projectFingerprint } from '../src/features/ai/patch-engine.js';
import { createAIRequest, prepareAIResult } from '../src/features/ai/requests.js';
import { compareProjects } from '../src/features/ai/comparison.js';
import { fixture, artwork, options } from './fixtures/project.mjs';
import { sparklePxa } from './fixtures/pxa-v2.mjs';

function overlappingProject() {
  const project = fixture();
  project.layers[0].locked = false;
  for (const animation of project.animations) for (const frame of animation.frames) {
    frame.cels[0].pixels[0] = 0;
    frame.cels[1].pixels[0] = 1;
  }
  return project;
}

test('moving a layer changes every frame of only its animation and retains shared definitions', () => {
  const project = overlappingProject(), before = structuredClone(project);
  assert.equal(moveAnimationLayer(project,project.animations[0],'artwork',-1),true);
  assert.deepEqual(project.layers,before.layers);
  assert.deepEqual(project.animations[1],before.animations[1]);
  for (const frame of project.animations[0].frames) assert.equal(compositeFrame(project,frame)[0],0);
  assert.equal(compositeFrame(project,project.animations[1].frames[0])[0],1);
  assert.equal(moveAnimationLayer(project,project.animations[0],'artwork',-1),false);
  project.layers[0].visible = false;
  assert.equal(compositeFrame(project,project.animations[0].frames[0])[0],1);
  assert.deepEqual(validateProject(project).animations[0].layerOrder,['artwork','background']);
});

test('legacy projects inherit declaration order and explicit orders are validated and cloned', () => {
  const project = fixture();
  assert.equal(validateProject(project).animations[0].layerOrder,undefined);
  for (const order of [[], ['artwork'], ['artwork','artwork'], ['artwork','missing'], 'artwork', [,'artwork']]) {
    project.animations[0].layerOrder = order;
    assert.throws(() => validateProject(project),/layer order/);
  }
  project.animations[0].layerOrder = ['artwork','background'];
  const clean = validateProject(project);
  clean.animations[0].layerOrder.reverse();
  assert.deepEqual(project.animations[0].layerOrder,['artwork','background']);
  project.layers[0].id = 'legacy layer ID';
  project.animations[0].layerOrder[1] = 'legacy layer ID';
  for (const animation of project.animations) for (const frame of animation.frames) frame.cels[0].layerId = 'legacy layer ID';
  const remapped = validateProject(project);
  assert.equal(remapped.animations[0].layerOrder[1],remapped.layers[0].id);
});

test('adding, duplicating and deleting shared layers preserve all animation stacks and cels', () => {
  const project = overlappingProject();
  moveAnimationLayer(project,project.animations[0],'artwork',-1);
  const layer = {id:'copy',name:'Copy',visible:true,locked:false};
  insertProjectLayer(project,layer,'artwork','artwork');
  assert.deepEqual(getAnimationLayers(project,project.animations[0]).map(l=>l.id),['artwork','copy','background']);
  assert.deepEqual(getAnimationLayers(project,project.animations[1]).map(l=>l.id),['background','artwork','copy']);
  for (const animation of project.animations) for (const frame of animation.frames) {
    const copy = frame.cels.find(c=>c.layerId==='copy'), original = frame.cels.find(c=>c.layerId==='artwork');
    assert.deepEqual(copy.pixels,original.pixels);
    assert.notEqual(copy.pixels,original.pixels);
  }
  assert.equal(canMergeLayerDown(project,'copy','artwork'),true);
  assert.equal(canMergeLayerDown(project,'background','copy'),false);
  assert.equal(canMergeLayerDown(project,'artwork','background'),false);
  removeProjectLayer(project,'artwork');
  assert.deepEqual(validateProject(project).animations[0].layerOrder,['copy','background']);
  assert.ok(project.animations.every(a=>a.frames.every(f=>f.cels.length===2 && !f.cels.some(c=>c.layerId==='artwork'))));
});

test('merging a layer down keeps every frame looking the same and keeps the top layer', () => {
  const project = overlappingProject();
  moveAnimationLayer(project,project.animations[0],'artwork',-1);
  insertProjectLayer(project,{id:'copy',name:'Copy',visible:true,locked:false},'artwork');
  const frames = project.animations.flatMap(a=>a.frames);
  for (const frame of frames) { const cel = frame.cels.find(c=>c.layerId==='copy'); cel.pixels = cel.pixels.map((_,i)=>i%3===0?1:-1); }
  const before = frames.map(frame=>compositeFrame(project,frame));
  assert.equal(mergeLayerDown(project,'copy').id,'artwork');
  assert.deepEqual(frames.map(frame=>compositeFrame(project,frame)),before);
  assert.ok(project.layers.some(l=>l.id==='copy' && l.name==='Copy') && !project.layers.some(l=>l.id==='artwork'));
  assert.throws(()=>mergeLayerDown(project,'background'),/not stacked the same way|no layer below/);
});

test('merging a pixel layer into a layer with objects keeps the objects above it', async () => {
  const { readFile } = await import('node:fs/promises');
  const { decodePXA2 } = await import('../src/formats/pxa-v2.js');
  const project = decodePXA2(await readFile(new URL('../public/samples/key-v2.pxa', import.meta.url), 'utf8')), top = project.layers[0].id;
  project.layers.unshift({ id: 'outline', name: 'Magic outline', visible: true, locked: false });
  const frames = project.animations.flatMap(a => a.frames);
  for (const frame of frames) frame.cels.push({ layerId: 'outline', pixels: Array(project.width * project.height).fill(-1).map((_, i) => i % 7 === 0 ? 1 : -1) });
  const before = frames.map(frame => compositeFrame(project, frame));
  mergeLayerDown(project, top);
  assert.deepEqual(frames.map(frame => compositeFrame(project, frame)), before);
  const ops = frames[0].cels.find(c => c.layerId === top).source.ops;
  assert.deepEqual(ops[0], { type: 'span', x: 0, y: 0, values: [1] }, 'the merged pixels are drawn first, under the objects');
  assert.ok(ops.some(op => op.type === 'use'));
});

test('JSON, PXA 1, PXA 2 and PXS retain independent animation orders and rendered pixels', async () => {
  const project = overlappingProject();
  moveAnimationLayer(project,project.animations[0],'artwork',-1);
  const imported = [validateProject(JSON.parse(JSON.stringify(project))),
    ...[1,2].map(version=>decodeAIProject(encodeAIProject(project,{version}))),
    await decodePixelProject(await encodePixelProject(project))];
  for (const result of imported) {
    assert.deepEqual(artwork(result),artwork(project));
    result.animations.forEach((animation,i)=>animation.frames.forEach((frame,j)=>{
      assert.deepEqual(compositeFrame(result,frame),compositeFrame(project,project.animations[i].frames[j]));
    }));
  }
  // PXS uses its original payload layout for legacy projects, and a versioned layout for ORDER.
  for (const [source,schema] of [[fixture(),2],[project,3]]) {
    const bytes = await encodePixelProject(source);
    const payload = bytes[5] ? gunzipSync(bytes.subarray(20)) : bytes.subarray(20);
    assert.equal(payload[0],schema);
  }
});

for (const version of [1,2]) {
  test(`PXA ${version} rejects incomplete, duplicate, unknown and misplaced layer orders`, () => {
    const project = overlappingProject();
    moveAnimationLayer(project,project.animations[0],'artwork',-1);
    const text = encodeAIProject(project,{version}), order = text.match(/^ORDER .+$/m)[0];
    const invalid = version === 1 ? ['ORDER 1','ORDER 1 1','ORDER 1 9','ORDER -1 0']
      : ['ORDER artwork','ORDER artwork artwork','ORDER artwork missing'];
    for (const command of invalid) assert.throws(()=>decodeAIProject(text.replace(order,command)),/ORDER|Layer index/);
    assert.throws(()=>decodeAIProject(text.replace(order,`${order}\n${order}`)),/ORDER/);
    assert.throws(()=>decodeAIProject(text.replace(order,'').replace(/^(FRAME .+)$/m,`$1\n${order}`)),/ORDER/);
    assert.throws(()=>decodeAIProject(text.replace(order,'').replace(/^(ANIM .+)$/m,`${order}\n$1`)),/ORDER/);
  });
}

test('PXA 2 FROM copies pixels without inheriting another animation order', () => {
  const project = overlappingProject();
  moveAnimationLayer(project,project.animations[0],'artwork',-1);
  const text = encodeAIProject(project,{version:2});
  assert.match(text,/FRAME walk-0 125 FROM idle-1/);
  const result = decodeAIProject(text);
  assert.equal(compositeFrame(result,result.animations[1].frames[0])[0],1);
});

test('retained parts and cel sources survive PXA 2 round trips with animation orders', () => {
  const project = decodeAIProject(sparklePxa);
  moveAnimationLayer(project,project.animations[0],'effects',-1);
  assert.deepEqual(decodeAIProject(encodeAIProject(project,{version:2})),project);
});

test('PXS rejects corrupt animation orders even with a valid container checksum', async () => {
  const project = overlappingProject();
  moveAnimationLayer(project,project.animations[0],'artwork',-1);
  const encoded = await encodePixelProject(project);
  const original = encoded[5] ? new Uint8Array(gunzipSync(encoded.subarray(20))) : encoded.slice(20);
  // Find the first animation order after the bounded strings, palette, layer metadata and frame count.
  const view = new DataView(original.buffer,original.byteOffset,original.byteLength);
  let offset = 6;
  const skipString = () => { offset += 2 + view.getUint16(offset,true); };
  skipString(); offset += project.palette.length * 3;
  for (const _layer of project.layers) { skipString(); skipString(); offset++; }
  skipString(); skipString(); offset += 8 + 2;
  for (const order of [[0,0],[0,2]]) {
    const payload = original.slice(); payload.set(order,offset);
    let crc = 0xffffffff;
    for (const value of payload) {
      crc ^= value;
      for (let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
    }
    const container = new Uint8Array(20+payload.length);
    container.set(encoded.subarray(0,20)); container[5]=0;
    const header = new DataView(container.buffer);
    header.setUint32(8,payload.length,true); header.setUint32(12,payload.length,true);
    header.setUint32(16,(crc^0xffffffff)>>>0,true);
    container.set(payload,20);
    await assert.rejects(decodePixelProject(container),/layer order/);
  }
});

test('layer order affects stale-response fingerprints and comparison even without pixel changes', () => {
  const before = fixture(), after = structuredClone(before);
  moveAnimationLayer(after,after.animations[0],'artwork',-1);
  assert.notEqual(projectFingerprint(before),projectFingerprint(after));
  const {changes} = compareProjects(before,after);
  assert.equal(changes.layersMoved,2);
  assert.equal(changes.layers,2);
  assert.equal(changes.animations,1);
  assert.equal(changes.pixels,0);
  assert.equal(changes.visiblePixels,0);
});

test('scoped raster AI edits preserve animation order and reject attempts to change it', () => {
  const project = overlappingProject();
  moveAnimationLayer(project,project.animations[0],'artwork',-1);
  for (const scope of ['frame','animation']) {
    const request = createAIRequest(project,{...options,mode:'edit',scope});
    const edited = structuredClone(request.targetProject);
    edited.animations[0].frames[0].cels[1].pixels[9] = 2;
    const reply = () => `${encodeAIProject(edited,{version:1})}\n${request.completionMarker}`;
    const result = prepareAIResult(request,reply());
    assert.deepEqual(result.project.animations[0].layerOrder,project.animations[0].layerOrder);
    assert.deepEqual(result.project.animations[1],project.animations[1]);
    delete edited.animations[0].layerOrder;
    assert.throws(()=>prepareAIResult(request,reply()),/layer order/);
  }
});

test('project AI edits bind order to layer identities and protect locked animation positions', () => {
  const project = overlappingProject();
  moveAnimationLayer(project,project.animations[0],'artwork',-1);
  const request = createAIRequest(project,{...options,mode:'edit',scope:'project'});
  const reply = request.sourcePxa.replace('ORDER 1 0','ORDER 0 1') + request.completionMarker;
  const result = prepareAIResult(request,reply);
  assert.deepEqual(result.project.animations[0].layerOrder,['background','artwork']);
  assert.equal(result.hasChanges,true);
  assert.equal(result.changes.pixels,0);
  project.layers[0].locked = true;
  const locked = createAIRequest(project,{...options,mode:'edit',scope:'project'});
  assert.throws(()=>prepareAIResult(locked,locked.sourcePxa.replace('ORDER 1 0','ORDER 0 1') + locked.completionMarker),/Locked layer.*position/);
});
