/**
 * Offline English → motion plan parser: "make him wave twice", "bounce 3 times then spin", "move the key to the right
 * by 10". Rule based, no AI. Produces a plan for runMotionPlan (motion-intent.js); phrases it cannot read are returned
 * in `unknown` so the UI can offer the AI path.
 */

const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, sixteen: 16, twenty: 20, couple: 2, few: 3, several: 3 };
const NUM = `(\\d+|${Object.keys(NUMBERS).join('|')})`;
const toNum = w => /^\d+$/.test(w) ? Number(w) : NUMBERS[w];
const SPEEDS = [[/\bvery (?:slow(?:ly)?)\b/, .4], [/\bvery (?:fast|quick(?:ly)?)\b|\bsuper fast\b/, 2.2], [/\b(?:slow(?:ly)?|lazy|lazily|leisurely)\b/, .6], [/\b(?:gentl[ey]|calm(?:ly)?)\b/, .75], [/\b(?:fast|quick(?:ly)?|rapid(?:ly)?|energetic(?:ally)?|hurr(?:y|ied))\b/, 1.6]];
const BIG = /\b(?:higher|high|big(?:ger)?|large|huge|lots|a lot|wild(?:ly)?|exaggerated|strong(?:ly)?|hard)\b/, SMALL = /\b(?:small(?:er)?|little|subtle|tiny|soft(?:ly)?|lower|slight(?:ly)?|bit)\b/;
const DIRS = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, upward: { x: 0, y: -1 }, upwards: { x: 0, y: -1 }, downward: { x: 0, y: 1 }, downwards: { x: 0, y: 1 } };
const VERB = '(?:walk(?:s|ing)?|stroll|run(?:s|ning)?|jog|sprint|jump(?:s|ing)?|hop(?:s|ping)?|leap|idle|breath(?:e|es|ing)?|stand|hover(?:s|ing)?|float(?:s|ing)?|bob(?:s|bing)?|wave(?:s|ing)?|greet|say hi|bounce(?:s)?|bouncing|spin(?:s|ning)?|twirl|flip(?:s|ping)?|somersault|backflip|cartwheel|turn(?:s)?|nod(?:s|ding)?|shake(?:s)?|shaking|tremble|shiver|wobble|jitter|move(?:s)?|slide(?:s)?|go(?:es)?|glide|drift|fall(?:s)?|drop(?:s)?|rise(?:s)?|fly|squash|raise(?:s)?|lift(?:s)?|lower(?:s)?|look(?:s)?|kick(?:s)?|hold|wait|pause|repeat|loop|ripple|flutter|follow(?:s)?|dance(?:s)?|swing|tilt|reach|do|strike|pose|crouch)';
const STEMS = ['walk', 'stroll', 'run', 'jog', 'sprint', 'jump', 'hop', 'leap', 'idle', 'breath', 'stand', 'hover', 'float', 'bob', 'wave', 'greet', 'say hi', 'bounc', 'spin', 'twirl', 'flip', 'somersault', 'backflip', 'cartwheel', 'turn', 'nod', 'shak', 'trembl', 'shiver', 'wobbl', 'jitter', 'mov', 'slid', 'go', 'glid', 'drift', 'fall', 'drop', 'ris', 'fly', 'squash', 'rais', 'lift', 'lower', 'look', 'kick', 'hold', 'wait', 'paus', 'repeat', 'loop', 'rippl', 'flutter', 'follow', 'danc', 'swing', 'tilt', 'reach', 'do', 'strike', 'pose', 'crouch'];
const LEAD = /^(?:(?:please|can you|could you|now|and|also|i want|i'd like|i would like|animate|let's|lets)\s+)+/;
const FILLER = new Set(['the', 'his', 'her', 'its', 'their', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'and', 'it', 'him', 'them', 'he', 'she', 'they', 'place', 'around', 'round', 'about', 'cycle', 'loop', 'looping', 'animation', 'motion', 'frames', 'frame', 'times', 'time', 'px', 'pixels', 'pixel', 'once', 'twice', 'thrice', 'again', 'more', 'bit', 'some', 'little', 'make', 'let', 'have', 'get', 'so', 'that', 'over', 'from', 'side', 'into', 'then', 'very', 'really', 'too', 'back', 'forth', 'all', 'way', 'like', 'just', 'x', 'do', 'does', 'go', 'please', 'should', 'will', 'can', 'quickly']);

/** Count ("twice", "3 times", "x3"), or undefined. */
function countOf(t) {
  if (/\bonce\b/.test(t)) return 1;
  if (/\btwice\b|\bdouble\b/.test(t)) return 2;
  if (/\bthrice\b/.test(t)) return 3;
  const m = t.match(new RegExp(`\\b${NUM}\\s*(?:more\\s+)?(?:times|x)\\b`)) || t.match(/(?:^|\s)[x×]\s*(\d+)\b/);
  return m ? toNum(m[1]) : undefined;
}
/** Frame count ("8 frames", "(12 frames)"). */
const framesOf = t => { const m = t.match(new RegExp(`\\b${NUM}[\\s-]*frames?\\b`)); return m ? toNum(m[1]) : undefined; };
const speedOf = t => SPEEDS.find(([re]) => re.test(t))?.[1];
const sizeOf = t => BIG.test(t) ? 1.6 : SMALL.test(t) ? .6 : 1;
/** Direction with distance: "to the right by 10", "left 5 px", "up". */
function directionOf(t, fallback) {
  const m = t.match(/\b(left|right|up|down|upwards?|downwards?)\b/);
  if (!m) return null;
  const d = DIRS[m[1]], amount = t.match(new RegExp(`\\b(?:by\\s+)?${NUM}\\s*(?:px|pixels?)\\b`)) || t.match(new RegExp(`\\bby\\s+${NUM}\\b`)) || t.match(new RegExp(`\\b(?:left|right|up|down)\\s+${NUM}\\b(?!\\s*(?:times|x|frames?))`));
  const n = amount ? toNum(amount[1]) : fallback(d);
  return { x: d.x * n, y: d.y * n };
}
/** Leftover words naming a target ("the key", "his left arm"), or ''. */
function targetWords(t, drop = []) {
  const words = t.replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9' -]/g, ' ').split(/\s+/).filter(Boolean);
  return words.filter(w => !FILLER.has(w) && !drop.includes(w) && !/^[x×]?\d+$/.test(w) && !NUMBERS[w] && !DIRS[w] && !speedOf(w) && !BIG.test(w) && !SMALL.test(w) && !/^(?:slow|fast|quick)/.test(w)).join(' ');
}
const clean = s => s.replace(/\s+/g, ' ').trim();

/** Split a request into clauses: commas, "then", "and then", "after that", and "and" before a verb. */
function clauses(text) {
  const t = ` ${String(text).toLowerCase().replace(/[’']/g, "'").replace(/squash(?:\s*(?:and|&|\+|-|\/)\s*|\s+)stretch/g, 'squash-stretch')} `;
  return t.split(/\s*(?:[,;.!?]|\band then\b|\bthen\b|\bafter that\b|\bfollowed by\b|\bafterwards\b|\bnext\b)\s*/)
    .flatMap(c => c.split(new RegExp(`\\s+(?:and|&|\\+)\\s+(?=(?:(?:then|also|he|she|it|they)\\s+)?${VERB}\\b)`)))
    .map(clean).filter(Boolean);
}

/**
 * Parse an English motion request. `poses`: saved pose names; `width`/`height`: canvas (default distances);
 * `rigged`: whether there is a character rig (affects arm/head phrases). Returns { plan: {steps}, understood, unknown }.
 */
export function parseMotionText(text, { poses = [], width = 32, height = 32, rigged = true } = {}) {
  const steps = [], understood = [], unknown = [];
  for (const raw of clauses(text)) {
    const c = raw.replace(LEAD, '');
    const before = c.length;
    const out = parseClause(c, { poses, width, height, rigged, steps });
    if (out?.length) { steps.push(...out); understood.push(raw); } else if (before) unknown.push(raw);
  }
  return { plan: { steps }, understood, unknown };
}

function parseClause(c, { poses, width, height, rigged, steps }) {
  const all = [...c.matchAll(new RegExp(`\\b${VERB}\\b`, 'g'))], vm = all.find(m => !/^(?:do|strike|go)$/.test(m[0])) || all[0];
  const verb = vm?.[0] || '', at = vm ? vm.index : -1;
  // Subject before the verb ("make the key bounce") or object after it ("spin the key").
  const subject = at > 0 ? targetWords(c.slice(0, at).replace(/^(?:make|let|have|get)\s+/, '')) : '';
  const rest = at >= 0 ? c.slice(at + verb.length) : c;
  const times = countOf(c), frames = framesOf(c), speed = speedOf(c), size = sizeOf(c);
  const common = s => { if (times > 1 || (times === 1 && s.times)) s.times = times; if (frames) s.frames = frames; if (speed) s.speed = speed; return s; };
  const tgt = (drop = []) => targetWords(rest, drop) || subject;
  const withTarget = (s, t = tgt()) => (t ? { ...s, target: t } : s);
  const v = STEMS.find(k => verb.startsWith(k)) || verb;
  const dist = d => Math.max(2, Math.round((d.x ? width : height) / 4));

  const pose = poses.find(n => n && new RegExp(`\\b${n.toLowerCase().replace(/[^a-z0-9]+/g, '\\W*')}\\b`).test(c));
  if (/^new animation\b|^(?:start|create|make) a new animation\b/.test(c)) {
    const name = c.match(/\b(?:called|named)\s+(.+)$/)?.[1];
    return [{ op: 'newAnimation', name: name ? name.replace(/^["“']|["”']$/g, '').replace(/\b\w/g, m => m.toUpperCase()) : 'Motion' }];
  }
  if (/\bsquash-stretch\b/.test(c)) {
    if (steps.length && !['hold', 'repeat', 'newAnimation'].includes(steps.at(-1).op)) return [{ op: 'squash', ...(size !== 1 ? { strength: Math.min(2, .5 * size) } : {}) }];
    return [common(withTarget({ op: 'bounce', height: Math.max(2, Math.round(height / 12 * size)), squash: 1 }, targetWords(c, ['squash-stretch'])))];
  }
  if (/\b(?:follows?|trails?)\b/.test(c)) {
    const m = c.match(/^(.*?)\s*\b(?:follows?|trails?)\b\s*(?:after\s+)?(.*)$/);
    const follower = targetWords(m?.[1] || ''), leader = targetWords(m?.[2] || '');
    return leader ? [withTarget({ op: 'follow', leader }, follower)] : null;
  }
  if (!verb) return pose ? [common({ op: 'pose', name: pose, yoyo: true })] : null;

  switch (v) {
    case 'walk': case 'stroll': case 'run': case 'jog': case 'sprint': {
      const name = /^(?:run|jog|sprint)/.test(v) ? 'run' : 'walk', d = /\b(?:across|to the|towards?|left|right)\b/.test(rest) && directionOf(rest, () => Math.round(width / 3));
      const s = common(withTarget({ op: 'template', name }, tgt(['across', 'towards', 'toward'])));
      if (d && d.x) { s.by = d; s.facing = d.x < 0 ? 'left' : 'right'; }
      return [s];
    }
    case 'jump': case 'hop': case 'leap': {
      const s = common(withTarget({ op: 'template', name: 'jump' }, tgt(['up', 'down'])));
      if (size !== 1) s.height = Math.round(height / 6 * size);
      return [s];
    }
    case 'idle': case 'breath': case 'stand': return [common(withTarget({ op: 'template', name: 'idle' }, tgt(['still', 'idle', 'breathing', 'breathe'])))];
    case 'hover': case 'float': case 'bob': return [common(withTarget({ op: 'template', name: 'hover' }, tgt()))];
    case 'wave': case 'greet': case 'say hi': {
      if (/\blike a flag\b|\bin the wind\b/.test(c)) return [common(withTarget({ op: 'ripple' }, tgt(['like', 'flag', 'wind'])))];
      const s = common(withTarget({ op: 'template', name: 'wave' }, tgt(['hello', 'hi', 'goodbye', 'bye', 'hand', 'arm'])));
      if (size !== 1) s.amplitude = Math.round(30 * size);
      return [s];
    }
    case 'bounc': return [common(withTarget({ op: 'bounce', height: Math.max(2, Math.round(height / 6 * size)), ...(/\bsquash/.test(c) ? { squash: 1 } : {}) }, tgt(['up', 'down'])))];
    case 'spin': case 'twirl': {
      const s = common(withTarget({ op: 'spin', axis: 'y' }, tgt(['backwards', 'backward'])));
      if (/\bbackwards?\b/.test(c)) s.turns = -1;
      return [s];
    }
    case 'flip': case 'somersault': case 'backflip': case 'cartwheel': {
      if (v === 'flip' && /\baround\b|\bround\b|\bover\b/.test(c) && !/\bhead over heels\b/.test(c)) return [common(withTarget({ op: 'turn', axis: 'y', degrees: 180 }, tgt()))];
      return [common(withTarget({ op: 'spin', axis: 'x', ...(v === 'backflip' || /\bbackwards?\b/.test(c) ? { turns: -1 } : {}) }, tgt(['head', 'heels', 'backwards', 'backward'])))];
    }
    case 'turn': {
      if (/\bhead\b/.test(rest)) return [common({ op: 'rotate', target: 'head', degrees: /\bleft\b/.test(rest) ? -15 : 15, yoyo: true })];
      return [common(withTarget({ op: 'turn', axis: 'y', degrees: /\b(?:left|right)\b/.test(rest) && !/\baround\b/.test(rest) ? 90 : 180, ...(/\bback\b/.test(rest) ? { yoyo: true } : {}) }, tgt(['face', 'other'])))];
    }
    case 'nod': return [common({ op: 'rotate', target: targetWords(rest, ['yes', 'head']) || 'head', degrees: Math.round(12 * size), yoyo: true, frames: 3 })];
    case 'shak': case 'trembl': case 'shiver': case 'wobbl': case 'jitter': {
      if (/\bhead\b|\bno\b/.test(c)) {
        const side = deg => ({ op: 'rotate', target: 'head', degrees: deg, yoyo: true, frames: frames || 2, ...(speed ? { speed } : {}) });
        return [side(-Math.round(12 * size)), side(Math.round(12 * size)), ...(times > 1 ? [{ op: 'repeat', times, steps: 2 }] : [])];
      }
      const s = common(withTarget({ op: 'shake' }, tgt(['no'])));
      if (size !== 1 || v !== 'shak') s.amount = Math.max(1, Math.round(2 * (v === 'shak' ? size : size * .6)));
      if (!s.times && v !== 'shak') s.times = 3;
      return [s];
    }
    case 'mov': case 'slid': case 'go': case 'glid': case 'drift': case 'fly': {
      const d = directionOf(rest, dist) || (v === 'fly' ? { x: 0, y: -dist({ y: 1 }) } : null);
      if (!d) {
        const to = rest.match(new RegExp(`\\bto\\s*\\(?\\s*(-?\\d+)\\s*,\\s*(-?\\d+)`));
        if (to) return [common(withTarget({ op: 'move', to: { x: Number(to[1]), y: Number(to[2]) } }, targetWords(rest.slice(0, to.index))))];
        if (/\bcent(?:er|re)\b|\bmiddle\b/.test(rest)) return [common(withTarget({ op: 'move', to: { x: Math.round(width / 2), y: Math.round(height / 2) } }, tgt(['center', 'centre', 'middle'])))];
      }
      const s = common(withTarget({ op: 'move', by: d || { x: dist({ x: 1 }), y: 0 } }, tgt(['up', 'down', 'off', 'screen', 'forward', 'forwards'])));
      if (/\b(?:and|then)\s+back\b|\bback and forth\b/.test(c)) s.yoyo = true;
      if (/\barc\b|\bcurve\b|\bhop\b/.test(c)) s.path = 'arc';
      s.easing = /\bsmooth/.test(c) ? 'easeInOut' : s.easing;
      if (!s.easing) delete s.easing;
      return [s];
    }
    case 'fall': case 'drop': return [common(withTarget({ op: 'move', by: { x: 0, y: directionOf(rest, dist)?.y || Math.round(height / 3) }, easing: 'easeIn' }, tgt(['over'])))];
    case 'ris': return [common(withTarget({ op: 'move', by: { x: 0, y: -Math.round(height / 4) }, easing: 'easeOut' }, tgt()))];
    case 'rais': case 'lift': case 'lower': case 'reach': {
      const limb = rest.match(/\b(?:(left|right)\s+)?(arm|hand|leg|foot|knee)s?\b/);
      if (!limb) {
        const d = directionOf(rest, dist) || { x: 0, y: v === 'lower' ? dist({ y: 1 }) : -dist({ y: 1 }) };
        return [common(withTarget({ op: 'move', by: d }, tgt(['up', 'down'])))];
      }
      const part = { arm: 'hand', hand: 'hand', leg: 'foot', foot: 'foot', knee: 'foot' }[limb[2]], side = limb[1] || 'right';
      const up = v !== 'lower', d = directionOf(rest, dist);
      const by = d && v === 'reach' ? d : { x: 0, y: Math.round(height / 4 * size) * (up ? -1 : 1) };
      return [common({ op: 'reach', target: `${side} ${part}`, by, ...(/\b(?:and|then)\s+(?:back|down)\b/.test(c) ? { yoyo: true } : {}) })];
    }
    case 'look': case 'tilt': {
      if (/\bup\b/.test(rest)) return [common({ op: 'rotate', target: 'head', degrees: -12, yoyo: true })];
      if (/\bdown\b/.test(rest)) return [common({ op: 'rotate', target: 'head', degrees: 12, yoyo: true })];
      return [common({ op: 'rotate', target: 'head', degrees: /\bleft\b/.test(rest) ? -15 : 15, yoyo: true })];
    }
    case 'kick': {
      const kp = poses.find(n => /kick/i.test(n));
      if (kp) return [common({ op: 'pose', name: kp, yoyo: true })];
      return [common({ op: 'reach', target: `${/\bleft\b/.test(c) ? 'left' : 'right'} foot`, by: { x: Math.round(width / 6), y: -Math.round(height / 6) }, yoyo: true })];
    }
    case 'swing': {
      const s = common(withTarget({ op: 'rotate', degrees: Math.round(20 * size), yoyo: true }, tgt(['swing'])));
      s.times ??= 2;
      return [s];
    }
    case 'hold': case 'wait': case 'paus': return [{ op: 'hold', frames: frames || toNum(rest.match(new RegExp(`\\b${NUM}\\b`))?.[1]) || 4 }];
    case 'repeat': case 'loop': return steps.length ? [{ op: 'repeat', times: times || 2, ...(/\b(?:all|everything|whole)\b/.test(c) ? { steps: steps.length } : {}) }] : null;
    case 'rippl': case 'flutter': return [common(withTarget({ op: 'ripple' }, tgt(['wind'])))];
    case 'danc': return [common(withTarget({ op: 'bounce', height: Math.max(2, Math.round(height / 10)), times: 2 }, tgt())), withTarget({ op: 'spin', axis: 'y' }, tgt())];
    case 'squash': return steps.length ? [{ op: 'squash' }] : [common(withTarget({ op: 'bounce', height: Math.max(2, Math.round(height / 12)), squash: 1 }, tgt()))];
    case 'do': case 'strike': case 'pose': case 'crouch': {
      const name = pose || poses.find(n => targetWords(rest, ['pose']) && n.toLowerCase().includes(targetWords(rest, ['pose']))) || (v === 'crouch' ? poses.find(n => /crouch|squat/i.test(n)) : null);
      if (name) return [common({ op: 'pose', name, yoyo: !/\bhold\b|\bstay\b/.test(c) })];
      if (v === 'crouch') return [common(withTarget({ op: 'move', by: { x: 0, y: Math.round(height / 10) }, yoyo: true }, tgt()))];
      if (/\bagain\b|\bit\b/.test(rest) && steps.length) return [{ op: 'repeat', times: times || 2 }];
      return null;
    }
    default: return pose ? [common({ op: 'pose', name: pose, yoyo: true })] : null;
  }
}
