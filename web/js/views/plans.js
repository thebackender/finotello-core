// Plans tab: monthly payments, planned expenses with their savings, and the safety cushion.
import * as api from '../api.js';
import { store, act, walletById, categoryById } from '../store.js';
import {
  openRecurring, openPay, openPlanned, openSave, openBuy, openTransactionById, PRIORITY_NAMES,
} from '../editor.js';
import { confirmDialog } from '../dialogs.js';
import { fmtMoney, fmtBase, fmtBaseNum, toNum, symbolOf, cleanAmount, baseCurrency } from '../money.js';
import { meter } from '../chart.js';
import { esc, freshBox, fmtDate, fmtMonth, paint, toast } from '../util.js';
import { icon } from '../icons.js';
import { missingRatesBanner } from './parts.js';

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
  return `<li class="plan-row ${r.is_active ? '' : 'inactive'}" data-recurring="${r.id}">
    <span class="day-badge" title="Day of the month">${ordinal(r.day)}</span>
    <div class="grow">
      <div class="plan-name">${esc(r.name)}</div>
      <div class="plan-meta">${categoryTag(r.category_id)}${w ? `<span class="muted">from ${esc(w.name)}</span>` : ''}</div>
    </div>
    <div class="plan-amount">${recurringAmount(r)}</div>
    <div class="plan-actions">
      ${!r.is_active ? '<span class="muted small">paused</span>'
        : r.paid_tx_id ? `<button type="button" class="ghost paid" data-act="open-paid" title="Paid ${esc(fmtDate(r.paid_date))}: open the payment">${icon('check', 14)} Paid ${esc(fmtDate(r.paid_date).slice(0, 5))}</button>`
          : `<button type="button" data-act="pay" title="Record the payment for ${esc(fmtMonth(month))}">Pay</button>`}
      <button type="button" class="icon" data-act="edit-recurring" title="Edit" aria-label="Edit ${esc(r.name)}">${icon('pencil')}</button>
    </div>
  </li>`;
}

function plannedRow(p) {
  const saved = toNum(p.saved);
  const amount = toNum(p.amount);
  const overdue = p.due && p.due < store.state.today;
  return `<li class="plan-row" data-planned="${p.id}">
    <span class="prio ${p.priority}" title="Priority: ${PRIORITY_NAMES[p.priority]}">${PRIORITY_NAMES[p.priority]}</span>
    <div class="grow">
      <div class="plan-name">${esc(p.name)}</div>
      <div class="plan-meta">${categoryTag(p.category_id)}${p.due ? `<span class="${overdue ? 'neg' : 'muted'}">by ${esc(fmtDate(p.due))}</span>` : ''}
        ${p.notes ? `<span class="muted notes" title="${esc(p.notes)}">${icon('info', 12)} notes</span>` : ''}</div>
      <div class="saving">
        ${meter(saved, amount, { label: `Saved for ${p.name}` })}
        <span class="muted small">${saved ? `${esc(fmtMoney(p.saved, p.currency))} saved · ${Math.min(100, Math.round((saved / amount) * 100))}%` : 'nothing saved yet'}</span>
      </div>
    </div>
    <div class="plan-amount"><b>${esc(fmtMoney(p.amount, p.currency))}</b>${inBase(p.amount, p.currency, p.amount_base)}</div>
    <div class="plan-actions">
      <button type="button" data-act="save" title="Put money aside for it, or take some back">${icon('piggy', 14)} Save</button>
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
  const missing = toNum(t.planned_missing);
  const cushionWallets = s.wallets.filter((w) => w.is_cushion && w.type !== 'debt');

  root.innerHTML = `
    ${missingRatesBanner()}
    <div class="plans">
      <section class="card">
        <header class="card-head">
          <h2>${icon('calendarCheck', 18, 'muted')} Monthly payments</h2>
          <span class="spacer"></span>
          <button type="button" data-act="add-recurring">${icon('plus')} Add</button>
        </header>
        <div class="summary-line">
          <span><b>${esc(fmtBase(t.monthly_required))}</b> a month</span>
          <span class="muted">${esc(fmtMonth(s.month))}: paid ${esc(fmtBase(t.monthly_paid))} · left ${esc(fmtBase(t.monthly_left))}</span>
        </div>
        ${active.length ? meter(toNum(t.monthly_paid), toNum(t.monthly_required), { label: 'Paid this month' }) : ''}
        ${s.recurring.length ? `<ul class="plan-list">${active.map((r) => recurringRow(r, s.month)).join('')}</ul>
          ${paused.length ? `<details class="closed"><summary>Paused <span class="muted">(${paused.length})</span></summary>
            <ul class="plan-list">${paused.map((r) => recurringRow(r, s.month)).join('')}</ul></details>` : ''}`
          : '<p class="muted">Rent, utilities, subscriptions, loan payments: everything you must pay every month. Their sum shows what a month costs you at least.</p>'}
      </section>

      <section class="card">
        <header class="card-head">
          <h2>${icon('bag', 18, 'muted')} Planned expenses</h2>
          <span class="spacer"></span>
          <button type="button" data-act="add-planned">${icon('plus')} Add</button>
        </header>
        ${open.length ? `
          <div class="summary-line">
            <span><b>${esc(fmtBase(t.planned_total))}</b> in total</span>
            <span class="muted">saved ${esc(fmtBase(t.planned_saved))} · missing ${esc(fmtBase(t.planned_missing))}</span>
          </div>
          ${missing <= 0 ? `<p class="hint">${icon('check', 14)} Everything is saved for.</p>` : ''}
          <ul class="plan-list">${open.map(plannedRow).join('')}</ul>`
          : '<p class="muted">A new laptop, dental treatment, a trip: what you will spend on. See the total, and put money aside for each.</p>'}
        ${closed.length ? `<details class="closed"><summary>Bought and dropped <span class="muted">(${closed.length})</span></summary>
          <ul class="plan-list">${closed.map((p) => `<li class="plan-row inactive" data-planned="${p.id}">
            <span class="status-tag">${p.status === 'done' ? `${icon('check', 12)} Bought` : 'Dropped'}</span>
            <div class="grow"><div class="plan-name">${esc(p.name)}</div><div class="plan-meta muted">${esc(fmtDate(p.done_at))}</div></div>
            <div class="plan-amount">${esc(fmtMoney(p.amount, p.currency))}</div>
            <div class="plan-actions">
              ${p.purchase_tx_id ? `<button type="button" class="ghost" data-act="open-purchase">Purchase</button>` : ''}
              <button type="button" class="icon" data-act="edit-planned" title="Edit or open again" aria-label="Edit ${esc(p.name)}">${icon('pencil')}</button>
            </div></li>`).join('')}</ul></details>` : ''}
      </section>

      <section class="card cushion">
        <header class="card-head"><h2>${icon('shield', 18, 'muted')} Safety cushion</h2></header>
        <form class="cushion-target">
          <label>Target
            <span class="amount-field"><input name="target" class="amount" inputmode="decimal" value="${toNum(t.cushion_target) ? esc(s.config.cushion_target) : ''}" placeholder="0.00"><span class="cur">${esc(symbolOf(baseCurrency()))}</span></span>
          </label>
          <button type="submit">Save</button>
          ${t.monthly_required && toNum(t.monthly_required) ? `<span class="muted small">Common advice: 3–6 months of payments, here ${esc(fmtBaseNum(toNum(t.monthly_required) * 3))} – ${esc(fmtBaseNum(toNum(t.monthly_required) * 6))}</span>` : ''}
        </form>
        ${toNum(t.cushion_target) ? `
          <div class="summary-line">
            <span><b>${esc(fmtBase(t.cushion_saved))}</b> of ${esc(fmtBase(t.cushion_target))}</span>
            <span class="muted">${toNum(t.cushion_left) ? `left to save <b class="fg">${esc(fmtBase(t.cushion_left))}</b>` : 'target reached'}
              ${t.months_covered != null ? ` · covers ${t.months_covered} month${t.months_covered === 1 ? '' : 's'} of payments` : ''}</span>
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
      case 'add-planned': return openPlanned();
      case 'edit-planned': return openPlanned(plan);
      case 'save': return openSave(plan);
      case 'buy': return openBuy(plan);
      case 'open-purchase': return openTransactionById(plan.purchase_tx_id);
      case 'drop':
        if (await confirmDialog({ title: `Drop “${plan.name}”?`, text: 'It moves to “Bought and dropped”; what was saved for it no longer counts as saved. You can open it again later.', ok: 'Drop' })) {
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
    act(() => api.put('/api/config', { cushion_target: value }), 'Cushion target saved');
    return undefined;
  });
}
