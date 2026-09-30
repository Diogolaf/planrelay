/**
 * Builds the dashboard's DOM. Board text only ever becomes text nodes: nothing here parses HTML.
 */

/** Attributes h() sets as given, besides data-* and aria-*. */
const PLAIN = new Set(['class', 'id', 'role', 'title', 'href', 'target', 'rel', 'type', 'tabindex', 'dir', 'placeholder', 'for', 'name']);
/** Attributes that are on or off. */
const BOOLEAN = new Set(['disabled', 'hidden', 'selected']);
/** The only link targets: the app's own routes, and http(s) pages. */
const SAFE_HREF = /^(#|https?:\/\/)/i;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Appends children: strings and numbers as text nodes, nodes as they are, arrays flattened;
 * null, undefined, true and false are skipped.
 * @param {Element} el @param {unknown[]} children
 */
function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.append(c);
    else el.append(document.createTextNode(String(c)));
  }
}

/**
 * h('div', { class: 'card', 'data-testid': 'x', onclick: fn, title: '...' }, child, 'text', [more]) -> HTMLElement.
 * - Children: see append. Strings become text nodes, never HTML.
 * - Attributes: class (a string, or an array whose falsy entries are dropped), id, data-*, aria-*,
 *   role, title, href, target, rel, type, value, tabindex, dir, placeholder, for, name; disabled,
 *   hidden and selected are on when truthy. on* are listeners (functions). null and undefined leave
 *   an attribute or a listener out, and so does false except for aria-* ("false").
 * - href: only "#..." routes and http(s) URLs; anything else is left out. target="_blank" always
 *   gets rel="noopener noreferrer".
 * - style is never accepted (use classes; dynamic values via el.style.setProperty in view code),
 *   nor any other attribute: both throw.
 * Children are appended before the attributes are set, so a <select>'s value can pick an option.
 * @param {string} tag
 * @param {Record<string, unknown> | null} [attrs]
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  append(el, children);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value == null) continue;
    if (/^on[a-z]+$/.test(name)) {
      if (typeof value !== 'function') throw new TypeError(`h(): ${name} must be a function`);
      el.addEventListener(name.slice(2), /** @type {EventListener} */ (value));
    } else if (BOOLEAN.has(name)) {
      el.toggleAttribute(name, Boolean(value));
    } else if (value === false && !name.startsWith('aria-')) {
      continue;
    } else if (name === 'value') {
      /** @type {any} */ (el).value = String(value);
    } else if (name === 'href') {
      if (SAFE_HREF.test(String(value))) el.setAttribute('href', String(value));
    } else if (name === 'class') {
      el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
    } else if (PLAIN.has(name) || /^(data|aria)-[a-z][a-z0-9-]*$/.test(name)) {
      el.setAttribute(name, String(value));
    } else if (name === 'style') {
      throw new Error('h(): style is not accepted; use a class, or el.style.setProperty for a dynamic value');
    } else {
      throw new Error(`h(): the attribute "${name}" is not accepted`);
    }
  }
  if (el.getAttribute('target') === '_blank') el.setAttribute('rel', 'noopener noreferrer');
  return el;
}

/** Removes every child of `el`. @param {Element} el */
export function clear(el) {
  el.replaceChildren();
}

/**
 * An icon from the sprite in index.html (`<symbol id="icon-<name>">`): search, copy, check-circle,
 * check, chevron-down. Decorative (aria-hidden); it takes its color from `currentColor`.
 * @param {string} name @param {number} [size] in px (default 16)
 * @returns {SVGSVGElement}
 */
export function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}
