// HTML escaping. Everything the page renders goes through esc().

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/**
 * HTML-escape a value for text or a quoted attribute: & < > " ' and backtick.
 * null and undefined become '' (nothing is printed as "null"); anything else goes
 * through String() first, so esc(0) is "0".
 * @param {*} value
 * @returns {string}
 */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (c) => ENTITIES[c]);
}

const HTTPS_URL_RE = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?::\d{1,5})?(?:[/?#][^\s"'<>`\\]*)?$/;
const METHODOLOGY_HREF_RE = /^methodology\.html#[a-z0-9][a-z0-9-]*$/;

/**
 * A URL that is safe to put in an href, or null. Only an https:// URL with a plain host name,
 * or a link to a rule on methodology.html (methodology.html#<rule-id>), the two forms a record's
 * source_url may take, is allowed; javascript:, data:, protocol-relative //host and anything with
 * whitespace, quotes or angle brackets is not. Render a null as text, never as a link.
 * @param {*} url
 * @returns {string|null}
 */
export function safeHref(url) {
  if (typeof url !== 'string') return null;
  return HTTPS_URL_RE.test(url) || METHODOLOGY_HREF_RE.test(url) ? url : null;
}
