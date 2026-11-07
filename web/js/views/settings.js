// Settings tab: base currency, currencies and their rates, categories, templates, theme, export.
import * as api from '../api.js';
import { store, act, categoryList, categoryById, maxlength } from '../store.js';
import { setupColorPicker, templateSummary, TX_TYPE_NAMES } from '../editor.js';
import { ask, confirmDialog, promptDialog } from '../dialogs.js';
import { cleanAmount, baseCurrency } from '../money.js';
import { THEMES, setTheme } from '../theme.js';
import { getPref } from '../prefs.js';
import { esc, freshBox, opt, fmtTs, paint, toast } from '../util.js';
import { icon } from '../icons.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function templateRows() {
  return store.state.templates.map((t) => `<li data-template="${t.id}">
    <span class="name">${icon('bookmark', 14, 'muted')}${esc(t.name)}</span>
    <span class="muted">${esc(TX_TYPE_NAMES[t.type])} · ${esc(templateSummary(t))}</span>
    <span class="spacer"></span>
    <button type="button" class="icon" data-act="rename-template" title="Rename" aria-label="Rename ${esc(t.name)}">${icon('pencil')}</button>
    <button type="button" class="icon" data-act="delete-template" title="Delete" aria-label="Delete ${esc(t.name)}">${icon('trash')}</button>
  </li>`).join('');
}

function currencyRows() {
  const base = baseCurrency();
  return store.state.currencies.map((c) => `<tr data-code="${esc(c.code)}">
    <td><b>${esc(c.code)}</b></td>
    <td><input class="cell-input" name="name" value="${esc(c.name)}" ${maxlength('currency_name')} aria-label="Name of ${esc(c.code)}"></td>
    <td class="muted">${c.kind}</td>
    <td class="muted num" title="Digits after the point">${c.decimals}</td>
    <td>${c.code === base ? '<span class="muted">base currency</span>'
      : `<span class="rate-field">1 ${esc(c.code)} = <input class="cell-input amount ${Number(c.rate) ? '' : 'invalid-soft'}" name="rate" inputmode="decimal"
          value="${Number(c.rate) ? esc(c.rate) : ''}" placeholder="not set" aria-label="Rate of ${esc(c.code)} in ${esc(base)}"> ${esc(base)}</span>`}</td>
    <td class="muted small">${c.rate_updated && c.code !== base ? esc(fmtTs(c.rate_updated)) : ''}</td>
    <td>${c.code === base || c.used ? '' : `<button type="button" class="icon" data-act="remove-currency" title="Remove ${esc(c.code)}" aria-label="Remove ${esc(c.code)}">${icon('trash')}</button>`}</td>
  </tr>`).join('');
}

function categoryRows(kind) {
  const list = categoryList(kind, { withInactive: true });
  return list.map((c) => {
    const isSub = c.parent_id != null;
    const subs = isSub ? [] : list.filter((x) => x.parent_id === c.id);
    const count = c.count + subs.reduce((s, x) => s + x.count, 0);
    const hiddenByParent = isSub && !categoryById(c.parent_id)?.is_active;
    return `<li class="${isSub ? 'sub' : 'root'}${c.is_active && !hiddenByParent ? '' : ' inactive'}" data-category="${c.id}">
      <span class="name">${isSub ? icon('cornerDownRight', 14, 'muted') : `<i class="dot" style="--c:${paint(c.color)}"></i>`}${esc(c.name)}</span>
      <span class="muted">${count ? plural(count, 'line') : ''}</span>
      <span class="spacer"></span>
      ${isSub ? '' : `<span class="color-cell"><input class="color-input" value="${esc(c.color)}" data-act="color" title="Color: click to pick"
        aria-label="Color of ${esc(c.name)}" spellcheck="false" autocomplete="off"></span>`}
      <label class="check" title="Hidden categories don't show up when you pick one; reports still count them">
        <input type="checkbox" data-act="active" ${c.is_active ? 'checked' : ''}> shown</label>
      <details class="view-menu row-menu">
        <summary title="More" aria-label="More actions for ${esc(c.name)}">${icon('more')}</summary>
        <div class="menu">
          <button type="button" class="ghost" data-act="rename">${icon('pencil', 14)} Rename</button>
          ${subs.length ? '' : `<button type="button" class="ghost" data-act="move">${icon('cornerDownRight', 14)} Move…</button>`}
          <button type="button" class="ghost" data-act="merge">${icon('merge', 14)} Merge into…</button>
          <button type="button" class="ghost danger" data-act="delete">${icon('trash', 14)} Delete</button>
        </div>
      </details>
    </li>`;
  }).join('');
}

const categoryCard = (kind, title, hint) => `<section class="settings-card">
  <h2>${title}</h2>
  <p class="hint">${hint}</p>
  <form class="add-row" data-kind="${kind}">
    <input name="path" placeholder="${kind === 'expense' ? 'Food or Food:Fruits' : 'Salary or Freelance:Upwork'}" ${maxlength('category_name')}>
    <button type="submit">${icon('plus')} Add</button>
  </form>
  <ul class="manage-list" data-kind="${kind}">${categoryRows(kind)}</ul>
</section>`;

export function render(view) {
  const root = freshBox(view);
  const s = store.state;
  const base = baseCurrency();
  const theme = THEMES[getPref('theme')] ? getPref('theme') : 'system';

  root.innerHTML = `
    <div class="settings">
      <section class="settings-card">
        <h2>Currencies</h2>
        <p class="hint">Totals are counted in the <b>base currency</b>. Rates are yours to keep up to date: one unit of a currency costs this much of ${esc(base)}.
          A wallet's currency is set when you create it.</p>
        <div class="base-row">
          <label>Base currency <select name="base">${s.currencies.map((c) => opt(c.code, `${c.code} — ${c.name}`, base)).join('')}</select></label>
        </div>
        <div class="table-wrap"><table class="data currencies">
          <thead><tr><th>Code</th><th>Name</th><th>Kind</th><th class="num">Dec.</th><th>Rate</th><th>Updated</th><th></th></tr></thead>
          <tbody>${currencyRows()}</tbody>
        </table></div>
        <details class="add-currency">
          <summary>${icon('plus', 14)} Add a currency</summary>
          <form class="add-row wrap">
            <input name="code" placeholder="Code: GBP, SOL…" maxlength="10" required>
            <input name="name" placeholder="Name" ${maxlength('currency_name')}>
            <select name="kind" aria-label="Kind">${opt('fiat', 'Fiat', 'fiat')}${opt('crypto', 'Crypto', 'fiat')}</select>
            <input name="decimals" type="number" min="0" max="8" placeholder="Decimals" title="Digits after the point: 2 for most money, 8 for most crypto" aria-label="Decimals">
            <input name="rate" inputmode="decimal" placeholder="Rate in ${esc(base)}" aria-label="Rate">
            <button type="submit">Add</button>
          </form>
        </details>
      </section>

      <div class="cards-2">
        ${categoryCard('expense', 'Spending categories', 'Two levels: <b>Category</b> or <b>Category:Subcategory</b>. Reports add subcategories into their category.')}
        ${categoryCard('income', 'Income sources', 'Where money comes from: salary, freelance, gifts. Subcategories work the same way.')}
      </div>

      <section class="settings-card">
        <h2>Transaction templates</h2>
        <p class="hint">Made with “Save as template” in a transaction's dialog; they show at the top of New transaction.</p>
        ${store.state.templates.length ? `<ul class="manage-list templates">${templateRows()}</ul>` : '<p class="muted small">No templates yet.</p>'}
      </section>

      <section class="settings-card">
        <h2>Appearance</h2>
        <div class="segmented">${Object.entries(THEMES).map(([value, label]) => `<button type="button" data-theme-choice="${value}" class="${theme === value ? 'on' : ''}">${label}</button>`).join('')}</div>
      </section>

      <section class="settings-card">
        <h2>Data</h2>
        <p class="hint">Everything lives in <code>data/finance.db</code> (SQLite). Before the first change of each day a copy goes to
          <code>${esc(store.lastBackup?.dir ?? 'data/backups')}</code>; the archive button at the top makes one right away.</p>
        <div class="row-actions">
          <a class="button-link" href="/api/export.csv" download>${icon('download', 14)} Transactions as CSV</a>
          <a class="button-link" href="/api/export.json" download>${icon('download', 14)} Everything as JSON</a>
        </div>
      </section>
    </div>`;
  setupColorPicker();

  // ----- currencies -----
  root.querySelector('[name=base]').addEventListener('change', async (e) => {
    const code = e.target.value;
    const rate = Number(s.currencies.find((c) => c.code === code)?.rate);
    const othersSet = s.currencies.some((c) => c.code !== base && c.code !== code && Number(c.rate));
    // Without a rate for the new base, the others can only be recounted if you give one now.
    const needRate = !rate && (othersSet || Number(s.config.cushion_target));
    const pending = ask({
      title: `Count everything in ${code}?`,
      text: needRate
        ? `The other rates are recounted through ${code}, so enter what 1 ${code} costs in ${base}. Balances don't change.`
        : rate ? `All rates are recounted through the rate of ${code} (1 ${code} = ${s.currencies.find((c) => c.code === code).rate} ${base}), and the cushion target is converted. Balances don't change.`
          : `No other rates are set yet, so nothing is recounted. Set the rates in ${code} after switching.`,
      body: needRate ? `<span class="rate-field dialog-rate">1 ${esc(code)} = <input class="dialog-input" id="base-rate" inputmode="decimal" placeholder="0.00"> ${esc(base)}</span>` : '',
      buttons: [{ spacer: true }, { value: 'cancel', label: 'Cancel' }, { value: 'ok', label: `Switch to ${code}`, kind: 'primary', focus: !needRate }],
    });
    const rateInput = document.getElementById('base-rate');
    rateInput?.focus();
    rateInput?.addEventListener('keydown', (k) => {
      if (k.key !== 'Enter') return;
      k.preventDefault();
      document.querySelector('#confirm-dialog button[value=ok]').click();
    });
    const answer = await pending;
    const body = { base_currency: code };
    if (answer === 'ok' && needRate) {
      body.base_rate = cleanAmount(document.getElementById('base-rate').value);
      if (!body.base_rate || Number(body.base_rate) <= 0) {
        toast(`Enter the rate of ${code} to switch`, 'error');
        e.target.value = base;
        return;
      }
    }
    if (answer !== 'ok' || !(await act(() => api.put('/api/config', body), `Totals are now in ${code}`))) e.target.value = base;
  });
  const saveCell = async (input) => {
    const code = input.closest('[data-code]').dataset.code;
    const currency = s.currencies.find((c) => c.code === code);
    if (input.name === 'rate') {
      const value = input.value.trim() ? cleanAmount(input.value) : '0';
      if (value === null || value.startsWith('-')) {
        input.classList.add('invalid');
        return;
      }
      if (Number(value) === Number(currency.rate)) return;
      await act(() => api.put(`/api/currencies/${code}`, { rate: value }), `1 ${code} = ${value} ${base}`);
    } else if (input.value.trim() !== currency.name) {
      await act(() => api.put(`/api/currencies/${code}`, { name: input.value }), 'Saved');
    }
  };
  root.querySelectorAll('.currencies .cell-input').forEach((input) => {
    input.addEventListener('change', () => saveCell(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
    });
  });
  root.querySelector('.add-currency form').addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    const payload = { code: data.code, name: data.name, kind: data.kind };
    if (data.decimals !== '') payload.decimals = Number(data.decimals);
    if (data.rate.trim()) payload.rate = cleanAmount(data.rate) ?? data.rate;
    act(() => api.post('/api/currencies', payload), (r) => `Added ${r.code}`);
  });

  // ----- categories -----
  root.querySelectorAll('form.add-row[data-kind]').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const path = form.path.value.trim();
    if (!path) return;
    const result = await act(() => api.post('/api/categories', { kind: form.dataset.kind, path }), (r) => (r.existed ? `“${path}” already exists` : `Added ${path}`));
    if (result) root.querySelector(`form.add-row[data-kind=${form.dataset.kind}] [name=path]`)?.focus();
  }));

  root.addEventListener('change', async (e) => {
    const li = e.target.closest('[data-category]');
    if (!li) return;
    const id = Number(li.dataset.category);
    if (e.target.dataset.act === 'active') await act(() => api.put(`/api/categories/${id}`, { is_active: e.target.checked }));
    if (e.target.dataset.act === 'color') await act(() => api.put(`/api/categories/${id}`, { color: e.target.value }));
  });

  root.addEventListener('click', async (e) => {
    // Not "[data-theme]": <html> carries data-theme, so every click would match it.
    const themeBtn = e.target.closest('[data-theme-choice]');
    if (themeBtn) return setTheme(themeBtn.dataset.themeChoice);
    const btn = e.target.closest('button[data-act]');
    if (btn?.dataset.act === 'remove-currency') {
      const code = btn.closest('[data-code]').dataset.code;
      return act(() => api.del(`/api/currencies/${code}`), `Removed ${code}`);
    }
    const tli = btn?.closest('[data-template]');
    if (tli) {
      const t = s.templates.find((x) => x.id === Number(tli.dataset.template));
      if (btn.dataset.act === 'rename-template') {
        const name = await promptDialog({ title: 'Rename template', value: t.name, ok: 'Rename', attrs: maxlength('name') });
        if (name && name !== t.name) await act(() => api.put(`/api/templates/${t.id}`, { name }), 'Renamed');
      } else if (btn.dataset.act === 'delete-template'
        && await confirmDialog({ title: `Delete the template “${t.name}”?`, text: 'Transactions made with it stay.', danger: true, ok: 'Delete' })) {
        await act(() => api.del(`/api/templates/${t.id}`), 'Deleted');
      }
      return undefined;
    }
    const li = btn?.closest('[data-category]');
    if (!li) return undefined;
    btn.closest('details')?.removeAttribute('open');
    const c = categoryById(li.dataset.category);
    const others = categoryList(c.kind, { withInactive: true }).filter((x) => x.id !== c.id && x.parent_id !== c.id);
    switch (btn.dataset.act) {
      case 'rename': {
        const name = await promptDialog({ title: 'Rename category', value: c.name, ok: 'Rename', attrs: maxlength('category_name') });
        if (name && name !== c.name) await act(() => api.put(`/api/categories/${c.id}`, { name }), 'Renamed');
        return undefined;
      }
      case 'move': {
        const parents = others.filter((x) => x.parent_id == null);
        const answer = await ask({
          title: `Move “${c.path}”`,
          text: 'Put it inside another category, or make it a category of its own. Its transactions come along.',
          body: `<select class="dialog-input" id="move-to">${opt('', '— a category of its own —', c.parent_id ?? '')}${parents.map((p) => opt(p.id, p.name, c.parent_id)).join('')}</select>`,
          buttons: [{ spacer: true }, { value: 'cancel', label: 'Cancel' }, { value: 'ok', label: 'Move', kind: 'primary' }],
        });
        const to = document.getElementById('move-to').value;
        if (answer === 'ok') await act(() => api.put(`/api/categories/${c.id}`, { parent_id: to ? Number(to) : null }), 'Moved');
        return undefined;
      }
      case 'merge': {
        const hasSubs = categoryList(c.kind, { withInactive: true }).some((x) => x.parent_id === c.id);
        const targets = hasSubs ? others.filter((x) => x.parent_id == null) : others;
        if (!targets.length) return undefined;
        const answer = await ask({
          title: `Merge “${c.path}” into…`,
          text: `All its transactions${hasSubs ? ' and subcategories' : ''} move to the category you pick, then “${c.name}” is deleted. This can’t be undone.`,
          body: `<select class="dialog-input" id="merge-into">${targets.map((x) => opt(x.id, x.path, '')).join('')}</select>`,
          buttons: [{ spacer: true }, { value: 'cancel', label: 'Cancel' }, { value: 'ok', label: 'Merge', kind: 'destructive' }],
        });
        const into = Number(document.getElementById('merge-into').value);
        if (answer === 'ok') await act(() => api.post(`/api/categories/${c.id}/merge`, { into }), `Merged into ${categoryById(into)?.path ?? ''}`);
        return undefined;
      }
      case 'delete': {
        const ok = await confirmDialog({
          title: `Delete “${c.path}”?`,
          text: `${c.parent_id == null ? 'Its subcategories go too. ' : ''}Transactions keep it (shown struck through) and still count in reports. To move them elsewhere, use Merge instead.`,
          ok: 'Delete', danger: true,
        });
        if (ok) await act(() => api.del(`/api/categories/${c.id}`), 'Deleted');
        return undefined;
      }
      default: return undefined;
    }
  });
}
