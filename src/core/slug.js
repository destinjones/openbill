// URL slugs for the static pages (docs/ARCHITECTURE.md, "Drug pages"): drug/<slug>/,
// class/<slug>/, og/<slug>.png. A slug is made from the name alone, so the same data always
// gives the same URLs. Product names that would share a slug each get a suffix made from their
// own exact name (siteSlugs, decision 46), so no name is picked by a guess to keep the plain URL;
// class names that would share one stop the build (uniqueSlugs).

import { sha256Hex } from './sha256.js';

/**
 * The slug of a name: lowercase ASCII, "&" → "and", every other run of characters that are not
 * a-z or 0-9 → "-", with no "-" at either end. Accented letters lose their accents first
 * ("É" → "e"). slugify('ELIQUIS 5 MG TABLET') → 'eliquis-5-mg-tablet';
 * slugify('AMOXICILLIN 400 MG/5 ML SUSP') → 'amoxicillin-400-mg-5-ml-susp';
 * slugify('A&D OINTMENT') → 'a-and-d-ointment'. Throws on a name that is not a string or has no
 * letters or digits, since an empty slug would not be a page.
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  if (typeof name !== 'string') throw new TypeError(`slugify needs a string, got ${name === null ? 'null' : typeof name}`);
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`slugify: ${JSON.stringify(name)} has no letters or digits to make a slug from`);
  return slug;
}

/** Hex digits of sha256(name) appended to a slug that two or more names share (siteSlugs). */
export const SLUG_SUFFIX_HEX = 8;

/**
 * The URL slug of every product name on the website (drug/<slug>/, og/<slug>.png), as a Map from
 * name to slug in first-seen order. Every name whose slugify() is shared with no other name gets
 * that slug. Names that do share one (real NADAC pairs such as "MICONAZOLE 7 CREAM" and
 * "MICONAZOLE-7 CREAM" differ only in punctuation) each get it with "-" and the first
 * SLUG_SUFFIX_HEX hex digits of the SHA-256 of their exact UTF-8 name appended, so neither one
 * is picked to keep the plain URL, and each suffix depends on the name alone, not on the order or
 * on which other names exist. docs/DECISIONS.md, decision 46. If two final slugs still matched
 * (a suffix clash), this throws rather than guessing. The app's "Shareable page" link and the
 * site builder both call this, so they always agree.
 * @param {Iterable<string>} names
 * @returns {Map<string, string>}
 */
export function siteSlugs(names) {
  if (!names || typeof names[Symbol.iterator] !== 'function') throw new TypeError('siteSlugs needs a list of names');
  const plain = new Map();
  const count = new Map();
  for (const name of names) {
    if (plain.has(name)) continue;
    const s = slugify(name);
    plain.set(name, s);
    count.set(s, (count.get(s) || 0) + 1);
  }
  const out = new Map();
  for (const [name, s] of plain) {
    out.set(name, count.get(s) > 1 ? `${s}-${sha256Hex(new TextEncoder().encode(name)).slice(0, SLUG_SUFFIX_HEX)}` : s);
  }
  const owner = new Map();
  const clashes = [];
  for (const [name, s] of out) {
    if (owner.has(s)) clashes.push(`slug "${s}" would be shared by ${JSON.stringify(owner.get(s))} and ${JSON.stringify(name)}`);
    else owner.set(s, name);
  }
  if (clashes.length) throw new Error(`siteSlugs: ${clashes.join('; ')}`);
  return out;
}

/**
 * The slug of every name, as a Map from name to slug in the order the names first appear; a
 * name given more than once is listed once. Throws one Error naming every slug that two or more
 * different names would share (and every name that has no slug), so the build fails rather than
 * guessing which page keeps the URL.
 * @param {Iterable<string>} names
 * @returns {Map<string, string>}
 */
export function uniqueSlugs(names) {
  if (!names || typeof names[Symbol.iterator] !== 'function') throw new TypeError('uniqueSlugs needs a list of names');
  const out = new Map();
  const bySlug = new Map();
  const problems = [];
  for (const name of names) {
    if (out.has(name)) continue;
    let slug;
    try {
      slug = slugify(name);
    } catch (e) {
      problems.push(e.message);
      continue;
    }
    out.set(name, slug);
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(name);
  }
  for (const [slug, list] of bySlug) {
    if (list.length > 1) problems.push(`slug "${slug}" would be shared by ${list.map((n) => JSON.stringify(n)).join(', ')}`);
  }
  if (problems.length) throw new Error(`uniqueSlugs: ${problems.join('; ')}`);
  return out;
}
