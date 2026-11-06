// Dialogs in the app's own style, instead of the browser's confirm() and prompt().
// One at a time, in <dialog id="confirm-dialog">; it opens on top of the task editor if that is open.
import { esc } from './util.js';

const box = document.getElementById('confirm-dialog');

/**
 * Ask a question with buttons. Resolves to the value of the button clicked, or to `dismiss` on Esc or a click outside.
 * buttons: [{value, label, kind?: 'primary' | 'danger' | 'destructive', focus?: true}]; {spacer: true} pushes the rest right.
 * body: extra HTML under the text (e.g. an input).
 */
export function ask({ title, text = '', body = '', buttons, dismiss = 'cancel' }) {
  return new Promise((resolve) => {
    box.innerHTML = `<form method="dialog" class="confirm">
      <h3>${esc(title)}</h3>
      ${text ? `<p>${esc(text)}</p>` : ''}
      ${body}
      <footer>${buttons.map((b) => (b.spacer ? '<span class="spacer"></span>'
        : `<button type="button" value="${esc(b.value)}" class="${b.kind ?? ''}"${b.focus ? ' autofocus' : ''}>${esc(b.label)}</button>`)).join('')}
      </footer>
    </form>`;
    let answered = false;
    const answer = (value) => {
      if (answered) return;
      answered = true;
      if (box.open) box.close();
      resolve(value);
    };
    // Answer right on click instead of waiting for the dialog's close event, which arrives later.
    box.querySelectorAll('button[value]').forEach((b) => {
      b.onclick = (e) => { e.preventDefault(); answer(b.value); };
    });
    box.onclick = (e) => { if (e.target === box) answer(dismiss); }; // backdrop
    // Esc: handled on "cancel", which fires right away (a late "close" event could answer the next question).
    box.oncancel = (e) => { e.preventDefault(); answer(dismiss); };
    box.showModal();
  });
}

/** Yes / no. danger: the button is red (deleting). Resolves to true or false. */
export async function confirmDialog({ title, text = '', ok = 'OK', danger = false }) {
  const answer = await ask({
    title, text,
    buttons: [{ spacer: true }, { value: 'cancel', label: 'Cancel' }, { value: 'ok', label: ok, kind: danger ? 'destructive' : 'primary', focus: true }],
  });
  return answer === 'ok';
}

/** Ask for a line of text. Resolves to the text (trimmed), or null if cancelled. attrs: extra input attributes. */
export async function promptDialog({ title, text = '', value = '', placeholder = '', ok = 'OK', attrs = '' }) {
  const pending = ask({
    title, text,
    body: `<input class="dialog-input" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" ${attrs}>`,
    buttons: [{ spacer: true }, { value: 'cancel', label: 'Cancel' }, { value: 'ok', label: ok, kind: 'primary' }],
  });
  const input = box.querySelector('.dialog-input');
  input.focus();
  input.select();
  input.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    box.querySelector('button[value="ok"]').click();
  };
  return (await pending) === 'ok' ? input.value.trim() : null;
}
