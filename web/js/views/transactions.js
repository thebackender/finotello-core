// Transactions tab: everything you spent, earned and moved, by day, with filters and search.
import * as api from '../api.js';
import { store, walletById, categoryById, categoryList, moneyWallets, people, TX_TYPE_NAMES } from '../store.js';
import { openTransaction } from '../editor.js';
import { fmtMoney, fmtBaseNum, toBaseNum, baseCurrency, decimalsOf, toMinor, fromMinor } from '../money.js';
import { getPrefs, setPrefs } from '../prefs.js';
import { esc, freshBox, today, monthRange, addMonths, fmtMonth, fmtDay, opt, paint } from '../util.js';
import { icon } from '../icons.js';
import { missingRatesBanner } from './parts.js';

const DEFAULTS = { wallet: '', category: '', type: '' };
const TYPE_ICONS = { expense: 'arrowOut', income: 'arrowIn', transfer: 'transfer', debt: 'users', adjustment: 'scale' };

// The month on screen and the search text live for the session only; the filters are saved.
let month = null;
let allTime = false;
let query = '';
let seq = 0;

/** Show every month (e.g. when opened from a wallet's history). */
export function showAllTime() {
  allTime = true;
}

/** What a line counts as in totals: spending, income, or nothing (a transfer, a debt, a balance adjustment). */
function lineKind(tx, e) {
  const c = e.category_id != null ? categoryById(e.category_id) : null;
  if (c) return c.kind;
  return tx.type === 'expense' || tx.type === 'income' ? tx.type : null;
}

const walletName = (id) => walletById(id)?.name ?? '?';
function categoryLabel(id) {
  if (id == null) return '<span class="muted">No category</span>';
  const c = categoryById(id);
  if (!c) return '?';
  return `<i class="dot" style="--c:${paint(c.color)}"></i><span class="${c.is_deleted ? 'deleted' : ''}">${esc(c.path)}</span>`;
}

/** Title, subtitle and amount of one transaction row. */
function describe(tx) {
  const moves = tx.entries.filter((e) => e.category_id == null);
  const out = moves.find((e) => e.amount.startsWith('-'));
  const inn = moves.find((e) => !e.amount.startsWith('-'));
  const fee = tx.entries.find((e) => e.category_id != null && (tx.type === 'transfer' || tx.type === 'debt'));
  const sub = [];
  let title;
  let amount = '';
  let currency = '';
  let cls = '';
  if (tx.type === 'expense' || tx.type === 'income') {
    const first = tx.entries[0];
    currency = first.currency;
    const decimals = decimalsOf(currency);
    amount = fromMinor(tx.entries.reduce((s, e) => s + (toMinor(e.amount, decimals) ?? 0n), 0n), decimals);
    cls = tx.type;
    title = tx.entries.length > 1
      ? `<span>Split into ${tx.entries.length} lines</span>`
      : `${categoryLabel(first.category_id)}${first.description ? `<span class="desc">${esc(first.description)}</span>` : ''}`;
    const w = walletById(first.wallet_id);
    sub.push(w?.type === 'debt' ? `paid by ${esc(w.name)}` : esc(walletName(first.wallet_id)));
  } else if (tx.type === 'adjustment') {
    const e = tx.entries[0];
    title = 'Balance adjustment';
    amount = e.amount;
    currency = e.currency;
    sub.push(esc(walletName(e.wallet_id)));
  } else {
    const outW = walletById(out?.wallet_id);
    const inW = walletById(inn?.wallet_id);
    if (tx.type === 'debt') {
      const lending = inW?.type === 'debt';
      title = lending ? `Gave to ${esc(inW?.name ?? '?')}` : `Got from ${esc(outW?.name ?? '?')}`;
      sub.push(esc(lending ? outW?.name ?? '?' : inW?.name ?? '?'));
      amount = lending ? out?.amount ?? '0' : inn?.amount ?? '0';
      currency = lending ? out?.currency : inn?.currency;
      cls = 'neutral';
    } else {
      title = `${esc(outW?.name ?? '?')} ${icon('chevronRight', 12, 'muted')} ${esc(inW?.name ?? '?')}`;
      amount = (out?.amount ?? '0').replace('-', '');
      currency = out?.currency;
      cls = 'neutral';
      if (inn && out && inn.currency !== out.currency) sub.push(`received ${esc(fmtMoney(inn.amount, inn.currency))}`);
    }
    if (fee) sub.push(`fee ${esc(fmtMoney(fee.amount.replace('-', ''), fee.currency))}`);
  }
  if (tx.note) sub.push(esc(tx.note));
  return { title, sub: sub.join(' · '), amount, currency, cls };
}

function row(tx) {
  const d = describe(tx);
  const sign = d.cls === 'expense' || d.cls === 'income' || tx.type === 'adjustment';
  const baseHint = d.currency && d.currency !== baseCurrency() ? `<span class="base-hint">≈ ${esc(fmtBaseNum(toBaseNum(d.amount, d.currency), { sign }))}</span>` : '';
  const lines = (tx.type === 'expense' || tx.type === 'income') && tx.entries.length > 1
    ? `<ul class="tx-lines">${tx.entries.map((e) => `<li><span class="grow">${categoryLabel(e.category_id)}${e.description ? `<span class="desc">${esc(e.description)}</span>` : ''}</span>
        <span class="num">${esc(fmtMoney(e.amount.replace('-', ''), e.currency))}</span></li>`).join('')}</ul>`
    : '';
  return `<li class="row clickable" data-tx="${tx.id}" tabindex="0" role="button">
    <span class="avatar ${d.cls || tx.type}" title="${esc(TX_TYPE_NAMES[tx.type])}">${icon(TYPE_ICONS[tx.type])}</span>
    <div class="row-main">
      <div class="row-title">${d.title}</div>
      <div class="row-sub">${d.sub}</div>
      ${lines}
    </div>
    <div class="row-value ${d.cls}"><span>${esc(fmtMoney(d.amount, d.currency, { sign }))}</span>${baseHint}</div>
  </li>`;
}

function totals(list) {
  let income = 0;
  let spent = 0;
  for (const tx of list) {
    for (const e of tx.entries) {
      const kind = lineKind(tx, e);
      if (kind === 'expense') spent -= toBaseNum(e.amount, e.currency);
      else if (kind === 'income') income += toBaseNum(e.amount, e.currency);
    }
  }
  return { income, spent };
}

export function newPreset() {
  const prefs = getPrefs('tx', DEFAULTS);
  const w = walletById(prefs.wallet);
  if (!w) return {};
  return w.type === 'debt' ? { type: 'debt', person_id: w.id } : { wallet_id: w.id };
}

export function render(view) {
  const root = freshBox(view);
  const prefs = getPrefs('tx', DEFAULTS);
  month ??= today().slice(0, 7);
  const [from, to] = allTime ? ['', ''] : monthRange(month);
  const walletOptions = (list) => list.map((w) => opt(w.id, w.name, prefs.wallet)).join('');
  const categoryOptions = (kind) => categoryList(kind, { withInactive: true })
    .map((c) => opt(c.id, c.parent_id ? `  ${c.path}` : c.path, prefs.category)).join('');

  root.innerHTML = `
    ${missingRatesBanner()}
    <div class="toolbar">
      <div class="month-nav">
        <button type="button" class="icon" data-month="-1" title="Previous month" aria-label="Previous month" ${allTime ? 'disabled' : ''}>${icon('chevronLeft')}</button>
        <h2>${allTime ? 'All time' : esc(fmtMonth(month))}</h2>
        <button type="button" class="icon" data-month="1" title="Next month" aria-label="Next month" ${allTime ? 'disabled' : ''}>${icon('chevronRight')}</button>
      </div>
      <div class="segmented">
        <button type="button" data-period="month" class="${allTime ? '' : 'on'}">Month</button>
        <button type="button" data-period="all" class="${allTime ? 'on' : ''}">All time</button>
      </div>
      ${!allTime && month !== today().slice(0, 7) ? '<button type="button" class="ghost" data-today>This month</button>' : ''}
      <span class="spacer"></span>
      <select name="wallet" aria-label="Wallet"><option value="">All wallets</option>
        <optgroup label="Wallets">${walletOptions(moneyWallets(true))}</optgroup>
        ${people(true).length ? `<optgroup label="People">${walletOptions(people(true))}</optgroup>` : ''}
      </select>
      <select name="category" aria-label="Category"><option value="">All categories</option>
        <optgroup label="Spending">${categoryOptions('expense')}</optgroup>
        <optgroup label="Income">${categoryOptions('income')}</optgroup>
      </select>
      <select name="type" aria-label="Type"><option value="">All types</option>
        ${Object.entries(TX_TYPE_NAMES).map(([v, n]) => opt(v, n, prefs.type)).join('')}
      </select>
      <input type="search" name="q" value="${esc(query)}" placeholder="Search notes and descriptions" aria-label="Search">
    </div>
    <div class="tx-summary"></div>
    <div class="tx-list is-loading"><div class="empty">Loading…</div></div>`;

  const load = () => {
    const mine = ++seq;
    api.get('/api/transactions', { from, to, wallet: prefs.wallet, category: prefs.category, type: prefs.type, q: query })
      .then((result) => { if (mine === seq && root.isConnected) fill(result); })
      .catch((e) => { if (mine === seq) root.querySelector('.tx-list').innerHTML = `<div class="empty error">${esc(e.message)}</div>`; });
  };

  function fill({ transactions, more }) {
    const list = root.querySelector('.tx-list');
    list.classList.remove('is-loading');
    const { income, spent } = totals(transactions);
    const left = income - spent;
    root.querySelector('.tx-summary').innerHTML = transactions.length ? `
      <span>Income <b>${esc(fmtBaseNum(income))}</b></span>
      <span>Spent <b>${esc(fmtBaseNum(spent))}</b></span>
      <span>Left over <b class="${left < 0 ? 'neg' : ''}">${esc(fmtBaseNum(left, { sign: true }))}</b></span>
      <span class="muted">${transactions.length} transaction${transactions.length === 1 ? '' : 's'}${more ? ' (the newest shown)' : ''}</span>` : '';
    if (!transactions.length) {
      const filtered = prefs.wallet || prefs.category || prefs.type || query;
      list.innerHTML = `<div class="empty">${filtered ? 'Nothing matches the filters.' : `No transactions ${allTime ? 'yet' : `in ${esc(fmtMonth(month))}`}.`}
        <div><button type="button" class="primary" data-new>${icon('plus')} Add one</button> <span class="muted">or press <kbd>N</kbd></span></div></div>`;
      return;
    }
    const days = new Map();
    for (const tx of transactions) {
      if (!days.has(tx.date)) days.set(tx.date, []);
      days.get(tx.date).push(tx);
    }
    list.innerHTML = [...days].map(([day, txs]) => {
      const t = totals(txs);
      return `<section class="card day-group">
        <h3><span>${esc(fmtDay(day))}</span><span class="spacer"></span>
          ${t.spent ? `<span class="muted">spent ${esc(fmtBaseNum(t.spent))}</span>` : ''}
          ${t.income ? `<span class="muted">income ${esc(fmtBaseNum(t.income))}</span>` : ''}</h3>
        <ul class="list">${txs.map(row).join('')}</ul>
      </section>`;
    }).join('');
    list.addEventListener('click', (e) => {
      const li = e.target.closest('[data-tx]');
      if (li) openTransaction(transactions.find((t) => t.id === Number(li.dataset.tx)));
    });
    list.addEventListener('keydown', (e) => {
      const li = e.target.closest('[data-tx]');
      if (li && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openTransaction(transactions.find((t) => t.id === Number(li.dataset.tx)));
      }
    });
  }

  root.addEventListener('click', (e) => {
    const step = e.target.closest('[data-month]');
    if (step) {
      month = addMonths(month, Number(step.dataset.month));
      render(view);
    } else if (e.target.closest('[data-today]')) {
      month = today().slice(0, 7);
      render(view);
    } else if (e.target.closest('[data-period]')) {
      allTime = e.target.closest('[data-period]').dataset.period === 'all';
      render(view);
    } else if (e.target.closest('[data-new]')) {
      openTransaction(null, newPreset());
    }
  });
  root.querySelectorAll('select').forEach((select) => select.addEventListener('change', () => {
    setPrefs('tx', { ...prefs, [select.name]: select.value });
    render(view);
  }));
  let timer;
  root.querySelector('[name=q]').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      query = e.target.value.trim();
      load();
    }, 250);
  });
  load();
}
