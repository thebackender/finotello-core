// Pieces shared by several tabs.
import { store, categoryById } from '../store.js';
import { meter } from '../chart.js';
import { fmtBase, fmtBaseNum, toNum } from '../money.js';
import { esc, paint, PALETTE } from '../util.js';
import { icon } from '../icons.js';

/**
 * One category budget this month: name, spent of the limit, a bar, and what is left (or over).
 * The bar turns amber from 90% and red past the limit; the words say so too.
 */
export function budgetRow(b, { edit = false } = {}) {
  const c = categoryById(b.category_id);
  const left = toNum(b.left);
  const state = b.share > 1 ? 'over' : b.share >= 0.9 ? 'warn' : '';
  return `<li class="budget-row" data-budget="${b.category_id}">
    <div class="budget-top">
      <span class="budget-name"><i class="dot" style="--c:${paint(c?.color)}"></i><span>${esc(c?.path ?? '?')}</span></span>
      <span class="spacer"></span>
      <span class="budget-nums"><b>${esc(fmtBase(b.spent))}</b> <span class="muted">of ${esc(fmtBase(b.budget))}</span></span>
      ${edit ? `<button type="button" class="icon" data-act="edit-budget" title="Edit" aria-label="Edit the budget of ${esc(c?.path ?? '')}">${icon('pencil')}</button>` : ''}
    </div>
    ${meter(toNum(b.spent), toNum(b.budget), { state, label: `${c?.path ?? ''}: ${Math.round(b.share * 100)}% of the budget` })}
    <div class="budget-left small ${state}">${left < 0
      ? `${icon('alert', 13)} Over by <b>${esc(fmtBaseNum(-left))}</b>`
      : `${state === 'warn' ? `${icon('alert', 13)} ` : ''}<b>${esc(fmtBase(b.left))}</b> left · ${Math.round(b.share * 100)}%`}</div>
  </li>`;
}

export function missingRatesBanner() {
  const codes = store.state.totals.missing_rates;
  if (!codes.length) return '';
  return `<div class="banner warn">${icon('alert')}<span><b>No exchange rate for ${esc(codes.join(', '))}.</b>
    Money in ${codes.length > 1 ? 'these currencies' : 'this currency'} counts as zero in totals.
    <a href="#settings">Set rates in Settings</a></span></div>`;
}

/**
 * Ranked bars, one per top-level category, largest first, in one hue (one series).
 * The category's own color is the dot by its name. block: a report's {total, groups}.
 * limit: fold the rest into one "Other" row. open: ids of categories unfolded to their subcategories.
 */
export function categoryRanking(block, { limit = Infinity, open = null } = {}) {
  const groups = block.groups.filter((g) => toNum(g.total) !== 0);
  const total = groups.reduce((s, g) => s + toNum(g.total), 0) || 1;
  const max = Math.max(...groups.map((g) => toNum(g.total)), ...groups.flatMap((g) => (open?.has(g.id) ? g.items.map((i) => toNum(i.total)) : []))) || 1;
  const shown = groups.length > limit ? groups.slice(0, limit - 1) : groups;
  const rest = groups.slice(shown.length);
  const bar = (value) => `<span class="rank-track"><span class="rank-bar" style="width:${Math.max(0, (value / max) * 100).toFixed(1)}%;--c:${paint(PALETTE[0])}"></span></span>`;
  const share = (value) => {
    const percent = (value / total) * 100;
    return percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`;
  };
  const row = (g) => {
    const value = toNum(g.total);
    const canOpen = open && g.items.length > 0;
    const isOpen = canOpen && open.has(g.id);
    return `<li class="rank-row ${canOpen ? 'can-open' : ''}" ${canOpen ? `data-open="${g.id}" tabindex="0" role="button" aria-expanded="${isOpen}"` : ''}>
        <span class="rank-name">${canOpen ? `<span class="caret">${icon(isOpen ? 'chevronDown' : 'chevronRight', 14)}</span>` : open ? '<span class="caret"></span>' : ''}
          <i class="dot" style="--c:${paint(g.color)}"></i><span class="${g.is_deleted ? 'deleted' : ''}">${esc(g.name)}</span></span>
        ${bar(value)}
        <span class="rank-value">${esc(fmtBase(g.total))}</span><span class="rank-share">${share(value)}</span>
      </li>
      ${isOpen ? g.items.map((i) => `<li class="rank-row sub">
        <span class="rank-name"><span class="caret"></span>${icon('cornerDownRight', 12, 'muted')}<span class="${i.is_deleted ? 'deleted' : ''}">${esc(i.own ? `${i.name} (no subcategory)` : i.name)}</span></span>
        ${bar(toNum(i.total))}
        <span class="rank-value">${esc(fmtBase(i.total))}</span><span class="rank-share">${share(toNum(i.total))}</span>
      </li>`).join('') : ''}`;
  };
  const restTotal = rest.reduce((s, g) => s + toNum(g.total), 0);
  return `<ul class="ranking">
    ${shown.map(row).join('')}
    ${rest.length ? `<li class="rank-row other"><span class="rank-name">${open ? '<span class="caret"></span>' : ''}<i class="dot" style="--c:var(--subtle)"></i>${rest.length} more</span>
      ${bar(restTotal)}<span class="rank-value">${esc(fmtBaseNum(restTotal))}</span><span class="rank-share">${share(restTotal)}</span></li>` : ''}
  </ul>`;
}
