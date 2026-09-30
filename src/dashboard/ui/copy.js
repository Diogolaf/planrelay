import { h, icon } from './dom.js';

/**
 * The copy button of a ready-to-copy request (the Overview's Needs you, the task view's question).
 *
 * Views are built again on every load and every 30 s, so a button's "Copied" confirmation lives in
 * `copiedAt`, by the button's data-key: the next render shows it for the rest of its 2 s.
 */

/** How long a copy button reads "Copied". */
const COPIED_MS = 2_000;
/** When each copy button last copied, by its data-key (this browser's clock). */
const copiedAt = new Map();

/** How long the button `key` still reads "Copied", 0 when it does not (then forgotten). @param {string} key */
function copiedLeft(key) {
  const left = (copiedAt.get(key) ?? -Infinity) + COPIED_MS - Date.now();
  if (left <= 0) copiedAt.delete(key);
  return Math.max(0, left);
}

/** Selects the contents of `el`, for the user to copy by hand. @param {Element} el */
function select(el) {
  const selection = window.getSelection();
  if (!selection || !el.isConnected) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * A button that copies `text` with the clipboard API and reads "Copied" for 2 s. When the browser
 * refuses (the page is not focused, no permission), `shown` (the element showing the text) is
 * selected instead, for the user to copy by hand.
 * @param {string} text @param {string} key the button's data-key, unique on the page @param {Element} shown
 * @returns {HTMLElement}
 */
export function copyButton(text, key, shown) {
  const button = h('button', { type: 'button', class: 'copy', 'data-testid': 'copy', 'data-key': key, onclick: () => void copy() });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const show = () => {
    const left = copiedLeft(key);
    button.classList.toggle('is-copied', left > 0);
    button.replaceChildren(...(left > 0
      ? [icon('check', 14), h('span', null, 'Copied')]
      : [icon('copy', 16), h('span', { class: 'sr-only' }, 'Copy request')]));
    clearTimeout(timer);
    if (left > 0) timer = setTimeout(show, left);
  };
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      select(shown);
      return;
    }
    copiedAt.set(key, Date.now());
    show();
  }
  show();
  return button;
}
