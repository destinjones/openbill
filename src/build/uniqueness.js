// How much of each drug page is its own text, and how much is template (decision 52).
// tools/uniqueness.mjs runs it over a built site; tests/site.test.js holds the pages to a floor.
//
// A page's prose is the visible text of its <main>: headings, paragraphs, lists, tables and the
// figure card, without the masthead, breadcrumbs and footer every page shares by design. It is
// split into blocks (one per paragraph, list item, heading, table row …) and each block into
// lower-case words. A shingle is SHINGLE consecutive words of one block (a shorter block is one
// shingle). A shingle that appears on at least TEMPLATE_SHARE of the pages (and on at least two)
// is template. A word is page-specific when no template shingle covers it and a shingle covering
// it is new on the page: so a price or a name inside a templated sentence counts, the template
// words around it mostly do not, and a sentence the page repeats (an FAQ answer restating the
// body) counts once.
//
// unique share = page-specific words ÷ all words of the page's prose.
//
// Pure and DOM-free: no fs, no clock.

/** Words per shingle. */
export const SHINGLE = 5;

/** A shingle on at least this share of the pages is template. */
export const TEMPLATE_SHARE = 0.01;

const BLOCK_TAGS = 'p|li|dt|dd|h1|h2|h3|h4|h5|h6|summary|tr|caption|section|div|ul|ol|dl|table|thead|tbody|details|header|nav|main|hr|br';
const BLOCK_RE = new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi');

const ENTITY = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#96;': '`', '&nbsp;': ' ' };

function unesc(s) {
  return s.replace(/&(?:amp|lt|gt|quot|nbsp|#39|#96);/g, (e) => ENTITY[e]);
}

/**
 * The visible text of a page's <main>, as blocks of text.
 * @param {string} html
 * @returns {string[]}
 */
export function proseBlocks(html) {
  const text = String(html);
  const start = text.indexOf('<main');
  const end = text.indexOf('</main>');
  if (start < 0 || end < start) throw new Error('proseBlocks: the page has no <main>');
  return unesc(
    text
      .slice(start, end + '</main>'.length)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<(?:td|th)\b[^>]*>/gi, ' ')
      .replace(BLOCK_RE, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * The words of a block: lower case, split on white space, with punctuation trimmed from each end
 * ("$3.35", "13.9×", "2026-10-14" and "00904-7368-06" stay whole).
 * @param {string} block
 * @returns {string[]}
 */
export function words(block) {
  return String(block)
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%×]+$/gu, ''))
    .filter(Boolean);
}

// A 53-bit hash of a shingle, so a page's shingles are numbers and the counts stay small.
function hash(s) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * One page's shingles, block by block: { words, blocks: [{ n, shingles }] } where n is the
 * block's word count and shingles its shingle hashes in order.
 * @param {string} html
 * @returns {{ words: number, blocks: { n: number, shingles: number[] }[] }}
 */
export function pageShingles(html) {
  let total = 0;
  const blocks = [];
  for (const b of proseBlocks(html)) {
    const w = words(b);
    if (!w.length) continue;
    total += w.length;
    const shingles = [];
    if (w.length <= SHINGLE) shingles.push(hash(w.join(' ')));
    else for (let i = 0; i + SHINGLE <= w.length; i++) shingles.push(hash(w.slice(i, i + SHINGLE).join(' ')));
    blocks.push({ n: w.length, shingles });
  }
  return { words: total, blocks };
}

/** The number of pages a shingle must appear on to count as template, for `pages` pages. */
export function templateMin(pages, share = TEMPLATE_SHARE) {
  return Math.max(2, Math.ceil(share * pages));
}

/**
 * Page-specific words of every page: [{ name, words, specific, share }] in input order.
 * @param {{ name: string, shingles: ReturnType<typeof pageShingles> }[]} pages
 * @param {{ share?: number }} [opts]
 */
export function measure(pages, opts = {}) {
  const df = new Map();
  for (const p of pages) {
    const seen = new Set();
    for (const b of p.shingles.blocks) for (const h of b.shingles) seen.add(h);
    for (const h of seen) df.set(h, (df.get(h) || 0) + 1);
  }
  const min = templateMin(pages.length, opts.share);
  return pages.map((p) => {
    let specific = 0;
    const seen = new Set();
    for (const b of p.shingles.blocks) {
      const common = b.shingles.map((h) => df.get(h) >= min);
      // A shingle already met higher up the page adds nothing new: text the page repeats counts once.
      const fresh = b.shingles.map((h) => !seen.has(h));
      for (const h of b.shingles) seen.add(h);
      if (b.n <= SHINGLE) {
        if (!common[0] && fresh[0]) specific += b.n;
        continue;
      }
      for (let i = 0; i < b.n; i++) {
        let template = false;
        let anyFresh = false;
        for (let j = Math.max(0, i - SHINGLE + 1); j <= Math.min(i, b.n - SHINGLE); j++) {
          if (common[j]) {
            template = true;
            break;
          }
          if (fresh[j]) anyFresh = true;
        }
        if (!template && anyFresh) specific += 1;
      }
    }
    const total = p.shingles.words;
    return { name: p.name, words: total, specific, share: total ? specific / total : 0 };
  });
}

/**
 * The value at quantile q (0 … 1) of the numbers, by the nearest-rank method on the sorted list.
 * @param {number[]} values
 * @param {number} q
 */
export function quantile(values, q) {
  if (!values.length) return NaN;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
}

/**
 * The summary the decision log and the tests quote: median and 10th percentile of each page's
 * unique share and page-specific words, and the median prose length.
 * @param {ReturnType<typeof measure>} results
 */
export function summarize(results) {
  const share = results.map((r) => r.share);
  const specific = results.map((r) => r.specific);
  return {
    pages: results.length,
    share: { median: quantile(share, 0.5), p10: quantile(share, 0.1) },
    specific: { median: quantile(specific, 0.5), p10: quantile(specific, 0.1) },
    words: { median: quantile(results.map((r) => r.words), 0.5) },
  };
}
