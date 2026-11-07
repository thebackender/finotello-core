// Overview tab: how much money you have, monthly payments, plans and the safety cushion,
// then income and spending for a period (views/reports.js).
import { store } from '../store.js';
import { openWallet, openPay } from '../editor.js';
import { fmtBase, toNum } from '../money.js';
import { meter, segmentedBar } from '../chart.js';
import { esc, freshBox, fmtMonth, paint, PALETTE } from '../util.js';
import { icon, WALLET_ICONS } from '../icons.js';
import { missingRatesBanner } from './parts.js';
import { renderReports } from './reports.js';

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
    <div class="row-actions">
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

  root.innerHTML = `
    <div class="overview">
      ${missingRatesBanner()}
      ${hasWallets ? '' : welcome()}
      <section class="card money">
        <div class="money-main">
          <div class="tile-label">Money in your wallets</div>
          <div class="hero">${esc(fmtBase(t.money))}</div>
          ${hasDebts ? `<div class="debt-line">
            ${toNum(t.owed_to_me) ? `<span>They owe you <b>${esc(fmtBase(t.owed_to_me))}</b></span>` : ''}
            ${toNum(t.i_owe) ? `<span>You owe <b>${esc(fmtBase(t.i_owe))}</b></span>` : ''}
            <span>With debts <b>${esc(fmtBase(t.net))}</b></span>
          </div>` : ''}
          <div class="free-line" title="Money in your wallets minus the safety cushion and what is saved for plans">
            Free money <b class="${toNum(t.free) < 0 ? 'neg' : ''}">${esc(fmtBase(t.free))}</b>
            <span class="muted">after the cushion and plan savings</span>
          </div>
        </div>
        <div class="money-split">
          ${segmentedBar(parts, 'Money by wallet type')}
          <ul class="split-list">
            ${parts.map((p) => `<li><i class="swatch" style="--c:${paint(p.color)}"></i>${icon(WALLET_ICONS[p.type], 14, 'muted')}
              <span>${p.name}</span><span class="spacer"></span><b>${esc(fmtBase(t.by_type[p.type]))}</b></li>`).join('')}
          </ul>
        </div>
      </section>

      <div class="cards-3">
        <section class="card">
          <header class="card-head"><h3>${icon('calendarCheck', 16, 'muted')} Monthly payments</h3><a href="#plans">All</a></header>
          <div class="figure-line"><b>${esc(fmtBase(t.monthly_required))}</b><span class="muted">a month</span></div>
          ${toNum(t.monthly_required) ? meter(toNum(t.monthly_paid), toNum(t.monthly_required), { label: 'Paid this month' }) : ''}
          <div class="muted small">Paid ${esc(fmtBase(t.monthly_paid))} · left ${esc(fmtBase(t.monthly_left))}</div>
          ${unpaid.length ? `<ul class="mini-list">${unpaid.slice(0, 5).map((r) => `<li>
            <span class="day">${r.day}</span><span class="grow">${esc(r.name)}</span>
            <span class="num">${esc(fmtBase(r.amount_base))}</span>
            <button type="button" class="small" data-pay="${r.id}">Pay</button></li>`).join('')}</ul>`
            : s.recurring.length ? `<p class="ok-line">${icon('check', 14)} All paid for ${fmtMonth(month)}</p>`
              : '<p class="muted small">No monthly payments yet. Add rent, subscriptions, loans in Plans.</p>'}
        </section>

        <section class="card">
          <header class="card-head"><h3>${icon('bag', 16, 'muted')} Planned expenses</h3><a href="#plans">All</a></header>
          <div class="figure-line"><b>${esc(fmtBase(t.planned_total))}</b><span class="muted">in ${openPlans.length} plan${openPlans.length === 1 ? '' : 's'}</span></div>
          ${toNum(t.planned_total) ? meter(toNum(t.planned_saved), toNum(t.planned_total), { label: 'Saved for plans' }) : ''}
          <div class="muted small">Saved ${esc(fmtBase(t.planned_saved))} · missing ${esc(fmtBase(t.planned_missing))}</div>
          ${openPlans.length ? `<ul class="mini-list">${openPlans.slice(0, 4).map((p) => `<li>
            <span class="grow">${esc(p.name)}</span><span class="num">${esc(fmtBase(p.amount_base))}</span></li>`).join('')}</ul>`
            : '<p class="muted small">Nothing planned. Add a purchase or a treatment you are saving for.</p>'}
        </section>

        <section class="card">
          <header class="card-head"><h3>${icon('shield', 16, 'muted')} Safety cushion</h3><a href="#plans">Details</a></header>
          ${cushionTarget ? `
            <div class="figure-line"><b>${esc(fmtBase(t.cushion_saved))}</b><span class="muted">of ${esc(fmtBase(t.cushion_target))}</span></div>
            ${meter(cushionSaved, cushionTarget, { label: 'Cushion saved' })}
            <div class="muted small">${toNum(t.cushion_left) ? `Left to save <b class="fg">${esc(fmtBase(t.cushion_left))}</b>` : `${icon('check', 14)} Target reached`}
              ${t.months_covered != null ? ` · covers ${t.months_covered} month${t.months_covered === 1 ? '' : 's'} of payments` : ''}</div>
            <p class="muted small">${t.cushion_wallets ? 'Counted from wallets marked for the cushion.' : 'No wallet is marked for the cushion, so all your money counts.'}</p>`
          : `<p class="muted small">Set how much you want to keep for a rainy day, and see how much is left to save.</p>
             <a class="button-link" href="#plans">Set a target</a>`}
        </section>
      </div>

      <div class="report-part"></div>
    </div>`;

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-act=add-wallet]')) openWallet();
    const pay = e.target.closest('[data-pay]');
    if (pay) openPay(s.recurring.find((r) => r.id === Number(pay.dataset.pay)));
  });

  renderReports(root.querySelector('.report-part'));
}
