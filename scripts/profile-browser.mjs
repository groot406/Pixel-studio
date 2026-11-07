/**
 * Browser profile of the editor on stress projects. Needs a running server (`node local/start.mjs --port 4405`) and Playwright
 * installed somewhere outside the app (it has no runtime dependencies), e.g. `npm i playwright` in a scratch folder:
 *   PLAYWRIGHT_DIR=.pw-perf node scripts/profile-browser.mjs [--browser webkit|chromium] [--url http://127.0.0.1:4405/]
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeStressProject, STRESS_PRESETS } from './stress-project.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const scratch = resolve(process.env.PLAYWRIGHT_DIR || '.pw-perf');
const { [arg('browser', 'webkit')]: browserType } = createRequire(resolve(scratch, 'package.json'))('playwright');
const url = new URL(arg('url', 'http://127.0.0.1:4405/'));
url.searchParams.set('perf', '1');

/** Runs inside the page: medians of editor operations via the `?perf` hook, plus a dispatched pencil stroke. */
async function measure() {
  const perf = globalThis.pixelStudioPerf, frame = () => new Promise(r => requestAnimationFrame(() => r()));
  const median = (action, runs = 5) => { action(); const t = []; for (let i = 0; i < runs; i++) { const s = performance.now(); action(); t.push(performance.now() - s); } return +t.sort((a, b) => a - b)[runs >> 1].toFixed(1); };
  const out = {};
  out.renderAllMs = median(perf.renderAll);
  out.canvasMs = median(perf.renderCanvas);
  out.timelineMs = median(perf.renderTimeline);
  out.objectsPanelMs = median(perf.renderLayers);
  out.previewMs = median(perf.renderPreview);
  out.snapshotMs = median(perf.snapshot);
  const frames = perf.state.project.animations[0].frames.length;
  let k = 0;
  out.frameSwitchMs = median(() => perf.selectFrameAt(++k % frames));
  await frame();
  // Pencil stroke on the top layer, driven by the real mouse from Node; handlers are timed between a window capture listener and a later canvas listener.
  perf.state.tool = 'pencil';
  perf.state.layerId = perf.state.project.layers.at(-1).id;
  perf.renderAll();
  const canvas = document.getElementById('pixel-canvas'), times = { move: [], down: 0, up: 0, gaps: [] };
  let begin = 0, last = 0, watching = true;
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
    window.addEventListener(type, () => { begin = performance.now(); }, true);
    canvas.addEventListener(type, () => { const ms = performance.now() - begin; if (type === 'pointermove') times.move.push(ms); else times[type.slice(7)] = ms; });
  }
  const watch = now => { if (last) times.gaps.push(now - last); last = now; if (watching) requestAnimationFrame(watch); };
  requestAnimationFrame(watch);
  globalThis.strokeTimes = () => { watching = false; return times; };
  const r = canvas.getBoundingClientRect();
  return { ...out, rect: { x: r.left, y: r.top, w: r.width, h: r.height, width: perf.state.project.width, height: perf.state.project.height } };
}

/** Second half of the in-page measurement, after the stroke. */
async function finish(out) {
  const perf = globalThis.pixelStudioPerf, frame = () => new Promise(r => requestAnimationFrame(() => r()));
  await frame(); await frame();
  const times = globalThis.strokeTimes(), avg = list => +(list.reduce((a, b) => a + b, 0) / Math.max(1, list.length)).toFixed(2);
  Object.assign(out, { strokeMoveMs: avg(times.move), strokeWorstFrameMs: +Math.max(...times.gaps).toFixed(1), strokeDownMs: +times.down.toFixed(1), strokeCommitMs: +times.up.toFixed(1) });
  delete out.rect;
  const t2 = performance.now();
  await perf.saveNow();
  out.saveMs = +(performance.now() - t2).toFixed(1);
  // Preview playback: rAF rate and long tasks while only the live preview animates.
  perf.state.playing = true;
  let ticks = 0, worst = 0, last = performance.now();
  const until = performance.now() + 2000;
  while (performance.now() < until) { await frame(); const now = performance.now(); worst = Math.max(worst, now - last); last = now; ticks++; }
  out.playbackFps = Math.round(ticks / 2);
  out.playbackWorstFrameMs = +worst.toFixed(1);
  out.undoEntries = perf.state.undo.length;
  return out;
}

const browser = await browserType.launch();
const rows = [];
await mkdir(scratch, { recursive: true });
for (const [name, preset] of Object.entries(STRESS_PRESETS)) {
  const file = resolve(scratch, `stress-${name}.json`);
  await writeFile(file, JSON.stringify(makeStressProject({ ...preset, name: `Stress ${name}` })));
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url.href);
  await page.waitForFunction(() => globalThis.pixelStudioPerf);
  if (await page.locator('.start-sample').count()) await page.locator('.start-sample').first().click();
  await page.setInputFiles('#data-file-input', file);
  await page.waitForFunction(n => globalThis.pixelStudioPerf.state.project.name === n, `Stress ${name}`, { timeout: 60000 });
  await page.waitForTimeout(500);
  const out = await page.evaluate(measure), { rect } = out, point = (x, y) => [rect.x + (x + .5) * rect.w / rect.width, rect.y + (y + .5) * rect.h / rect.height];
  await page.mouse.move(...point(2, 2));
  await page.mouse.down();
  for (let i = 0; i < 120; i++) await page.mouse.move(...point(2 + i % (rect.width - 4), 2 + Math.floor(i / 4) % (rect.height - 4)));
  await page.mouse.up();
  rows.push({ preset: name, ...(await page.evaluate(finish, out)), errors: errors.join(' | ').slice(0, 300) || 0 });
  await page.close();
}
await browser.close();
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
else console.table(rows);
