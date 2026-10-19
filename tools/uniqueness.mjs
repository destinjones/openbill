// How much of each drug page is its own text: node tools/uniqueness.mjs [--site <dir>] [--show NAME]...
//
// Measures every drug page (src/build/uniqueness.js, decision 52) and prints the median and
// 10th percentile of the unique share and of the page-specific words, then the same at other
// template thresholds, so the choice of threshold can be judged.
//
//   --site <dir>   read drug/*/index.html from a site tools/site.mjs wrote (for example one built
//                  from an older commit, to compare); default: render every page from
//                  data/drugs.json with the current code, in memory
//   --show NAME    also print this product's page-specific and total words (repeatable)

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readData } from './site.mjs';
import { buildModel, renderDrugPage } from '../src/build/drugpage.js';
import { pageShingles, measure, summarize, templateMin, TEMPLATE_SHARE, SHINGLE } from '../src/build/uniqueness.js';

/** Every drug page rendered in memory from data/drugs.json: [{ name, html }]. */
export function renderAll(dataFile) {
  const { doc } = readData(dataFile);
  const model = buildModel(doc, { dataDate: doc.sources.nadac.as_of_date });
  return model.products.map((p) => ({ name: p.name, html: renderDrugPage(model, p).html }));
}

function readSite(dir) {
  const root = path.join(dir, 'drug');
  return fs
    .readdirSync(root)
    .sort()
    .map((slug) => {
      const html = fs.readFileSync(path.join(root, slug, 'index.html'), 'utf8');
      const m = /<h1 class="page-title">([^<]*)<\/h1>/.exec(html);
      return { name: m ? m[1] : slug, html };
    });
}

function pct(x) {
  return `${(100 * x).toFixed(1)}%`;
}

function main(argv) {
  let site = null;
  const show = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site' && i + 1 < argv.length) site = argv[++i];
    else if (argv[i] === '--show' && i + 1 < argv.length) show.push(argv[++i]);
    else throw new Error(`unknown option ${JSON.stringify(argv[i])}; see the top of tools/uniqueness.mjs`);
  }
  const pages = (site ? readSite(site) : renderAll()).map((p) => ({ name: p.name, shingles: pageShingles(p.html), html: p.html }));
  const n = pages.length;
  const results = measure(pages);
  const s = summarize(results);
  console.log(`${site ? `Site ${site}` : 'Pages rendered from data/drugs.json'}: ${n.toLocaleString('en-US')} drug pages`);
  console.log(`  template = a ${SHINGLE}-word shingle on at least ${pct(TEMPLATE_SHARE)} of pages (${templateMin(n)} pages)`);
  console.log(`  unique share:         median ${pct(s.share.median)}, 10th percentile ${pct(s.share.p10)}`);
  console.log(`  page-specific words:  median ${s.specific.median}, 10th percentile ${s.specific.p10}`);
  console.log(`  words of prose:       median ${s.words.median}`);
  console.log('  other thresholds (median share / p10 share / median words / p10 words):');
  for (const share of [1 / n, 10 / n, 0.05]) {
    const t = summarize(measure(pages, { share }));
    console.log(`    on >= ${String(templateMin(n, share)).padStart(4)} pages: ${pct(t.share.median)} / ${pct(t.share.p10)} / ${t.specific.median} / ${t.specific.p10}`);
  }
  for (const name of show) {
    const i = pages.findIndex((p) => p.name === name);
    if (i < 0) throw new Error(`--show ${JSON.stringify(name)}: no such page`);
    console.log(`\n${name}: ${results[i].specific} of ${results[i].words} words page-specific (${pct(results[i].share)})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`uniqueness.mjs: ${e.message}`);
    process.exitCode = 1;
  }
}
