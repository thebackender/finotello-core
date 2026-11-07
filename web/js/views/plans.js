// Plans tab: monthly payments, budgets, planned expenses and the safety cushion.
import * as api from '../api.js';
import { store, act, walletById, categoryById } from '../store.js';
import {
  openRecurring, openPay, openPlanned, openBuy, openTransactionById, openBudget, PRIORITY_NAMES,
} from '../editor.js';
import { confirmDialog } from '../dialogs.js';
import { fmtMoney, fmtBase, fmtBaseNum, toNum, symbolOf, cleanAmount, baseCurrency, convert } from '../money.js';
import { meter } from '../chart.js';
import { esc, freshBox, fmtDate, fmtMonth, paint, toast, opt } from '../util.js';
import { icon } from '../icons.js';
import { missingRatesBanner, budgetRow, afterPayments } from './parts.js';

const categoryTag = (id) => {
  const c = id != null ? categoryById(id) : null;
  return c ? `<span class="tag"><i class="dot" style="--c:${paint(c.color)}"></i>${esc(c.path)}</span>` : '';
};
const inBase = (amount, currency, amountBase) =>
  (currency === baseCurrency() ? '' : `<span class="base-hint">≈ ${esc(fmtBase(amountBase))}</span>`);
const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][n % 100 >> 3 ^ 1 && n % 10] || 'th'}`;

/** The amount of a monthly payment: fixed, or (when it varies) about the average of the last payments;
 * once paid this month, also what was really paid when it differs. */
function recurringAmount(r) {
  let html;
  if (!r.is_variable) {
    html = `<b>${esc(fmtMoney(r.amount, r.currency))}</b>${inBase(r.amount, r.currency, r.amount_base)}`;
  } else if (r.expected_from) {
    html = `<b title="Average of the last ${r.expected_from} payment${r.expected_from === 1 ? '' : 's'}">~${esc(fmtMoney(r.expected, r.currency))}</b>
      ${inBase(r.expected, r.currency, r.expected_base)}<span class="base-hint">varies · avg of ${r.expected_from}</span>`;
  } else {
    html = `<b>~${esc(fmtMoney(r.amount, r.currency))}</b><span class="base-hint">varies</span>`;
  }
  if (r.paid_tx_id && (r.is_variable || r.paid_base !== r.amount_base)) {
    html += `<span class="base-hint paid-amount">paid ${esc(fmtBase(r.paid_base))}</span>`;
  }
  return html;
}

function recurringRow(r, month) {
  const w = r.wallet_id ? walletById(r.wallet_id) : null;
  return `<li class="row ${r.is_active ? '' : 'inactive'}" data-recurring="${r.id}">
    <span class="avatar day" title="Paid on the ${ordinal(r.day)}">${r.day}</span>
    <div class="row-main">
      <div class="row-title">${esc(r.name)}</div>
      <div class="row-sub">${categoryTag(r.category_id)}${w ? `<span>from ${esc(w.name)}</span>` : ''}</div>
    </div>
    <div class="row-value">${recurringAmount(r)}</div>
    <div class="row-actions">
      ${!r.is_active ? '<span class="muted small">paused</span>'
        : r.paid_tx_id ? `<button type="button" class="ghost paid" data-act="open-paid" title="Paid ${esc(fmtDate(r.paid_date))}: open the payment">${icon('check', 14)} Paid ${esc(fmtDate(r.paid_date).slice(0, 5))}</button>`
          : `<button type="button" data-act="pay" title="Record the payment for ${esc(fmtMonth(month))}">Pay</button>`}
      <button type="button" class="icon" data-act="edit-recurring" title="Edit" aria-label="Edit ${esc(r.name)}">${icon('pencil')}</button>
    </div>
  </li>`;
}

function plannedRow(p) {
  const overdue = p.due && p.due < store.state.today;
  return `<li class="row" data-planned="${p.id}">
    <span class="avatar">${icon('bag')}</span>
    <div class="row-main">
      <div class="row-title">${esc(p.name)}</div>
      <div class="row-sub"><span class="tag prio ${p.priority}" title="Priority">${PRIORITY_NAMES[p.priority]}</span>${categoryTag(p.category_id)}${p.due ? `<span class="${overdue ? 'neg' : 'muted'}">by ${esc(fmtDate(p.due))}</span>` : ''}
        ${p.notes ? `<span class="muted notes" title="${esc(p.notes)}">${icon('info', 12)} notes</span>` : ''}</div>
    </div>
    <div class="row-value"><b>${esc(fmtMoney(p.amount, p.currency))}</b>${inBase(p.amount, p.currency, p.amount_base)}</div>
    <div class="row-actions">
      <button type="button" data-act="buy" title="Record the purchase">Bought</button>
      <button type="button" class="icon" data-act="edit-planned" title="Edit" aria-label="Edit ${esc(p.name)}">${icon('pencil')}</button>
      <button type="button" class="icon" data-act="drop" title="Drop: not needed any more" aria-label="Drop ${esc(p.name)}">${icon('x')}</button>
    </div>
  </li>`;
}

export function render(view) {
  const root = freshBox(view);
  const s = store.state;
  const t = s.totals;
  const active = s.recurring.filter((r) => r.is_active);
  const paused = s.recurring.filter((r) => !r.is_active);
  const open = s.planned.filter((p) => p.status === 'open');
  const closed = s.planned.filter((p) => p.status !== 'open');
  const cushionWallets = s.wallets.filter((w) => w.is_cushion && w.type !== 'debt');
  const overBudget = s.budgets.filter((b) => b.share > 1).length;
  const cushion = t.cushion;
  // 3 or 6 months of payments, in the cushion's currency ('' without a rate for it).
  const advice = (months) => {
    const value = convert((toNum(t.monthly_required) * months).toFixed(2), baseCurrency(), cushion.currency);
    return value ? fmtMoney(value, cushion.currency) : '';
  };

  root.innerHTML = `
    ${missingRatesBanner()}
    <div class="plans">
      <section class="card">
        <header class="card-head">
          <h2>Monthly payments</h2>
          <span class="spacer"></span>
          <button type="button" data-act="add-recurring">${icon('plus')} Add</button>
        </header>
        <div class="figure-line">
          <span><b>${esc(fmtBase(t.monthly_required))}</b> a month</span>
          <span class="muted">${esc(fmtMonth(s.month))}: paid ${esc(fmtBase(t.monthly_paid))} · left ${esc(fmtBase(t.monthly_left))}</span>
        </div>
        ${active.length ? meter(toNum(t.monthly_paid), toNum(t.monthly_required), { label: 'Paid this month' }) : ''}
        ${afterPayments()}
        ${s.recurring.length ? `<ul class="list">${active.map((r) => recurringRow(r, s.month)).join('')}</ul>
          ${paused.length ? `<details class="closed"><summary>Paused <span class="muted">(${paused.length})</span></summary>
            <ul class="list">${paused.map((r) => recurringRow(r, s.month)).join('')}</ul></details>` : ''}`
          : '<p class="muted">Rent, utilities, subscriptions, loan payments: everything you must pay every month. Their sum shows what a month costs you at least.</p>'}
      </section>

      <section class="card">
        <header class="card-head">
          <h2>Budgets</h2>
          <span class="spacer"></span>
          <button type="button" data-act="add-budget">${icon('plus')} Add</button>
        </header>
        ${s.budgets.length ? `
          <div class="figure-line"><span class="muted">${esc(fmtMonth(s.month))}: ${overBudget ? `${overBudget} over the limit` : 'all within the limits'}</span></div>
          <ul class="budget-list">${s.budgets.map((b) => budgetRow(b, { edit: true })).join('')}</ul>`
          : '<p class="muted">A monthly limit for a category (food, eating out, shopping) shows how much is left this month. Subcategories count toward their category.</p>'}
      </section>

      <section class="card">
        <header class="card-head">
          <h2>Planned expenses</h2>
          <span class="spacer"></span>
          <button type="button" data-act="add-planned">${icon('plus')} Add</button>
        </header>
        ${open.length ? `
          <div class="figure-line"><span><b>${esc(fmtBase(t.planned_total))}</b> in total</span></div>
          <ul class="list">${open.map(plannedRow).join('')}</ul>`
          : '<p class="muted">A new laptop, dental treatment, a trip: what you will spend on, and how much it all adds up to.</p>'}
        ${closed.length ? `<details class="closed"><summary>Bought and dropped <span class="muted">(${closed.length})</span></summary>
          <ul class="list">${closed.map((p) => `<li class="row inactive" data-planned="${p.id}">
            <span class="avatar">${icon(p.status === 'done' ? 'check' : 'x')}</span>
            <div class="row-main"><div class="row-title">${esc(p.name)}</div><div class="row-sub">${p.status === 'done' ? 'Bought' : 'Dropped'} ${esc(fmtDate(p.done_at))}</div></div>
            <div class="row-value">${esc(fmtMoney(p.amount, p.currency))}</div>
            <div class="row-actions">
              ${p.purchase_tx_id ? `<button type="button" class="ghost" data-act="open-purchase">Purchase</button>` : ''}
              <button type="button" class="icon" data-act="edit-planned" title="Edit or open again" aria-label="Edit ${esc(p.name)}">${icon('pencil')}</button>
            </div></li>`).join('')}</ul></details>` : ''}
      </section>

      <section class="card cushion">
        <header class="card-head"><h2>Safety cushion</h2></header>
        <form class="cushion-target">
          <label>Target
            <span class="amount-field"><input name="target" class="amount" inputmode="decimal" value="${toNum(cushion.target) ? esc(cushion.target) : ''}" placeholder="0.00"><span class="cur" data-cur-of="target">${esc(symbolOf(cushion.currency))}</span></span>
          </label>
          <label>Currency
            <select name="currency">${s.currencies.map((c) => opt(c.code, `${c.code} — ${c.name}`, cushion.currency)).join('')}</select>
          </label>
          <button type="submit">Save</button>
          ${toNum(t.monthly_required) && advice(3) ? `<span class="muted small">Common advice: 3–6 months of payments, here ${esc(advice(3))} – ${esc(advice(6))}</span>` : ''}
        </form>
        ${toNum(cushion.target) ? `
          <div class="figure-line">
            <span><b>${esc(fmtMoney(cushion.saved, cushion.currency))}</b> of ${esc(fmtMoney(cushion.target, cushion.currency))}</span>
            <span class="muted">${toNum(cushion.left) ? `left to save <b class="fg">${esc(fmtMoney(cushion.left, cushion.currency))}</b>` : 'target reached'}
              ${t.months_covered != null ? ` · covers ${t.months_covered} month${t.months_covered === 1 ? '' : 's'} of payments` : ''}</span>
            ${cushion.currency !== baseCurrency() ? `<span class="muted small">≈ ${esc(fmtBase(t.cushion_saved))} of ${esc(fmtBase(t.cushion_target))}</span>` : ''}
          </div>
          ${meter(toNum(t.cushion_saved), toNum(t.cushion_target), { label: 'Cushion saved' })}` : ''}
        <p class="hint">${cushionWallets.length
          ? `Counted from: ${cushionWallets.map((w) => `<b>${esc(w.name)}</b>`).join(', ')}. Mark or unmark wallets in <a href="#wallets">Wallets</a>.`
          : 'No wallet is marked for the cushion, so all your money counts toward it. Mark a savings account in <a href="#wallets">Wallets</a> (edit → “Counts toward the safety cushion”) to count only that.'}</p>
      </section>
    </div>`;

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const rec = s.recurring.find((r) => r.id === Number(btn.closest('[data-recurring]')?.dataset.recurring));
    const plan = s.planned.find((p) => p.id === Number(btn.closest('[data-planned]')?.dataset.planned));
    switch (btn.dataset.act) {
      case 'add-recurring': return openRecurring();
      case 'edit-recurring': return openRecurring(rec);
      case 'pay': return openPay(rec);
      case 'open-paid': return openTransactionById(rec.paid_tx_id);
      case 'add-budget': return openBudget();
      case 'edit-budget': return openBudget(s.budgets.find((b) => b.category_id === Number(btn.closest('[data-budget]').dataset.budget)));
      case 'add-planned': return openPlanned();
      case 'edit-planned': return openPlanned(plan);
      case 'buy': return openBuy(plan);
      case 'open-purchase': return openTransactionById(plan.purchase_tx_id);
      case 'drop':
        if (await confirmDialog({ title: `Drop “${plan.name}”?`, text: 'It moves to “Bought and dropped”. You can open it again later.', ok: 'Drop' })) {
          await act(() => api.post(`/api/planned/${plan.id}/drop`), `Dropped: ${plan.name}`);
        }
        return undefined;
      default: return undefined;
    }
  });
  root.querySelector('.cushion-target').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = e.target.target.value.trim();
    const value = text ? cleanAmount(text) : '0';
    if (value === null || value.startsWith('-')) return toast('Enter an amount', 'error');
    act(() => api.put('/api/config', { cushion_target: value, cushion_currency: e.target.currency.value }), 'Cushion target saved');
    return undefined;
  });
  // The symbol follows the picked currency; the amount is saved as typed, in that currency.
  root.querySelector('.cushion-target [name=currency]').addEventListener('change', (e) => {
    root.querySelector('.cushion-target [data-cur-of=target]').textContent = symbolOf(e.target.value);
  });
}
