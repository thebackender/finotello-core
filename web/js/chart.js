// Small charts drawn by hand in SVG / HTML, following the dataviz rules: a 2px surface gap between touching parts,
// text in text colors (never the data color), a hover / focus tooltip, and the numbers also shown without hovering.
import { esc, paint } from './util.js';

/** A ring slice from angle a0 to a1 (radians, clockwise from 12 o'clock). r = 0 gives a pie wedge. */
function slicePath(cx, cy, R, r, a0, a1) {
  const end = Math.min(a1, a0 + Math.PI * 2 - 1e-4); // a full circle needs a hair of a gap to draw
  const large = end - a0 > Math.PI ? 1 : 0;
  const at = (radius, a) => `${(cx + radius * Math.sin(a)).toFixed(2)} ${(cy - radius * Math.cos(a)).toFixed(2)}`;
  return `M${at(R, a0)}A${R} ${R} 0 ${large} 1 ${at(R, end)}` +
    (r ? `L${at(r, end)}A${r} ${r} 0 ${large} 0 ${at(r, a0)}Z` : `L${cx} ${cy}Z`);
}

/**
 * Pie (a ring, with the total in the middle): one whole split into parts.
 * slices: [{name, value (number > 0), color (light-theme hex), text (formatted value), key?}], largest first;
 * key: put on the slice as data-open, so a click can unfold it in the list.
 * fold the tail into "Other" before calling. center: [big text, small text].
 * Slices are separated by a 2px gap in the surface color. Hover / focus a slice for its name, value and share;
 * the list next to the chart carries the same numbers without hovering.
 */
export function pieHTML(slices, { center = ['', ''], caption = '', size = 220, hole = 0.62 } = {}) {
  const total = slices.reduce((sum, x) => sum + x.value, 0);
  if (total <= 0) return '';
  const R = size / 2 - 2;
  const c = size / 2;
  let angle = 0;
  const paths = slices.map((x, i) => {
    const a0 = angle;
    angle += (x.value / total) * Math.PI * 2;
    const share = Math.round((x.value / total) * 100);
    return `<path d="${slicePath(c, c, R, R * hole, a0, angle)}" fill="${paint(x.color)}" class="slice" data-slice="${i}" tabindex="0"${x.key != null ? ` data-open="${esc(x.key)}"` : ''}
      aria-label="${esc(`${x.name}: ${x.text}, ${share < 1 ? 'under 1' : share}%`)}"></path>`;
  }).join('');
  return `<div class="pie-wrap">
    <svg class="pie" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(caption)}">${paths}
      ${hole ? `<text x="${c}" y="${c - 2}" class="pie-total" text-anchor="middle">${esc(center[0])}</text>
      <text x="${c}" y="${c + 18}" class="pie-sub" text-anchor="middle">${esc(center[1])}</text>` : ''}
    </svg>
    <div class="chart-tip" role="status" hidden></div>
  </div>`;
}

/**
 * Hover for a pie drawn with pieHTML inside root: a tooltip on each slice, and the slice and its row
 * in the list (elements with the same data-slice) light up together.
 */
export function bindPie(root, slices) {
  const wrap = root.querySelector('.pie-wrap');
  if (!wrap) return;
  const tip = wrap.querySelector('.chart-tip');
  const total = slices.reduce((sum, x) => sum + x.value, 0);
  const light = (i) => {
    root.querySelectorAll('[data-slice]').forEach((n) => n.classList.toggle('on', i != null && n.dataset.slice === String(i)));
    wrap.querySelector('svg').classList.toggle('focused', i != null);
  };
  const show = (i, x, y) => {
    const s = slices[i];
    tip.replaceChildren();
    const value = document.createElement('b');
    value.textContent = s.text;
    const name = document.createElement('span');
    const share = (s.value / total) * 100;
    name.textContent = `${s.name} · ${share > 0 && share < 1 ? '<1' : Math.round(share)}%`;
    const row = document.createElement('div');
    row.className = 'tip-row';
    const key = document.createElement('i');
    key.className = 'line-key';
    key.style.setProperty('--c', paint(s.color));
    row.append(key, value, name);
    tip.append(row);
    tip.hidden = false;
    tip.style.left = `${Math.max(0, x - tip.offsetWidth / 2)}px`;
    tip.style.top = `${Math.max(0, y - tip.offsetHeight - 12)}px`;
  };
  const hide = () => {
    tip.hidden = true;
    light(null);
  };
  root.addEventListener('pointerover', (e) => {
    const n = e.target.closest('[data-slice]');
    if (!n) return;
    light(n.dataset.slice);
    if (n.classList.contains('slice')) {
      const box = wrap.getBoundingClientRect();
      show(Number(n.dataset.slice), e.clientX - box.left, e.clientY - box.top);
    }
  });
  root.addEventListener('pointermove', (e) => {
    const n = e.target.closest('.slice');
    if (!n) return;
    const box = wrap.getBoundingClientRect();
    show(Number(n.dataset.slice), e.clientX - box.left, e.clientY - box.top);
  });
  root.addEventListener('pointerout', (e) => {
    if (e.target.closest('[data-slice]') && !e.relatedTarget?.closest?.(`[data-slice="${e.target.closest('[data-slice]').dataset.slice}"]`)) hide();
  });
  wrap.addEventListener('focusin', (e) => {
    const n = e.target.closest('.slice');
    if (!n) return;
    light(n.dataset.slice);
    const box = n.getBoundingClientRect();
    const base = wrap.getBoundingClientRect();
    show(Number(n.dataset.slice), box.left + box.width / 2 - base.left, box.top - base.top + 8);
  });
  wrap.addEventListener('focusout', hide);
}

/** Progress toward a target: fill on a lighter track of the same hue. state: '' | 'warn' | 'over'. */
export function meter(value, max, { state = '', label = '' } = {}) {
  const share = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return `<span class="meter ${state}" role="meter" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${value}"
    ${label ? `aria-label="${esc(label)}"` : ''}><span class="meter-fill" style="width:${(share * 100).toFixed(1)}%"></span></span>`;
}

/** One whole split into parts: a thin bar, no text (the list next to it carries the numbers). parts: [{value, color, name}]. */
export function segmentedBar(parts, label) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  if (total <= 0) return '';
  return `<div class="segbar" role="img" aria-label="${esc(label)}: ${esc(parts.map((p) => `${p.name} ${Math.round((Math.max(0, p.value) / total) * 100)}%`).join(', '))}">
    ${parts.filter((p) => p.value > 0).map((p) => `<span style="flex:${p.value / total};--c:${paint(p.color)}" title="${esc(p.name)}"></span>`).join('')}
  </div>`;
}

// ---------- line chart over months ----------

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (month, withYear) => `${SHORT_MONTHS[Number(month.slice(5, 7)) - 1]}${withYear ? ` ${month.slice(0, 4)}` : ''}`;

/** Clean steps for an axis: about `count` ticks from lo to hi, on 1 / 2 / 2.5 / 5 × 10^n. */
function niceTicks(lo, hi, count = 4) {
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** Axis ticks, padding and the month / value -> pixel mappings, shared by drawing and hover. */
function lineGeometry(months, series, width, height) {
  const all = series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const [lo, hi] = [ticks[0], ticks.at(-1)];
  const pad = { top: 12, right: 76, bottom: 26, left: 52 };
  const plotW = Math.max(40, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const x = (i) => pad.left + (months.length === 1 ? plotW / 2 : (i / (months.length - 1)) * plotW);
  const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * plotH;
  return { ticks, pad, plotW, plotH, x, y };
}

/**
 * Lines over months, one value per month and series, on one axis that includes zero.
 * months: ['2026-09', …]; series: [{name, color (light-theme hex), values: [number]}];
 * fmtShort: axis and end labels (compact); fmtFull: tooltip and table. width: the container's width in px.
 * Every series has its value at the line's end; hover / arrow keys show all series for one month;
 * a table under the chart has every number.
 */
export function lineChartHTML({ months, series, width, height = 220, fmtShort, fmtFull, caption }) {
  const { ticks, pad, plotW, plotH, x, y } = lineGeometry(months, series, width, height);

  const grid = ticks.map((t) => `<line x1="${pad.left}" x2="${pad.left + plotW}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"
      class="${t === 0 ? 'axis-base' : 'axis-grid'}"/>
    <text x="${pad.left - 8}" y="${(y(t) + 4).toFixed(1)}" class="axis-label" text-anchor="end">${esc(fmtShort(t))}</text>`).join('');

  // Month labels that fit side by side; the year with the first one and with every January.
  const every = Math.max(1, Math.ceil(months.length / Math.max(1, Math.floor(plotW / 64))));
  const xLabels = months.map((m, i) => (i % every && i !== months.length - 1 ? '' : `<text x="${x(i).toFixed(1)}" y="${height - 8}"
      class="axis-label" text-anchor="middle">${esc(monthLabel(m, i === 0 || m.endsWith('-01')))}</text>`)).join('');

  const lines = series.map((s) => {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
    return `<path d="${d}" class="series-line" stroke="${paint(s.color)}"/>
      ${months.length === 1 ? `<circle cx="${x(0)}" cy="${y(s.values[0])}" r="4" fill="${paint(s.color)}" class="series-dot"/>` : ''}`;
  }).join('');

  // Values at the line ends; a label that would sit on top of the one before it is left to the tooltip.
  const placed = [];
  const endLabels = series.map((s) => {
    const ly = y(s.values.at(-1));
    if (placed.some((p) => Math.abs(p - ly) < 14)) return '';
    placed.push(ly);
    return `<text x="${x(months.length - 1) + 8}" y="${(ly + 4).toFixed(1)}" class="end-label">${esc(fmtShort(s.values.at(-1)))}</text>`;
  }).join('');

  const table = `<details class="chart-table"><summary>Table</summary><div class="table-wrap"><table class="data">
    <thead><tr><th>Month</th>${series.map((s) => `<th class="num">${esc(s.name)}</th>`).join('')}</tr></thead>
    <tbody>${months.map((m, i) => `<tr><td>${esc(monthLabel(m, true))}</td>${series.map((s) => `<td class="num">${esc(fmtFull(s.values[i]))}</td>`).join('')}</tr>`).reverse().join('')}</tbody>
  </table></div></details>`;

  return `<div class="line-wrap">
    ${series.length > 1 ? `<div class="line-legend">${series.map((s) => `<span><i class="line-key" style="--c:${paint(s.color)}"></i>${esc(s.name)}</span>`).join('')}</div>` : ''}
    <div class="line-plot">
      <svg class="line-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" tabindex="0" aria-label="${esc(caption)}">
        ${grid}${xLabels}${lines}${endLabels}
        <line class="crosshair" y1="${pad.top}" y2="${pad.top + plotH}" hidden/>
        <g class="hover-dots"></g>
        <rect class="hit" x="${pad.left - 12}" y="0" width="${plotW + 24}" height="${height}" fill="transparent"/>
      </svg>
      <div class="chart-tip" role="status" hidden></div>
    </div>
    ${table}
  </div>`;
}

/** Crosshair and tooltip for a chart drawn with lineChartHTML inside root (same arguments). */
export function bindLineChart(root, { months, series, width, height = 220, fmtFull }) {
  const svg = root.querySelector('.line-chart');
  if (!svg) return;
  const tip = root.querySelector('.line-plot .chart-tip');
  const cross = svg.querySelector('.crosshair');
  const dots = svg.querySelector('.hover-dots');
  const { pad, plotW, x, y } = lineGeometry(months, series, width, height);
  let current = null;

  function show(i) {
    current = i;
    const cx = x(i);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.removeAttribute('hidden');
    dots.innerHTML = series.map((s) => `<circle cx="${cx}" cy="${y(s.values[i])}" r="4.5" fill="${paint(s.color)}" class="series-dot"/>`).join('');
    tip.replaceChildren();
    const title = document.createElement('div');
    title.className = 'tip-title';
    title.textContent = monthLabel(months[i], true);
    tip.append(title);
    for (const s of series) {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const key = document.createElement('i');
      key.className = 'line-key';
      key.style.setProperty('--c', paint(s.color));
      const value = document.createElement('b');
      value.textContent = fmtFull(s.values[i]);
      const name = document.createElement('span');
      name.textContent = s.name;
      row.append(key, value, name);
      tip.append(row);
    }
    tip.hidden = false;
    const left = cx + 12 + tip.offsetWidth > width ? cx - 12 - tip.offsetWidth : cx + 12;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${pad.top}px`;
  }
  function hide() {
    current = null;
    cross.setAttribute('hidden', '');
    dots.innerHTML = '';
    tip.hidden = true;
  }
  const nearest = (clientX) => {
    const box = svg.getBoundingClientRect();
    const px = clientX - box.left;
    if (months.length === 1) return 0;
    return Math.max(0, Math.min(months.length - 1, Math.round(((px - pad.left) / plotW) * (months.length - 1))));
  };
  svg.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(months.length - 1));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    show(Math.max(0, Math.min(months.length - 1, (current ?? months.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1))));
  });
}
