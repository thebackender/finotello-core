// Period picker: a button showing the period ("1 Sep – 15 Oct 2026") that opens two months of calendar.
// Click a start day, then an end day (a hover shows the range); or type the dates in the fields below.
import { esc, isoDate, parseUserDate, fmtDate, addMonths, monthRange, today, MONTHS, MONTHS_SHORT } from './util.js';
import { icon } from './icons.js';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/** "November 2026", "7 Nov 2026", "1 Sep – 15 Oct 2026", "15 Dec 2025 – 10 Jan 2026". */
export function fmtPeriod(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (from === to) return `${fd} ${MONTHS_SHORT[fm - 1]} ${fy}`;
  if (fy === ty && fm === tm && fd === 1 && to === monthRange(to.slice(0, 7))[1]) return `${MONTHS[fm - 1]} ${fy}`;
  const start = `${fd} ${MONTHS_SHORT[fm - 1]}${fy === ty ? '' : ` ${fy}`}`;
  return `${start} – ${td} ${MONTHS_SHORT[tm - 1]} ${ty}`;
}

function monthHTML(month) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const blanks = (first.getDay() + 6) % 7; // weeks start on Monday
  const days = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < blanks; i++) cells.push('<span></span>');
  for (let d = 1; d <= days; d++) {
    const iso = isoDate(new Date(y, m - 1, d));
    cells.push(`<button type="button" class="rp-day" data-day="${iso}" tabindex="-1" aria-label="${d} ${MONTHS[m - 1]} ${y}">${d}</button>`);
  }
  return `<div class="rp-month">
    <div class="rp-title">${MONTHS[m - 1]} ${y}</div>
    <div class="rp-grid">${WEEKDAYS.map((w) => `<span class="rp-wd">${w}</span>`).join('')}${cells.join('')}</div>
  </div>`;
}

/**
 * Put a period picker into host. from / to: ISO dates of the period shown.
 * onApply(from, to) gets the picked period; onReset() goes back to the default (the current month).
 */
export function rangePicker(host, { from, to, onApply, onReset }) {
  host.innerHTML = `<div class="range-picker">
    <button type="button" class="range-btn" title="Period of the spending and income below" aria-haspopup="dialog" aria-expanded="false">
      ${icon('calendar', 16, 'muted')}<span>${esc(fmtPeriod(from, to))}</span>${icon('chevronDown', 14, 'muted')}
    </button>
    <div class="range-pop" role="dialog" aria-label="Pick a period" hidden>
      <div class="rp-nav">
        <button type="button" class="icon" data-nav="-1" title="Earlier" aria-label="Earlier months">${icon('chevronLeft')}</button>
        <button type="button" class="icon" data-nav="1" title="Later" aria-label="Later months">${icon('chevronRight')}</button>
      </div>
      <div class="rp-months"></div>
      <div class="rp-foot">
        <input name="rp-from" placeholder="DD.MM.YYYY" autocomplete="off" inputmode="numeric" aria-label="From">
        <span class="muted">–</span>
        <input name="rp-to" placeholder="DD.MM.YYYY" autocomplete="off" inputmode="numeric" aria-label="To">
        <span class="spacer"></span>
        <button type="button" data-reset title="Back to the current month">This month</button>
        <button type="button" class="primary" data-apply>Apply</button>
      </div>
    </div>
  </div>`;
  const wrap = host.querySelector('.range-picker');
  const btn = wrap.querySelector('.range-btn');
  const pop = wrap.querySelector('.range-pop');
  const months = wrap.querySelector('.rp-months');
  const fromInput = wrap.querySelector('[name=rp-from]');
  const toInput = wrap.querySelector('[name=rp-to]');

  // a..b is the picked range; while picking (only the start clicked) b is null and the hover shows the end.
  let a = from;
  let b = to;
  let hover = null;
  let view = from.slice(0, 7); // the left month

  function paint() {
    const end = b ?? hover ?? a;
    const [lo, hi] = a <= end ? [a, end] : [end, a];
    const now = today();
    for (const day of months.querySelectorAll('.rp-day')) {
      const d = day.dataset.day;
      day.classList.toggle('in', d > lo && d < hi);
      day.classList.toggle('edge', d === lo || d === hi);
      day.classList.toggle('lo', d === lo && lo !== hi);
      day.classList.toggle('hi', d === hi && lo !== hi);
      day.classList.toggle('today', d === now);
      day.setAttribute('aria-pressed', String(d === lo || d === hi));
    }
    fromInput.value = fmtDate(lo);
    toInput.value = b == null && hover == null ? '' : fmtDate(hi);
    fromInput.classList.remove('invalid');
    toInput.classList.remove('invalid');
  }

  function draw() {
    months.innerHTML = monthHTML(view) + monthHTML(addMonths(view, 1));
    paint();
  }

  const onOutside = (e) => {
    if (!wrap.isConnected) return document.removeEventListener('pointerdown', onOutside, true);
    if (!wrap.contains(e.target)) close();
  };

  function open() {
    a = from;
    b = to;
    hover = null;
    view = from.slice(0, 7);
    draw();
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
  }

  function close() {
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
  }

  function apply() {
    // Typed dates win over clicks: read the fields first.
    const f = parseUserDate(fromInput.value);
    const t = parseUserDate(toInput.value);
    if (!f) return fromInput.classList.add('invalid'), fromInput.focus();
    if (t === undefined) return toInput.classList.add('invalid'), toInput.focus();
    const end = t ?? f; // no end: just that day
    close();
    if (f !== from || end !== to) onApply(f <= end ? f : end, f <= end ? end : f);
  }

  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  wrap.addEventListener('click', (e) => {
    const day = e.target.closest('.rp-day');
    if (day) {
      if (b == null) {
        b = day.dataset.day;
        if (b < a) [a, b] = [b, a];
      } else {
        a = day.dataset.day;
        b = null;
      }
      hover = null;
      return paint();
    }
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      view = addMonths(view, Number(nav.dataset.nav));
      return draw();
    }
    if (e.target.closest('[data-apply]')) return apply();
    if (e.target.closest('[data-reset]')) {
      close();
      onReset();
    }
  });
  months.addEventListener('pointerover', (e) => {
    const day = e.target.closest('.rp-day');
    if (b == null && day && day.dataset.day !== hover) {
      hover = day.dataset.day;
      paint();
    }
  });
  // A typed date moves the selection and the calendar to it.
  for (const input of [fromInput, toInput]) {
    input.addEventListener('change', () => {
      const iso = parseUserDate(input.value);
      if (!iso) return input.classList.toggle('invalid', iso === undefined);
      if (input === fromInput) a = iso;
      else b = iso;
      if (b != null && b < a) [a, b] = [b, a];
      hover = null;
      const shown = [view, addMonths(view, 1)];
      if (!shown.includes(iso.slice(0, 7))) view = iso.slice(0, 7);
      draw();
    });
  }
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault(); // app.js leaves an Escape that was handled alone
      close();
      btn.focus();
    } else if (e.key === 'Enter' && e.target.matches('input')) {
      e.preventDefault();
      e.target.dispatchEvent(new Event('change'));
      apply();
    }
  });
  return { close };
}
