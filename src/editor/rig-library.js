/**
 * Skeleton mode's reusable rigs (rig-mode.js): the pose library cards in the Pose step, the Animation templates dialog
 * (src/domain/templates.js) and the Retarget dialog plus "Copy animation poses" (src/domain/poses.js). A copied clip
 * lives in this module (and the system clipboard as JSON), so it carries across project tabs.
 */
import {
  savePose, applyPose, renamePose, deletePose, characters, copyAnimationPoses, readPoseClip, retargetMapping, retargetAnimation,
  rigDescriptor, detectRoles, ROLES, POSE_CLIP_FORMAT,
} from '../domain/poses.js';
import { TEMPLATES, generateTemplate } from '../domain/templates.js';
import { placed, subtree } from '../domain/skeleton.js';
import { instanceBox } from '../domain/geometry.js';
import { compositeFrame } from '../domain/project.js';

let a, clip = null, timer = 0;
const thumbs = new Map();
const d = () => a.d;
const st = () => a.d.state;
const esc = text => a.d.escapeHTML(String(text ?? ''));
const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;

/** Pixels of `frame` cropped to the character's parts (2px margin): { pixels, width, height }. */
function characterImage(p, frame, rootId, box) {
  const full = compositeFrame(p, frame), W = p.width;
  if (!box) {
    const keep = subtree(p, rootId);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [id, s] of placed(p, frame)) if (keep.has(id)) { const b = instanceBox(s.op, s.part); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
    box = x0 === Infinity ? { x: 0, y: 0, width: W, height: p.height } : { x: Math.max(0, x0 - 2), y: Math.max(0, y0 - 2), width: Math.min(W, x1 + 2) - Math.max(0, x0 - 2), height: Math.min(p.height, y1 + 2) - Math.max(0, y0 - 2) };
  }
  const pixels = [];
  for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) pixels.push(full[y * W + x] ?? -1);
  return { pixels, width: box.width, height: box.height, box };
}
/** Union of the character's part boxes over every frame of an animation (a steady preview window). */
function animationBox(p, animation, rootId) {
  const boxes = animation.frames.map(f => characterImage(p, f, rootId).box);
  const x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y));
  return { x: x0, y: y0, width: Math.max(...boxes.map(b => b.x + b.width)) - x0, height: Math.max(...boxes.map(b => b.y + b.height)) - y0 };
}
function paint(canvas, image, palette) { d().paintSprite(canvas, image.pixels, palette, true, image.width, image.height); }

// ---------------------------------------------------------------------------------------------
// Pose library (in the bar)

/** The library block for the Pose step. */
export function libraryHTML() {
  const p = st().project, poses = p.poses || [], list = a.characters(), who = a.character();
  const button = a.button, chips = a.chips, toggle = a.toggle;
  const cards = poses.map(pose => `<li class="rig-card" data-pose="${pose.id}">
      <button type="button" class="rig-card-apply" data-act="pose-apply" data-pose="${pose.id}" title="Apply “${esc(pose.name)}” to ${st().objectScope === 'frame' ? 'this frame' : 'every frame'}"><canvas data-thumb="${pose.id}" aria-hidden="true"></canvas></button>
      <input type="text" class="rig-name" value="${esc(pose.name)}" maxlength="60" data-pose="${pose.id}" data-field="pose-name" aria-label="Pose name">
      <span class="rig-card-tools"><button type="button" class="rig-mini" data-act="pose-mirror" data-pose="${pose.id}" title="Apply mirrored (left ↔ right)" aria-label="Apply ${esc(pose.name)} mirrored">${d().icon('flip-h')}</button><button type="button" class="rig-mini" data-act="pose-delete" data-pose="${pose.id}" title="Delete this pose" aria-label="Delete ${esc(pose.name)}">${d().icon('trash')}</button></span></li>`).join('');
  return `<div class="rig-library">
    <span class="rig-row"><span class="motion-label">Poses</span>${button('pose-save', 'Save pose', { icon: 'plus', title: 'Add this frame’s pose to the project’s pose library' })}${toggle('poseMove', 'Position', a.r().poseMove, 'Also move the figure to where the pose stood')}
      <label class="rig-blend" title="Apply part of the way toward the pose"><span>Blend</span><input type="range" min="10" max="100" step="10" value="${a.r().blend}" data-field="blend" aria-label="Blend amount"><output>${a.r().blend}%</output></label></span>
    ${list.length > 1 ? `<span class="rig-row"><span class="motion-label">Character</span>${chips('character', list.map(c => [c.id, esc(c.name)]), who)}</span>` : ''}
    ${poses.length ? `<ul class="rig-cards" aria-label="Pose library">${cards}</ul>` : '<p class="rig-empty">No saved poses yet: pose a frame, then Save pose.</p>'}
    <span class="rig-row">${button('templates', 'Templates…', { icon: 'animate', title: 'Generate a walk, run, jump, idle, wave or hover animation' })}${button('retarget', 'Retarget…', { icon: 'swap', title: 'Copy an animation from one character onto another' })}${button('copy-clip', 'Copy animation poses', { icon: 'copy', title: 'Copy this character’s animation as poses, to retarget here or in another project' })}</span></div>`;
}
/** Paint the card thumbnails (cached per pose, animation, character and rig). */
export function paintThumbs(bar) {
  const p = st().project, animation = a.animation(), who = a.character(), rig = JSON.stringify(p.bones);
  for (const canvas of bar.querySelectorAll('canvas[data-thumb]')) {
    const pose = p.poses.find(x => x.id === canvas.dataset.thumb), key = JSON.stringify([pose, animation.id, who, rig, p.palette]);
    let image = thumbs.get(key);
    if (!image) {
      try {
        const base = animation.frames[0], out = applyPose(p, { pose, animationId: animation.id, frameId: base.id });
        image = characterImage(out.project, out.project.animations.find(x => x.id === animation.id).frames[0], who);
      } catch { image = { pixels: [], width: 1, height: 1 }; }
      if (thumbs.size > 200) thumbs.clear();
      thumbs.set(key, image);
    }
    paint(canvas, image, p.palette);
  }
}
/** Library and dialog actions; false when `name` is not one of them. */
export function libraryAction(name, el) {
  const pose = el?.dataset.pose, opts = a.poseOpts();
  if (name === 'pose-save') {
    let id;
    a.commit(p => { const out = savePose(p, { ...opts, rootBoneId: a.character(), name: '' }); id = out.poseId; return out.project; }, 'Pose saved to the library: rename it on its card.');
    if (id) document.querySelector(`#rig-bar input[data-pose="${id}"]`)?.select();
  } else if (name === 'pose-apply' || name === 'pose-mirror') a.commit(p => applyPose(p, { ...opts, poseId: pose, mirror: name === 'pose-mirror', amount: a.r().blend / 100, move: a.r().poseMove }).project);
  else if (name === 'pose-delete') a.commit(p => deletePose(p, pose), 'Pose deleted.');
  else if (name === 'templates') templatesDialog();
  else if (name === 'retarget') retargetDialog();
  else if (name === 'copy-clip') {
    try {
      clip = copyAnimationPoses(st().project, { animationId: a.animation().id, frameId: st().frameId, rootBoneId: a.character() });
      navigator.clipboard?.writeText(JSON.stringify(clip)).catch(() => {});
      d().toast(`“${clip.name}” poses copied (${clip.frames.length} frames). Use Retarget… here or in another project.`);
    } catch (error) { d().toast(error.message); }
  } else return false;
  return true;
}
/** Library inputs (pose names, blend); false when not one of them. */
export function libraryChange(el) {
  if (el.dataset.field === 'pose-name') { a.commit(p => renamePose(p, el.dataset.pose, el.value)); return true; }
  if (el.dataset.field === 'blend') { a.r().blend = Number(el.value); el.nextElementSibling.value = `${el.value}%`; return true; }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Dialogs

/** Play an animation of `project` (character `rootId`) on the dialog's preview canvas. */
function preview(project, animationId, rootId) {
  clearInterval(timer);
  const canvas = d().$('rig-dialog-preview');
  if (!canvas) return;
  const animation = project.animations.find(x => x.id === animationId), box = animationBox(project, animation, rootId);
  const images = animation.frames.map(f => characterImage(project, f, rootId, box)), sprite = document.createElement('canvas');
  const scale = Math.max(1, Math.floor(Math.min(220 / box.width, 200 / box.height)));
  canvas.width = box.width * scale; canvas.height = box.height * scale;
  let k = 0;
  const step = () => {
    if (!canvas.isConnected) { clearInterval(timer); return; }
    paint(sprite, images[k], project.palette);
    const c = canvas.getContext('2d'); c.imageSmoothingEnabled = false; c.clearRect(0, 0, canvas.width, canvas.height); c.drawImage(sprite, 0, 0, canvas.width, canvas.height);
    k = (k + 1) % images.length;
  };
  step();
  timer = setInterval(step, Math.max(40, animation.frames[0].duration));
}
const dialogError = message => { const el = d().$('rig-dialog-error'); if (el) { el.textContent = message || ''; el.hidden = !message; } };
function onClose() { const modal = d().$('modal'), stop = () => { clearInterval(timer); modal.removeEventListener('close', stop); modal.removeEventListener('pixel-studio:dialog-replace', stop); }; modal.addEventListener('close', stop); modal.addEventListener('pixel-studio:dialog-replace', stop); }
/** Commit a generated project and show its animation. */
function finish(project, animationId, message) {
  d().$('modal').close();
  a.commit(() => project, message);
  const animation = st().project.animations.find(x => x.id === animationId);
  if (animation) { Object.assign(st(), { animationId, frameId: animation.frames[0].id, previewIndex: 0, previewTime: 0 }); d().renderAll(); }
}
const field = (label, html, wide = false) => `<label class="field${wide ? ' rig-wide' : ''}"><span class="field-label">${label}</span>${html}</label>`;
const number = (id, value, min, max, step = 1) => `<input id="${id}" type="number" min="${min}" max="${max}" step="${step}" value="${value}">`;
const range = (id, value, min, max, step) => `<span class="rig-range"><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"><output>${value}</output></span>`;

function templatesDialog() {
  const p = st().project, animation = a.animation(), who = a.character();
  if (!who) { d().toast('Rig a character first.'); return; }
  const at = { animationId: animation.id, frameId: st().frameId, rootBoneId: who }, rig = rigDescriptor(p, at), found = detectRoles(rig);
  const s = { template: 'walk', roles: { ...found.roles }, ...TEMPLATES.walk, exaggeration: 1, facing: 'auto', mode: 'new', candidate: null, name: '' };
  const boneOptions = role => option('', '—', !s.roles[role]) + rig.map(b => option(b.id, b.name, s.roles[role] === b.id)).join('');
  const roleRows = ROLES.map(([role, label]) => `<label class="rig-map-row"><span>${label}</span><select data-role="${role}">${boneOptions(role)}</select></label>`).join('');
  d().openDialog('Animation templates', `<div class="rig-dialog">
    <div class="rig-template-pick" role="radiogroup">${Object.entries(TEMPLATES).map(([id, t]) => `<button type="button" class="motion-chip${id === s.template ? ' active' : ''}" role="radio" aria-checked="${id === s.template}" data-template="${id}">${t.label}</button>`).join('')}</div>
    <div class="rig-dialog-main"><div class="rig-dialog-stage"><canvas id="rig-dialog-preview" aria-label="Template preview"></canvas><small id="rig-dialog-note"></small></div>
    <div class="form-grid">${field('Frames', number('tpl-frames', s.frames, 2, 64))}${field('Frame length (ms)', number('tpl-ms', s.frameMs, 16, 2000, 5))}
      ${field('Swing (degrees)', number('tpl-amplitude', s.amplitude, 0, 180))}${field('Bounce / height (px)', number('tpl-bounce', s.bounce, 0, 64))}
      ${field('Exaggeration', range('tpl-exaggeration', 1, .25, 2, .05))}${field('Facing', `<select id="tpl-facing">${[['auto', `Auto (${found.facing === 'front' ? 'front' : 'side'})`], ['right', 'Side, facing right'], ['left', 'Side, facing left'], ['front', 'Front']].map(([v, l]) => option(v, l, v === 'auto')).join('')}</select>`)}
      ${field('Result', `<select id="tpl-mode">${option('new', 'New animation', true)}${option('replace', `Replace “${animation.name}” frames`)}</select>`)}${field('Name', `<input id="tpl-name" type="text" maxlength="80" value="${TEMPLATES.walk.name}">`)}</div></div>
    <details class="rig-roles"${Object.keys(found.roles).length < 5 ? ' open' : ''}><summary>Bone roles <small>${Object.keys(found.roles).length} found by name and shape: fix any that are wrong</small></summary><div class="rig-map">${roleRows}</div></details>
    <p id="rig-dialog-error" class="sheet-error" role="alert" hidden></p>
    <div class="modal-actions"><button type="button" class="button" data-close>Cancel</button><button type="button" class="button primary" id="rig-dialog-go">${d().icon('check')} Generate</button></div></div>`, 'SKELETON');
  d().$('modal').classList.add('wide');
  onClose();
  const box = d().$('modal-content'), $v = id => box.querySelector(`#${id}`);
  const run = () => {
    s.candidate = null; dialogError('');
    try {
      const out = generateTemplate(p, { ...at, template: s.template, roles: s.roles, frames: Number($v('tpl-frames').value), frameMs: Number($v('tpl-ms').value), amplitude: Number($v('tpl-amplitude').value), bounce: Number($v('tpl-bounce').value), exaggeration: Number($v('tpl-exaggeration').value), facing: $v('tpl-facing').value, mode: $v('tpl-mode').value, name: $v('tpl-name').value.trim() || TEMPLATES[s.template].name });
      s.candidate = out;
      $v('rig-dialog-note').textContent = `${out.frameIds.length} frames · ${out.facing === 'front' ? 'front view' : `facing ${out.facing}`} · loops`;
      preview(out.project, out.animationId, who);
    } catch (error) { dialogError(error.message); clearInterval(timer); }
    $v('rig-dialog-go').disabled = !s.candidate;
  };
  box.addEventListener('click', event => {
    const t = event.target.closest('[data-template]');
    if (t) {
      const def = TEMPLATES[s.template = t.dataset.template], name = $v('tpl-name');
      box.querySelectorAll('[data-template]').forEach(b => { b.classList.toggle('active', b === t); b.setAttribute('aria-checked', b === t); });
      $v('tpl-frames').value = def.frames; $v('tpl-ms').value = def.frameMs; $v('tpl-amplitude').value = def.amplitude; $v('tpl-bounce').value = def.bounce;
      if (!name.dataset.edited) name.value = def.name;
      run();
    } else if (event.target.closest('[data-close]')) d().$('modal').close();
    else if (event.target.closest('#rig-dialog-go') && s.candidate) finish(s.candidate.project, s.candidate.animationId, `${TEMPLATES[s.template].label} generated: ${s.candidate.frameIds.length} frames.`);
  });
  box.addEventListener('input', event => {
    const el = event.target;
    if (el.type === 'range') el.nextElementSibling.value = el.value;
    if (el.id === 'tpl-name') el.dataset.edited = '1';
  });
  box.addEventListener('change', event => {
    const el = event.target;
    if (el.dataset.role) { if (el.value) s.roles[el.dataset.role] = el.value; else delete s.roles[el.dataset.role]; }
    if (el.id !== 'tpl-name') run();
  });
  run();
}

function retargetDialog() {
  const p = st().project, animation = a.animation(), targets = a.characters(), who = a.character();
  if (!targets.length) { d().toast('Rig a character first.'); return; }
  const sources = [];
  if (clip) sources.push({ value: 'clip', label: `Copied: ${clip.name} (${clip.frames.length} frames)` });
  for (const anim of p.animations) for (const c of characters(p, anim.id, anim.frames[0].id)) sources.push({ value: `${anim.id}\n${c.id}`, label: `${anim.name} · ${c.name}`, anim, root: c.id });
  const source = sources.find(x => x.value === 'clip') || sources.find(x => x.root !== who) || sources[0];
  const s = { source, target: source.value === 'clip' ? who : targets.find(t => t.id !== source.root)?.id || who, mapping: null, candidate: null };
  d().openDialog('Retarget animation', `<div class="rig-dialog">
    <div class="form-grid">${field('From', `<select id="rt-source">${sources.map(x => option(x.value, x.label, x === s.source)).join('')}</select>`)}${field('Onto character', `<select id="rt-target">${targets.map(t => option(t.id, t.name, t.id === s.target)).join('')}</select>`)}
      ${field('Result', `<select id="rt-mode">${option('new', 'New animation', true)}${option('merge', `Fill “${animation.name}” frames`)}</select>`)}${field('Name', `<input id="rt-name" type="text" maxlength="80" placeholder="Source animation name">`)}</div>
    <div class="rig-row"><button type="button" class="button small" id="rt-paste">${d().icon('paste')} Paste copied poses</button><label class="rig-check"><input id="rt-scale" type="checkbox" checked> Scale root motion by leg length</label></div>
    <div class="rig-dialog-main"><div class="rig-dialog-stage"><canvas id="rig-dialog-preview" aria-label="Retarget preview"></canvas><small id="rig-dialog-note"></small></div>
    <div class="rig-map rig-retarget-map" id="rt-map"></div></div>
    <p id="rig-dialog-error" class="sheet-error" role="alert" hidden></p>
    <div class="modal-actions"><button type="button" class="button" data-close>Cancel</button><button type="button" class="button primary" id="rig-dialog-go">${d().icon('check')} Retarget</button></div></div>`, 'SKELETON');
  d().$('modal').classList.add('wide');
  onClose();
  const box = d().$('modal-content'), $v = id => box.querySelector(`#${id}`);
  const sourceClip = () => s.source.value === 'clip' ? clip : copyAnimationPoses(p, { animationId: s.source.anim.id, rootBoneId: s.source.root });
  const at = () => ({ animationId: animation.id, frameId: st().frameId, rootBoneId: s.target });
  const mapRows = () => {
    dialogError('');
    try {
      const c = sourceClip(), found = retargetMapping(p, { clip: c, ...at() });
      s.mapping = found.map;
      $v('rt-map').innerHTML = `<p class="rig-map-head"><span>${esc(c.name)} bone</span><span>→ ${esc(targets.find(t => t.id === s.target)?.name)} bone</span></p>${c.bones.map(b => `<label class="rig-map-row"><span>${esc(b.name || b.id)}</span><select data-source="${esc(b.id)}">${option('', '— skip —', !found.map[b.id])}${found.rig.map(t => option(t.id, t.name, found.map[b.id] === t.id)).join('')}</select><small>${found.how[b.id] || ''}</small></label>`).join('')}`;
    } catch (error) { s.mapping = null; $v('rt-map').innerHTML = ''; dialogError(error.message); }
  };
  const run = () => {
    s.candidate = null;
    if (s.mapping) {
      try {
        const c = sourceClip();
        s.candidate = retargetAnimation(p, { clip: c, mapping: s.mapping, ...at(), mode: $v('rt-mode').value, name: $v('rt-name').value.trim() || c.name, scaleMoves: $v('rt-scale').checked });
        $v('rig-dialog-note').textContent = `${s.candidate.frameIds.length} frames · ${Object.keys(s.candidate.mapping).length} bones matched`;
        preview(s.candidate.project, s.candidate.animationId, s.target);
      } catch (error) { dialogError(error.message); clearInterval(timer); }
    }
    $v('rig-dialog-go').disabled = !s.candidate;
  };
  box.addEventListener('click', async event => {
    if (event.target.closest('[data-close]')) d().$('modal').close();
    else if (event.target.closest('#rig-dialog-go') && s.candidate) finish(s.candidate.project, s.candidate.animationId, `Retargeted onto ${targets.find(t => t.id === s.target)?.name}.`);
    else if (event.target.closest('#rt-paste')) {
      try {
        clip = readPoseClip(JSON.parse(await navigator.clipboard.readText()));
        d().$('modal').close(); retargetDialog();
      } catch { dialogError(`The clipboard holds no copied animation poses. Use “Copy animation poses” first (format ${POSE_CLIP_FORMAT}).`); }
    }
  });
  box.addEventListener('change', event => {
    const el = event.target;
    if (el.id === 'rt-source') s.source = sources.find(x => x.value === el.value);
    if (el.id === 'rt-target') s.target = el.value;
    if (el.dataset.source) { if (el.value) s.mapping[el.dataset.source] = el.value; else delete s.mapping[el.dataset.source]; }
    else if (el.id === 'rt-source' || el.id === 'rt-target') mapRows();
    run();
  });
  mapRows(); run();
}

/** Wire the library to Skeleton mode: `api` gives d (app deps), r(), button/chips/toggle, animation(), characters(), character(), poseOpts(), commit(). */
export function initRigLibrary(api) { a = api; }
