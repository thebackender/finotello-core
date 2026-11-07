// Icons in the style of Lucide (24×24 grid, 2px stroke, currentColor).
// Each icon is one <svg> with a single <path>: all strokes of an icon are merged into one path string,
// so every part after the first must start with an absolute M (a relative m would start from the previous part).

/** Rounded rectangle and circle as path data, so they can be merged into one path. */
const rect = (x, y, w, h, r) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}` +
  `h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z`;
const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 -${2 * r} 0`;

const LINE = {
  calendar: [rect(3, 4, 18, 18, 2), 'M16 2v4M8 2v4M3 10h18'],
  calendarCheck: [rect(3, 4, 18, 18, 2), 'M16 2v4M8 2v4M3 10h18', 'M9 16l2 2 4-4'],
  x: ['M18 6 6 18M6 6l12 12'],
  pencil: ['M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z', 'M15 5l4 4'],
  alert: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4M12 17h.01'],
  plus: ['M5 12h14M12 5v14'],
  minus: ['M5 12h14'],
  check: ['M20 6 9 17l-5-5'],
  chevronRight: ['m9 18 6-6-6-6'],
  chevronDown: ['m6 9 6 6 6-6'],
  chevronLeft: ['m15 18-6-6 6-6'],
  cornerDownRight: ['m15 10 5 5-5 5', 'M4 4v7a4 4 0 0 0 4 4h12'],
  sun: [circle(12, 12, 4), 'M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2M20 12h2m-15.66 5.66-1.41 1.41M19.07 4.93l-1.41 1.41'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  archive: [rect(2, 3, 20, 5, 1), 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4'],
  clock: [circle(12, 12, 10), 'M12 6v6l4 2'],
  wallet: ['M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1', 'M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4'],
  bank: ['M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 2l8 5H4z'],
  cash: [rect(2, 6, 20, 12, 2), circle(12, 12, 2), 'M6 12h.01M18 12h.01'],
  bitcoin: ['M11.767 19.089c4.924.868 6.14-6.025 1.216-6.894m-1.216 6.894L5.86 18.047m5.908 1.042-.347 1.97m1.563-8.864c4.924.869 6.14-6.025 1.215-6.893m-1.215 6.893-3.94-.694m5.155-6.2L8.29 4.26m5.908 1.042.348-1.97M7.48 20.364l3.126-17.727'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', circle(9, 7, 4), 'M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'],
  piggy: ['M19 5c-1.5 0-2.8 1.4-3 2-3.5-1.5-11-.3-11 5 0 1.8 0 3 2 4.5V20h4v-2h3v2h4v-4c1-.5 1.7-1 2-2h2v-4h-2c0-1-.5-1.5-1-2V5z', 'M2 9v1c0 1.1.9 2 2 2h1', 'M16 11h.01'],
  shield: ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'],
  arrowIn: ['M17 7 7 17', 'M17 17H7V7'],
  arrowOut: ['M7 7h10v10', 'M7 17 17 7'],
  transfer: ['M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4'],
  refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5'],
  scale: ['m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z', 'M2 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z', 'M7 21h10M12 3v18M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2'],
  trash: ['M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'],
  search: [circle(11, 11, 8), 'M21 21l-4.3-4.3'],
  split: ['M11 12H3M16 6H3M16 18H3M18 9v6M21 12h-6'],
  table: [rect(3, 3, 18, 18, 2), 'M3 9h18M3 15h18M12 3v18'],
  chart: ['M3 3v16a2 2 0 0 0 2 2h16', 'M7 16v-4M12 16V8M17 16v-7'],
  bag: ['M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z', 'M3 6h18', 'M16 10a4 4 0 0 1-8 0'],
  target: [circle(12, 12, 10), circle(12, 12, 6), circle(12, 12, 2)],
  more: ['M12 12h.01M19 12h.01M5 12h.01'],
  eyeOff: ['M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68', 'M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61', 'M14.12 14.12a3 3 0 1 1-4.24-4.24M2 2l20 20'],
  merge: ['m8 6 4-4 4 4', 'M12 2v10.3a4 4 0 0 1-1.17 2.83L4 22', 'M20 22l-5-5'],
  info: [circle(12, 12, 10), 'M12 16v-4M12 8h.01'],
};
const LINE_D = Object.fromEntries(Object.entries(LINE).map(([name, parts]) => [name, parts.join('')]));

const STROKE = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';

/** Inline icon. size in px; extra class names go on the <svg>. */
export function icon(name, size = 16, cls = '') {
  return `<svg class="i${cls ? ` ${cls}` : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE} stroke-width="2" aria-hidden="true">` +
    `<path d="${LINE_D[name]}"/></svg>`;
}

/** Icon of a wallet type. */
export const WALLET_ICONS = { bank: 'bank', cash: 'cash', crypto: 'bitcoin', debt: 'users' };
