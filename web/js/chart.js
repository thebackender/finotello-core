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
