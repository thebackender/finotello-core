// Small charts drawn by hand in SVG / HTML, following the dataviz rules:
// thin marks (bars <= 24px, 4px rounded data end, square at the baseline), hairline grid, a legend for 2+ series,
// a hover / focus tooltip on every column, and a table view with the same numbers.
import { esc, paint } from './util.js';

const SVG = 'http://www.w3.org/2000/svg';

/** Round numbers for the y axis: 0, 500, 1000, … up to at least max. */
function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** A bar growing up from the baseline: square bottom, 4px rounded top. */
function columnPath(x, y, w, h) {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
}

const el = (name, attrs = {}) => {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

/**
 * Grouped columns. container: an empty element. opts:
 *   labels: ['Dec', 'Jan', …] (x positions), titles: full names for the tooltip and table,
 *   series: [{name, color (light-theme hex), values: [numbers]}],
 *   format(n): a value for the tooltip and table; axis(n): a y-axis tick.
 *   caption: what the chart shows, for screen readers.
 */
export function columnChart(container, { labels, titles = labels, series, format, axis, caption }) {
  container.classList.add('chart');
  container.innerHTML = `
    <div class="chart-head">
      <div class="legend">${series.map((s) => `<span><i class="swatch" style="--c:${paint(s.color)}"></i>${esc(s.name)}</span>`).join('')}</div>
      <span class="spacer"></span>
      <button type="button" class="ghost small" data-table-toggle aria-pressed="false">Table</button>
    </div>
    <div class="chart-plot" role="img" aria-label="${esc(caption)}"></div>
    <div class="chart-table" hidden></div>
    <div class="chart-tip" role="status" hidden></div>`;
  const plot = container.querySelector('.chart-plot');
  const tableBox = container.querySelector('.chart-table');
  const tip = container.querySelector('.chart-tip');

  // Table view: the same numbers, no hovering needed.
  tableBox.innerHTML = `<table class="data"><thead><tr><th>Month</th>${series.map((s) => `<th class="num">${esc(s.name)}</th>`).join('')}</tr></thead>
    <tbody>${titles.map((t, i) => `<tr><td>${esc(t)}</td>${series.map((s) => `<td class="num">${esc(format(s.values[i]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  container.querySelector('[data-table-toggle]').addEventListener('click', (e) => {
    const showTable = tableBox.hidden;
    tableBox.hidden = !showTable;
    plot.hidden = showTable;
    e.currentTarget.setAttribute('aria-pressed', String(showTable));
    e.currentTarget.textContent = showTable ? 'Chart' : 'Table';
  });

  function draw() {
    const width = plot.clientWidth || 600;
    const height = 220;
    const axisBand = 24;
    const left = 56;
    const right = 8;
    const top = 8;
    const max = Math.max(0, ...series.flatMap((s) => s.values));
    const ticks = niceTicks(max);
    const top_ = ticks.at(-1) || 1;
    const y = (v) => top + (height - top) * (1 - Math.max(0, v) / top_);
    const svg = el('svg', { width, height: height + axisBand, viewBox: `0 0 ${width} ${height + axisBand}`, class: 'chart-svg' });

    for (const t of ticks) {
      const ty = y(t);
      svg.append(el('line', { x1: left, x2: width - right, y1: ty, y2: ty, class: t === 0 ? 'baseline' : 'grid' }));
      const label = el('text', { x: left - 8, y: ty + 4, class: 'tick', 'text-anchor': 'end' });
      label.textContent = axis(t);
      svg.append(label);
    }
    const band = (width - left - right) / labels.length;
    const barW = Math.min(24, Math.max(4, (band * 0.7 - 2 * (series.length - 1)) / series.length));
    const groupW = barW * series.length + 2 * (series.length - 1);
    labels.forEach((label, i) => {
      const x0 = left + band * i;
      const hit = el('rect', { x: x0, y: top, width: band, height: height - top, class: 'hit', tabindex: 0,
        'aria-label': `${titles[i]}: ${series.map((s) => `${s.name} ${format(s.values[i])}`).join(', ')}` });
      svg.append(hit);
      series.forEach((s, k) => {
        const v = s.values[i];
        const bx = x0 + (band - groupW) / 2 + k * (barW + 2);
        svg.append(el('path', { d: columnPath(bx, y(v), barW, y(0) - y(v)), fill: paint(s.color), class: 'bar', 'pointer-events': 'none' }));
      });
      const text = el('text', { x: x0 + band / 2, y: height + 16, class: 'tick', 'text-anchor': 'middle' });
      text.textContent = label;
      svg.append(text);
      const show = () => {
        svg.querySelectorAll('.hit.on').forEach((n) => n.classList.remove('on'));
        hit.classList.add('on');
        tip.replaceChildren();
        const head = document.createElement('div');
        head.className = 'tip-title';
        head.textContent = titles[i];
        tip.append(head);
        for (const s of series) {
          const row = document.createElement('div');
          row.className = 'tip-row';
          const key = document.createElement('i');
          key.className = 'line-key';
          key.style.setProperty('--c', paint(s.color));
          const value = document.createElement('b');
          value.textContent = format(s.values[i]);
          const name = document.createElement('span');
          name.textContent = s.name;
          row.append(key, value, name);
          tip.append(row);
        }
        tip.hidden = false;
        const tipW = tip.offsetWidth;
        const x = Math.min(Math.max(x0 + band / 2 - tipW / 2, 0), width - tipW);
        // The tip sits in .chart, above the tallest column of the month; the plot starts below the legend row.
        tip.style.left = `${plot.offsetLeft + x}px`;
        tip.style.top = `${plot.offsetTop + Math.max(0, y(Math.max(...series.map((s) => s.values[i]))) - tip.offsetHeight - 10)}px`;
      };
      const hide = () => {
        hit.classList.remove('on');
        tip.hidden = true;
      };
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('blur', hide);
    });
    plot.replaceChildren(svg);
  }
  draw();
  const observer = new ResizeObserver(() => {
    if (!container.isConnected) return observer.disconnect();
    if (Math.abs((plot.firstChild?.getAttribute('width') ?? 0) - plot.clientWidth) > 2) draw();
  });
  observer.observe(plot);
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
