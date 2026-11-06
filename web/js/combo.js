// Searchable dropdown ("combobox"): a text box that filters a list as you type.
// The chosen value lives in a hidden input with the given name, so forms read it like a <select>.
import { esc } from './util.js';
import { icon } from './icons.js';

/**
 * items: [{value, label, hint?, dot?}]; hint is shown greyed out and is searchable too; dot is a color.
 * The first entry of the list is "— none —" (empty value) unless noneLabel is null.
 * creatable: when the typed text matches no item exactly, the list offers "+ Create …";
 * picking it calls the onCreate given to bindCombos.
 */
export function comboHTML(name, items, value, { placeholder = 'Type to search…', noneLabel = '— none —', creatable = false } = {}) {
  const current = items.find((i) => String(i.value) === String(value ?? ''));
  return `<div class="combo">
    <input type="hidden" name="${name}" value="${esc(current ? current.value : '')}">
    <input type="text" class="combo-input" value="${esc(current?.label ?? '')}" placeholder="${esc(placeholder)}"
      autocomplete="off" role="combobox" aria-expanded="false">
    <ul class="combo-list" role="listbox" hidden>
      ${noneLabel === null ? '' : `<li data-value="" data-label="" class="none">${esc(noneLabel)}</li>`}
      ${items.map(itemHTML).join('')}
      ${creatable ? '<li class="combo-create" hidden></li>' : ''}
      <li class="combo-empty" hidden>No matches</li>
    </ul>
  </div>`;
}

const itemHTML = (i) => `<li data-value="${esc(i.value)}" data-label="${esc(i.label)}"
  data-search="${esc(`${i.label} ${i.hint ?? ''}`.toLowerCase())}">${i.dot ? `<i class="dot" style="--c:${esc(i.dot)}"></i>` : ''}${esc(i.label)}${i.hint ? ` <span class="muted">${esc(i.hint)}</span>` : ''}</li>`;

/**
 * Wire up every combo inside root. Call once after the markup is inserted.
 * onCreate(text): for creatable combos; resolves to the new {value, label, dot?}, or null if nothing was made.
 */
export function bindCombos(root, opts = {}) {
  root.querySelectorAll('.combo').forEach((box) => bindCombo(box, opts));
}

export function bindCombo(box, { onCreate } = {}) {
  if (box.dataset.bound) return;
  box.dataset.bound = '1';
  const hidden = box.querySelector('input[type=hidden]');
  const input = box.querySelector('.combo-input');
  const list = box.querySelector('.combo-list');
  const items = [...list.querySelectorAll('li[data-value]')];
  const createLi = list.querySelector('.combo-create');
  const empty = list.querySelector('.combo-empty');
  let active = -1;

  const visible = () => [...items, ...(createLi ? [createLi] : [])].filter((li) => !li.hidden);
  const currentLabel = () => items.find((li) => li.dataset.value === hidden.value)?.dataset.label ?? '';

  function highlight(index) {
    const shown = visible();
    list.querySelectorAll('li.active').forEach((li) => li.classList.remove('active'));
    active = Math.max(-1, Math.min(index, shown.length - 1));
    if (active >= 0) {
      shown[active].classList.add('active');
      shown[active].scrollIntoView({ block: 'nearest' });
    }
  }
  function filter(query) {
    const q = query.trim().toLowerCase();
    // While searching, "— none —" is hidden; it shows again when the box is empty.
    items.forEach((li) => (li.hidden = q !== '' && !(li.dataset.search ?? '').includes(q)));
    if (createLi) {
      createLi.hidden = !q || items.some((li) => li.dataset.label.toLowerCase() === q);
      createLi.textContent = `+ Create “${query.trim()}”`;
    }
    empty.hidden = visible().length > 0;
  }
  function open() {
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    filter('');
    highlight(visible().findIndex((li) => li.dataset.value === hidden.value));
  }
  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.value = currentLabel(); // typed text that wasn't picked is dropped
  }
  function set(value) {
    hidden.value = value;
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
    close();
  }
  async function create() {
    const text = input.value.trim();
    close();
    const item = await onCreate?.(text);
    if (!item) return;
    const tmp = document.createElement('ul');
    tmp.innerHTML = itemHTML(item);
    const li = tmp.firstElementChild;
    list.insertBefore(li, createLi);
    items.push(li);
    set(String(item.value));
  }
  function choose(li) {
    if (li === createLi) create();
    else set(li.dataset.value);
  }

  input.addEventListener('focus', () => { open(); input.select(); });
  input.addEventListener('click', () => { if (list.hidden) open(); });
  input.addEventListener('input', () => {
    list.hidden = false;
    filter(input.value);
    // An exact match comes first; otherwise the first match, or "+ Create".
    const shown = visible();
    const q = input.value.trim().toLowerCase();
    const exact = shown.findIndex((li) => li.dataset.label?.toLowerCase() === q);
    highlight(exact >= 0 ? exact : 0);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.hidden) open();
      else highlight(active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight(active - 1);
    } else if (e.key === 'Enter' && !list.hidden) {
      e.preventDefault(); // pick, don't submit the form
      const li = visible()[active];
      if (li) choose(li);
      else close();
    } else if (e.key === 'Escape' && !list.hidden) {
      e.preventDefault(); // close the list, not the whole dialog
      e.stopPropagation();
      close();
    }
  });
  // mousedown (not click) so the choice lands before the input loses focus
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-value], li.combo-create');
    e.preventDefault();
    if (li) choose(li);
  });
  input.addEventListener('blur', () => { if (!list.hidden) close(); });
}

// ---------- picker: a <select> look-alike whose options carry an icon ----------

/**
 * items: [{value, label, icon}] (icon is HTML). The value lives in a hidden input with the given name.
 * An option can be turned off later with aria-disabled="true" on its <li>, and get a note in its .opt-hint.
 * Put it in a <div class="field">, not a <label>: a label would pass clicks on the list back to the button.
 */
export function pickerHTML(name, items, value, ariaLabel = name) {
  const cur = items.find((i) => String(i.value) === String(value)) ?? items[0];
  return `<div class="picker">
    <input type="hidden" name="${name}" value="${esc(cur.value)}">
    <button type="button" class="picker-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(ariaLabel)}">${cur.icon}<span>${esc(cur.label)}</span></button>
    <ul class="combo-list picker-list" role="listbox" hidden>
      ${items.map((i) => `<li role="option" data-value="${esc(i.value)}" aria-selected="${i === cur}">${i.icon}<span>${esc(i.label)}</span><span class="opt-hint"></span></li>`).join('')}
    </ul>
  </div>`;
}

/** Wire up every picker inside root. Call once after the markup is inserted. */
export function bindPickers(root) {
  root.querySelectorAll('.picker').forEach(setupPicker);
}

function setupPicker(box) {
  const hidden = box.querySelector('input[type=hidden]');
  const btn = box.querySelector('.picker-btn');
  const list = box.querySelector('.picker-list');
  const items = [...list.querySelectorAll('li')];
  let active = -1;

  function highlight(i) {
    active = (i + items.length) % items.length;
    items.forEach((li, n) => li.classList.toggle('active', n === active));
    items[active].scrollIntoView({ block: 'nearest' });
  }
  function open() {
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    highlight(items.findIndex((li) => li.dataset.value === hidden.value));
  }
  function close() {
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
  function choose(li) {
    if (li.getAttribute('aria-disabled') === 'true') return; // stays open: pick another one
    close();
    if (li.dataset.value === hidden.value) return;
    hidden.value = li.dataset.value;
    items.forEach((x) => x.setAttribute('aria-selected', x === li));
    btn.innerHTML = li.innerHTML;
    btn.querySelector('.opt-hint')?.remove();
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
  }

  btn.addEventListener('click', () => (list.hidden ? open() : close()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) open();
      else highlight(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if ((e.key === 'Enter' || e.key === ' ') && !list.hidden) {
      e.preventDefault(); // pick, don't submit the form or re-click the button
      choose(items[active]);
    } else if (e.key === 'Escape' && !list.hidden) {
      e.preventDefault(); // close the list, not the whole dialog
      e.stopPropagation();
      close();
    }
  });
  // mousedown (not click) so the choice lands before the button loses focus
  list.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const li = e.target.closest('li');
    if (li) choose(li);
  });
  list.addEventListener('mousemove', (e) => {
    const i = items.indexOf(e.target.closest('li'));
    if (i >= 0 && i !== active) highlight(i);
  });
  btn.addEventListener('blur', close);
}
