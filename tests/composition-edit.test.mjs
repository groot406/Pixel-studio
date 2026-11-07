import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAIProject } from '../src/formats/pxa.js';
import { validateProject } from '../src/domain/project.js';
import { createAIRequest, prepareAIResult } from '../src/features/ai/requests.js';
import { projectFingerprint } from '../src/features/ai/patch-engine.js';
import { sparklePxa } from './fixtures/pxa-v2.mjs';
import { fixture } from './fixtures/project.mjs';

const opts={mode:'edit',scope:'frame',animationId:'idle',frameId:'f0',instruction:'Move the sparkle right.'};
const response=(request,body)=>`PXAPATCH 2\nBASE ${request.baseFingerprint}\n${body}\nEND\n${request.completionMarker}`;

test('explicit composition mode upgrades a raster cel while preserving the request action and protected cels', () => {
  const source = fixture();
  const request = createAIRequest(source, { ...opts, mode: 'compose', frameId: 'idle-0' });
  assert.equal(request.mode, 'compose'); // The review dialog uses this to retain the copied request and completion marker.
  const result = prepareAIResult(request, response(request, 'TARGET idle idle-0 artwork\nSPAN 0 0 1'));
  assert.equal(result.project.version, 3);
  assert.equal(result.project.animations[0].frames[0].cels[1].pixels[0], 1);
  assert.deepEqual(result.project.animations[0].frames[0].cels[0], source.animations[0].frames[0].cels[0]);
  assert.deepEqual(result.project.animations[0].frames[1], source.animations[0].frames[1]);
  assert.deepEqual(result.project.animations[1], source.animations[1]);
});

test('composition request sends scoped context and moves an instance without touching other frames',()=>{
  const p=decodeAIProject(sparklePxa), request=createAIRequest(p,opts), before=structuredClone(p);
  assert.match(request.prompt,/PXAPATCH 2/);
  assert.doesNotMatch(request.prompt,/FRAME f1 /);
  const result=prepareAIResult(request,response(request,'TARGET idle f0 effects\nAT glint 8 4'));
  assert.equal(result.project.animations[0].frames[0].cels[1].source.ops[0].x,8);
  assert.deepEqual(result.project.animations[0].frames.slice(1),p.animations[0].frames.slice(1));
  assert.deepEqual(result.project.animations[1],p.animations[1]);
  assert.deepEqual(p,before);
});
test('shared edits respect transitive scope, including hidden locked references',()=>{
  const p=decodeAIProject(sparklePxa);
  const edit='PART star 5 5\nRECT 0 0 5 5 2\nENDPART';
  const scoped=createAIRequest(p,opts);
  assert.throws(()=>prepareAIResult(scoped,response(scoped,edit)),/Shared part.*scope/);
  const global=createAIRequest(p,{...opts,scope:'project'});
  const result=prepareAIResult(global,response(global,edit));
  assert.equal(result.changes.parts,1);
  assert.equal(result.project.animations[1].frames[0].cels[1].pixels[4*16+3],2);
  p.layers[0].visible=false;p.layers[0].locked=true;
  p.animations[1].frames[0].cels[0].source.ops.push({type:'use',id:'secret',partId:'star',x:0,y:0,transform:'N'});
  const locked=createAIRequest(validateProject(p),{...opts,scope:'project'});
  assert.throws(()=>prepareAIResult(locked,response(locked,edit)),/locked/);
});
test('forking a part changes one instance while protecting shared definitions',()=>{
  const request=createAIRequest(decodeAIProject(sparklePxa),opts);
  const result=prepareAIResult(request,response(request,'PART local FROM star\nSPAN 2 2 1\nENDPART\nTARGET idle f0 effects\nSWAP glint local'));
  assert.equal(result.project.parts.length,2);
  assert.equal(result.project.animations[0].frames[0].cels[1].pixels[6*16+5],1);
  assert.equal(result.project.animations[0].frames[1].cels[1].pixels[6*16+9],2);
  assert.equal(result.project.animations[0].frames[0].cels[1].source.ops[0].partId,'local');
});
test('structural edits are reviewable even when the rendered image is identical',()=>{
  const request=createAIRequest(decodeAIProject(sparklePxa),opts);
  const result=prepareAIResult(request,response(request,'PART local FROM star\nENDPART\nTARGET idle f0 effects\nSWAP glint local'));
  assert.equal(result.changes.pixels,0);
  assert.equal(result.changes.parts,1);
  assert.equal(result.changes.compositions,1);
  assert.ok(result.hasChanges);
});
test('patches reject incomplete responses, wrong bases, stale source changes, invalid references and targets atomically',()=>{
  const request=createAIRequest(decodeAIProject(sparklePxa),opts), snapshot=structuredClone(request.sourceProject);
  const text=response(request,'TARGET idle f0 effects\nAT glint 1 1');
  for(const invalid of [text.replace('END\n',''),text.replace(request.completionMarker,''),text.replace(request.baseFingerprint,'0000000000000000'),response(request,'TARGET idle f1 effects\nAT glint 1 1'),response(request,'TARGET idle f0 effects\nSWAP glint missing'),response(request,'TARGET idle f0 effects\nOVERRIDE 16 0 0')]) assert.throws(()=>prepareAIResult(request,invalid));
  assert.deepEqual(request.sourceProject,snapshot);
  const oldFingerprint=projectFingerprint(snapshot);
  request.sourceProject.parts[0].ops[0].color=2;
  assert.notEqual(projectFingerprint(request.sourceProject),oldFingerprint);
  assert.throws(()=>prepareAIResult(request,text),/changed/);
});
test('legacy inpaint on a retained cel persists a local erasure instead of destroying references',()=>{
  const p=decodeAIProject(sparklePxa), request=createAIRequest(p,{...opts,mode:'inpaint',layerId:'effects',selection:{x:5,y:6,width:1,height:1}});
  const text=`PXAINPAINT 1\nSIZE 16 16\nRECT 5 6 1 1\nBASE ${projectFingerprint(p)}\nTARGET 0 0 1\nSPAN 6 5 .\n${request.completionMarker}`;
  const result=prepareAIResult(request,text), saved=validateProject(result.project);
  assert.equal(saved.animations[0].frames[0].cels[1].source.ops[0].partId,'star');
  assert.equal(saved.animations[0].frames[0].cels[1].pixels[6*16+5],-1);
  assert.equal(saved.animations[0].frames[1].cels[1].pixels[6*16+9],2);
});
