/**
 * Animate panel: motion tools for the selected placed object (src/domain/animate.js) — tween to a keyframe along a
 * path, squash & stretch, follow-through, two-bone IK, wave motion and smear frames. Each opens a small dialog,
 * applies as one undo step and summarises the result in a toast.
 */
import { tweenObject, autoSquashStretch, springFollow, ikLimb, waveAnimate, smearFrame, canInsertFrames } from '../domain/animate.js';
import { EASINGS, ease } from '../domain/motion.js';
import { celObjects } from '../domain/objects.js';
import { instancePivot, transformedSize } from '../domain/geometry.js';

let d, picking = null;
const EASING_NAMES = { linear: 'Linear (steady)', easeIn: 'Ease in (speed up)', easeOut: 'Ease out (slow down)', easeInOut: 'Ease in and out', cubicIn: 'Strong ease in', cubicOut: 'Strong ease out', cubicInOut: 'Strong ease in and out', backIn: 'Back in (wind up)', backOut: 'Back out (overshoot)', bounceOut: 'Bounce', elasticOut: 'Elastic' };
const ACTIONS = ['tween', 'squash', 'follow', 'ik', 'wave', 'smear'];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function initAnimatePanel(deps) {
  d = deps;
  const { $ } = d;
  $('animate-tween').onclick = tweenDialog;
  $('animate-squash').onclick = squashDialog;
  $('animate-follow').onclick = followDialog;
  $('animate-ik').onclick = () => ikDialog();
  $('animate-wave').onclick = waveDialog;
  $('animate-smear').onclick = smearDialog;
  // IK "pick on canvas": the next click on the canvas sets the target and reopens the dialog.
  $('canvas-stage').addEventListener('pointerdown', event => {
    if (!picking || event.target !== $('pixel-canvas')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const at = d.canvasPosition(event), values = { ...picking, targetX: Math.floor(at.x), targetY: Math.floor(at.y) };
    picking = null; $('pixel-canvas').classList.remove('picking-point');
    ikDialog(values);
  }, true);
  document.addEventListener('keydown', event => { if (picking && event.key === 'Escape') { picking = null; $('pixel-canvas').classList.remove('picking-point'); d.toast('Target picking cancelled.'); } }, true);
}

/** The selected placed object in the current frame, with the objects around it. */
function context() {
  const { state } = d, animation = d.currentAnimation(), frame = d.currentFrame(), index = animation.frames.indexOf(frame);
  const objects = [];
  for (const layer of state.project.layers) {
    const cel = frame.cels.find(c => c.layerId === layer.id);
    if (!cel) continue;
    for (const node of celObjects(cel)) if (node.instance) objects.push({ layerId: layer.id, key: node.key, op: node.instance, name: node.name, layerName: layer.name });
  }
  const item = state.objectSelection, primary = item && !state.inPlaceEdit && objects.find(o => o.layerId === item.layerId && o.key === item.key);
  return { animation, frame, index, objects, primary, others: primary ? objects.filter(o => o !== primary) : [] };
}
const opIn = (frame, layerId, key) => frame.cels.find(c => c.layerId === layerId)?.source?.ops.find(op => op.type === 'use' && op.id === key);
const partOf = op => d.state.project.parts.find(p => p.id === op.partId);
const frameLabel = (animation, frame) => `Frame ${animation.frames.indexOf(frame) + 1}`;

/** Enable each action for the selection, with a reason when it cannot apply. */
export function renderAnimatePanel() {
  const { $, state } = d, ctx = context(), reasons = {};
  if (!ctx.primary) for (const a of ACTIONS) reasons[a] = '';
  else {
    const { animation, index, primary } = ctx, appears = animation.frames.filter(f => opIn(f, primary.layerId, primary.key));
    if (!animation.frames.slice(index + 1).some(f => opIn(f, primary.layerId, primary.key))) reasons.tween = 'Needs this object in a later frame: duplicate the frame and move it there.';
    if (appears.length < 2) reasons.squash = 'Needs this object in 2 or more frames.';
    if (!ctx.others.length) reasons.follow = reasons.ik = 'Needs a second object in this frame.';
    if (index >= animation.frames.length - 1) reasons.smear = 'Needs a next frame to smear towards.';
  }
  $('animate-hint').textContent = ctx.primary
    ? `“${ctx.primary.name}” · ${state.objectScope === 'animation' ? 'changes every frame it moves in' : 'the Edit switch is on this frame, IK changes this frame only'}`
    : state.inPlaceEdit ? 'Finish editing the object to animate it.' : 'Select a placed object on the canvas or in Layers to animate it.';
  for (const action of ACTIONS) {
    const button = $(`animate-${action}`), small = button.querySelector('small');
    small.dataset.hint ||= small.textContent;
    const reason = reasons[action];
    button.disabled = reason !== undefined;
    small.textContent = reason || small.dataset.hint;
    small.classList.toggle('maths-reason', Boolean(reason));
    button.title = reason || '';
  }
}

// ---------------------------------------------------------------------------------------------
// Dialog scaffolding

const formatters = {};
const slider = (id, label, min, max, step, value, format = v => v) => (formatters[id] = format) && `<label class="field"><span class="field-label">${label}</span><span class="field-row"><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"><output for="${id}" id="${id}-out">${format(Number(value))}</output></span></label>`;
const check = (id, label, checked) => `<label class="check-row"><input id="${id}" type="checkbox"${checked ? ' checked' : ''}> ${label}</label>`;
function objectOptions(objects, selected) {
  const seen = new Map(), primary = d.state.objectSelection;
  return objects.map((o, i) => {
    const same = objects.filter(x => x.name === o.name && x.layerId === o.layerId), n = (seen.get(`${o.layerId}/${o.name}`) || 0) + 1;
    seen.set(`${o.layerId}/${o.name}`, n);
    const label = `${o.name}${same.length > 1 ? ` (${n} of ${same.length})` : ''} · ${o.layerName}${primary?.layerId === o.layerId && primary.key === o.key ? ' · selected' : ''}`;
    return `<option value="${i}"${o === selected ? ' selected' : ''}>${d.escapeHTML(label)}</option>`;
  }).join('');
}
const readObject = (objects, value) => value === undefined || value === '' ? undefined : objects[Number(value)];

/**
 * Open a maths dialog. `run(form)` applies the change to state.project (inside mutate) and returns a toast message.
 */
function mathsDialog({ title, intro, body, submit, icon, run, update }) {
  const { $ } = d;
  d.openDialog(title, `<form id="maths-form" class="maths-form"><p class="modal-body-text">${intro}</p>${body}<p id="maths-error" class="maths-error" role="alert"></p><div class="modal-actions"><button type="button" id="maths-cancel" class="button">Cancel</button><button type="submit" class="button primary">${icon ? d.icon(icon) : ''} ${submit}</button></div></form>`, 'ANIMATE');
  const form = $('maths-form');
  const refresh = () => {
    for (const input of form.querySelectorAll('input[type="range"]')) { const out = $(`${input.id}-out`); if (out) out.textContent = (formatters[input.id] || (v => v))(Number(input.value)); }
    update?.(form);
  };
  form.addEventListener('input', refresh); form.addEventListener('change', refresh); refresh();
  $('maths-cancel').onclick = () => $('modal').close();
  form.onsubmit = event => {
    event.preventDefault();
    let message;
    try { d.mutate(() => { message = run(form); }); }
    catch (error) { $('maths-error').textContent = error.message; return; }
    $('modal').close(); d.renderAll(); if (message) d.toast(message);
  };
}

// ---------------------------------------------------------------------------------------------
// Tween

function drawEasing(canvas, name) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2), w = canvas.clientWidth || 240, h = canvas.clientHeight || 96;
  canvas.width = w * ratio; canvas.height = h * ratio;
  const c = canvas.getContext('2d'), pad = 10, lo = -0.3, hi = 1.3;
  c.setTransform(ratio, 0, 0, ratio, 0, 0); c.clearRect(0, 0, w, h);
  const X = t => pad + t * (w - 2 * pad), Y = v => h - pad - (v - lo) / (hi - lo) * (h - 2 * pad);
  c.strokeStyle = '#e4e9e1'; c.lineWidth = 1;
  for (const v of [0, 1]) { c.beginPath(); c.moveTo(X(0), Y(v)); c.lineTo(X(1), Y(v)); c.stroke(); }
  c.setLineDash([3, 3]); c.beginPath(); c.moveTo(X(0), Y(0)); c.lineTo(X(1), Y(1)); c.stroke(); c.setLineDash([]);
  c.strokeStyle = '#3d7d5f'; c.lineWidth = 2.5; c.lineJoin = 'round'; c.beginPath();
  for (let i = 0; i <= 80; i++) { const t = i / 80, v = ease(name, t); i ? c.lineTo(X(t), Y(v)) : c.moveTo(X(t), Y(v)); }
  c.stroke();
}

function tweenDialog() {
  const ctx = context(), { animation, index, primary } = ctx;
  if (!primary) return;
  const keys = animation.frames.slice(index + 1).filter(f => opIn(f, primary.layerId, primary.key));
  if (!keys.length) return;
  const pose = op => JSON.stringify({ ...op, id: 0, name: 0, visible: 0, locked: 0 });
  const first = keys.find(f => pose(opIn(f, primary.layerId, primary.key)) !== pose(primary.op)) || keys[0];
  const defaultInsert = frame => animation.frames.indexOf(frame) - index === 1 ? 3 : 0;
  mathsDialog({
    title: 'Tween to frame', icon: 'tween', submit: 'Tween',
    intro: `Fill the frames between ${frameLabel(animation, ctx.frame)} and a later keyframe with in-between poses of “${d.escapeHTML(primary.name)}”: position, size, angle, skew and deform, eased along a path.`,
    body: `<div class="form-grid"><label class="field"><span class="field-label">To keyframe</span><select id="tween-to">${keys.map(f => `<option value="${d.escapeHTML(f.id)}"${f === first ? ' selected' : ''}>${frameLabel(animation, f)}${animation.frames.indexOf(f) - index > 1 ? ` · ${animation.frames.indexOf(f) - index - 1} between` : ' · next frame'}</option>`).join('')}</select></label>
      <label class="field"><span class="field-label">Insert in-betweens</span><input id="tween-insert" type="number" min="0" max="24" step="1" value="${defaultInsert(first)}"></label></div>
      <div class="form-grid"><label class="field"><span class="field-label">Easing</span><select id="tween-easing">${Object.keys(EASINGS).map(n => `<option value="${n}"${n === 'easeInOut' ? ' selected' : ''}>${EASING_NAMES[n] || n}</option>`).join('')}</select></label>
      <label class="field"><span class="field-label">Path</span><select id="tween-path"><option value="line">Straight line</option><option value="arc">Arc (a jump or throw)</option><option value="bezier">S-curve</option></select></label></div>
      <canvas id="tween-curve" class="easing-curve" role="img" aria-label="Easing curve: progress over time"></canvas>
      ${slider('tween-lift', 'Path height', -100, 100, 5, 40, v => `${v}%`)}
      ${check('tween-orient', 'Turn along the path', false)}
      ${check('tween-squash', 'Squash & stretch with the speed', false)}
      ${slider('tween-squash-strength', 'Squash strength', 0.1, 1.5, 0.1, 0.5, v => v.toFixed(1))}
      <p id="tween-info" class="maths-info"></p>`,
    update() {
      const { $ } = d, to = animation.frames.find(f => f.id === $('tween-to').value), path = $('tween-path').value;
      if ($('tween-to').dataset.last !== to.id) { if ($('tween-to').dataset.last) $('tween-insert').value = String(defaultInsert(to)); $('tween-to').dataset.last = to.id; }
      drawEasing($('tween-curve'), $('tween-easing').value);
      $('tween-curve').setAttribute('aria-label', `Easing curve: ${EASING_NAMES[$('tween-easing').value]}`);
      $('tween-lift').disabled = path === 'line'; $('tween-orient').disabled = path === 'line';
      $('tween-squash-strength').disabled = !$('tween-squash').checked;
      const between = animation.frames.indexOf(to) - index - 1 + (Number($('tween-insert').value) || 0);
      $('tween-info').textContent = between > 0 ? `${plural(between, 'in-between frame')} will be posed${Number($('tween-insert').value) ? `, ${$('tween-insert').value} of them new copies of this frame` : ''}.` : 'There are no frames between these keyframes: insert some in-betweens.';
    },
    run() {
      const { $, state } = d, toFrameId = $('tween-to').value, kind = $('tween-path').value, insert = Math.max(0, Math.min(24, Math.round(Number($('tween-insert').value) || 0)));
      const to = opIn(animation.frames.find(f => f.id === toFrameId), primary.layerId, primary.key);
      let path;
      if (kind !== 'line') {
        const a = instancePivot(primary.op, partOf(primary.op)), b = instancePivot(to, partOf(to)), dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
        if (!len) throw new Error('The object is in the same place in both keyframes, so there is no path to curve. Use a straight line.');
        let n = { x: dy / len, y: -dx / len };
        if (n.y > 0 || (n.y === 0 && n.x > 0)) n = { x: -n.x, y: -n.y };
        const lift = Number($('tween-lift').value) / 100 * len, at = (t, h) => ({ x: a.x + dx * t + n.x * h, y: a.y + dy * t + n.y * h });
        path = kind === 'arc' ? { kind, via: at(.5, lift) } : { kind, controls: [at(1 / 3, lift * 1.5), at(2 / 3, -lift * 1.5)] };
      }
      const result = tweenObject(state.project, { animationId: animation.id, layerId: primary.layerId, instanceId: primary.key, fromFrameId: ctx.frame.id, toFrameId, easing: $('tween-easing').value, insert, path, orient: kind !== 'line' && $('tween-orient').checked, autoSquash: $('tween-squash').checked ? { strength: Number($('tween-squash-strength').value) } : undefined });
      state.project = result.project;
      return `Tweened ${plural(result.frameIds.length, 'frame')}${result.inserted.length ? ` (${result.inserted.length} new)` : ''}.`;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Squash & stretch, follow-through

function squashDialog() {
  const { animation, primary } = context();
  if (!primary) return;
  mathsDialog({
    title: 'Squash & stretch', icon: 'squash', submit: 'Apply',
    intro: `Stretch “${d.escapeHTML(primary.name)}” along its motion where it moves fast and squash it where it lands, keeping its area. Apply once: it builds on the current sizes.`,
    body: `${slider('squash-strength', 'Stretch with speed', 0.1, 1.5, 0.1, 0.5, v => v.toFixed(1))}${slider('squash-max', 'Most stretch', 0.1, 1, 0.05, 0.6, v => `${Math.round(v * 100)}%`)}${slider('squash-impact', 'Landing squash', 0, 2, 0.1, 0.3, v => v ? `${Math.round(v * 100)}%` : 'Off')}
      ${check('squash-tilt', 'Lean into the direction of motion', true)}${check('squash-loop', 'Looping animation (last frame flows into the first)', animation.frames.length > 2)}`,
    run() {
      const { $, state } = d;
      const result = autoSquashStretch(state.project, { animationId: animation.id, layerId: primary.layerId, instanceId: primary.key, strength: Number($('squash-strength').value), max: Number($('squash-max').value), impact: Number($('squash-impact').value), tilt: $('squash-tilt').checked, loop: $('squash-loop').checked });
      state.project = result.project;
      const impacts = result.frames.filter(f => f.impact).length;
      return `Squash & stretch over ${plural(result.frames.length, 'frame')}${impacts ? `, ${plural(impacts, 'landing')}` : ''}.`;
    }
  });
}

function followDialog() {
  const { animation, primary, others } = context();
  if (!primary || !others.length) return;
  mathsDialog({
    title: 'Follow-through', icon: 'follow', submit: 'Apply',
    intro: `Make “${d.escapeHTML(primary.name)}” follow another object with a springy lag, like a tail, hair or a cape.`,
    body: `<div class="form-grid"><label class="field"><span class="field-label">Follow</span><select id="follow-leader">${objectOptions(others, others[0])}</select></label>
      <label class="field"><span class="field-label">Copy its</span><select id="follow-property"><option value="angle">Rotation (swing)</option><option value="position">Position (trail)</option></select></label></div>
      ${slider('follow-stiffness', 'Stiffness', 0.05, 1, 0.05, 0.25, v => v.toFixed(2))}${slider('follow-damping', 'Damping', 0, 1, 0.05, 0.7, v => v.toFixed(2))}${slider('follow-delay', 'Extra delay', 0, 6, 1, 0, v => plural(v, 'frame'))}
      ${check('follow-loop', 'Looping animation', animation.frames.length > 2)}
      <p class="maths-info">Low stiffness lags more, low damping wobbles longer. Only frames that show both objects change.</p>`,
    run() {
      const { $, state } = d, leader = readObject(others, $('follow-leader').value);
      const result = springFollow(state.project, { animationId: animation.id, layerId: primary.layerId, instanceId: primary.key, leaderId: leader.key, leaderLayerId: leader.layerId, property: $('follow-property').value, stiffness: Number($('follow-stiffness').value), damping: Number($('follow-damping').value), delay: Number($('follow-delay').value), loop: $('follow-loop').checked });
      state.project = result.project;
      return `“${primary.name}” follows “${leader.name}” over ${plural(result.frameIds.length, 'frame')}.`;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// IK limb

function ikDialog(values = {}) {
  const { $, state } = d, { animation, frame, primary, objects } = context();
  if (!primary || objects.length < 2) return;
  const upper = readObject(objects, values.upper) || primary, lower = readObject(objects, values.lower) || objects.find(o => o !== upper);
  const box = op => { const size = transformedSize(op, partOf(op)); return { x: op.x + size.width / 2, y: op.y + size.height / 2 }; };
  const guess = box(lower.op), onlyThis = state.objectScope === 'frame';
  mathsDialog({
    title: 'IK limb', icon: 'ik', submit: 'Reach',
    intro: 'Bend a two-part limb (upper arm and forearm, thigh and shin) so its end reaches a target point.',
    body: `<div class="form-grid"><label class="field"><span class="field-label">Upper part (turns at shoulder/hip)</span><select id="ik-upper">${objectOptions(objects, upper)}</select></label>
      <label class="field"><span class="field-label">Lower part (turns at elbow/knee)</span><select id="ik-lower">${objectOptions(objects, lower)}</select></label></div>
      <p class="maths-info" id="ik-pivots"></p>
      <div class="form-grid"><label class="field"><span class="field-label">Target x</span><input id="ik-x" type="number" min="-256" max="512" step="1" value="${values.targetX ?? Math.round(guess.x)}"></label>
      <label class="field"><span class="field-label">Target y</span><input id="ik-y" type="number" min="-256" max="512" step="1" value="${values.targetY ?? Math.round(guess.y)}"></label></div>
      <button type="button" id="ik-pick" class="button small">${d.icon('pivot')} Pick target on canvas</button>
      <label class="field"><span class="field-label">Bend</span><select id="ik-bend"><option value="1">Bend one way</option><option value="-1"${values.bend === '-1' ? ' selected' : ''}>Bend the other way</option></select></label>
      <p class="maths-info">${onlyThis ? `Changes ${frameLabel(animation, frame)} only (Edit switch: this frame).` : 'Changes every frame that shows both parts (Edit switch: all frames). Set the switch to “This frame” to pose one frame.'}</p>`,
    update() {
      const u = readObject(objects, $('ik-upper').value), l = readObject(objects, $('ik-lower').value), missing = [u, l].filter(o => !o.op.pivot).map(o => `“${d.escapeHTML(o.name)}”`);
      $('ik-pivots').innerHTML = u === l ? '<strong>Choose two different parts.</strong>'
        : missing.length ? `<strong>Set pivots first:</strong> ${missing.join(' and ')} still turn${missing.length === 1 ? 's' : ''} around the centre. Select each part, use the Object tool and drag its pink pivot to the joint (shoulder for the upper part, elbow for the lower).`
        : 'Pivots are set: the upper part turns at its pivot, the lower part at the elbow pivot, which stays on the upper part.';
    },
    run() {
      const u = readObject(objects, $('ik-upper').value), l = readObject(objects, $('ik-lower').value);
      if (u === l) throw new Error('Choose two different parts.');
      const result = ikLimb(state.project, { animationId: animation.id, layerId: u.layerId, upperId: u.key, lowerId: l.key, lowerLayerId: l.layerId, frameIds: onlyThis ? [frame.id] : undefined, target: { x: Number($('ik-x').value) + .5, y: Number($('ik-y').value) + .5 }, bend: Number($('ik-bend').value) });
      state.project = result.project;
      const missed = result.frames.filter(f => !f.reached).length;
      return `IK posed ${plural(result.frames.length, 'frame')}${missed ? ` · target out of reach in ${missed}, stretched towards it` : ''}.`;
    }
  });
  $('ik-pick').onclick = () => {
    picking = { upper: $('ik-upper').value, lower: $('ik-lower').value, bend: $('ik-bend').value };
    $('modal').close(); $('pixel-canvas').classList.add('picking-point');
    d.toast('Click the canvas where the limb should reach. Esc cancels.');
  };
}

// ---------------------------------------------------------------------------------------------
// Wave motion, smear

const gcd = (a, b) => b ? gcd(b, a % b) : a;
function waveDialog() {
  const { animation, primary } = context();
  if (!primary) return;
  const count = animation.frames.length, has = primary.op.deform?.kind === 'wave', fit = 360 % count === 0 && count > 1 ? 360 / count : 45;
  mathsDialog({
    title: 'Wave motion', icon: 'wave', submit: 'Animate',
    intro: `Ripple “${d.escapeHTML(primary.name)}” by moving its wave a step further in each frame: flags, water, hair, grass.`,
    body: `${slider('wave-speed', 'Speed per frame', -180, 180, 5, fit, v => `${v}°`)}
      ${has ? '<p class="maths-info">Uses the object’s wave deform (Transform panel → Deform).</p>' : `<div class="form-grid"><label class="field"><span class="field-label">Sway</span><select id="wave-axis"><option value="x">Rows sideways</option><option value="y">Columns up and down</option></select></label>
      <label class="field"><span class="field-label">Size</span><input id="wave-amplitude" type="number" min="1" max="32" value="2"></label></div>
      <label class="field"><span class="field-label">Wavelength (pixels)</span><input id="wave-length" type="number" min="2" max="256" value="8"></label>`}
      <p id="wave-info" class="maths-info" aria-live="polite"></p>`,
    update() {
      const speed = Number(d.$('wave-speed').value), loop = speed ? 360 / gcd(360, Math.abs(speed)) : 1;
      d.$('wave-info').innerHTML = !speed ? 'A speed of 0° keeps the wave still.'
        : count % loop === 0 ? `<strong>Seamless loop</strong> · one cycle takes ${plural(loop, 'frame')}, this animation has ${count}.`
        : `Not seamless: one cycle takes ${plural(loop, 'frame')}, this animation has ${count}.${360 % count === 0 && count > 1 ? ` Use ${360 / count}° to loop in ${count}.` : ''}`;
    },
    run() {
      const { $, state } = d, speed = Number($('wave-speed').value);
      if (!speed) throw new Error('Choose a speed other than 0°.');
      const wave = has ? undefined : { axis: $('wave-axis').value, amplitude: Number($('wave-amplitude').value), wavelength: Number($('wave-length').value) };
      const result = waveAnimate(state.project, { animationId: animation.id, layerId: primary.layerId, instanceId: primary.key, speed, wave });
      state.project = result.project;
      return `Wave over ${plural(result.frameIds.length, 'frame')} · ${result.seamless ? 'loops seamlessly' : `loops every ${result.loopFrames} frames`}.`;
    }
  });
}

function smearDialog() {
  const { animation, frame, index, primary } = context();
  if (!primary || index >= animation.frames.length - 1) return;
  const next = animation.frames[index + 1], canInsert = canInsertFrames(d.state.project, animation.id, 1);
  mathsDialog({
    title: 'Smear frame', icon: 'smear', submit: 'Make smear',
    intro: `Draw a motion trail from ${frameLabel(animation, frame)} to ${frameLabel(animation, next)}, so fast moves read as one sweep.`,
    body: `${check('smear-object', `Follow “${d.escapeHTML(primary.name)}” (off: the whole container’s pixels)`, true)}
      <div class="form-grid"><label class="field"><span class="field-label">Trail colour</span><select id="smear-color"><option value="source">The object’s colours</option><option value="active">Active colour</option></select></label>
      <label class="field"><span class="field-label">Result</span><select id="smear-insert"><option value="insert"${canInsert ? '' : ' disabled'}>Insert a new frame between</option><option value="replace"${canInsert ? '' : ' selected'}>Turn ${frameLabel(animation, next)} into the smear</option></select></label></div>
      ${slider('smear-steps', 'Trail steps', 0, 16, 1, 0, v => v ? v : 'Auto')}`,
    run() {
      const { $, state } = d, insert = $('smear-insert').value === 'insert', steps = Number($('smear-steps').value);
      const result = smearFrame(state.project, { animationId: animation.id, layerId: primary.layerId, fromFrameId: frame.id, toFrameId: next.id, instanceId: $('smear-object').checked ? primary.key : undefined, steps: steps || undefined, color: $('smear-color').value === 'active' ? state.color : 'source', insert });
      state.project = result.project; state.frameId = result.frameId; d.normalizeSelection();
      return `Smear frame ${insert ? 'added' : 'made'} · trail ${Math.round(Math.hypot(result.offset.x, result.offset.y))} px.`;
    }
  });
}
