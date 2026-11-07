// Wallets tab: your wallets by type with their balances, and the people you lend to or borrow from.
import { store, moneyWallets, people } from '../store.js';
import { openWallet, openTransaction } from '../editor.js';
import { fmtMoney, fmtBase, fmtBaseNum, fmtBaseCompact, toNum, baseCurrency } from '../money.js';
import { lineChartHTML, bindLineChart } from '../chart.js';
import { getPrefs, setPrefs } from '../prefs.js';
import { esc, freshBox, paint, PALETTE } from '../util.js';
import { icon, WALLET_ICONS } from '../icons.js';
import { missingRatesBanner } from './parts.js';
import { showAllTime } from './transactions.js';
import { secret, eyeButton, balancesHidden } from '../privacy.js';

const SECTIONS = [['bank', 'Bank accounts'], ['cash', 'Cash'], ['crypto', 'Crypto']];
const inBase = (w) => (w.currency === baseCurrency() || balancesHidden() ? '' : `<span class="base-hint">≈ ${esc(fmtBase(w.balance_base))}</span>`);

function walletRow(w) {
  const negative = toNum(w.balance) < 0;
  return `<li class="row ${w.is_archived ? 'inactive' : ''}" data-wallet="${w.id}">
    <span class="avatar tint" style="--c:${paint(w.color)}">${icon(WALLET_ICONS[w.type])}</span>
    <div class="row-main">
      <div class="row-title">${esc(w.name)} <span class="muted small">${esc(w.currency)}</span>
        ${w.is_cushion ? `<span class="tag" title="Counts toward the safety cushion">${icon('shield', 12)} cushion</span>` : ''}</div>
      ${w.note ? `<div class="row-sub">${esc(w.note)}</div>` : ''}
    </div>
    <div class="row-value"><b class="${negative ? 'neg' : ''}">${secret(esc(fmtMoney(w.balance, w.currency)))}</b>${inBase(w)}</div>
    <div class="row-actions">
      <button type="button" class="icon" data-act="history" title="Its transactions" aria-label="Transactions of ${esc(w.name)}">${icon('search')}</button>
      <button type="button" class="icon" data-act="edit" title="Edit" aria-label="Edit ${esc(w.name)}">${icon('pencil')}</button>
    </div>
  </li>`;
}

function personRow(p) {
  const value = toNum(p.balance);
  const status = value > 0 ? `owes you <b>${secret(esc(fmtMoney(p.balance, p.currency)))}</b>`
    : value < 0 ? `you owe <b class="neg">${secret(esc(fmtMoney(p.balance.replace('-', ''), p.currency)))}</b>` : '<span class="muted">even</span>';
  return `<li class="row ${p.is_archived ? 'inactive' : ''}" data-wallet="${p.id}">
    <span class="avatar">${icon('users')}</span>
    <div class="row-main">
      <div class="row-title">${esc(p.name)}</div>
      ${p.note ? `<div class="row-sub">${esc(p.note)}</div>` : ''}
    </div>
    <div class="row-value"><span>${status}</span>${value ? inBase(p) : ''}</div>
    <div class="row-actions">
      <button type="button" data-act="give" title="Lend money, or pay back what you owe">${icon('arrowOut', 14)} Give</button>
      <button type="button" data-act="get" title="Borrow money, or get back what they owe">${icon('arrowIn', 14)} Get</button>
      <button type="button" class="icon" data-act="history" title="Transactions with them" aria-label="Transactions with ${esc(p.name)}">${icon('search')}</button>
      <button type="button" class="icon" data-act="edit" title="Edit" aria-label="Edit ${esc(p.name)}">${icon('pencil')}</button>
    </div>
  </li>`;
}

/** Capital by month: a line chart that redraws when its box changes width. */
function drawHistory(box, history) {
  if (balancesHidden()) {
    box.innerHTML = `<p class="muted">${secret('')} Balances are hidden.</p>`;
    return;
  }
  if (history.length < 2) {
    box.innerHTML = '<p class="muted">The chart shows month by month, once your transactions span two months.</p>';
    return;
  }
  const months = history.map((h) => h.month);
  const money = history.map((h) => toNum(h.money));
  const net = history.map((h) => toNum(h.net));
  const series = [{ name: 'Money in wallets', color: PALETTE[0], values: money }];
  if (net.some((v, i) => v !== money[i])) series.push({ name: 'With debts', color: PALETTE[1], values: net });
  let width = 0;
  const draw = () => {
    const w = Math.floor(box.clientWidth);
    if (!w || w === width) return;
    width = w;
    const opts = {
      months, series, width, fmtShort: fmtBaseCompact, fmtFull: (v) => fmtBaseNum(v),
      caption: `Money in wallets by month, now ${fmtBaseNum(money.at(-1))}`,
    };
    box.innerHTML = lineChartHTML(opts);
    bindLineChart(box, opts);
  };
  draw();
  const observer = new ResizeObserver(() => (box.isConnected ? draw() : observer.disconnect()));
  observer.observe(box);
}

export function render(view) {
  const root = freshBox(view);
  const s = store.state;
  const t = s.totals;
  const archived = s.wallets.filter((w) => w.is_archived);
  const list = moneyWallets();
  const persons = people();

  root.innerHTML = `
    ${missingRatesBanner()}
    <div class="toolbar">
      <h2>Wallets</h2>
      <span class="muted">${secret(esc(fmtBase(t.money)))} in total</span>
      ${eyeButton()}
      <span class="spacer"></span>
      <button type="button" class="primary" data-act="add-wallet">${icon('plus')} Add wallet</button>
    </div>
    ${s.history.length ? `<section class="card history-card">
      <header class="card-head"><h3>Capital by month</h3><span class="spacer"></span>
        <span class="muted small">at today's rates</span></header>
      <div class="history-chart"></div>
    </section>` : ''}
    ${list.length ? '' : '<div class="card empty-card"><p>No wallets yet. Add your bank accounts, cash and crypto: each has its own currency.</p></div>'}
    ${SECTIONS.map(([type, title]) => {
      const items = list.filter((w) => w.type === type);
      if (!items.length) return '';
      return `<section class="card wallet-group">
        <header class="card-head"><h3>${title}</h3><span class="spacer"></span>
          <b>${secret(esc(fmtBase(t.by_type[type])))}</b></header>
        <ul class="list">${items.map(walletRow).join('')}</ul>
      </section>`;
    }).join('')}

    <section class="card wallet-group">
      <header class="card-head"><h3>Debts</h3><span class="spacer"></span>
        ${toNum(t.owed_to_me) ? `<span>They owe you <b>${secret(esc(fmtBase(t.owed_to_me)))}</b></span>` : ''}
        ${toNum(t.i_owe) ? `<span>You owe <b class="neg">${secret(esc(fmtBase(t.i_owe)))}</b></span>` : ''}
        <button type="button" data-act="add-person">${icon('plus')} Add person</button>
      </header>
      ${persons.length ? `<ul class="list">${persons.map(personRow).join('')}</ul>`
        : '<p class="muted">Lent money to someone, or borrowed? Add the person: each gets a balance, above zero when they owe you.</p>'}
    </section>

    ${archived.length ? `<details class="closed card"><summary>Archived <span class="muted">(${archived.length})</span></summary>
      <p class="hint">Hidden from the lists; their balances still count. Total: ${secret(esc(fmtBaseNum(archived.filter((w) => w.type !== 'debt').reduce((sum, w) => sum + toNum(w.balance_base), 0))))}</p>
      <ul class="list">${archived.map((w) => (w.type === 'debt' ? personRow(w) : walletRow(w))).join('')}</ul></details>` : ''}`;

  const chartBox = root.querySelector('.history-chart');
  if (chartBox) drawHistory(chartBox, s.history);

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const w = s.wallets.find((x) => x.id === Number(btn.closest('[data-wallet]')?.dataset.wallet));
    switch (btn.dataset.act) {
      case 'add-wallet': return openWallet();
      case 'add-person': return openWallet(null, { type: 'debt' });
      case 'edit': return openWallet(w);
      case 'give':
      case 'get': return openTransaction(null, { type: 'debt', direction: btn.dataset.act, person_id: w.id });
      case 'history':
        setPrefs('tx', { ...getPrefs('tx', {}), wallet: String(w.id), category: '', type: '' });
        showAllTime();
        location.hash = '#transactions';
        return undefined;
      default: return undefined;
    }
  });
}
