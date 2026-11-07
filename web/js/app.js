// Entry point: tabs, keyboard shortcuts, re-render on data changes.
import { store, reload, subscribe, undo, backupNow } from './store.js';
import { openTransaction } from './editor.js';
import { esc, today, addDays, fmtDate, fmtTs } from './util.js';
import { toggleTheme } from './theme.js';
import * as overview from './views/overview.js';
import * as transactions from './views/transactions.js';
import * as plans from './views/plans.js';
import * as wallets from './views/wallets.js';
import * as settings from './views/settings.js';

const VIEWS = { overview, transactions, plans, wallets, settings };
// Old links still work: Reports became part of Overview.
const ALIASES = { reports: 'overview' };
const main = document.getElementById('view');
const undoBtn = document.getElementById('undo-btn');
const backupBtn = document.getElementById('backup-btn');

/** The Backup button shows when the last backup was made: "14:32" today, "yesterday 23:10", or a date. */
function showLastBackup() {
  const info = store.lastBackup;
  const label = backupBtn.querySelector('.backup-time');
  if (!info?.time) {
    label.textContent = 'no backup';
    backupBtn.title = `Back up now. No backups yet.${info?.dir ? `\nFolder: ${info.dir}` : ''}`;
    return;
  }
  const [day, time] = info.time.split('T');
  const hm = time.slice(0, 5);
  label.textContent = day === today() ? hm : day === addDays(today(), -1) ? `yesterday ${hm}` : fmtDate(day).slice(0, 5);
  backupBtn.title = `Back up now\nLast backup: ${fmtTs(info.time)} (${info.file})\nFolder: ${info.dir}`;
}

let current = 'overview';

function route() {
  if (!store.state) return;
  const hash = location.hash.slice(1);
  const name = VIEWS[hash] ? hash : ALIASES[hash] ?? 'overview';
  current = name;
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${name}`));
  // A fresh container each time, so the old view's event listeners go away with it.
  const root = document.createElement('div');
  root.className = `view view-${name}`;
  main.replaceChildren(root);
  VIEWS[name].render(root);
}

subscribe(() => {
  undoBtn.disabled = !store.canUndo;
  showLastBackup();
  route();
});
window.addEventListener('hashchange', route);
window.addEventListener('themechange', route); // charts pick their colors in JS

/** New transaction with the current tab's defaults (e.g. the wallet open in a filter). */
const newTransaction = () => openTransaction(null, VIEWS[current].newPreset?.() ?? {});
document.getElementById('add-tx').addEventListener('click', newTransaction);
undoBtn.addEventListener('click', () => undo());
backupBtn.addEventListener('click', async () => {
  backupBtn.disabled = true;
  await backupNow();
  backupBtn.disabled = false;
});
document.getElementById('theme-btn').addEventListener('click', toggleTheme);

// Shortcuts use e.code (the physical key), so they also work with a Russian keyboard layout.
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, select, [contenteditable]');
  const dialogOpen = document.getElementById('dialog').open || document.getElementById('confirm-dialog').open;
  if (e.key === 'Escape') {
    if (e.defaultPrevented || dialogOpen) return;
    const menus = document.querySelectorAll('details.view-menu[open]');
    if (menus.length) return menus.forEach((d) => d.removeAttribute('open'));
    if (typing) e.target.blur();
    return;
  }
  if (typing || dialogOpen) return;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyZ') {
    e.preventDefault();
    undo();
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyN') {
    e.preventDefault();
    newTransaction();
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && /^(Digit|Numpad)[1-9]$/.test(e.code)) {
    const tab = document.querySelectorAll('#tabs a')[Number(e.code.at(-1)) - 1];
    if (tab) {
      e.preventDefault();
      location.hash = tab.getAttribute('href');
    }
  }
});

reload().catch((e) => {
  main.innerHTML = `<div class="empty error">${esc(e.message)}</div>`;
});
