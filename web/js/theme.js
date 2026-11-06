// Light / dark / system theme. index.html sets data-theme before the first paint from a copy kept in
// localStorage; the saved choice itself lives in data/settings.json.
import { getPref, setPrefs } from './prefs.js';

export const THEMES = { light: 'Light', dark: 'Dark', system: 'System' };
const CACHE_KEY = 'fin.theme';
const media = matchMedia('(prefers-color-scheme: dark)');
let mode = THEMES[getPref('theme')] ? getPref('theme') : 'system';

export const isDark = () => document.documentElement.dataset.theme === 'dark';

function apply() {
  const html = document.documentElement;
  const next = mode === 'dark' || (mode === 'system' && media.matches) ? 'dark' : 'light';
  localStorage.setItem(CACHE_KEY, mode);
  if (html.dataset.theme === next) return;
  // Switch everything at once: without this, buttons fade (hover transitions) while the rest flips.
  html.classList.add('theme-switching');
  html.dataset.theme = next;
  requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove('theme-switching')));
}

/** Views re-render on this event: charts and the graph pick colors in JS. */
const announce = () => window.dispatchEvent(new Event('themechange'));

export function setTheme(next) {
  if (!THEMES[next]) return;
  mode = next;
  setPrefs('theme', next);
  apply();
  announce();
}

/** Header button: switch to the opposite of what's on screen now. */
export const toggleTheme = () => setTheme(isDark() ? 'light' : 'dark');

apply();
media.addEventListener('change', () => {
  if (mode !== 'system') return;
  apply();
  announce();
});
