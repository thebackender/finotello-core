// The "Income and spending" part of the Overview tab: spending by category (a pie) and income by source
// for a period. All in the base currency at the current rates.
// It redraws only itself when the period changes; the rest of Overview stays.
import * as api from '../api.js';
import { fmtBase, fmtBaseNum, toNum } from '../money.js';
import { pieHTML, bindPie } from '../chart.js';
import { getPrefs, setPrefs } from '../prefs.js';
import {
  esc, freshBox, today, monthRange, addMonths, fmtMonth, fmtDate, dateInput, bindDateInputs, readDate, paint, toast,
} from '../util.js';
import { categoryRanking } from './parts.js';
import { icon } from '../icons.js';

const PIE_PARTS = 6; // more slices than this can't be told apart: the smallest fold into "Other"
const FOLD_COLOR = '#c3c2b7'; // "Other": a light gray, apart from the gray of "No category" and "Fees"

/** Spending groups as pie slices, largest first, the tail folded into "Other". */
function spendingSlices(block) {
  const groups = block.groups.filter((g) => toNum(g.total) > 0);
  const shown = groups.length > PIE_PARTS ? groups.slice(0, PIE_PARTS - 1) : groups;
  const rest = groups.slice(shown.length);
  const slices = shown.map((g) => ({
    name: g.name, value: toNum(g.total), color: g.color, text: fmtBase(g.total), group: g,
    key: g.items.length ? String(g.id) : null,
  }));
  if (rest.length) {
    const value = rest.reduce((sum, g) => sum + toNum(g.total), 0);
    slices.push({ name: `Other (${rest.length})`, value, color: FOLD_COLOR, text: fmtBaseNum(value), rest, key: 'other' });
  }
  return slices;
}

/** The list next to the pie: each slice with its amount and share; a click unfolds subcategories (or "Other"). */
function pieLegend(slices, open) {
  const total = slices.reduce((sum, x) => sum + x.value, 0) || 1;
  const share = (v) => {
    const p = (v / total) * 100;
    return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
  };
  const subRow = (name, value, deleted = false) => `<li class="pie-row sub">
      <span class="caret"></span><span class="pie-name">${icon('cornerDownRight', 12, 'muted')}<span class="${deleted ? 'deleted' : ''}">${esc(name)}</span></span>
      <span class="rank-value">${esc(fmtBaseNum(value))}</span><span class="rank-share">${share(value)}</span></li>`;
  return `<ul class="pie-legend">${slices.map((x, i) => {
    const isOpen = x.key != null && open.has(x.key);
    const subs = !isOpen ? '' : x.rest
      ? x.rest.map((g) => subRow(g.name, toNum(g.total), g.is_deleted)).join('')
      : x.group.items.map((it) => subRow(it.own ? `${it.name} (no subcategory)` : it.name, toNum(it.total), it.is_deleted)).join('');
    return `<li class="pie-row ${x.key != null ? 'can-open' : ''}" data-slice="${i}" ${x.key != null ? `data-open="${esc(x.key)}" tabindex="0" role="button" aria-expanded="${isOpen}"` : ''}>
        <span class="caret">${x.key != null ? icon(isOpen ? 'chevronDown' : 'chevronRight', 14) : ''}</span>
        <span class="pie-name"><i class="swatch" style="--c:${paint(x.color)}"></i><span class="${x.group?.is_deleted ? 'deleted' : ''}">${esc(x.name)}</span></span>
        <span class="rank-value">${esc(x.text)}</span><span class="rank-share">${share(x.value)}</span>
      </li>${subs}`;
  }).join('')}</ul>`;
}

const PRESETS = [
  ['month', 'This month'], ['last-month', 'Last month'], ['3-months', 'Last 3 months'],
  ['year', 'This year'], ['12-months', 'Last 12 months'], ['custom', 'Custom'],
];

/** The period of a preset: [from, to]. */
function period(prefs) {
  const now = today();
  const month = now.slice(0, 7);
  switch (prefs.preset) {
    case 'last-month': return monthRange(addMonths(month, -1));
    case '3-months': return [monthRange(addMonths(month, -2))[0], monthRange(month)[1]];
    case 'year': return [`${now.slice(0, 4)}-01-01`, `${now.slice(0, 4)}-12-31`];
    case '12-months': return [monthRange(addMonths(month, -11))[0], monthRange(month)[1]];
    case 'custom': return [prefs.from || monthRange(month)[0], prefs.to || now];
    default: return monthRange(month);
  }
}

const periodLabel = (from, to) => {
  if (from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && to === monthRange(to.slice(0, 7))[1]) return fmtMonth(from.slice(0, 7));
  return `${fmtDate(from)} – ${fmtDate(to)}`;
};

const DEFAULTS = { preset: 'month', from: '', to: '', open: [] };
/** Keys of unfolded rows: category ids (numbers), null for "No category", "other" for the folded tail. */
const openKey = (text) => (text === 'null' ? null : /^\d+$/.test(text) ? Number(text) : text);
let seq = 0;

/** Draw the part into container (an element of the Overview tab). */
export function renderReports(container) {
  const root = freshBox(container);
  const prefs = getPrefs('reports', DEFAULTS);
  const open = new Set(prefs.open);
  const [from, to] = period(prefs);
  const ticket = ++seq;

  root.innerHTML = `
    <div class="toolbar section-head">
      <h2>Income and spending</h2>
      <div class="segmented presets">${PRESETS.map(([value, label]) => `<button type="button" data-preset="${value}" class="${prefs.preset === value ? 'on' : ''}">${label}</button>`).join('')}</div>
      ${prefs.preset === 'custom' ? `<form class="range">${dateInput('from', from)}<span class="muted">–</span>${dateInput('to', to)}<button type="submit">Show</button></form>` : ''}
      <span class="muted period-label">${esc(periodLabel(from, to))}</span>
    </div>
    <div class="report-body is-loading"><div class="empty">Loading…</div></div>`;
  bindDateInputs(root);

  root.addEventListener('click', (e) => {
    const preset = e.target.closest('[data-preset]');
    if (preset) {
      setPrefs('reports', { ...prefs, preset: preset.dataset.preset, open: [...open] });
      renderReports(container);
      return;
    }
    const row = e.target.closest('[data-open]');
    if (row) toggle(row);
  });
  root.addEventListener('keydown', (e) => {
    const row = e.target.closest('[data-open]');
    if (row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggle(row);
    }
  });
  root.querySelector('form.range')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = readDate(e.target.querySelector('[name=from]'), 'From');
    const t = readDate(e.target.querySelector('[name=to]'), 'To');
    if (f === undefined || t === undefined) return;
    if (f && t && f > t) return toast('The period starts after it ends', 'error');
    setPrefs('reports', { ...prefs, from: f ?? '', to: t ?? '', open: [...open] });
    renderReports(container);
  });

  let report = null;
  function toggle(row) {
    const id = openKey(row.dataset.open);
    if (open.has(id)) open.delete(id);
    else open.add(id);
    setPrefs('reports', { ...prefs, open: [...open] });
    fill();
  }

  function fill() {
    const box = root.querySelector('.report-body');
    box.classList.remove('is-loading');
    const slices = spendingSlices(report.expense);
    // The pie and its list look up unfolded rows by the same keys as the category bars (numbers, "other").
    const pieOpen = new Set([...open].map(String));
    box.innerHTML = `
      <div class="cards-2">
        <section class="card spending-card">
          <header class="card-head"><h3>Spending by category</h3><span class="spacer"></span><b class="card-total">${esc(fmtBase(report.expense.total))}</b></header>
          ${slices.length ? `<div class="pie-layout">
              ${pieHTML(slices, { center: [fmtBase(report.expense.total), 'spent'], caption: `Spending by category: ${slices.map((x) => `${x.name} ${x.text}`).join(', ')}` })}
              ${pieLegend(slices, pieOpen)}
            </div>` : '<p class="muted small">No spending in this period.</p>'}
        </section>
        <section class="card">
          <header class="card-head"><h3>Income by source</h3><span class="spacer"></span><b class="card-total">${esc(fmtBase(report.income.total))}</b></header>
          ${report.income.groups.length ? categoryRanking(report.income, { open }) : '<p class="muted small">No income in this period.</p>'}
        </section>
      </div>`;
    bindPie(box.querySelector('.spending-card'), slices);
  }

  api.get('/api/report', { from, to }).then((r) => {
    if (ticket !== seq || !root.isConnected) return;
    report = r;
    fill();
  }).catch((e) => {
    if (ticket === seq) root.querySelector('.report-body').innerHTML = `<div class="empty error">${esc(e.message)}</div>`;
  });
}
