// Dialogs: transaction (expense / income / transfer / debt / balance adjustment), wallet,
// monthly payment and its payment, plan, its savings and its purchase.
import * as api from './api.js';
import {
  store, act, walletById, walletItems, categoryById, categoryItems, createCategory, moneyWallets,
  maxlength, WALLET_TYPE_NAMES,
} from './store.js';
import { comboHTML, bindCombos, bindCombo } from './combo.js';
import { confirmDialog, promptDialog } from './dialogs.js';
import {
  fmtMoney, symbolOf, decimalsOf, toMinor, fromMinor, cleanAmount, negate, convert, baseCurrency,
} from './money.js';
import { esc, opt, today, dateInput, bindDateInputs, readDate, toast, PALETTE, OTHER_COLOR, fmtDate, fmtTs } from './util.js';
import { icon } from './icons.js';
import { isDark } from './theme.js';

const dialog = document.getElementById('dialog');

// ---------- dialog frame ----------

function openForm(html, { wide = false } = {}) {
  dialog.innerHTML = `<form class="editor${wide ? '' : ' narrow'}" novalidate>${html}</form>`;
  const form = dialog.querySelector('form');
  bindDateInputs(form);
  form.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
  dialog.showModal();
  return form;
}

/** Dialog title and close button; extra goes between them. */
const header = (title, extra = '') =>
  `<header><h2>${esc(title)}</h2>${extra}<button type="button" class="icon" data-close aria-label="Close">${icon('x')}</button></header>`;

function footer({ remove = false, extra = '', ok = 'Save' } = {}) {
  return `<footer>
    ${remove ? `<button type="button" class="danger" data-remove>${icon('trash')} Delete</button>` : ''}${extra}
    <span class="spacer"></span>
    <button type="button" data-close>Cancel</button>
    <button type="submit" class="primary">${esc(ok)}</button>
  </footer>`;
}

/** Submit: fn() resolves to a truthy value when it worked; then the dialog closes. */
function onSubmit(form, fn) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if (await fn()) dialog.close();
    } finally {
      btn.disabled = false;
    }
  });
}

function onRemove(form, question, fn) {
  form.querySelector('[data-remove]')?.addEventListener('click', async () => {
    if (!(await confirmDialog({ ...question, ok: question.ok ?? 'Delete', danger: true }))) return;
    if (await fn()) dialog.close();
  });
}

/** Amount input with the currency's symbol after it. */
const amountField = (name, value, currency, attrs = '') =>
  `<span class="amount-field"><input name="${name}" class="amount" inputmode="decimal" autocomplete="off"
    value="${esc(value ?? '')}" placeholder="0.00" ${attrs}><span class="cur" data-cur-of="${name}">${esc(symbolOf(currency))}</span></span>`;

/** Reads an amount input: a clean positive number string, or null (marks the field). */
function readAmount(input, { allowNegative = false, optional = false } = {}) {
  const text = input.value.trim();
  if (!text && optional) return '';
  const clean = cleanAmount(text);
  const ok = clean !== null && Number(clean) !== 0 && (allowNegative || !clean.startsWith('-'));
  input.classList.toggle('invalid', !ok);
  if (!ok) {
    input.focus();
    toast(text ? 'Enter a number above zero' : 'Enter an amount', 'error');
    return null;
  }
  return clean;
}

const currencyOptions = (selected) =>
  store.state.currencies.map((c) => opt(c.code, `${c.code} — ${c.name}`, selected)).join('');

const wallet = (id) => walletById(id);
const currencyOfWallet = (id) => wallet(id)?.currency ?? baseCurrency();

/** Combo of wallets that tells, through the hidden input's change event, which wallet was picked. */
const walletCombo = (name, value, opts = {}) =>
  comboHTML(name, walletItems({ ...opts, keep: value ? [value] : [] }), value, { placeholder: 'Wallet', noneLabel: null });

// ---------- transaction ----------

/** Shape of the form, from a stored transaction (or empty). */
function txModel(tx, preset) {
  const m = {
    type: 'expense', date: today(), note: '', wallet_id: null,
    lines: [{ amount: '', category_id: null, description: '' }],
    from_id: null, to_id: null, sent: '', received: '', fee: '', fee_category_id: null,
    direction: 'give', person_id: null, adjust: '',
    ...preset,
  };
  if (!tx) {
    m.wallet_id ??= moneyWallets()[0]?.id ?? null;
    m.from_id ??= m.wallet_id;
    if (m.type === 'transfer') m.to_id ??= moneyWallets().find((w) => w.id !== m.from_id)?.id ?? null;
    if (m.fee_category_id == null) m.fee_category_id = store.state.categories.find((c) => c.name === 'Fees' && c.kind === 'expense' && !c.is_deleted)?.id ?? null;
    return m;
  }
  const abs = (s) => String(s).replace('-', '');
  Object.assign(m, { type: tx.type, date: tx.date, note: tx.note });
  const moves = tx.entries.filter((e) => e.category_id == null);
  const fee = tx.entries.find((e) => e.category_id != null);
  const out = moves.find((e) => e.amount.startsWith('-'));
  const inn = moves.find((e) => !e.amount.startsWith('-'));
  if (tx.type === 'expense' || tx.type === 'income') {
    m.wallet_id = tx.entries[0].wallet_id;
    m.lines = tx.entries.map((e) => ({ amount: abs(e.amount), category_id: e.category_id, description: e.description }));
  } else if (tx.type === 'adjustment') {
    m.wallet_id = tx.entries[0].wallet_id;
    m.adjust = tx.entries[0].amount;
  } else {
    if (fee) Object.assign(m, { fee: abs(fee.amount), fee_category_id: fee.category_id });
    if (tx.type === 'transfer') {
      Object.assign(m, { from_id: out?.wallet_id, to_id: inn?.wallet_id, sent: abs(out?.amount ?? ''), received: inn?.amount ?? '' });
    } else if (wallet(out?.wallet_id)?.type === 'debt') {
      Object.assign(m, { direction: 'get', person_id: out.wallet_id, wallet_id: inn?.wallet_id, sent: inn?.amount ?? '', received: abs(out.amount) });
    } else {
      Object.assign(m, { direction: 'give', wallet_id: out?.wallet_id, person_id: inn?.wallet_id, sent: abs(out?.amount ?? ''), received: inn?.amount ?? '' });
    }
    // The second amount only matters when the currencies differ.
    const [a, b] = tx.type === 'transfer' ? [m.from_id, m.to_id] : [m.wallet_id, m.person_id];
    if (currencyOfWallet(a) === currencyOfWallet(b)) m.received = '';
  }
  return m;
}

const TYPES = [['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer'], ['debt', 'Debt']];
export const TX_TYPE_NAMES = Object.fromEntries(TYPES);

/** What a template fills in, in a few words: "$3.50 · Food:Eating out", "Card → Cash · $200". */
export function templateSummary(t) {
  const d = t.data;
  const name = (id) => walletById(id)?.name ?? '?';
  const money = (amount, walletId) => (amount ? fmtMoney(amount, currencyOfWallet(walletId)) : 'any amount');
  if (d.type === 'expense' || d.type === 'income') {
    return (d.lines ?? []).map((l) => [money(l.amount, d.wallet_id), categoryById(l.category_id)?.path].filter(Boolean).join(' · ')).join(', ');
  }
  if (d.type === 'transfer') return `${name(d.from_id)} → ${name(d.to_id)} · ${money(d.sent, d.from_id)}`;
  return `${d.direction === 'get' ? 'From' : 'To'} ${name(d.person_id)} · ${money(d.sent, d.wallet_id)}`;
}

/** A saved template as a preset for a new transaction: wallets and categories deleted since then are dropped. */
function fromTemplate(t) {
  const d = structuredClone(t.data);
  for (const key of ['wallet_id', 'from_id', 'to_id', 'person_id']) {
    if (d[key] != null && !walletById(d[key])) d[key] = null;
  }
  const live = (id) => (id != null && categoryById(id) && !categoryById(id).is_deleted ? id : null);
  if (Array.isArray(d.lines) && d.lines.length) d.lines = d.lines.map((l) => ({ amount: l.amount ?? '', description: l.description ?? '', category_id: live(l.category_id) }));
  else delete d.lines;
  if ('fee_category_id' in d) d.fee_category_id = live(d.fee_category_id);
  delete d.date;
  return d;
}

/**
 * New or existing transaction. preset (new only): {type, wallet_id, from_id, to_id, person_id, direction,
 * date, lines}. Resolves when the dialog closes.
 */
export function openTransaction(tx = null, preset = {}) {
  const m = txModel(tx, preset);
  const templates = tx ? [] : store.state.templates;
  const extra = m.type === 'adjustment' ? '' : `
    ${tx ? `<button type="button" class="ghost" data-repeat title="A new transaction like this one, dated today">${icon('repeat', 14)} Repeat</button>` : ''}
    <button type="button" class="ghost" data-save-template title="Keep this form to fill a new transaction in one click">${icon('bookmark', 14)} Save as template</button>`;
  const form = openForm(`
    ${header(tx ? (tx.type === 'adjustment' ? 'Balance adjustment' : 'Edit transaction') : 'New transaction',
      templates.length ? `<div class="template-pick" title="Fill the form from a saved template">${icon('bookmark', 14, 'muted')}${comboHTML('template',
        templates.map((t) => ({ value: t.id, label: t.name, hint: templateSummary(t) })), preset.template_id,
        { placeholder: 'Templates', noneLabel: null })}</div>` : '')}
    ${m.type === 'adjustment' ? '' : `<div class="segmented type-switch" role="tablist">
      ${TYPES.map(([value, label]) => `<button type="button" data-type="${value}" class="${m.type === value ? 'on' : ''}">${label}</button>`).join('')}
    </div>`}
    <div class="tx-body"></div>
    <div class="grid">
      <label>Date ${dateInput('date', m.date)}</label>
      <label>Note <input name="note" value="${esc(m.note)}" placeholder="Shop, reason…" ${maxlength('note')}></label>
    </div>
    ${footer({ remove: !!tx, extra })}`, { wide: true });
  const body = form.querySelector('.tx-body');

  // ----- reading the form back into the model -----
  const val = (name) => form.querySelector(`[name="${name}"]`)?.value ?? '';
  function collect() {
    m.note = val('note');
    if (m.type === 'expense' || m.type === 'income') {
      m.wallet_id = Number(val('wallet_id')) || null;
      m.lines = [...body.querySelectorAll('.line')].map((row) => ({
        amount: row.querySelector('[name=amount]').value,
        category_id: Number(row.querySelector('[name=category_id]').value) || null,
        description: row.querySelector('[name=description]').value,
      }));
    } else if (m.type === 'adjustment') {
      m.adjust = val('adjust');
    } else {
      Object.assign(m, { sent: val('sent'), received: val('received'), fee: val('fee'), fee_category_id: Number(val('fee_category_id')) || null });
      if (m.type === 'transfer') Object.assign(m, { from_id: Number(val('from_id')) || null, to_id: Number(val('to_id')) || null });
      else Object.assign(m, { wallet_id: Number(val('wallet_id')) || null, person_id: Number(val('person_id')) || null });
    }
  }

  // ----- drawing the part that depends on the type -----
  const lineHTML = (l, kind, currency) => `<div class="line">
    ${amountField('amount', l.amount, currency)}
    <div class="line-cat">${comboHTML('category_id', categoryItems(kind, l.category_id ? [l.category_id] : []), l.category_id,
      { placeholder: 'Category or Category:Sub', creatable: true, noneLabel: '— no category —' })}</div>
    <input name="description" value="${esc(l.description)}" placeholder="Description" ${maxlength('description')}>
    <button type="button" class="icon" data-remove-line title="Remove this line" aria-label="Remove this line">${icon('x')}</button>
  </div>`;

  function feeHTML(currency) {
    return `<details class="fee" ${m.fee ? 'open' : ''}>
      <summary>Fee <span class="muted">(optional, counts as spending)</span></summary>
      <div class="grid">
        <label>Amount ${amountField('fee', m.fee, currency)}</label>
        <div class="field">Category ${comboHTML('fee_category_id', categoryItems('expense', m.fee_category_id ? [m.fee_category_id] : []), m.fee_category_id,
          { placeholder: 'Category', creatable: true, noneLabel: null })}</div>
      </div>
    </details>`;
  }

  function draw() {
    if (m.type === 'expense' || m.type === 'income') {
      const currency = currencyOfWallet(m.wallet_id);
      body.innerHTML = `
        <div class="field">${m.type === 'expense' ? 'Paid from' : 'Received to'}
          ${walletCombo('wallet_id', m.wallet_id)}
        </div>
        <div class="field">Lines
          <div class="lines">${m.lines.map((l) => lineHTML(l, m.type, currency)).join('')}</div>
          <div class="lines-foot">
            <button type="button" class="ghost" data-add-line>${icon('split')} Split into another line</button>
            <span class="spacer"></span><span class="lines-total"></span>
          </div>
        </div>`;
      body.querySelector('[data-remove-line]').closest('.lines').classList.toggle('single', m.lines.length === 1);
    } else if (m.type === 'adjustment') {
      const w = wallet(m.wallet_id);
      body.innerHTML = `<p class="hint">The starting balance of <b>${esc(w?.name ?? '?')}</b>, recorded when the wallet was added.
        Above zero adds money, below zero takes it away.</p>
        <label>Difference ${amountField('adjust', m.adjust, currencyOfWallet(m.wallet_id))}</label>`;
    } else if (m.type === 'transfer') {
      const [fromCur, toCur] = [currencyOfWallet(m.from_id), currencyOfWallet(m.to_id)];
      body.innerHTML = `
        <div class="grid">
          <div class="field">From ${walletCombo('from_id', m.from_id)}</div>
          <div class="field">To ${walletCombo('to_id', m.to_id)}</div>
          <label>Sent ${amountField('sent', m.sent, fromCur)}</label>
          <label class="${fromCur === toCur ? 'hidden-keep' : ''}">Received ${amountField('received', m.received, toCur)}</label>
        </div>
        ${feeHTML(fromCur)}`;
    } else {
      const person = wallet(m.person_id);
      const [myCur, theirCur] = [currencyOfWallet(m.wallet_id), person?.currency ?? currencyOfWallet(m.wallet_id)];
      const give = m.direction === 'give';
      body.innerHTML = `
        <div class="segmented direction">
          <button type="button" data-direction="give" class="${give ? 'on' : ''}">${icon('arrowOut')} I give money</button>
          <button type="button" data-direction="get" class="${give ? '' : 'on'}">${icon('arrowIn')} I get money</button>
        </div>
        <p class="hint">${give ? 'Lending to a person, or paying back what you owe.' : 'Borrowing from a person, or getting back what they owe you.'}</p>
        <div class="grid">
          <div class="field">Person ${comboHTML('person_id', walletItems({ withPeople: true, keep: m.person_id ? [m.person_id] : [] }).filter((i) => wallet(i.value)?.type === 'debt'),
            m.person_id, { placeholder: 'Name', creatable: true, noneLabel: null })}</div>
          <div class="field">${give ? 'From my wallet' : 'To my wallet'} ${walletCombo('wallet_id', m.wallet_id)}</div>
          <label>Amount ${amountField('sent', m.sent, myCur)}</label>
          <label class="${myCur === theirCur ? 'hidden-keep' : ''}">In ${esc(theirCur)} (the debt's currency) ${amountField('received', m.received, theirCur)}</label>
        </div>
        ${feeHTML(myCur)}`;
    }
    bindBodyCombos();
    updateTotals();
  }

  /** "+ Create …" in a combo: a category of the right kind, or a new person. */
  async function createFor(text, box) {
    if (box?.querySelector('[name=person_id]')) return createPerson(text);
    return createCategory(m.type === 'income' ? 'income' : 'expense', text);
  }
  async function createPerson(name) {
    const currency = currencyOfWallet(Number(val('wallet_id')) || m.wallet_id);
    const result = await act(() => api.post('/api/wallets', { name, type: 'debt', currency }), `Added ${name}`);
    return result ? { value: result.id, label: name } : null;
  }
  // Each combo's "+ Create" needs to know which combo asked: a person or a category.
  function bindBodyCombos() {
    body.querySelectorAll('.combo').forEach((box) => bindCombo(box, { onCreate: (text) => createFor(text, box) }));
  }

  function updateTotals() {
    const total = body.querySelector('.lines-total');
    if (!total) return;
    const rows = [...body.querySelectorAll('.line [name=amount]')];
    const currency = currencyOfWallet(Number(val('wallet_id')));
    const decimals = decimalsOf(currency);
    const sum = rows.reduce((s, input) => s + (toMinor(input.value, decimals) ?? 0n), 0n);
    total.textContent = rows.length > 1 ? `Total ${fmtMoney(fromMinor(sum, decimals), currency)}` : '';
  }

  // Suggest the received amount from the rates while it's empty.
  function suggestReceived() {
    const received = form.querySelector('[name=received]');
    if (!received) return;
    const [a, b] = m.type === 'transfer' ? [val('from_id'), val('to_id')] : [val('wallet_id'), val('person_id')];
    const from = currencyOfWallet(Number(a));
    const to = m.type === 'transfer' ? currencyOfWallet(Number(b)) : (wallet(Number(b))?.currency ?? from);
    received.placeholder = convert(cleanAmount(val('sent')) ?? '0', from, to) || '0.00';
  }

  /** The form without its date: for a template, or for a copy. */
  function snapshot() {
    collect();
    const fee = { fee: m.fee, fee_category_id: m.fee_category_id };
    if (m.type === 'expense' || m.type === 'income') return { type: m.type, note: m.note, wallet_id: m.wallet_id, lines: m.lines };
    if (m.type === 'transfer') return { type: m.type, note: m.note, from_id: m.from_id, to_id: m.to_id, sent: m.sent, received: m.received, ...fee };
    return { type: m.type, note: m.note, direction: m.direction, wallet_id: m.wallet_id, person_id: m.person_id, sent: m.sent, received: m.received, ...fee };
  }

  async function saveTemplate() {
    const data = snapshot();
    const guess = m.note || categoryById(m.lines?.[0]?.category_id)?.name || TX_TYPE_NAMES[m.type];
    const name = await promptDialog({
      title: 'Save as template', value: guess, ok: 'Save', attrs: maxlength('name'),
      text: 'It shows at the top of New transaction. Amounts are kept too: clear one first to type it each time.',
    });
    if (name) await act(() => api.post('/api/templates', { name, data }), `Template “${name}” saved`);
  }

  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-repeat]')) {
      const copy = snapshot();
      dialog.close();
      openTransaction(null, copy);
      return;
    }
    if (e.target.closest('[data-save-template]')) {
      saveTemplate();
      return;
    }
    const typeBtn = e.target.closest('[data-type]');
    if (typeBtn && typeBtn.dataset.type !== m.type) {
      collect();
      const before = m.type;
      m.type = typeBtn.dataset.type;
      form.querySelectorAll('[data-type]').forEach((b) => b.classList.toggle('on', b === typeBtn));
      // Carry the amount and wallet across types.
      const firstAmount = before === 'expense' || before === 'income' ? m.lines[0]?.amount : m.sent;
      const firstWallet = before === 'transfer' ? m.from_id : m.wallet_id;
      if (m.type === 'expense' || m.type === 'income') {
        if (before === 'expense' || before === 'income') m.lines = m.lines.map((l) => ({ ...l, category_id: null }));
        else m.lines = [{ amount: firstAmount ?? '', category_id: null, description: '' }];
        m.wallet_id = firstWallet;
        if (m.type === 'income' && wallet(m.wallet_id)?.type === 'debt') m.wallet_id = moneyWallets()[0]?.id ?? null;
      } else {
        m.sent ||= firstAmount ?? '';
        if (m.type === 'transfer') {
          m.from_id = wallet(firstWallet)?.type === 'debt' ? moneyWallets()[0]?.id : firstWallet;
          m.to_id ??= moneyWallets().find((w) => w.id !== m.from_id)?.id ?? null;
        } else if (wallet(firstWallet)?.type === 'debt') {
          m.person_id = firstWallet;
          m.wallet_id = moneyWallets()[0]?.id ?? null;
        } else {
          m.wallet_id = firstWallet;
        }
      }
      draw();
      return;
    }
    const dirBtn = e.target.closest('[data-direction]');
    if (dirBtn) {
      collect();
      m.direction = dirBtn.dataset.direction;
      draw();
      return;
    }
    if (e.target.closest('[data-add-line]')) {
      collect();
      m.lines.push({ amount: '', category_id: null, description: '' });
      draw();
      body.querySelectorAll('.line [name=amount]')[m.lines.length - 1]?.focus();
      return;
    }
    const removeLine = e.target.closest('[data-remove-line]');
    if (removeLine) {
      collect();
      const index = [...body.querySelectorAll('.line')].indexOf(removeLine.closest('.line'));
      if (m.lines.length > 1) m.lines.splice(index, 1);
      draw();
    }
  });
  form.addEventListener('input', (e) => {
    if (e.target.name === 'amount') updateTotals();
    if (e.target.name === 'sent') suggestReceived();
    e.target.classList.remove('invalid');
  });
  form.addEventListener('change', (e) => {
    // A template picked: start over from it (the type and the fields may all change).
    if (e.target.name === 'template' && e.target.value) {
      const t = store.state.templates.find((x) => x.id === Number(e.target.value));
      dialog.close();
      openTransaction(null, { ...fromTemplate(t), template_id: t.id });
      return;
    }
    // A different wallet can mean a different currency: redraw to update the symbols and fields.
    if (['wallet_id', 'from_id', 'to_id', 'person_id'].includes(e.target.name)) {
      collect();
      draw();
      suggestReceived();
    }
  });

  const picker = form.querySelector('.template-pick .combo');
  if (picker) bindCombo(picker);
  draw();
  suggestReceived();
  // From a template: the first empty amount, or Save when everything is filled in (Enter saves).
  if (!tx) {
    setTimeout(() => {
      const amounts = [...form.querySelectorAll('.tx-body .amount')];
      const target = preset.template_id ? amounts.find((i) => !i.value) ?? form.querySelector('button[type=submit]') : amounts[0];
      target?.focus();
    }, 0);
  }

  onSubmit(form, async () => {
    collect();
    const date = readDate(form.querySelector('[name=date]'), 'Date');
    if (date === undefined) return false;
    let entries;
    if (m.type === 'expense' || m.type === 'income') {
      if (!m.wallet_id) return toast('Pick a wallet', 'error');
      const inputs = [...body.querySelectorAll('.line [name=amount]')];
      entries = [];
      for (const [i, l] of m.lines.entries()) {
        const amount = readAmount(inputs[i]);
        if (amount === null) return false;
        entries.push({ wallet_id: m.wallet_id, amount: m.type === 'expense' ? negate(amount) : amount, category_id: l.category_id, description: l.description });
      }
    } else if (m.type === 'adjustment') {
      const amount = readAmount(form.querySelector('[name=adjust]'), { allowNegative: true });
      if (amount === null) return false;
      entries = [{ wallet_id: m.wallet_id, amount }];
    } else {
      const [mine, theirs] = m.type === 'transfer' ? [m.from_id, m.to_id] : [m.wallet_id, m.person_id];
      if (!mine || !theirs) return toast(m.type === 'transfer' ? 'Pick both wallets' : 'Pick the person and your wallet', 'error');
      if (mine === theirs) return toast('Pick two different wallets', 'error');
      const sent = readAmount(form.querySelector('[name=sent]'));
      if (sent === null) return false;
      const sameCurrency = currencyOfWallet(mine) === currencyOfWallet(theirs);
      let received = sent;
      if (!sameCurrency) {
        const input = form.querySelector('[name=received]');
        if (!input.value.trim() && input.placeholder && cleanAmount(input.placeholder)) input.value = input.placeholder;
        received = readAmount(input);
        if (received === null) return false;
      }
      const fee = readAmount(form.querySelector('[name=fee]'), { optional: true });
      if (fee === null) return false;
      if (m.type === 'transfer' || m.direction === 'give') {
        entries = [{ wallet_id: mine, amount: negate(sent) }, { wallet_id: theirs, amount: received }];
      } else {
        entries = [{ wallet_id: theirs, amount: negate(received) }, { wallet_id: mine, amount: sent }];
      }
      if (fee) {
        if (!m.fee_category_id) return toast('Pick a category for the fee', 'error');
        entries.push({ wallet_id: mine, amount: negate(fee), category_id: m.fee_category_id });
      }
    }
    const payload = { type: m.type, date: date ?? today(), note: m.note, entries };
    return tx
      ? act(() => api.put(`/api/transactions/${tx.id}`, payload), 'Saved')
      : act(() => api.post('/api/transactions', payload), 'Added');
  });
  onRemove(form, { title: 'Delete this transaction?', text: 'Balances and reports change at once. This can’t be undone.' },
    () => act(() => api.del(`/api/transactions/${tx.id}`), 'Deleted'));
}

// ---------- wallet ----------

// Color picker: Coloris (web/vendor/coloris), loaded as a plain script. The palette colors are its quick swatches.
export function setupColorPicker() {
  if (!window.Coloris) return;
  window.Coloris({
    el: '.color-input', wrap: true, themeMode: isDark() ? 'dark' : 'light', format: 'hex', alpha: false,
    swatches: [...PALETTE, OTHER_COLOR], closeButton: true, closeLabel: 'Done', margin: 6,
  });
  window.Coloris.wrap('.color-input'); // fields drawn after start-up need wrapping too
}

/** New or existing wallet; preset (new only): {type, currency}. A person (type "debt") is a wallet too. */
export function openWallet(w = null, preset = {}) {
  const type = w?.type ?? preset.type ?? 'bank';
  const hasTransactions = !!w?.has_transactions;
  const isPerson = type === 'debt';
  const types = ['bank', 'cash', 'crypto'];
  const form = openForm(`
    ${header(w ? `Edit ${isPerson ? 'person' : 'wallet'}` : isPerson ? 'New person' : 'New wallet')}
    <label>Name <input name="name" value="${esc(w?.name ?? '')}" placeholder="${isPerson ? 'Ivan' : 'T-Bank card'}" required ${maxlength('name')}></label>
    <div class="grid">
      ${isPerson ? '' : `<label>Type <select name="type">${types.map((t) => opt(t, WALLET_TYPE_NAMES[t], type)).join('')}</select></label>`}
      <label>Currency <select name="currency" ${w?.currency_fixed ? 'disabled' : ''}>${currencyOptions(w?.currency ?? preset.currency ?? baseCurrency())}</select></label>
    </div>
    ${w?.currency_fixed ? `<p class="field-hint currency-hint">The currency is fixed: this ${isPerson ? 'debt' : 'wallet'} has transfers or debts with other wallets.
      To hold money in another currency, create a new wallet and make a transfer.</p>` : ''}
    ${hasTransactions && !w.currency_fixed ? `<p class="field-hint currency-hint" hidden>Changing the currency keeps every amount of this wallet as the same number, now in the new currency.
      Use it to fix a currency picked by mistake; to exchange money, make a transfer to another wallet.</p>` : ''}
    ${w ? '' : `<label>${isPerson ? 'They owe you now' : 'Balance now'}
      ${amountField('balance', '', w?.currency ?? preset.currency ?? baseCurrency())}
      <span class="field-hint">${isPerson ? 'Below zero if you owe them. Leave empty if you are even.' : 'Recorded as the starting balance. Leave empty for zero.'}</span></label>`}
    ${isPerson ? '' : `<div class="grid">
      <div class="field">Color <span class="color-cell"><input class="color-input" name="color" value="${esc(w?.color ?? '')}" placeholder="auto" autocomplete="off" spellcheck="false"></span></div>
      <label class="check top-pad"><input type="checkbox" name="is_cushion" ${w?.is_cushion ? 'checked' : ''}> Counts toward the safety cushion</label>
    </div>`}
    <label>Note <textarea name="note" rows="2" ${maxlength('note')} placeholder="${isPerson ? 'Phone, when they promised to pay back…' : 'Card number ending, what it is for…'}">${esc(w?.note ?? '')}</textarea></label>
    ${w ? `<label class="check"><input type="checkbox" name="is_archived" ${w.is_archived ? 'checked' : ''}> Archived: hidden from the lists, the balance still counts</label>` : ''}
    ${footer({ remove: !!w })}`);
  setupColorPicker();
  form.querySelector('[name=currency]').addEventListener('change', (e) => {
    const cur = form.querySelector('[data-cur-of=balance]');
    if (cur) cur.textContent = symbolOf(e.target.value);
    const hint = form.querySelector('.currency-hint');
    if (hint && w) hint.hidden = e.target.value === w.currency;
  });
  if (!w) form.querySelector('[name=name]').focus();

  onSubmit(form, async () => {
    const data = Object.fromEntries(new FormData(form));
    const payload = { name: data.name, note: data.note };
    if (!isPerson) {
      payload.type = data.type;
      payload.is_cushion = !!data.is_cushion;
      if (data.color) payload.color = data.color;
    } else payload.type = 'debt';
    if (!w?.currency_fixed) payload.currency = data.currency;
    if (w) {
      payload.is_archived = !!data.is_archived;
      if (hasTransactions && payload.currency && payload.currency !== w.currency) {
        const ok = await confirmDialog({
          title: `Switch ${w.name} to ${data.currency}?`,
          text: `Its balance ${fmtMoney(w.balance, w.currency)} becomes ${fmtMoney(w.balance, data.currency)}: every amount keeps its number.`,
          ok: `Switch to ${data.currency}`,
        });
        if (!ok) return false;
      }
      return act(() => api.put(`/api/wallets/${w.id}`, payload), 'Saved');
    }
    const balance = data.balance?.trim();
    if (balance) {
      const clean = cleanAmount(balance);
      if (clean === null) return toast('Balance: enter a number', 'error');
      payload.balance = clean;
    }
    return act(() => api.post('/api/wallets', payload), `Added ${data.name}`);
  });
  onRemove(form, {
    title: `Delete ${w?.name}?`,
    text: w?.has_transactions ? 'It has transactions, so it can only be archived.' : 'This can’t be undone.',
  }, () => act(() => api.del(`/api/wallets/${w.id}`), 'Deleted'));
}

// ---------- currency ----------

/** Name and rate of a currency; Delete while nothing uses it. */
export function openCurrency(c) {
  const base = baseCurrency();
  const isBase = c.code === base;
  const form = openForm(`
    ${header(`${c.code} — ${c.name}`)}
    <label>Name <input name="name" value="${esc(c.name)}" ${maxlength('currency_name')}></label>
    ${isBase ? '<p class="hint">The base currency: totals are counted in it, so its rate is always 1.</p>' : `
      <label>Rate <span class="rate-field">1 ${esc(c.code)} =
        <input name="rate" class="amount" inputmode="decimal" autocomplete="off" value="${Number(c.rate) ? esc(c.rate) : ''}" placeholder="not set"> ${esc(base)}</span></label>
      <p class="hint">${c.rate_updated ? `Updated ${esc(fmtTs(c.rate_updated))}. ` : ''}All totals and reports are recounted at this rate.</p>`}
    ${footer({ remove: !isBase && !c.used })}`);
  const nameInput = form.querySelector('[name=name]');
  const rateInput = form.querySelector('[name=rate]');
  (rateInput ?? nameInput).focus();
  (rateInput ?? nameInput).select();
  onSubmit(form, async () => {
    const payload = {};
    if (nameInput.value.trim() !== c.name) payload.name = nameInput.value;
    if (rateInput) {
      const value = rateInput.value.trim() ? cleanAmount(rateInput.value) : '0';
      if (value === null || value.startsWith('-')) {
        rateInput.classList.add('invalid');
        return toast('Enter the rate as a number', 'error');
      }
      if (Number(value) !== Number(c.rate)) payload.rate = value;
    }
    if (!Object.keys(payload).length) return true;
    return act(() => api.put(`/api/currencies/${c.code}`, payload), payload.rate ? `1 ${c.code} = ${payload.rate} ${base}` : 'Saved');
  });
  onRemove(form, { title: `Remove ${c.code}?`, text: 'No wallet, payment or plan uses it. You can add it again later.', ok: 'Remove' },
    () => act(() => api.del(`/api/currencies/${c.code}`), `Removed ${c.code}`));
}

// ---------- budget ----------

/** A monthly limit for a spending category. item: a budget from the state, or null for a new one. */
export function openBudget(item = null) {
  const category = item ? categoryById(item.category_id) : null;
  const choices = categoryItems('expense').filter((i) => !categoryById(i.value)?.budget);
  const form = openForm(`
    ${header(item ? `Budget: ${category?.path ?? ''}` : 'New budget')}
    <p class="hint">How much you mean to spend on it in a month, in ${esc(baseCurrency())}. Its subcategories count toward it.</p>
    ${item ? '' : `<div class="field">Category ${comboHTML('category_id', choices, null,
      { placeholder: 'Category or Category:Sub', creatable: true, noneLabel: null })}</div>`}
    <label>Per month ${amountField('budget', item?.budget ?? '', baseCurrency())}</label>
    ${footer({ remove: !!item })}`);
  bindCombos(form, { onCreate: (text) => createCategory('expense', text) });
  (item ? form.querySelector('[name=budget]') : form.querySelector('.combo-input'))?.focus();
  onSubmit(form, async () => {
    const id = item ? item.category_id : Number(form.querySelector('[name=category_id]').value) || null;
    if (!id) return toast('Pick a category', 'error');
    const budget = readAmount(form.querySelector('[name=budget]'));
    if (budget === null) return false;
    return act(() => api.put(`/api/categories/${id}`, { budget }), item ? 'Budget saved' : 'Budget added');
  });
  onRemove(form, { title: `Remove the budget of “${category?.path ?? ''}”?`, text: 'The category and its spending stay.', ok: 'Remove' },
    () => act(() => api.put(`/api/categories/${item.category_id}`, { budget: '' }), 'Budget removed'));
}

// ---------- monthly payments ----------

export function openRecurring(item = null) {
  const currency = item?.currency ?? baseCurrency();
  const form = openForm(`
    ${header(item ? 'Edit monthly payment' : 'New monthly payment')}
    <label>Name <input name="name" value="${esc(item?.name ?? '')}" placeholder="Rent, internet, gym…" ${maxlength('name')}></label>
    <div class="grid">
      <label><span class="amount-label">${item?.is_variable ? 'About' : 'Amount'}</span> ${amountField('amount', item?.amount ?? '', currency)}</label>
      <label>Currency <select name="currency">${currencyOptions(currency)}</select></label>
    </div>
    <label class="check"><input type="checkbox" name="is_variable" ${item?.is_variable ? 'checked' : ''}> The amount varies (utilities, phone…)</label>
    <p class="field-hint variable-hint" ${item?.is_variable ? '' : 'hidden'}>Enter roughly how much it is. Once it has been paid,
      the monthly total uses the average of the last 3 payments instead; each time you pay, you enter the real bill.</p>
    <div class="grid">
      <div class="field">Category ${comboHTML('category_id', categoryItems('expense', item?.category_id ? [item.category_id] : []), item?.category_id,
        { placeholder: 'Category', creatable: true })}</div>
      <label>Day of the month <input name="day" type="number" min="1" max="31" value="${item?.day ?? 1}"></label>
    </div>
    <div class="field">Usually paid from ${comboHTML('wallet_id', walletItems({ keep: item?.wallet_id ? [item.wallet_id] : [] }), item?.wallet_id, { placeholder: 'Wallet', noneLabel: '— ask each time —' })}</div>
    ${item ? `<label class="check"><input type="checkbox" name="is_active" ${item.is_active ? 'checked' : ''}> Active: counts in the monthly total</label>` : ''}
    ${footer({ remove: !!item })}`);
  bindCombos(form, { onCreate: (text) => createCategory('expense', text) });
  form.querySelector('[name=currency]').addEventListener('change', (e) => {
    form.querySelector('[data-cur-of=amount]').textContent = symbolOf(e.target.value);
  });
  form.querySelector('[name=is_variable]').addEventListener('change', (e) => {
    form.querySelector('.amount-label').textContent = e.target.checked ? 'About' : 'Amount';
    form.querySelector('.variable-hint').hidden = !e.target.checked;
  });
  if (!item) form.querySelector('[name=name]').focus();
  onSubmit(form, async () => {
    const data = Object.fromEntries(new FormData(form));
    const amount = readAmount(form.querySelector('[name=amount]'));
    if (amount === null) return false;
    const payload = {
      name: data.name, amount, currency: data.currency, day: Number(data.day) || 1, is_variable: !!data.is_variable,
      category_id: Number(data.category_id) || null, wallet_id: Number(data.wallet_id) || null,
    };
    if (item) payload.is_active = !!data.is_active;
    return item
      ? act(() => api.put(`/api/recurring/${item.id}`, payload), 'Saved')
      : act(() => api.post('/api/recurring', payload), 'Added');
  });
  onRemove(form, { title: `Delete “${item?.name}”?`, text: 'Payments already made stay.' },
    () => act(() => api.del(`/api/recurring/${item.id}`), 'Deleted'));
}

/**
 * Spending dialog for Pay (monthly payment) and Bought (plan): wallet, amount (in the wallet's currency,
 * suggested from the planned amount), date, category.
 */
function openSpend({ title, hint, amount, currency, walletId, categoryId, ok, send, amountLabel = 'Amount' }) {
  const start = walletId ?? moneyWallets()[0]?.id;
  const suggest = (id) => (currencyOfWallet(id) === currency ? amount : convert(amount, currency, currencyOfWallet(id)));
  const form = openForm(`
    ${header(title)}
    <p class="hint">${hint}</p>
    <div class="field">Paid from ${walletCombo('wallet_id', start)}</div>
    <div class="grid">
      <label>${esc(amountLabel)} ${amountField('amount', suggest(start), currencyOfWallet(start))}</label>
      <label>Date ${dateInput('date', today())}</label>
    </div>
    <div class="field">Category ${comboHTML('category_id', categoryItems('expense', categoryId ? [categoryId] : []), categoryId,
      { placeholder: 'Category', creatable: true, noneLabel: '— no category —' })}</div>
    ${footer({ ok })}`);
  bindCombos(form, { onCreate: (text) => createCategory('expense', text) });
  const amountInput = form.querySelector('[name=amount]');
  let typed = false;
  amountInput.addEventListener('input', () => (typed = true));
  form.querySelector('[name=wallet_id]').addEventListener('change', (e) => {
    const id = Number(e.target.value);
    form.querySelector('[data-cur-of=amount]').textContent = symbolOf(currencyOfWallet(id));
    if (!typed) amountInput.value = suggest(id);
  });
  amountInput.focus();
  amountInput.select();
  onSubmit(form, async () => {
    const walletIdNow = Number(form.querySelector('[name=wallet_id]').value);
    if (!walletIdNow) return toast('Pick a wallet', 'error');
    const value = readAmount(amountInput);
    if (value === null) return false;
    const date = readDate(form.querySelector('[name=date]'), 'Date');
    if (date === undefined) return false;
    return send({ wallet_id: walletIdNow, amount: value, date: date ?? today(), category_id: Number(form.querySelector('[name=category_id]').value) || null });
  });
}

export function openPay(item) {
  // A varying payment suggests what it usually costs; type the real bill over it.
  const usual = item.is_variable && item.expected_from;
  openSpend({
    title: `Pay: ${item.name}`,
    hint: item.is_variable
      ? `Usually about <b>${esc(fmtMoney(usual ? item.expected : item.amount, item.currency))}</b>${usual ? ` (average of the last ${item.expected_from})` : ''}.
         Enter this month's bill. Records an expense and marks this month as paid.`
      : `Planned: <b>${esc(fmtMoney(item.amount, item.currency))}</b> on day ${item.day}. Records an expense and marks this month as paid.`,
    amount: usual ? item.expected : item.amount, currency: item.currency,
    amountLabel: item.is_variable ? "This month's bill" : 'Amount',
    walletId: item.wallet_id, categoryId: item.category_id, ok: 'Pay',
    send: (body) => act(() => api.post(`/api/recurring/${item.id}/pay`, body), `Paid: ${item.name}`),
  });
}

// ---------- plans ----------

export const PRIORITY_NAMES = { high: 'High', medium: 'Medium', low: 'Low' };

export function openPlanned(item = null) {
  const currency = item?.currency ?? baseCurrency();
  const locked = item && Number(item.saved) !== 0;
  const form = openForm(`
    ${header(item ? 'Edit plan' : 'New planned expense')}
    <label>What <input name="name" value="${esc(item?.name ?? '')}" placeholder="New laptop, dental treatment…" ${maxlength('name')}></label>
    <div class="grid">
      <label>Expected cost ${amountField('amount', item?.amount ?? '', currency)}</label>
      <label>Currency <select name="currency" ${locked ? 'disabled' : ''}>${currencyOptions(currency)}</select>
        ${locked ? '<span class="field-hint">Fixed: money is saved for it in this currency. Take it back to change.</span>' : ''}</label>
      <label>Priority <select name="priority">${Object.entries(PRIORITY_NAMES).map(([v, n]) => opt(v, n, item?.priority ?? 'medium')).join('')}</select></label>
      <label>By <span class="muted">(optional)</span> ${dateInput('due', item?.due)}</label>
    </div>
    <div class="field">Category ${comboHTML('category_id', categoryItems('expense', item?.category_id ? [item.category_id] : []), item?.category_id,
      { placeholder: 'Category', creatable: true })}</div>
    <label>Notes <textarea name="notes" rows="3" ${maxlength('plan_notes')} placeholder="Options, links, quotes…">${esc(item?.notes ?? '')}</textarea></label>
    ${item && item.status !== 'open' ? `<label class="check"><input type="checkbox" name="reopen"> Open it again (it is ${item.status === 'done' ? 'bought' : 'dropped'})</label>` : ''}
    ${footer({ remove: !!item })}`);
  bindCombos(form, { onCreate: (text) => createCategory('expense', text) });
  form.querySelector('[name=currency]').addEventListener('change', (e) => {
    form.querySelector('[data-cur-of=amount]').textContent = symbolOf(e.target.value);
  });
  if (!item) form.querySelector('[name=name]').focus();
  onSubmit(form, async () => {
    const data = Object.fromEntries(new FormData(form));
    const amount = readAmount(form.querySelector('[name=amount]'));
    if (amount === null) return false;
    const due = readDate(form.querySelector('[name=due]'), 'By');
    if (due === undefined) return false;
    const payload = { name: data.name, amount, priority: data.priority, due, notes: data.notes, category_id: Number(data.category_id) || null };
    if (!locked) payload.currency = data.currency;
    if (data.reopen) payload.status = 'open';
    return item
      ? act(() => api.put(`/api/planned/${item.id}`, payload), 'Saved')
      : act(() => api.post('/api/planned', payload), 'Added');
  });
  onRemove(form, { title: `Delete “${item?.name}”?`, text: 'This can’t be undone.' },
    () => act(() => api.del(`/api/planned/${item.id}`), 'Deleted'));
}

/** Put money aside for a plan, or take it back. */
export async function openSave(item) {
  let mode = 'in';
  const form = openForm(`
    ${header(`Savings: ${item.name}`)}
    <p class="hint">Saved <b>${esc(fmtMoney(item.saved, item.currency))}</b> of ${esc(fmtMoney(item.amount, item.currency))}.
      The money stays in your wallets; this only marks it as put aside for the plan.</p>
    <div class="segmented">
      <button type="button" data-mode="in" class="on">${icon('plus')} Put aside</button>
      <button type="button" data-mode="out">${icon('minus')} Take back</button>
    </div>
    <div class="grid">
      <label>Amount ${amountField('amount', '', item.currency)}</label>
      <label>Date ${dateInput('date', today())}</label>
    </div>
    <label>Note <input name="note" ${maxlength('note')}></label>
    <div class="savings-history"></div>
    ${footer({ ok: 'Save' })}`);
  form.querySelector('[name=amount]').focus();
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    mode = b.dataset.mode;
    form.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
  });
  api.get(`/api/planned/${item.id}/savings`).then(({ savings }) => {
    if (!savings.length) return;
    form.querySelector('.savings-history').innerHTML = `<details><summary>History <span class="muted">(${savings.length})</span></summary>
      <ul class="history">${savings.map((s) => `<li><time>${fmtDate(s.date)}</time> ${esc(fmtMoney(s.amount, item.currency, { sign: true }))}${s.note ? ` · ${esc(s.note)}` : ''}</li>`).join('')}</ul></details>`;
  }).catch(() => {});
  onSubmit(form, async () => {
    const amount = readAmount(form.querySelector('[name=amount]'));
    if (amount === null) return false;
    const date = readDate(form.querySelector('[name=date]'), 'Date');
    if (date === undefined) return false;
    return act(() => api.post(`/api/planned/${item.id}/save`, { amount: mode === 'in' ? amount : negate(amount), date, note: form.querySelector('[name=note]').value }),
      (r) => `Saved for “${item.name}”: ${fmtMoney(r.saved, item.currency)}`);
  });
}

export function openBuy(item) {
  openSpend({
    title: `Bought: ${item.name}`,
    hint: `Planned: <b>${esc(fmtMoney(item.amount, item.currency))}</b>. Records the expense and closes the plan.`,
    amount: item.amount, currency: item.currency, walletId: null, categoryId: item.category_id, ok: 'Record purchase',
    send: (body) => act(() => api.post(`/api/planned/${item.id}/buy`, body), `Bought: ${item.name}`),
  });
}

/** Open the transaction with this id (fetched, since the state doesn't hold transactions). */
export async function openTransactionById(id) {
  try {
    const { transactions } = await api.get('/api/transactions', { id });
    const tx = transactions[0];
    if (tx) openTransaction(tx);
    else toast('Transaction not found', 'error');
  } catch (e) {
    toast(e.message, 'error');
  }
}
