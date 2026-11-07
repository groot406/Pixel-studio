/** Offline, reproducible representation benchmark. Bytes are not model tokens. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { encodeAIProject, decodeAIProject } from '../src/formats/pxa.js';
import { encodeRun } from '../src/formats/pxa-v2.js';
import { createEditRequest, prepareEditResult } from '../src/features/ai/edit.js';
import { createAIRequest, prepareAIResult } from '../src/features/ai/requests.js';
import { projectFingerprint } from '../src/features/ai/patch-engine.js';
import { pixelSpans } from '../src/domain/artwork.js';
import { keyPrototype, sparklePxa } from '../tests/fixtures/pxa-v2.mjs';
import { artwork } from '../tests/fixtures/project.mjs';

const cases = [];
for (const name of ['key','campfire','panda','red-panda']) cases.push({name:`${name} (raster import)`, project:decodeAIProject(await readFile(new URL(`../public/samples/${name}.pxa`,import.meta.url),'utf8'))});
const key = await keyPrototype();
assert.deepEqual(artwork(key.project), artwork(key.original));
cases.push({name:'key (authored parts)',project:key.project}, {name:'sparkle (authored parts)',project:decodeAIProject(sparklePxa)});
const rows = [];
const texts = [];
for (const {name,project} of cases) {
  const a=encodeAIProject(project,{version:1}), b=encodeAIProject(project,{version:2});
  assert.deepEqual(artwork(decodeAIProject(b)),artwork(project));
  const timings=[];
  for (let i=0;i<21;i++) {const start=performance.now();decodeAIProject(b);timings.push(performance.now()-start);}
  timings.sort((a,b)=>a-b);
  rows.push({case:name,v1Bytes:Buffer.byteLength(a),v2Bytes:Buffer.byteLength(b),byteReductionPercent:+(100*(1-Buffer.byteLength(b)/Buffer.byteLength(a))).toFixed(1),v2DecodeMedianMs:+timings[10].toFixed(3)});
  texts.push(a,b);
}
const options = { mode:'edit', scope:'frame', animationId:'idle', frameId:'idle_0', layerId:'art', instruction:'Move the key one pixel right.' };
function stableRequest(request,id) {
  const old=request.id;
  request.id=id;
  request.completionMarker=request.completionMarker.replace(old,id);
  request.prompt=request.prompt.replaceAll(old,id);
  return request;
}
const request = stableRequest(createAIRequest(key.project,options),'benchmark_v2');
const patch = `PXAPATCH 2\nBASE ${request.baseFingerprint}\nTARGET idle idle_0 art\nAT body 1 0\nEND\n${request.completionMarker}`;
const edited = prepareAIResult(request,patch).project;
const legacy = stableRequest(createEditRequest(key.project,options),'benchmark_v1');
const full = encodeAIProject({...edited,animations:[{...edited.animations[0],frames:[edited.animations[0].frames[0]]}]},{version:1})+legacy.completionMarker;
assert.deepEqual(artwork(prepareEditResult(legacy,full).project),artwork(edited));
const inpaint = stableRequest(createAIRequest(key.project,{...options,mode:'inpaint',selection:{x:0,y:0,width:32,height:32}}),'benchmark_inpaint');
const before = key.project.animations[0].frames[0].cels[0].pixels, after = edited.animations[0].frames[0].cels[0].pixels;
const spans = pixelSpans(after,32,(i,v)=>v!==before[i]);
const sparse = `PXAINPAINT 1\nSIZE 32 32\nRECT 0 0 32 32\nBASE ${projectFingerprint(key.project)}\nTARGET 0 0 0\n${spans.map(s=>`SPAN ${s.y} ${s.x} ${encodeRun(s.values)}`).join('\n')}\n${inpaint.completionMarker}`;
assert.deepEqual(artwork(prepareAIResult(inpaint,sparse).project),artwork(edited));
const edits = [
  {workflow:'v1 full-frame edit',input:legacy.prompt,output:full},
  {workflow:'v1 existing inpaint',input:inpaint.prompt,output:sparse},
  {workflow:'v2 instance patch',input:request.prompt,output:patch},
];
const editRows = edits.map(e=>({workflow:e.workflow,inputBytes:Buffer.byteLength(e.input),outputBytes:Buffer.byteLength(e.output),totalBytes:Buffer.byteLength(e.input+e.output)}));
for (const e of edits) texts.push(e.input,e.output);
const report={note:'UTF-8 bytes and local decode latency. Optional o200k_base token counts are a comparison proxy, not measured Codex billing. No live model calls, generation-speed or visual-quality claims.',cases:rows,editCase:'Move the Golden Key one pixel right in its idle frame, preserving all other artwork.',edits:editRows};
const pythonIndex = process.argv.indexOf('--tokenizer-python');
if (pythonIndex >= 0) {
  const python = process.argv[pythonIndex+1];
  if (!python) throw new Error('--tokenizer-python needs a Python executable with tiktoken installed.');
  const result = spawnSync(python,['-c','import sys,json,tiktoken; e=tiktoken.get_encoding("o200k_base"); print(json.dumps([len(e.encode(s,disallowed_special=())) for s in json.load(sys.stdin)]))'],{input:JSON.stringify(texts),encoding:'utf8',maxBuffer:1024*1024});
  if (result.status !== 0) throw new Error(result.stderr || 'Tokenizer failed.');
  const counts=JSON.parse(result.stdout);
  report.tokenizer='tiktoken o200k_base (proxy)';
  rows.forEach((row,i)=>Object.assign(row,{v1Tokens:counts[2*i],v2Tokens:counts[2*i+1],tokenReductionPercent:+(100*(1-counts[2*i+1]/counts[2*i])).toFixed(1)}));
  editRows.forEach((row,i)=>{const at=2*(rows.length+i);Object.assign(row,{inputTokens:counts[at],outputTokens:counts[at+1],totalTokens:counts[at]+counts[at+1]});});
}
console.log(JSON.stringify(report,null,2));
if(process.argv.includes('--write')) {
  await writeFile(new URL('../docs/pxa-v2-benchmark.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  await writeFile(new URL('../public/samples/key-v2.pxa',import.meta.url),encodeAIProject(key.project));
}
