// Shared constants and small helpers: escaping, dates, toasts, colors.
import { icon } from './icons.js';

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

// Categorical palette (dataviz reference palette, light theme): colors are assigned in order.
export const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const OTHER_COLOR = '#9a9893';
// The same eight hues stepped for the dark surface (dataviz reference palette).
const DARK_STEPS = {
  '#2a78d6': '#3987e5', '#eb6834': '#d95926', '#1baf7a': '#199e70', '#eda100': '#c98500',
  '#e87ba4': '#d55181', '#008300': '#008300', '#6250d6': '#9085e9', '#e34948': '#e66767',
};
/** A data color for the current theme. Colors are stored in their light-theme form. */
export const paint = (hex) => (document.documentElement.dataset.theme === 'dark' && DARK_STEPS[hex?.toLowerCase()]) || hex;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export const today = () => isoDate(new Date());

export function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso, n) {
  const d = parseDate(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

/** "2026-11" + n months. */
export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return isoDate(d).slice(0, 7);
}

/** First and last day of a month "2026-11". */
export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return [`${month}-01`, isoDate(new Date(y, m, 0))];
}

/** "2026-11" -> "November 2026". */
export const fmtMonth = (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** ISO "2026-10-30" -> "30.10.2026". Data is stored as ISO; the UI always shows DD.MM.YYYY. */
export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** "Fri, 7 November" (and the year when it isn't this year): the day headers of the transaction list. */
export function fmtDay(iso) {
  const d = parseDate(iso);
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'short' });
  const year = iso.slice(0, 4) === today().slice(0, 4) ? '' : ` ${iso.slice(0, 4)}`;
  return `${weekday}, ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

/** "DD.MM.YYYY" (also D.M.YYYY, with "/" or "-") -> ISO. Empty -> null, invalid -> undefined. */
export function parseUserDate(text) {
  const s = text.trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!m) return undefined;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return undefined;
  return isoDate(date);
}

/**
 * Date field: a DD.MM.YYYY text input plus a calendar button that opens the browser's date picker.
 * The native <input type="date"> shows the OS locale format, so it stays hidden and only serves as the picker.
 */
export function dateInput(name, iso, attrs = '') {
  return `<span class="date-field">
    <input ${name ? `name="${name}"` : ''} value="${fmtDate(iso)}" placeholder="DD.MM.YYYY" autocomplete="off" inputmode="numeric" ${attrs}>
    <input type="date" class="date-picker" tabindex="-1" aria-hidden="true" value="${iso || ''}">
    <button type="button" class="icon date-btn" title="Pick a date">${icon('calendar')}</button>
  </span>`;
}

/** Wires up every dateInput() inside root (event delegation, so re-rendered fields work too). */
export function bindDateInputs(root) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('.date-btn');
    if (!btn) return;
    e.preventDefault();
    const field = btn.closest('.date-field');
    const picker = field.querySelector('.date-picker');
    picker.value = parseUserDate(field.querySelector('input:not(.date-picker)').value) || '';
    try { picker.showPicker(); } catch { picker.click(); }
  });
  root.addEventListener('change', (e) => {
    if (!e.target.classList.contains('date-picker')) return;
    const text = e.target.closest('.date-field').querySelector('input:not(.date-picker)');
    text.value = fmtDate(e.target.value);
    text.classList.remove('invalid');
  });
}

/** Reads a dateInput; marks it red and returns undefined if the text isn't a valid date. */
export function readDate(input, label) {
  const iso = parseUserDate(input.value);
  if (iso === undefined) {
    input.classList.add('invalid');
    input.focus();
    toast(`${label}: use DD.MM.YYYY`, 'error');
  }
  return iso;
}

export function fmtTs(ts) {
  const [d, t] = ts.split('T');
  return `${fmtDate(d)} ${t.slice(0, 5)}`;
}

export const opt = (value, label, selected) =>
  `<option value="${esc(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${esc(label)}</option>`;

export const empty = (html) => `<div class="empty">${html}</div>`;

export function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.className = ''), kind === 'error' ? 5000 : 3000);
}

/** A fresh container inside the view: when a view re-renders itself, old event listeners go away with it. */
export function freshBox(view) {
  const box = document.createElement('div');
  box.className = 'box';
  view.replaceChildren(box);
  return box;
}

/** Runs an API call; shows its error as a toast. Resolves to the result, or undefined on error. */
export async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'error');
    return undefined;
  }
}
