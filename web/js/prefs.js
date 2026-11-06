// UI settings saved in data/settings.json: the theme and each tab's view options (filters, sorting, …).
import * as api from './api.js';
import { toast } from './util.js';

let saved = {};
const pending = {};
let timer = null;

// Loaded before any tab module runs (top-level await), so tabs can read their options right away.
try {
  saved = await api.getSettings();
} catch {
  saved = {}; // server unreachable: tabs use their defaults, app.js shows the error
}

/** Saved value of a string setting, e.g. "theme". */
export const getPref = (key) => saved[key];

/** One tab's options, with defaults for anything not saved yet. */
export function getPrefs(key, defaults) {
  const value = saved[key];
  return { ...defaults, ...(value && typeof value === 'object' ? value : {}) };
}

/** Save a setting. Quick changes in a row are sent as one request. */
export function setPrefs(key, value) {
  saved[key] = value;
  pending[key] = value;
  clearTimeout(timer);
  timer = setTimeout(flush, 400);
}

function flush(keepalive = false) {
  clearTimeout(timer);
  const keys = Object.keys(pending);
  if (!keys.length) return;
  const body = {};
  for (const k of keys) {
    body[k] = pending[k];
    delete pending[k];
  }
  api.putSettings(body, keepalive).catch((e) => toast(`Settings not saved: ${e.message}`, 'error'));
}

// Don't lose a change made right before the tab is closed or reloaded.
window.addEventListener('pagehide', () => flush(true));
