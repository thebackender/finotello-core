// Reports tab: spending by category, income by source, and income vs spending by month.
// All in the base currency at the current rates.
import * as api from '../api.js';
import { store } from '../store.js';
import { fmtBase, fmtBaseNum, fmtBaseCompact, toNum } from '../money.js';
import { columnChart } from '../chart.js';
import { getPrefs, setPrefs } from '../prefs.js';
import {
  esc, freshBox, today, monthRange, addMonths, fmtMonth, fmtDate, MONTHS_SHORT, dateInput, bindDateInputs, readDate,
  PALETTE, toast,
} from '../util.js';
import { missingRatesBanner, categoryRanking } from './parts.js';

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
let seq = 0;

export function render(view) {
  const root = freshBox(view);
  const prefs = getPrefs('reports', DEFAULTS);
  const open = new Set(prefs.open);
  const [from, to] = period(prefs);
  const ticket = ++seq;

  root.innerHTML = `
    ${missingRatesBanner()}
    <div class="toolbar">
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
      render(view);
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
    render(view);
  });

  let report = null;
  function toggle(row) {
    const id = row.dataset.open === 'null' ? null : Number(row.dataset.open);
    if (open.has(id)) open.delete(id);
    else open.add(id);
    setPrefs('reports', { ...prefs, open: [...open] });
    fill();
  }

  function fill() {
    const box = root.querySelector('.report-body');
    const net = toNum(report.income.total) - toNum(report.expense.total);
    box.classList.remove('is-loading');
    box.innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="tile-label">Income</div><div class="tile-value">${esc(fmtBase(report.income.total))}</div></div>
        <div class="tile"><div class="tile-label">Spent</div><div class="tile-value">${esc(fmtBase(report.expense.total))}</div></div>
        <div class="tile ${net < 0 ? 'negative' : ''}"><div class="tile-label">Left over</div><div class="tile-value">${esc(fmtBaseNum(net, { sign: true }))}</div></div>
      </div>
      <div class="cards-2">
        <section class="card">
          <header class="card-head"><h3>Spending by category</h3></header>
          ${report.expense.groups.length ? categoryRanking(report.expense, { open }) : '<p class="muted small">No spending in this period.</p>'}
        </section>
        <section class="card">
          <header class="card-head"><h3>Income by source</h3></header>
          ${report.income.groups.length ? categoryRanking(report.income, { open }) : '<p class="muted small">No income in this period.</p>'}
        </section>
      </div>
      <section class="card">
        <header class="card-head"><h3>Income and spending by month</h3><span class="muted small">12 months to ${esc(fmtMonth(report.to.slice(0, 7)))}</span></header>
        <div class="month-chart"></div>
      </section>`;
    const months = report.months;
    columnChart(box.querySelector('.month-chart'), {
      labels: months.map((m) => MONTHS_SHORT[Number(m.month.slice(5)) - 1]),
      titles: months.map((m) => fmtMonth(m.month)),
      series: [
        { name: 'Income', color: PALETTE[0], values: months.map((m) => toNum(m.income)) },
        { name: 'Spending', color: PALETTE[1], values: months.map((m) => toNum(m.expense)) },
      ],
      format: (n) => fmtBaseNum(n),
      axis: (n) => fmtBaseCompact(n),
      caption: `Income and spending by month, ${store.state.config.base_currency}`,
    });
  }

  api.get('/api/report', { from, to }).then((r) => {
    if (ticket !== seq || !root.isConnected) return;
    report = r;
    fill();
  }).catch((e) => {
    if (ticket === seq) root.querySelector('.report-body').innerHTML = `<div class="empty error">${esc(e.message)}</div>`;
  });
}
