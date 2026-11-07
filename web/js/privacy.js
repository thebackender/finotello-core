// Hide balances, like the eye button in Binance: wallet balances and totals show as ******.
// The choice is kept in data/settings.json ("privacy"), so it survives a reload.
import { getPrefs, setPrefs } from './prefs.js';
import { icon } from './icons.js';

let hidden = getPrefs('privacy', { hide_balances: false }).hide_balances === true;

const MASK = '******';

export const balancesHidden = () => hidden;

/** A balance as shown: its HTML, or dots while balances are hidden. */
export const secret = (html) => (hidden ? `<span class="masked" role="img" aria-label="Hidden">${MASK}</span>` : html);

/** Views re-render on this event. */
export function toggleBalances() {
  hidden = !hidden;
  setPrefs('privacy', { hide_balances: hidden });
  window.dispatchEvent(new Event('balanceschange'));
}

/** The eye button; app.js handles clicks on any [data-toggle-balances]. */
export const eyeButton = () => {
  const label = hidden ? 'Show balances' : 'Hide balances';
  return `<button type="button" class="icon eye-btn" data-toggle-balances title="${label}" aria-label="${label}" aria-pressed="${hidden}">${icon(hidden ? 'eyeOff' : 'eye')}</button>`;
};
