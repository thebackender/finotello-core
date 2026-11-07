// Overview tab: how much money you have, monthly payments, plans and the safety cushion,
// then income and spending for a period (views/reports.js).
import { store } from '../store.js';
import { openWallet, openPay } from '../editor.js';
import { fmtBase, fmtMoney, toNum, baseCurrency } from '../money.js';
import { meter, segmentedBar } from '../chart.js';
import { esc, freshBox, fmtMonth, paint, PALETTE } from '../util.js';
import { icon, WALLET_ICONS } from '../icons.js';
import { missingRatesBanner, budgetRow, afterPayments } from './parts.js';
import { renderReports } from './reports.js';
import { secret, eyeButton } from '../privacy.js';

// Wallet types take the first three categorical slots, always in this order.
const TYPE_PARTS = [
  { type: 'bank', name: 'Bank', color: PALETTE[0] },
  { type: 'cash', name: 'Cash', color: PALETTE[1] },
  { type: 'crypto', name: 'Crypto', color: PALETTE[2] },
];

function welcome() {
  return `<section class="card welcome">
    <h2>Welcome to Finotello</h2>
    <p class="muted">Add your wallets first: bank accounts, cash, crypto. Each one has its own currency.
      Then record what you spend and earn, and the totals here fill in.</p>
    <div class="btn-row">
      <button class="primary" data-act="add-wallet">${icon('plus')} Add a wallet</button>
      <a class="button-link" href="#settings">Currencies and categories</a>
    </div>
  </section>`;
}

export function render(view) {
  const root = freshBox(view);
  const s = store.state;
  const t = s.totals;
  const month = s.month;
  const hasWallets = s.wallets.some((w) => w.type !== 'debt');
  const parts = TYPE_PARTS.map((p) => ({ ...p, value: toNum(t.by_type[p.type]) }));
  const hasDebts = toNum(t.owed_to_me) || toNum(t.i_owe);
  const unpaid = s.recurring.filter((r) => r.is_active && !r.paid_tx_id);
  const openPlans = s.planned.filter((p) => p.status === 'open');
  const cushionTarget = toNum(t.cushion_target);
  const cushionSaved = toNum(t.cushion_saved);
  const overBudget = s.budgets.filter((b) => b.share > 1).length;

  root.innerHTML = `
    <div class="overview">
      ${missingRatesBanner()}
      ${hasWallets ? '' : welcome()}
      <section class="card money">
        <div class="money-main">
          <div class="stat-label">Money in your wallets ${eyeButton()}</div>
          <div class="hero">${secret(esc(fmtBase(t.money)))}</div>
          ${hasDebts ? `<div class="debt-line">
            ${toNum(t.owed_to_me) ? `<span>They owe you <b>${secret(esc(fmtBase(t.owed_to_me)))}</b></span>` : ''}
            ${toNum(t.i_owe) ? `<span>You owe <b>${secret(esc(fmtBase(t.i_owe)))}</b></span>` : ''}
            <span>With debts <b>${secret(esc(fmtBase(t.net)))}</b></span>
          </div>` : ''}
        </div>
        <div class="money-split">
          ${segmentedBar(parts, 'Money by wallet type')}
          <ul class="split-list">
            ${parts.map((p) => `<li><i class="swatch" style="--c:${paint(p.color)}"></i>${icon(WALLET_ICONS[p.type], 14, 'muted')}
              <span>${p.name}</span><span class="spacer"></span><b>${secret(esc(fmtBase(t.by_type[p.type])))}</b></li>`).join('')}
          </ul>
        </div>
      </section>

      <div class="report-part"></div>

      <div class="cards-3 four">
        <section class="card">
          <header class="card-head"><h3>Monthly payments</h3><a href="#plans">All</a></header>
          <div class="figure-line"><b>${esc(fmtBase(t.monthly_required))}</b><span class="muted">a month</span></div>
          ${toNum(t.monthly_required) ? meter(toNum(t.monthly_paid), toNum(t.monthly_required), { label: 'Paid this month' }) : ''}
          <div class="muted small">Paid ${esc(fmtBase(t.monthly_paid))} · left ${esc(fmtBase(t.monthly_left))}</div>
          ${unpaid.length ? `<ul class="list compact">${unpaid.slice(0, 5).map((r) => `<li>
            <span class="day">${r.day}</span><span class="grow">${esc(r.name)}</span>
            <span class="num" ${r.is_variable ? 'title="Varies: what it usually costs"' : ''}>${r.is_variable ? '~' : ''}${esc(fmtBase(r.expected_base))}</span>
            <button type="button" class="small" data-pay="${r.id}">Pay</button></li>`).join('')}</ul>`
            : s.recurring.length ? `<p class="ok-line">${icon('check', 14)} All paid for ${fmtMonth(month)}</p>`
              : '<p class="muted small">No monthly payments yet. Add rent, subscriptions, loans in Plans.</p>'}
          ${afterPayments()}
        </section>

        <section class="card">
          <header class="card-head"><h3>Planned expenses</h3><a href="#plans">All</a></header>
          <div class="figure-line"><b>${esc(fmtBase(t.planned_total))}</b><span class="muted">in ${openPlans.length} plan${openPlans.length === 1 ? '' : 's'}</span></div>
          ${openPlans.length ? `<ul class="list compact">${openPlans.slice(0, 4).map((p) => `<li>
            <span class="grow">${esc(p.name)}</span><span class="num">${esc(fmtBase(p.amount_base))}</span></li>`).join('')}</ul>`
            : '<p class="muted small">Nothing planned. Add a purchase or a treatment you are planning.</p>'}
        </section>

        <section class="card">
          <header class="card-head"><h3>Budgets</h3><a href="#plans">All</a></header>
          ${s.budgets.length ? `<div class="muted small">${esc(fmtMonth(month))}${overBudget ? ` · <span class="neg">${overBudget} over the limit</span>` : ''}</div>
            <ul class="budget-list">${s.budgets.slice(0, 4).map((b) => budgetRow(b)).join('')}</ul>
            ${s.budgets.length > 4 ? `<a class="muted small" href="#plans">${s.budgets.length - 4} more</a>` : ''}`
            : `<p class="muted small">Set a monthly limit for a category and see how much is left this month.</p>
             <a class="button-link" href="#plans">Set a budget</a>`}
        </section>

        <section class="card">
          <header class="card-head"><h3>Safety cushion</h3><a href="#plans">Details</a></header>
          ${cushionTarget ? `
            <div class="figure-line"><b>${esc(fmtMoney(t.cushion.saved, t.cushion.currency))}</b><span class="muted">of ${esc(fmtMoney(t.cushion.target, t.cushion.currency))}</span></div>
            ${meter(cushionSaved, cushionTarget, { label: 'Cushion saved' })}
            <div class="muted small">${toNum(t.cushion.left) ? `Left to save <b class="fg">${esc(fmtMoney(t.cushion.left, t.cushion.currency))}</b>` : `${icon('check', 14)} Target reached`}${t.cushion.currency !== baseCurrency() ? ` · ≈ ${esc(fmtBase(t.cushion_saved))} saved` : ''}
              ${t.months_covered != null ? ` · covers ${t.months_covered} month${t.months_covered === 1 ? '' : 's'} of payments` : ''}</div>
            <p class="muted small">${t.cushion_wallets ? 'Counted from wallets marked for the cushion.' : 'No wallet is marked for the cushion, so all your money counts.'}</p>`
          : `<p class="muted small">Set how much you want to keep for a rainy day, and see how much is left to save.</p>
             <a class="button-link" href="#plans">Set a target</a>`}
        </section>
      </div>
    </div>`;

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-act=add-wallet]')) openWallet();
    const pay = e.target.closest('[data-pay]');
    if (pay) openPay(s.recurring.find((r) => r.id === Number(pay.dataset.pay)));
  });

  renderReports(root.querySelector('.report-part'));
}
