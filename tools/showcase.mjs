#!/usr/bin/env node
// The showcase's figures for this data, from the core, for a person to re-check on a refresh
// (docs/DECISIONS.md, decisions 45 and 53). A data refresh moves them, so no test pins them; this
// prints them for the pull request body, and says whether the README still states them.
//
// Usage: node tools/showcase.mjs [--data FILE]

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SHOWCASE } from '../src/build/drugpage.js';
import { linkRows } from '../src/core/pack.js';
import { groupProducts } from '../src/core/search.js';
import { summarizeProduct, defaultQuantity, partDNameContext, formatSpreadMultiple } from '../src/core/rules.js';
import { formatMoney } from '../src/core/money.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What the showcase's card says for this data, computed the way the card computes it. Throws when
 * the showcase has left the data, or no longer suits (decision 45): that needs a person.
 * @param {object} doc data/drugs.json
 */
export function showcaseFigures(doc) {
  const rows = linkRows(doc);
  const product = groupProducts(rows).find((p) => p.name === SHOWCASE.drug);
  if (!product) throw new Error(`The showcase ${SHOWCASE.drug} has left the data. Choose a new one (decision 45).`);
  const qty = defaultQuantity(product).qty;
  const s = summarizeProduct(product.rows, qty, { partDContext: partDNameContext(rows) });
  const lost = (x) => !x || x.missing === true;
  if (lost(s.pack) || lost(s.reference) || lost(s.spread)) throw new Error(`The showcase ${SHOWCASE.drug} no longer has a pack total, a Medicare figure and a spread. Choose a new one (decision 45).`);
  return {
    drug: SHOWCASE.drug,
    qty,
    asOf: doc.sources.nadac.as_of_date,
    pharmacy: formatMoney(s.pack.min.value),
    medicare: formatMoney(s.reference.pack.min.value),
    spread: formatSpreadMultiple(s.spread.range.min.value),
    costPlus: lost(s.cost_plus) ? null : formatMoney(s.cost_plus.min.value),
    year: s.reference.range.min.period.slice(0, 4),
    effective: s.nadac.min.effective_date,
    extreme: Boolean(s.spread.extreme),
    onePack: Boolean(s.pack.same),
    oneSpread: s.spread.range.min.value === s.spread.range.max.value,
    partD: s.reference.kind === 'part_d',
  };
}

/**
 * Does the README state these figures? Only asked when it says it describes this data's NADAC week:
 * until the refresh updates the README, it describes the week before, and that is true of that week.
 * @param {string} readme
 * @param {{ asOf: string, pharmacy: string, medicare: string, spread: string }} f
 * @returns {{ week: string|null, current: boolean, missing: string[] }}
 */
export function readmeCheck(readme, f) {
  const m = /NADAC week of (\d{4}-\d{2}-\d{2})/.exec(readme);
  const week = m ? m[1] : null;
  const current = week === f.asOf;
  return { week, current, missing: current ? [f.pharmacy, f.medicare, f.spread].filter((v) => !readme.includes(v)) : [] };
}

/** Markdown for the refresh pull request body. */
export function showcaseSummary(doc, readme) {
  const f = showcaseFigures(doc);
  const c = readmeCheck(readme, f);
  const suits = [
    [f.onePack, 'one pack total'],
    [f.partD, 'a Part D figure'],
    [f.oneSpread && !f.extreme, 'one spread, not extreme'],
  ];
  const words = suits.filter(([ok]) => !ok).map(([, what]) => `no longer has ${what}`);
  let readmeLine;
  if (!c.week) readmeLine = 'The README does not say which NADAC week it describes.';
  else if (c.current) readmeLine = c.missing.length ? `The README claims this week but lacks: ${c.missing.join(', ')}.` : 'The README states these figures.';
  else readmeLine = `The README describes NADAC week ${c.week}: update its headline, its "Data as of" line and docs/ARCHITECTURE.md, "Showcase", for ${f.asOf}.`;
  return [
    '## Showcase, for a person to re-check',
    '',
    `${f.drug}, quantity ${f.qty}, NADAC week of ${f.asOf} (effective ${f.effective}):`,
    '',
    `- Pharmacies pay ${f.pharmacy}`,
    `- Medicare Part D paid ${f.medicare} (${f.year} average)`,
    `- Spread ${f.spread}`,
    `- Cost-plus estimate ${f.costPlus ?? 'none'}`,
    '',
    words.length ? `**Decision 45's reasons no longer hold: it ${words.join(', ')}. Consider a new showcase.**` : "Decision 45's reasons still hold: one pack total, a Part D figure, one spread, not extreme.",
    '',
    readmeLine,
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--data');
  const file = at > 0 ? process.argv[at + 1] : path.join(ROOT, 'data', 'drugs.json');
  process.stdout.write(showcaseSummary(JSON.parse(readFileSync(file, 'utf8')), readFileSync(path.join(ROOT, 'README.md'), 'utf8')));
}
