// App state: what /api/state returns, lookup helpers, and every change through the API.
import * as api from './api.js';
import { setCurrencies, fmtBase } from './money.js';
import { toast } from './util.js';

/** The last /api/state; views read it directly (store.state.wallets, …). */
export const store = { state: null, canUndo: false, lastBackup: null };

const listeners = new Set();
export const subscribe = (fn) => listeners.add(fn);

let wallets = new Map();
let categories = new Map();

export async function reload() {
  const state = await api.getState();
  store.state = state;
  store.canUndo = state.can_undo;
  store.lastBackup = state.last_backup ?? null; // {time, file, dir}; no time when there is no backup yet
  setCurrencies(state.currencies, state.config.base_currency);
  wallets = new Map(state.wallets.map((w) => [w.id, w]));
  categories = new Map(state.categories.map((c) => [c.id, c]));
  listeners.forEach((fn) => fn());
}

/**
 * Run a change: call the API, reload, show okMessage. Errors show as a toast.
 * Resolves to the API's answer, or undefined when it failed.
 */
export async function act(call, okMessage) {
  let result;
  try {
    result = await call();
  } catch (e) {
    toast(e.message, 'error');
    return undefined;
  }
  await reload().catch((e) => toast(e.message, 'error'));
  const message = typeof okMessage === 'function' ? okMessage(result) : okMessage;
  if (message) toast(message);
  return result;
}

export async function undo() {
  if (!store.canUndo) return;
  await act(() => api.post('/api/undo'), (r) => `Undone: ${r.undone}`);
}

export async function backupNow() {
  try {
    const result = await api.post('/api/backup');
    store.lastBackup = result.last_backup;
    toast(`Backup saved: ${result.file}`);
    listeners.forEach((fn) => fn());
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- queries ----------

/** maxlength="…" for a text field, from the server's limits (see LIMITS in db.py). */
export const maxlength = (key) => (store.state?.limits[key] ? `maxlength="${store.state.limits[key]}"` : '');

export const walletById = (id) => wallets.get(Number(id));
export const categoryById = (id) => categories.get(Number(id));

export const WALLET_TYPE_NAMES = { bank: 'Bank', cash: 'Cash', crypto: 'Crypto', debt: 'Person' };
export const TX_TYPE_NAMES = { expense: 'Expense', income: 'Income', transfer: 'Transfer', debt: 'Debt', adjustment: 'Balance adjustment' };

/** Your own wallets (not debts); archived ones only when asked. */
export const moneyWallets = (withArchived = false) =>
  store.state.wallets.filter((w) => w.type !== 'debt' && (withArchived || !w.is_archived));
/** People you lend to or borrow from. */
export const people = (withArchived = false) =>
  store.state.wallets.filter((w) => w.type === 'debt' && (withArchived || !w.is_archived));

/** Categories of a kind, each top-level one followed by its subcategories (by name). */
export function categoryList(kind, { withInactive = false, withDeleted = false } = {}) {
  const ok = (c) => c.kind === kind && (withDeleted || !c.is_deleted) && (withInactive || c.is_active);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const all = store.state.categories;
  const roots = all.filter((c) => c.parent_id == null && ok(c)).sort(byName);
  return roots.flatMap((r) => [r, ...all.filter((c) => c.parent_id === r.id && ok(c)).sort(byName)]);
}

/** Items for a category combo; keep: an id to include even if it is hidden or deleted (it's already on the item). */
export function categoryItems(kind, keep = []) {
  const list = categoryList(kind);
  for (const id of keep) {
    const c = categoryById(id);
    if (c && !list.includes(c)) list.push(c);
  }
  return list.map((c) => ({ value: c.id, label: c.path, dot: c.color, hint: c.is_deleted ? 'deleted' : !c.is_active ? 'hidden' : '' }));
}

/** For a creatable category combo: make "Food:Snacks" and answer with its combo item. */
export async function createCategory(kind, path) {
  const result = await act(() => api.post('/api/categories', { kind, path }), (r) => (r.existed ? '' : `Category “${path}” added`));
  if (!result) return null;
  const c = categoryById(result.id);
  return c ? { value: c.id, label: c.path, dot: c.color } : null;
}

/** Items for a wallet combo: your wallets, then (optionally) people. */
export function walletItems({ withPeople = false, keep = [] } = {}) {
  const list = [...moneyWallets(), ...(withPeople ? people() : [])];
  for (const id of keep) {
    const w = walletById(id);
    if (w && !list.includes(w)) list.push(w);
  }
  return list.map((w) => ({ value: w.id, label: w.name, dot: w.color, hint: w.type === 'debt' ? `person · ${w.currency}` : w.currency }));
}

/** The base-currency hint after an amount: "≈ $12.30", or '' when it's already in the base currency. */
export function baseHint(value, currency, valueBase) {
  if (currency === store.state.config.base_currency) return '';
  return `≈ ${fmtBase(valueBase)}`;
}
