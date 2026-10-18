// Prefilled GitHub issue-form links ("Wrong? Tell us"). Field ids are shared with
// .github/ISSUE_TEMPLATE/*.yml (docs/ARCHITECTURE.md, "Issue-form field ids").

import { REPO_URL } from './config.js';

/** Field ids of each issue form, in form order. */
export const ISSUE_TEMPLATES = Object.freeze({
  'wrong-price.yml': Object.freeze(['product', 'ndc', 'figure', 'shown_value', 'source_file', 'what_is_wrong', 'evidence', 'build_id']),
  'missing-drug.yml': Object.freeze(['drug_name', 'ndc', 'where_seen', 'notes']),
  'bug.yml': Object.freeze(['what_happened', 'steps', 'device', 'build_id']),
});

/** Longest URL issueUrl() returns; longer values are cut with "…". */
export const ISSUE_URL_MAX = 7500;

const ELLIPSIS = '…';
const ELLIPSIS_ENCODED = encodeURIComponent(ELLIPSIS).length;

function wellFormed(s) {
  // encodeURIComponent throws on a lone surrogate; replace it with U+FFFD.
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

function cut(value, maxEncoded) {
  // The longest prefix (by code point) whose encoding plus "…" fits in maxEncoded.
  const budget = maxEncoded - ELLIPSIS_ENCODED;
  let out = '';
  let used = 0;
  for (const ch of value) {
    const n = encodeURIComponent(ch).length;
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return out + ELLIPSIS;
}

/**
 * A prefilled GitHub issue-form URL:
 * REPO_URL/issues/new?template=<t>&title=<title>[&labels=<a,b>]&<field id>=<value>…
 * Values are encoded with encodeURIComponent; null, undefined and '' fields are left out;
 * an unknown template or field id throws. If the URL would be longer than ISSUE_URL_MAX,
 * the longest values (fields or title) are cut to one common length, as long as fits, and
 * end with "…", so values shorter than that are kept whole and no value is cut to nothing
 * just because it was the longest. The template and labels are never cut.
 * @param {{ template: string, title?: string, fields?: Record<string, *>, labels?: string[] }} args
 * @returns {string}
 */
export function issueUrl({ template, title, fields = {}, labels } = {}) {
  const ids = Object.prototype.hasOwnProperty.call(ISSUE_TEMPLATES, template) ? ISSUE_TEMPLATES[template] : null;
  if (!ids) throw new Error(`unknown issue template ${JSON.stringify(template)}; expected one of ${Object.keys(ISSUE_TEMPLATES).join(', ')}`);
  for (const k of Object.keys(fields)) {
    if (!ids.includes(k)) throw new Error(`${template} has no field ${JSON.stringify(k)}; its fields are ${ids.join(', ')}`);
  }
  const params = [['template', template, false]];
  if (title !== undefined && title !== null && String(title) !== '') params.push(['title', wellFormed(String(title)), true]);
  if (labels && labels.length) params.push(['labels', wellFormed(labels.map(String).join(',')), false]);
  for (const id of ids) {
    const v = fields[id];
    if (v === undefined || v === null || String(v) === '') continue;
    params.push([id, wellFormed(String(v)), true]);
  }

  const build = () => `${REPO_URL}/issues/new?` + params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  let url = build();
  const cuttable = params.map((p, i) => (p[2] ? i : -1)).filter((i) => i >= 0);
  if (url.length > ISSUE_URL_MAX && cuttable.length) {
    // The largest common cap (in encoded characters) at which every cuttable value fits.
    const lens = cuttable.map((i) => encodeURIComponent(params[i][1]).length);
    const budget = ISSUE_URL_MAX - (url.length - lens.reduce((a, n) => a + n, 0));
    const used = (cap) => lens.reduce((a, n) => a + Math.min(n, cap), 0);
    let lo = 0;
    let hi = Math.max(...lens);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (used(mid) <= budget) lo = mid;
      else hi = mid - 1;
    }
    const cap = Math.max(lo, ELLIPSIS_ENCODED);
    cuttable.forEach((i, k) => {
      if (lens[k] > cap) params[i][1] = cut(params[i][1], cap);
    });
    url = build();
  }
  return url;
}
