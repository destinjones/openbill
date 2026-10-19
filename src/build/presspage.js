// The press kit, press/index.html (decision 51): the wordmark, screenshots of the card, the reveal
// clip, the headline numbers, a paragraph a journalist can paste, the DOIs, how to get in touch
// and the honesty lines. tools/site.mjs writes it on every deploy, with the pictures it lists
// rendered from the same build (PRESS_MEDIA), so nothing on it goes stale.
//
// DOM-free and pure, like drugpage.js, whose page parts it shares: no fs, no clock, no network.
// Every number comes from data/drugs.json through src/core (drugFacts(), the figures the showcase's
// drug page shows, and the model's own counts); the DOIs come from CITATION.cff, which
// tools/site.mjs reads and passes in. The page has no script at all.

import { html, joinHtml, link, chip, honestyLine, honestyText, honestyList, provTexts, sourceList, headHtml, masthead, footer, crumbs, page, quantityKicker, appHash, ogImagePath, drugFacts } from './drugpage.js';
import { revealFacts, revealQuery, REVEAL_LAYOUTS, REVEAL_DURATION_CS } from './reveal.js';
import { formatCount } from '../core/money.js';
import { SITE_URL, APP_NAME, REPO_URL } from '../core/config.js';

/** The press page sits one folder below the site root. */
const UP = '../';

export const PRESS_PATH = 'press/';

/**
 * Screenshots of the app's default card (the showcase), taken from the built openbill.html by
 * tools/shots.mjs: the same three the README shows from docs/img/.
 */
export const PRESS_SHOTS = Object.freeze([
  Object.freeze({ file: 'card-360.png', viewport: Object.freeze({ width: 360, height: 780 }), colorScheme: 'light', isMobile: true, what: 'on a 360px-wide phone screen, light theme' }),
  Object.freeze({ file: 'card-360-dark.png', viewport: Object.freeze({ width: 360, height: 780 }), colorScheme: 'dark', isMobile: true, what: 'on a 360px-wide phone screen, dark theme' }),
  Object.freeze({ file: 'card-desktop.png', viewport: Object.freeze({ width: 1280, height: 800 }), colorScheme: 'light', isMobile: false, what: 'on a 1280×800 desktop screen, light theme' }),
]);

/** The wordmark (the stamp), on a transparent background: dark ink for light backgrounds, light ink for dark ones. */
export const WORDMARK = Object.freeze({ width: 240, height: 80, scale: 4 });
export const PRESS_WORDMARKS = Object.freeze([
  Object.freeze({ file: 'openbill-wordmark.png', ink: 'dark', what: 'dark ink, for light backgrounds' }),
  Object.freeze({ file: 'openbill-wordmark-on-dark.png', ink: 'light', what: 'light ink, for dark backgrounds' }),
]);

/** Every file the image step writes into press/ (tools/site.mjs; skipped with --no-og). */
export function pressMediaFiles() {
  return [
    ...PRESS_WORDMARKS.map((w) => w.file),
    ...PRESS_SHOTS.map((s) => s.file),
    ...Object.values(REVEAL_LAYOUTS).flatMap((l) => [l.file, l.still].filter(Boolean)),
  ];
}

/**
 * The wordmark as a whole page, for tools/site.mjs to screenshot with a transparent background.
 * `css` is src/site/reveal.css (its stamp) with the fonts as data: URIs.
 * @param {{ css: string, ink: 'dark'|'light' }} opts
 * @returns {string}
 */
export function renderWordmarkHtml({ css, ink }) {
  if (typeof css !== 'string' || /<\/style/i.test(css)) throw new Error('renderWordmarkHtml needs the CSS as a string');
  if (ink !== 'dark' && ink !== 'light') throw new Error(`no wordmark ink ${JSON.stringify(ink)}`);
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<style>${css}</style>\n</head>\n<body class="wordmark ink-${ink}">\n<span class="stamp"><span class="stamp-name">${APP_NAME}</span><span class="stamp-sub">drug price receipt</span></span>\n</body>\n</html>\n`;
}

/**
 * The DOIs in CITATION.cff's `identifiers`: [{ doi, description }], in its order.
 * @param {string} cff the text of CITATION.cff
 * @returns {{ doi: string, description: string }[]}
 */
export function citationDois(cff) {
  const out = [];
  const block = /^identifiers:\s*\n((?:[ \t]+.*\n?)+)/m.exec(String(cff));
  if (!block) return out;
  for (const item of block[1].split(/^\s*-\s+/m).slice(1)) {
    const field = (name) => {
      const m = new RegExp(`(?:^|\\n)\\s*${name}:\\s*"?([^"\\n]+?)"?\\s*(?:\\n|$)`).exec(item);
      return m ? m[1].trim() : null;
    };
    if (field('type') !== 'doi') continue;
    const doi = field('value');
    if (!doi || !/^10\.\d{4,9}\/[A-Za-z0-9._;()/:-]+$/.test(doi)) throw new Error(`CITATION.cff: ${JSON.stringify(doi)} is not a DOI`);
    out.push({ doi, description: field('description') || doi });
  }
  return out;
}

// ---------------------------------------------------------------- the numbers

/**
 * The press page's figures and counts, from the model: drugFacts() for the showcase and the
 * counts of the whole build. Counting the products with a Medicare figure reads every product's
 * facts; tools/site.mjs renders the page after the class and A–Z pages, which have worked them out.
 * @param {object} model buildModel()
 * @param {{ name: string, rows: object[] }} product the showcase
 */
export function pressFacts(model, product) {
  const f = revealFacts(model, product);
  const ndcs = new Set(model.rows.map((r) => r.ndc)).size;
  const withMedicare = model.products.filter((p) => !drugFacts(model, p).medicare.missing).length;
  return { f, products: model.products.length, ndcs, withMedicare };
}

/** "a generic drug" or "a brand-name drug", from NADAC's rate-setting classes (G, B). */
function drugKind(f) {
  const rc = f.s.rate_classes;
  if (rc.length && rc.every((c) => c === 'G')) return 'a generic drug';
  if (rc.length && rc.every((c) => c === 'B')) return 'a brand-name drug';
  return 'a drug';
}

/** What Medicare paid, as the paragraph and the page word it. */
function medicareWords(f) {
  const m = f.medicare;
  if (m.kind === 'part_d') return `Medicare Part D paid ${m.text}, its ${m.year ? `${m.year} ` : ''}average across every strength and form sold under the name`;
  return `Medicare Part B’s payment limit comes to ${m.text}`;
}

/**
 * The paragraph a journalist can paste as it stands. Every number and date in it is the build's.
 * @param {object} model
 * @param {object} pf pressFacts()
 * @param {{ doi: string }[]} dois
 * @returns {string}
 */
export function pressParagraph(model, pf, dois) {
  const { f } = pf;
  const doi = dois[0] ? ` (DOI ${dois[0].doi})` : '';
  return [
    `${APP_NAME} (${SITE_URL}) is a free, open-source website that puts what US pharmacies pay for a prescription drug next to what Medicare pays for it, with the source file and dates on every number.`,
    `It covers ${formatCount(pf.products)} drug products (${formatCount(pf.ndcs)} National Drug Codes) in the CMS National Average Drug Acquisition Cost (NADAC) file of ${model.doc.sources.nadac.as_of_date}.`,
    `Take ${f.name.toLowerCase()}: for ${f.qtyText}, pharmacies pay ${f.pharmacy.text}, and ${medicareWords(f)}.`,
    `${f.spread.sentence.replace(/\.$/, '')}, a comparison ${APP_NAME} labels ${f.spread.state}.`,
    honestyText('not-your-price', { firstSentenceOnly: true }),
    `${APP_NAME} has no ads, accounts or tracking; its code is MIT licensed, and each release is archived on Zenodo${doi}.`,
  ].join(' ');
}

// ---------------------------------------------------------------- the page

function provBlock(key, lines) {
  return joinHtml(
    lines.map((t) => html`<p class="prov mono" data-prov="${key}">${t}</p>`),
    '\n',
  );
}

function headline(f) {
  const m = f.medicare;
  return html`<section class="card press-card" aria-label="The showcase figures">
<p class="card-kicker">${quantityKicker(f)} · ${f.name}</p>
<section class="fig fig-pharmacy" aria-labelledby="press-ph">
<h3 id="press-ph" class="fig-label">Pharmacies pay</h3>
<p class="fig-value"><span class="amount" data-figure="pharmacy">${f.pharmacy.text}</span> ${chip(f.pharmacy.state)}</p>
<p class="arith mono">${f.pharmacy.arith}</p>
${provBlock('pharmacy', provTexts(f.pharmacy.records))}
</section>
<section class="fig fig-medicare" aria-labelledby="press-md">
<h3 id="press-md" class="fig-label">${m.label}</h3>
<p class="fig-value"><span class="amount" data-figure="medicare">${m.text}</span> ${chip(m.state)}</p>
<p class="arith mono">${m.arith}</p>
${m.kind === 'part_d' ? html`<p class="why">The ${m.year ? `${m.year} ` : ''}average across every strength and form sold under the name, not this product’s own price.</p>` : ''}
<p class="not-yours">${honestyLine('not-your-price', { firstSentenceOnly: true })}</p>
${provBlock('medicare', provTexts(m.records, m.inputs))}
</section>
<hr class="rule">
<section class="spread" aria-labelledby="press-sp">
<h3 id="press-sp" class="fig-label">The spread</h3>
<p class="fig-value"><span class="multiple" data-figure="spread">${f.spread.text}</span> ${chip(f.spread.state)}</p>
<p class="spread-sentence">${f.spread.sentence}</p>
${f.spread.caveats.first ? html`<p class="caveat">${f.spread.caveats.first}</p>` : ''}
${provBlock('spread', provTexts(f.spread.records, f.spread.inputs))}
</section>
<p class="card-cta">${link(`${UP}${f.path}`, `${f.name}: its drug page`, ' class="button"')} ${link(`${UP}${appHash(f.name, f.qty)}`, 'The interactive card')}</p>
</section>`;
}

function figure({ src, width, height, alt, caption, downloads, cls = '', reduced = null }) {
  const img = html`<img src="${src}" width="${String(width)}" height="${String(height)}" alt="${alt}" loading="lazy" decoding="async">`;
  const picture = reduced ? html`<picture><source media="(prefers-reduced-motion: reduce)" srcset="${reduced}">${img}</picture>` : img;
  return html`<figure class="press-media${cls}">
${picture}
<figcaption>${caption}<span class="press-get">Download: ${joinHtml(
    downloads.map((d) => link(d.href, d.text, ' download')),
    ' · ',
  )}</span></figcaption>
</figure>`;
}

/** The figures as words, for the pictures' alt text. */
function figuresInWords(f) {
  const m = f.medicare;
  return `pharmacies pay ${f.pharmacy.text} for ${f.qtyText} (${f.pharmacy.state}); ${m.label} ${m.text} (${m.state}${m.year ? `, ${m.year} average` : ''}); the spread, ${f.spread.text} (${f.spread.state})`;
}

function pictures(f) {
  const wide = REVEAL_LAYOUTS.wide;
  const tall = REVEAL_LAYOUTS.tall;
  const secs = REVEAL_DURATION_CS / 100;
  const clipAlt = (shape) =>
    `A ${secs}-second ${shape} clip of the ${APP_NAME} card: the search box types “${revealQuery(f.name)}”, the card for ${f.name} resolves, then ${figuresInWords(f)}, then the source lines appear.`;
  const shots = PRESS_SHOTS.map((s) =>
    figure({
      src: s.file,
      width: s.viewport.width,
      height: s.viewport.height,
      alt: `The ${APP_NAME} card for ${f.name} ${s.what}: ${figuresInWords(f)}.`,
      caption: html`The card ${s.what}, ${String(s.viewport.width)}×${String(s.viewport.height)}.`,
      downloads: [{ href: s.file, text: 'PNG' }],
      cls: s.isMobile ? ' press-phone' : '',
    }),
  );
  const marks = PRESS_WORDMARKS.map((w) =>
    figure({
      src: w.file,
      width: WORDMARK.width,
      height: WORDMARK.height,
      alt: `The ${APP_NAME} wordmark, a rubber stamp reading “${APP_NAME}, drug price receipt”, in ${w.what}.`,
      caption: html`The wordmark in ${w.what}, ${String(WORDMARK.width * WORDMARK.scale)}×${String(WORDMARK.height * WORDMARK.scale)}, transparent background.`,
      downloads: [{ href: w.file, text: 'PNG' }],
      cls: w.ink === 'light' ? ' press-wordmark press-on-dark' : ' press-wordmark',
    }),
  );
  return html`<section class="prose" aria-labelledby="h-pictures">
<h2 id="h-pictures">Pictures and the clip</h2>
<p>Every picture here is rendered from this build of the site when it is deployed, so it shows the numbers on this page. Where you ask your browser to reduce motion, the clips show a still instead.</p>
<h3>The reveal clip</h3>
${figure({
  src: wide.file,
  width: wide.width,
  height: wide.height,
  alt: clipAlt('16:9'),
  caption: html`16:9, ${String(wide.width)}×${String(wide.height)}, ${String(secs)} seconds, loops, for the README and most feeds. Its last frame is also a still.`,
  downloads: [
    { href: wide.file, text: 'GIF' },
    { href: wide.still, text: 'Still (PNG)' },
  ],
  cls: ' press-clip',
  reduced: wide.still,
})}
${figure({
  src: tall.file,
  width: tall.width,
  height: tall.height,
  alt: clipAlt('9:16'),
  caption: html`9:16, ${String(tall.width)}×${String(tall.height)}, for stories.`,
  downloads: [{ href: tall.file, text: 'GIF' }],
  cls: ' press-clip press-tall',
  reduced: PRESS_SHOTS[0].file,
})}
<h3>Screenshots of the card</h3>
<div class="press-grid">
${joinHtml(shots, '\n')}
</div>
<h3>The wordmark</h3>
<div class="press-grid">
${joinHtml(marks, '\n')}
</div>
</section>`;
}

/**
 * press/index.html.
 * @param {object} model buildModel()
 * @param {{ name: string, rows: object[] }} product the showcase
 * @param {{ dois: { doi: string, description: string }[] }} opts
 * @returns {{ path: string, file: string, html: string, title: string, description: string, facts: object, paragraph: string }}
 */
export function renderPressPage(model, product, { dois }) {
  if (!Array.isArray(dois) || !dois.length) throw new Error('the press page needs the DOIs from CITATION.cff');
  const pf = pressFacts(model, product);
  const { f } = pf;
  const m = f.medicare;
  const canonical = `${SITE_URL}${PRESS_PATH}`;
  const paragraph = pressParagraph(model, pf, dois);
  const title = `Press kit | ${APP_NAME}`;
  const description = `${APP_NAME}’s press kit: the numbers, pictures, a ${REVEAL_DURATION_CS / 100}-second clip and a paragraph to paste, from the CMS NADAC file of ${model.doc.sources.nadac.as_of_date}. For ${f.qtyText} of ${f.name}, pharmacies pay ${f.pharmacy.text}; ${m.label} ${m.text}${m.year ? ` (${m.year} average)` : ''}: ${f.spread.text}, ${f.spread.state}. ${honestyText('not-your-price', { firstSentenceOnly: true })}`;
  const crumbList = [
    { name: APP_NAME, href: UP, url: SITE_URL },
    { name: 'Press kit', href: '', url: canonical },
  ];
  const repoHost = REPO_URL.replace(/^https:\/\//, '');
  const body = html`<a class="skip" href="#main">Skip to the press kit</a>
${masthead(model, UP)}
${crumbs(crumbList)}
<main id="main">
<h1 class="page-title">Press kit</h1>
<p class="lede">${APP_NAME} puts what US pharmacies pay for a drug next to what Medicare pays for it, with a source and a date on every number. This page has what you need to write about it. Every number on it is computed from the data in this build of the site, by the same code as the drug pages.</p>
<section class="prose" aria-labelledby="h-numbers">
<h2 id="h-numbers">The headline numbers</h2>
<p>The example ${APP_NAME} leads with is ${f.name}, ${f.qtyText}: ${drugKind(f)} whose gap between the two figures is large, but not so large that the two may not measure the same thing.</p>
${headline(f)}
<h3>In this build</h3>
<ul class="press-facts">
<li><span class="press-count" data-count="products">${formatCount(pf.products)}</span> drug products, as the CMS NADAC file names them</li>
<li><span class="press-count" data-count="ndcs">${formatCount(pf.ndcs)}</span> NDCs (National Drug Codes, the numbers on the packages)</li>
<li><span class="press-count" data-count="medicare">${formatCount(pf.withMedicare)}</span> of the products with a Medicare figure</li>
</ul>
<h3>Source dates</h3>
<ul class="footer-sources">
${sourceList(model)}
</ul>
</section>
<section class="prose" aria-labelledby="h-paste">
<h2 id="h-paste">A paragraph you can paste</h2>
<p class="why">Written to be quoted as it stands. Its numbers are this build’s.</p>
<blockquote class="paste"><p>${paragraph}</p></blockquote>
</section>
${pictures(f)}
<section class="prose" aria-labelledby="h-cite">
<h2 id="h-cite">Cite it</h2>
<p>Each release is archived on Zenodo with its data.</p>
<ul class="link-list">${joinHtml(
    dois.map((d) => html`<li>${d.description}: ${link(`https://doi.org/${d.doi}`, d.doi, ' rel="noopener"')}</li>`),
    '',
  )}</ul>
<p>GitHub’s “Cite this repository” gives the same citation from ${link(`${REPO_URL}/blob/main/CITATION.cff`, 'CITATION.cff', ' rel="noopener"')}.</p>
</section>
<section class="prose" aria-labelledby="h-contact">
<h2 id="h-contact">Contact</h2>
<p>Questions and interview requests go through GitHub issues: ${link(`${REPO_URL}/issues`, `${repoHost}/issues`, ' rel="noopener"')}. Anyone can read them, so leave out anything private.</p>
<p>A number you think is wrong: “Wrong? Tell us” on its card or drug page opens an issue with the product, the figure and its source file filled in. A security problem: report it privately, as ${link(`${REPO_URL}/blob/main/SECURITY.md`, 'SECURITY.md', ' rel="noopener"')} explains.</p>
</section>
<section class="prose" aria-labelledby="h-honesty">
<h2 id="h-honesty">How to read these prices</h2>
${honestyList()}
</section>
</main>
${footer(model, UP)}`;
  const head = headHtml({
    title,
    description,
    canonical,
    ogImage: `${SITE_URL}${ogImagePath('site')}`,
    ogAlt: `${APP_NAME}: what pharmacies pay and what Medicare paid, with a source and date on every number.`,
    up: UP,
  });
  return {
    path: PRESS_PATH,
    file: `${PRESS_PATH}index.html`,
    html: page({ head: head.s, body: body.s, ld: '' }),
    title,
    description,
    facts: pf,
    paragraph,
  };
}

