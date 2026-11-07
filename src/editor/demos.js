/**
 * Tiny looping SVG demos for tour cards and rich tooltips. Each is a pixel-grid sketch (one viewBox unit = one pixel)
 * animated with SMIL, so it needs no script; playDemo pauses them when the user prefers reduced motion.
 */
const W = 24, H = 14, DUR = 3;
const loop = (dur = DUR) => `dur="${dur}s" repeatCount="indefinite"`;
const C = { ink: '#283b2e', green: '#4f8a5b', leaf: '#8fbf6a', lime: '#cfe39a', pink: '#ff2d87', sky: '#79a9d6', sea: '#3c6e9e', warm: '#e9a35b', paper: '#fffefb' };
const RAMP = ['#2d2445', '#5a3a5e', '#9a5b62', '#d38f6a', '#f2d39b'];

const rect = (x, y, w, h, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`;
/** Hidden until `at` (fraction of the loop), visible until `until`. */
const show = (at, until = 0.94) => `<animate attributeName="opacity" values="0;1;0" keyTimes="0;${at};${until}" calcMode="discrete" ${loop()}/>`;
const px = (x, y, fill, at = null, until) => at === null ? rect(x, y, 1, 1, fill) : `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}" opacity="0">${show(at, until)}</rect>`;
const move = (values, times, extra = '') => `<animateTransform attributeName="transform" type="translate" values="${values}" keyTimes="${times}" ${loop()}${extra}/>`;
const discrete = (attr, values, times) => `<animate attributeName="${attr}" values="${values}" keyTimes="${times}" calcMode="discrete" ${loop()}/>`;
const ants = `stroke-dasharray=".8 .6"><animate attributeName="stroke-dashoffset" values="0;1.4" dur=".7s" repeatCount="indefinite"/></rect>`;
const sprite = (x, y, body = C.green) => [[1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [3, 1], [0, 2], [1, 2], [2, 2], [3, 2], [1, 3], [2, 3]].map(([a, b]) => px(x + a, y + b, body)).join('') + px(x + 1, y + 1, C.ink) + px(x + 3, y + 1, C.ink);
const pointer = (x, y) => `<path d="M${x} ${y}l0 3.2 .9-.9 .7 1.4.6-.3-.7-1.3h1.3Z" fill="${C.paper}" stroke="${C.ink}" stroke-width=".25" stroke-linejoin="round"/>`;
const label = (x, y, text, extra = '') => `<text x="${x}" y="${y}" font-size="1.5" font-weight="600" fill="${C.ink}" font-family="-apple-system,Segoe UI,sans-serif"${extra}>${text}</text>`;

/** Pixels of a staircase stroke, with the doubled corners a plain freehand stroke would leave. */
const STROKE = [[3, 10], [4, 10], [5, 9], [6, 9], [7, 8], [8, 7], [9, 7], [10, 6], [11, 6], [12, 5], [13, 5], [14, 5], [15, 4], [16, 4], [17, 4], [18, 3], [19, 3], [20, 3]];
const CORNERS = [[5, 10], [8, 8], [12, 6], [15, 5], [18, 4]];
const cursorPath = points => {
  const times = points.map((_, i) => (0.04 + 0.66 * i / (points.length - 1)).toFixed(3));
  const coord = k => [points[0][k], ...points.map(p => p[k]), points.at(-1)[k]].map(v => v + 0.5).join(';');
  const keys = ['0', ...times, '1'].join(';');
  return `<circle r=".85" fill="none" stroke="${C.pink}" stroke-width=".3"><animate attributeName="cx" values="${coord(0)}" keyTimes="${keys}" ${loop()}/><animate attributeName="cy" values="${coord(1)}" keyTimes="${keys}" ${loop()}/></circle>`;
};
const blob = [[8, 4], [9, 4], [10, 4], [7, 5], [8, 5], [9, 5], [10, 5], [11, 5], [7, 6], [8, 6], [9, 6], [10, 6], [11, 6], [12, 6], [7, 7], [8, 7], [9, 7], [10, 7], [11, 7], [12, 7], [8, 8], [9, 8], [10, 8], [11, 8], [9, 9], [10, 9]];
const outlineOf = shape => {
  const has = new Set(shape.map(p => p.join())), out = new Set();
  for (const [x, y] of shape) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!has.has(`${x + dx},${y + dy}`)) out.add(`${x + dx},${y + dy}`);
  return [...out].map(s => s.split(',').map(Number));
};
const bone = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C.ink}" stroke-width=".8" stroke-linecap="round"/>`;
const joint = (x, y) => `<circle cx="${x}" cy="${y}" r=".7" fill="${C.pink}"/>`;
const spin = (cx, cy, values, times) => `<animateTransform attributeName="transform" type="rotate" values="${values.map(v => `${v} ${cx} ${cy}`).join(';')}" keyTimes="${times}" calcMode="spline" keySplines="${times.split(';').slice(1).map(() => '.45 0 .55 1').join(';')}" ${loop()}/>`;

const DEMOS = {
  pencil: () => STROKE.map((p, i) => px(...p, C.ink, (0.04 + 0.66 * i / (STROKE.length - 1)).toFixed(3))).join('')
    + CORNERS.map(([x, y], i) => px(x, y, C.pink, (0.06 + 0.13 * i + 0.02).toFixed(3), (0.06 + 0.13 * i + 0.1).toFixed(3))).join('') + cursorPath(STROKE),
  curve: () => `<path fill="none" stroke="${C.ink}" stroke-width="1" d="M3.5 11.5 Q12.5 7.5 21.5 3.5"><animate attributeName="d" values="M3.5 11.5 Q12.5 7.5 21.5 3.5;M3.5 11.5 Q12.5 7.5 21.5 3.5;M3.5 11.5 Q6 -1 21.5 3.5;M3.5 11.5 Q6 -1 21.5 3.5;M3.5 11.5 Q12.5 7.5 21.5 3.5" keyTimes="0;.25;.6;.85;1" ${loop()}/></path>`
    + rect(3, 11, 1, 1, C.green) + rect(21, 3, 1, 1, C.green)
    + `<circle r=".9" fill="${C.pink}" cx="12.5" cy="7.5"><animate attributeName="cx" values="12.5;12.5;9.25;9.25;12.5" keyTimes="0;.25;.6;.85;1" ${loop()}/><animate attributeName="cy" values="7.5;7.5;3.75;3.75;7.5" keyTimes="0;.25;.6;.85;1" ${loop()}/></circle>`,
  shade: () => [0, 1, 2, 3].map(i => `<rect x="${4 + i * 4}" y="3" width="3" height="3" fill="${RAMP[3]}">${discrete('fill', `${RAMP[3]};${RAMP[2]};${RAMP[1]};${RAMP[3]}`, `0;${(0.12 + i * 0.08).toFixed(2)};${(0.5 + i * 0.08).toFixed(2)};.95`)}</rect>`).join('')
    + RAMP.map((c, i) => rect(7 + i * 2, 10, 2, 2, c)).join('') + `<circle r=".9" cy="4.5" fill="none" stroke="${C.pink}" stroke-width=".3"><animate attributeName="cx" values="5.5;5.5;17.5;5.5;17.5;17.5" keyTimes="0;.1;.4;.48;.78;1" ${loop()}/></circle>`,
  gradient: () => RAMP.map((c, i) => `<rect x="${2 + i * 4}" y="2" width="4" height="10" fill="${c}" opacity="0">${show((0.42 + i * 0.05).toFixed(2))}</rect>`).join('')
    + `<line x1="2.5" y1="7" x2="2.5" y2="7" stroke="${C.pink}" stroke-width=".45" stroke-linecap="round"><animate attributeName="x2" values="2.5;2.5;21.5;21.5" keyTimes="0;.06;.36;1" ${loop()}/></line><circle cx="2.5" cy="7" r=".7" fill="${C.pink}"/>`,
  select: () => `<g>${move('0 0;0 0;5 1;5 1', '0;.48;.7;1')}${sprite(5, 5, C.warm)}<rect x="4" y="4" width="0" height="0" fill="none" stroke="${C.ink}" stroke-width=".3"><animate attributeName="width" values="0;6;6" keyTimes="0;.35;1" ${loop()}/><animate attributeName="height" values="0;6;6" keyTimes="0;.35;1" ${loop()}/><animate attributeName="stroke-dashoffset" values="0;1.4" dur=".7s" repeatCount="indefinite"/></rect></g>`
    .replace('stroke-width=".3">', 'stroke-width=".3" stroke-dasharray=".8 .6">'),
  wand: () => blob.map(p => px(...p, C.leaf)).join('') + [[16, 8], [17, 8], [16, 9], [17, 9], [18, 9], [17, 10]].map(p => px(...p, C.sky)).join('')
    + `<rect x="6.5" y="3.5" width="7" height="7" rx=".4" fill="none" stroke="${C.pink}" stroke-width=".35" opacity="0" ${ants.replace('</rect>', `${show(0.32)}</rect>`)}`
    + `<g>${move('14 10;14 10;9 6;9 6', '0;.05;.28;1')}${`<path d="M0 0l2 2M-.4 .9l.5-.5M.9-.4l-.5.5" stroke="${C.ink}" stroke-width=".35" stroke-linecap="round"/>`}</g>`,
  move: () => `<g>${move('0 0;0 0;10 -2;10 -2;0 0', '0;.15;.5;.8;1', ' calcMode="spline" keySplines="0 0 1 1;.45 0 .55 1;0 0 1 1;.45 0 .55 1"')}${sprite(5, 6)}<rect x="4.5" y="5.5" width="5" height="5" fill="none" stroke="${C.pink}" stroke-width=".3" ${ants}${pointer(7.6, 8.2)}</g>`,
  transform: () => `<g transform="translate(12 7)"><g>${spin(0, 0, [0, 0, 0, 25, 25, 0], '0;.35;.5;.7;.85;1')}<g><animateTransform attributeName="transform" type="scale" values="1;1.5 .7;1.5 .7;1;1" keyTimes="0;.2;.35;.5;1" ${loop()}/>${rect(-3, -3, 6, 6, C.leaf)}${rect(-1.5, -1.5, 1, 1, C.ink)}${rect(0.5, -1.5, 1, 1, C.ink)}<rect x="-3" y="-3" width="6" height="6" fill="none" stroke="${C.pink}" stroke-width=".25"/>${[[-3, -3], [3, -3], [-3, 3], [3, 3]].map(([x, y]) => rect(x - 0.5, y - 0.5, 1, 1, C.paper, ` stroke="${C.pink}" stroke-width=".2"`)).join('')}</g></g></g>`,
  skeleton: () => `<circle cx="12" cy="2.2" r="1.5" fill="none" stroke="${C.ink}" stroke-width=".6"/>${bone(12, 3.7, 12, 8.5)}${bone(12, 8.5, 9.5, 12.5)}${bone(12, 8.5, 14.5, 12.5)}${bone(12, 5, 9, 7)}`
    + `<g>${spin(12, 5, [0, -70, -70, 0], '0;.4;.6;1')}${bone(12, 5, 15.5, 7)}<g>${spin(15.5, 7, [0, -50, -50, 0], '0;.4;.6;1')}${bone(15.5, 7, 18.5, 9)}${joint(18.5, 9)}</g>${joint(15.5, 7)}</g>${joint(12, 5)}${joint(12, 8.5)}`,
  rig: () => `${rect(10, 3, 3, 6, C.leaf)}<g>${move('4 2;4 2;0 0;0 0', '0;.3;.5;1')}${rect(13, 4, 5, 2, C.warm)}</g>`
    + `<circle cx="13" cy="5" r="0" fill="${C.pink}"><animate attributeName="r" values="0;0;.9;.7;.7" keyTimes="0;.5;.58;.65;1" ${loop()}/></circle><g>${move('19 7;19 7;13.4 5.4;13.4 5.4', '0;.1;.45;1')}${pointer(0, 0)}</g>`,
  zoom: () => `<g transform="translate(12 7)"><g><animateTransform attributeName="transform" type="scale" values="1;1;1.7;1.7;1" keyTimes="0;.2;.45;.8;1" calcMode="spline" keySplines="0 0 1 1;.45 0 .55 1;0 0 1 1;.45 0 .55 1" ${loop()}/><g transform="translate(-2 -2)">${sprite(0, 0)}</g></g></g>`
    + `<circle cx="20" cy="10.5" r="1.6" fill="none" stroke="${C.ink}" stroke-width=".4"/><path d="M21.2 11.7l1.3 1.3M19.3 10.5h1.4M20 9.8v1.4" stroke="${C.ink}" stroke-width=".35"/>`,
  palette: () => {
    const sw = [C.ink, C.green, C.leaf, C.lime, C.warm, RAMP[2], C.sky, C.sea];
    return sw.map((c, i) => rect(1.5 + i * 2.7, 2, 2.2, 2.2, c)).join('')
      + `<rect y="1.5" width="3.2" height="3.2" rx=".4" fill="none" stroke="${C.pink}" stroke-width=".35">${discrete('x', '3.7;12.1;17.5', '0;.33;.66')}</rect>`
      + [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((x, i) => `<rect x="${x}" y="${9 + (i % 3 === 0 ? 0 : 1)}" width="1" height="1">${discrete('fill', `${sw[1]};${sw[4]};${sw[6]}`, '0;.33;.66')}</rect>`).join('');
  },
  frames: () => [0, 1, 2, 3].map(i => `${rect(1.5 + i * 5.5, 8.5, 4.5, 4.5, C.paper, ` stroke="#cfd8c7" stroke-width=".25"`)}${rect(3.2 + i * 5.5, [11, 9.7, 9.3, 9.7][i], 1.2, 1.2, C.green)}`).join('')
    + `<rect y="8.2" width="5.1" height="5.1" rx=".4" fill="none" stroke="${C.pink}" stroke-width=".35">${discrete('x', '1.2;6.7;12.2;17.7', '0;.25;.5;.75')}</rect>`
    + `<rect x="10" width="4" height="4" fill="${C.green}">${discrete('y', '3.5;1.5;.6;1.5', '0;.25;.5;.75')}</rect>`,
  scope: () => [0, 1, 2, 3].map(i => `${rect(1.5 + i * 5.5, 6.5, 4.5, 4.5, C.paper, ` stroke="#cfd8c7" stroke-width=".25"`)}<rect x="${3.2 + i * 5.5}" y="8.2" width="1.2" height="1.2" fill="${C.pink}" opacity="0">${i === 1 ? show(0.15) : show(0.15, 0.5)}</rect>`).join('')
    + `<g opacity="0">${show(0.02, 0.5)}${label(1.5, 4, 'All frames')}${rect(1.2, 5, 22, 0.4, C.green)}</g><g opacity="0">${show(0.5)}${label(7, 4, 'This frame')}${rect(6.7, 5, 5.1, 0.4, C.green)}</g>`,
  preview: () => `${rect(2, 12, 20, 0.5, '#cfd8c7')}<g>${move('0 0;0 -5;0 0', '0;.5;1', ' calcMode="spline" keySplines=".2 .6 .4 1;.6 0 .8 .4"')}${sprite(10, 8)}</g>`
    + `<circle cx="18.6" cy="2.3" r=".6" fill="${C.pink}"><animate attributeName="opacity" values="1;.2;1" dur="1.2s" repeatCount="indefinite"/></circle>${label(19.6, 3, 'LIVE')}`,
  export: () => `${rect(1.5, 3, 7, 7, C.paper, ` stroke="#cfd8c7" stroke-width=".3"`)}${sprite(3, 4.5)}<g>${move('0 0;4 0;0 0', '0;.5;1')}<path d="M10 6.5h3m-1-1 1 1-1 1" fill="none" stroke="${C.pink}" stroke-width=".45" stroke-linecap="round"/></g>`
    + `<path d="M15.5 2h4.5l2 2v8h-6.5Z" fill="${C.paper}" stroke="${C.ink}" stroke-width=".35"/>${['.png', '.gif', '.pxa'].map((t, i) => `<g opacity="0">${show([0.01, 0.33, 0.66][i], [0.33, 0.66, 0.99][i])}${label(15.9, 9, t, ' font-size="1.7"')}</g>`).join('')}`,
  tween: () => `<path d="M5 10.5 Q8 1 19 4.5" fill="none" stroke="${C.pink}" stroke-width=".25" stroke-dasharray=".6 .5"/>`
    + `<g opacity=".35">${sprite(17, 2.5)}</g>` + [[7.4, 6.2], [10.5, 4.2], [14.2, 3.6]].map(([x, y], i) => `<rect x="${x - 1}" y="${y - 1}" width="2" height="2" fill="none" stroke="${C.green}" stroke-width=".25" opacity="0">${show((0.15 + i * 0.08).toFixed(2), 0.6)}</rect>`).join('')
    + `<g><animateMotion path="M0 0 Q3 -9.5 14 -6" keyPoints="0;0;1;1" keyTimes="0;.55;.85;1" calcMode="linear" ${loop()}/>${sprite(3, 8.5)}</g>`,
  bounce: () => `${rect(3, 12, 18, 0.5, '#cfd8c7')}<ellipse cx="12" cy="3" rx="2" ry="2" fill="${C.warm}"><animate attributeName="cy" values="3;10;10;3" keyTimes="0;.45;.55;1" calcMode="spline" keySplines=".5 0 1 .5;0 0 1 1;0 .5 .5 1" ${loop(1.6)}/><animate attributeName="rx" values="1.7;1.7;2.8;1.7;1.7" keyTimes="0;.42;.5;.58;1" ${loop(1.6)}/><animate attributeName="ry" values="2.2;2.2;1.2;2.2;2.2" keyTimes="0;.42;.5;.58;1" ${loop(1.6)}/></ellipse>`,
  follow: () => {
    const lead = (begin, r, fill) => `<circle cx="8" cy="5" r="${r}" fill="${fill}"><animate attributeName="cx" values="6;18;6" keyTimes="0;.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" ${loop(2.4)} begin="${begin}s"/></circle>`;
    return `<g transform="translate(0 0)">${lead(0, 2, C.green)}</g><g transform="translate(0 2.4)">${lead(0.14, 1.1, C.warm)}</g><g transform="translate(0 4.2)">${lead(0.28, 0.95, C.warm)}</g><g transform="translate(0 5.8)">${lead(0.42, 0.8, C.warm)}</g>`;
  },
  wave: () => `${rect(3, 1.5, 0.7, 11.5, C.ink)}<path fill="${C.sky}" d="M3.7 2 C8 0 12 4 20 2 V9 C12 11 8 7 3.7 9Z"><animate attributeName="d" values="M3.7 2 C8 0 12 4 20 2 V9 C12 11 8 7 3.7 9Z;M3.7 2 C8 4 12 0 20 2 V9 C12 7 8 11 3.7 9Z;M3.7 2 C8 0 12 4 20 2 V9 C12 11 8 7 3.7 9Z" keyTimes="0;.5;1" ${loop(1.6)}/></path>`,
  outline: () => blob.map(p => px(...p, C.leaf)).join('') + outlineOf(blob).map(p => px(...p, C.ink, 0.35)).join(''),
  aa: () => {
    const line = [[3, 10], [4, 10], [5, 10], [6, 9], [7, 9], [8, 9], [9, 8], [10, 8], [11, 8], [12, 7], [13, 7], [14, 7], [15, 6], [16, 6], [17, 6], [18, 5], [19, 5], [20, 5]];
    const soft = [[5, 9], [6, 10], [8, 8], [9, 9], [11, 7], [12, 8], [14, 6], [15, 7], [17, 5], [18, 6]];
    return line.map(p => px(...p, C.ink)).join('') + soft.map(p => px(...p, '#93a191', 0.4)).join('');
  },
  corner: () => STROKE.map(p => px(...p, C.ink)).join('') + CORNERS.map(p => `<rect x="${p[0]}" y="${p[1]}" width="1" height="1" fill="${C.pink}">${discrete('opacity', '1;0', '0;.5')}</rect>`).join(''),
  wheel: () => {
    const hues = ['#e05a5a', '#e9a35b', '#e8d45a', '#8fbf6a', '#4fa58b', '#79a9d6', '#5a6fd0', '#a46ad0', '#d06aa8'];
    const dots = hues.map((c, i) => { const a = i / hues.length * Math.PI * 2; return `<circle cx="${(12 + Math.cos(a) * 5).toFixed(2)}" cy="${(7 + Math.sin(a) * 5).toFixed(2)}" r="1.25" fill="${c}"/>`; }).join('');
    const marks = [0, 1, 2].map(i => { const a = i / 3 * Math.PI * 2; return `<circle cx="${(12 + Math.cos(a) * 5).toFixed(2)}" cy="${(7 + Math.sin(a) * 5).toFixed(2)}" r="1.75" fill="none" stroke="${C.ink}" stroke-width=".35"/>`; }).join('');
    return `${dots}<g>${spin(12, 7, [0, 40, 40, 0], '0;.4;.6;1')}<path d="M17 7 L12 7" stroke="${C.ink}" stroke-width=".2"/>${marks}</g>`;
  },
  ramp: () => RAMP.map((c, i) => `<rect x="${2 + i * 4.1}" y="4" width="3.6" height="6" rx=".4" fill="${c}" opacity="0">${show((0.08 + i * 0.12).toFixed(2))}</rect>`).join(''),
  cycle: () => [0, 1, 2, 3, 4, 5].map(i => `<rect x="2" y="${1.5 + i * 1.8}" width="20" height="1.8">${discrete('fill', [0, 1, 2, 3, 4, 5].map(k => [C.sea, C.sky, '#b9d8ef', C.sky, C.sea, '#2a4f75'][(i + k) % 6]).join(';'), '0;.166;.333;.5;.666;.833')}</rect>`).join(''),
  float: () => `${rect(1, 1, 22, 12, C.paper, ` stroke="#cfd8c7" stroke-width=".3"`)}${rect(17, 1, 6, 12, '#f0f4e9')}<rect x="17.5" y="2" width="5" height="4" fill="none" stroke="#b9c6ad" stroke-width=".25" stroke-dasharray=".6 .5"/>`
    + `<g>${move('0 0;0 0;-9 3;-9 3;0 0', '0;.2;.5;.85;1')}${rect(17.5, 2, 5, 4, C.paper, ` stroke="${C.green}" stroke-width=".3"`)}${rect(17.5, 2, 5, 1, C.green)}</g>`,
};

export const DEMO_NAMES = Object.keys(DEMOS);
/** SVG markup for demo `name` ('' when unknown). */
export function demoMarkup(name) {
  return DEMOS[name] ? `<svg class="onb-demo" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false" shape-rendering="crispEdges">${DEMOS[name]()}</svg>` : '';
}
/** Put demo `name` into `container`, frozen for users who prefer reduced motion. */
export function playDemo(container, name) {
  container.innerHTML = demoMarkup(name);
  container.hidden = !container.innerHTML;
  const svg = container.querySelector('svg');
  if (svg && globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { svg.pauseAnimations(); svg.setCurrentTime(DUR * 0.8); }
}
