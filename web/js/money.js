// Money on the page: formatting, exact sums and conversion to the base currency.
// The server sends amounts as strings in ordinary units ("12.30"). Sums the page must get exactly right
// (the total of a split receipt, a transfer) use BigInt minor units; charts and sorting use plain numbers.

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£', RUB: '₽', UAH: '₴', KZT: '₸', TRY: '₺', JPY: '¥', CNY: '¥', INR: '₹' };
const PREFIX = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR']); // written before the number: $12.00

let byCode = new Map();
let base = 'USD';

/** Called by the store after each load. */
export function setCurrencies(list, baseCode) {
  byCode = new Map(list.map((c) => [c.code, c]));
  base = baseCode;
}
export const baseCurrency = () => base;
export const currencyOf = (code) => byCode.get(code);
export const decimalsOf = (code) => byCode.get(code)?.decimals ?? 2;
export const symbolOf = (code) => SYMBOLS[code] ?? code;

const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * "-1234.5" -> "−1,234.50". Fiat shows all its decimals; crypto drops trailing zeros (keeping two).
 * sign: show "+" before positive amounts. Works on the string, so no digits are lost.
 */
export function fmtAmount(value, code, { sign = false } = {}) {
  let s = String(value ?? '0').trim();
  const negative = s.startsWith('-');
  if (negative || s.startsWith('+')) s = s.slice(1);
  let [int, frac = ''] = s.split('.');
  const decimals = decimalsOf(code);
  if (byCode.get(code)?.kind === 'crypto') {
    frac = frac.replace(/0+$/, '');
    if (frac.length < 2 && decimals >= 2) frac = frac.padEnd(2, '0');
  } else {
    frac = frac.padEnd(decimals, '0').slice(0, Math.max(decimals, frac.replace(/0+$/, '').length));
  }
  int = group(int.replace(/^0+(?=\d)/, '') || '0');
  const zero = !/[1-9]/.test(s);
  const mark = zero ? '' : negative ? '−' : sign ? '+' : '';
  return `${mark}${frac ? `${int}.${frac}` : int}`;
}

/** "−$1,234.50", "80,000.00 ₽", "0.0105 BTC". */
export function fmtMoney(value, code, opts) {
  const text = fmtAmount(value, code, opts);
  const symbol = SYMBOLS[code];
  if (symbol && PREFIX.has(code)) {
    const [, mark, digits] = text.match(/^([−+]?)(.*)$/);
    return `${mark}${symbol}${digits}`;
  }
  return `${text} ${symbol ?? code}`;
}

/** In the base currency. */
export const fmtBase = (value, opts) => fmtMoney(value, base, opts);
/** A plain number (a sum the page made) in the base currency, rounded to its decimals. */
export const fmtBaseNum = (n, opts) => fmtBase(n.toFixed(decimalsOf(base)), opts);

/** Short, for chart axes and tight spots: 950, 12.9K, 4.2M. */
export function compact(n) {
  const abs = Math.abs(n);
  const cut = (v, s) => `${(Math.round(v * 10) / 10).toString()}${s}`;
  if (abs >= 1e9) return cut(n / 1e9, 'B');
  if (abs >= 1e6) return cut(n / 1e6, 'M');
  if (abs >= 1e4) return cut(n / 1e3, 'K');
  return Math.round(n).toLocaleString('en-US');
}
export const fmtBaseCompact = (n) => {
  const symbol = SYMBOLS[base];
  return symbol && PREFIX.has(base) ? `${n < 0 ? '−' : ''}${symbol}${compact(Math.abs(n))}` : `${compact(n)} ${symbol ?? base}`;
};

export const toNum = (value) => Number(value) || 0;

/** Approximate value in the base currency, for charts, sorting and hints. 0 when the rate isn't set. */
export function toBaseNum(value, code) {
  if (code === base) return toNum(value);
  return toNum(value) * toNum(byCode.get(code)?.rate);
}

/** A rough conversion between two currencies through the base, rounded to the target's decimals. */
export function convert(value, from, to) {
  if (from === to) return String(value);
  const rateTo = toNum(byCode.get(to)?.rate) || (to === base ? 1 : 0);
  if (!rateTo) return '';
  const result = toBaseNum(value, from) / rateTo;
  return result ? result.toFixed(decimalsOf(to)) : '';
}

// ---------- exact amounts ----------

/** What a person typed -> a clean number string, or null. Accepts "1 234,50", "−5", "+3". */
export function cleanAmount(text) {
  const s = String(text ?? '').replace(/[\s  ']/g, '').replace(',', '.').replace('−', '-');
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(s) ? s.replace(/^\+/, '') : null;
}

/** "12.3" with 2 decimals -> 1230n. null when it has too many decimals or isn't a number. */
export function toMinor(text, decimals) {
  const s = cleanAmount(text);
  if (s === null) return null;
  const negative = s.startsWith('-');
  const [int, frac = ''] = s.replace('-', '').split('.');
  if (frac.replace(/0+$/, '').length > decimals) return null;
  const value = BigInt((int || '0') + frac.padEnd(decimals, '0').slice(0, decimals));
  return negative ? -value : value;
}

/** 1230n with 2 decimals -> "12.30". */
export function fromMinor(value, decimals) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const text = decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
  return negative ? `-${text}` : text;
}

/** Flip the sign of an amount string. */
export const negate = (s) => (String(s).startsWith('-') ? String(s).slice(1) : `-${s}`);
