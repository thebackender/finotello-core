// The "Income and spending" part of the Overview tab: spending by category (a pie) and income by source
// for a period. All in the base currency at the current rates.
// The period is kept in the database (config report_from / report_to); empty means the current month.
// It redraws only itself when the period changes; the rest of Overview stays.
import * as api from '../api.js';
import { store } from '../store.js';
import { fmtBase, fmtBaseNum, toNum } from '../money.js';
import { pieHTML, bindPie } from '../chart.js';
import { getPrefs, setPrefs } from '../prefs.js';
import {
  esc, freshBox, today, monthRange, paint, toast,
} from '../util.js';
import { categoryRanking } from './parts.js';
import { icon } from '../icons.js';
import { rangePicker } from '../rangepicker.js';

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

/** The saved period: [from, to]. An empty end is that end of the current month. */
function period() {
  const [monthFrom, monthTo] = monthRange(today().slice(0, 7));
  const { report_from: from, report_to: to } = store.state.config;
  return [from || monthFrom, to || monthTo];
}

const DEFAULTS = { open: [] }; // view options in data/settings.json; the period is in the database
/** Keys of unfolded rows: category ids (numbers), null for "No category", "other" for the folded tail. */
const openKey = (text) => (text === 'null' ? null : /^\d+$/.test(text) ? Number(text) : text);
let seq = 0;

/** Draw the part into container (an element of the Overview tab). */
export function renderReports(container) {
  const root = freshBox(container);
  const prefs = getPrefs('reports', DEFAULTS);
  const open = new Set(prefs.open);
  const [from, to] = period();
  const ticket = ++seq;

  root.innerHTML = `
    <div class="toolbar section-head">
      <h2>Income and spending</h2>
      <span class="period"></span>
    </div>
    <div class="report-body is-loading"><div class="empty">Loading…</div></div>`;
  const savePeriod = async (f, t) => {
    const saved = { report_from: f, report_to: t };
    try {
      await api.put('/api/config', saved);
    } catch (err) {
      return toast(err.message, 'error');
    }
    Object.assign(store.state.config, saved);
    renderReports(container);
  };
  rangePicker(root.querySelector('.period'), {
    from, to, onApply: savePeriod, onReset: () => savePeriod('', ''),
  });

  root.addEventListener('click', (e) => {
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
