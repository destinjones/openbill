# One page that tells a person what their medical care and drugs actually cost, with a source and a date on every single number.

**Pharmacies pay $3.35 for 30 aripiprazole 10 mg tablets. Medicare Part D paid $46.50: 13.9×.**
Medicare's figure is its 2024 average spending per dosage unit on generic aripiprazole, all
strengths together, so the multiple is `estimated`. What pharmacies pay is CMS's NADAC, effective
2026-09-23. Medicare's price is not your price. [See the card](https://destinjones.github.io/openbill/#drug=ARIPIPRAZOLE%2010%20MG%20TABLET&qty=30).

**Open it: [destinjones.github.io/openbill](https://destinjones.github.io/openbill/)**

OpenBill is one offline page that puts what US pharmacies pay for a drug next to what Medicare pays for it. Data as of: NADAC week of 2026-10-14; Medicare Part D data year 2024; Medicare Part B October 2026 quarter.

[![CI](https://github.com/destinjones/openbill/actions/workflows/ci.yml/badge.svg)](https://github.com/destinjones/openbill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Data as of 2026-10-14](https://img.shields.io/badge/data%20as%20of-2026--10--14-informational)](docs/DATA-QUALITY.md)
![Runtime dependencies: none](https://img.shields.io/badge/runtime%20dependencies-none-brightgreen)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23457871.svg)](https://doi.org/10.5281/zenodo.23457871)

Not medical advice. Not a lead-gen funnel. No account, no ads, no tracking, no paywall.

![The OpenBill card on a 360px-wide phone screen, light theme: ARIPIPRAZOLE 10 MG TABLET, 31 NDCs, priced per each. Pharmacy pays $3.35, filed: 30 × $0.11173 per EA, CMS NADAC, effective 2026-09-23, file as of 2026-10-14. Medicare Part D paid $46.50, filed: 30 × $1.54994 per EA, the Part D average for 2024, with the line "Medicare's price is not your price." Cost-plus estimate $8.85, estimated: $3.35 (NADAC) × 1.15 + $5.00 fee, what a pharmacy that paid NADAC and charged cost + 15% + a $5.00 fee would charge; not a price anyone quoted. The spread: 13.9×, estimated.](docs/img/card-360.png)

## What it shows

Search a drug. The card shows:

1. what pharmacies pay: CMS NADAC, the national average drug acquisition cost
2. Medicare's reference price: Part D, or Part B when there is no usable Part D figure
3. the spread: the multiple between the two, stated plainly
4. a cost-plus estimate: what pharmacies pay, plus 15%, plus a $5.00 fee, always `estimated`
5. if you type what you were charged, that amount as a multiple of the two figures above
6. the state, source, file, effective date and retrieved date of every number
7. "Wrong? Tell us", a link that opens a prefilled GitHub issue

**The cost-plus estimate is not a cash price.** No source of cash prices may be reused: the
companies and pharmacies that publish them forbid storing or copying them. So OpenBill works
out what a pharmacy would charge if it priced the way Cost Plus Drugs describes (its cost plus
a 15% markup and a $5.00 fee) and paid NADAC. It copies no price from anyone, and it is not
compared with NADAC as a spread, because it is built from NADAC
([decision 39](docs/DECISIONS.md#39-no-cash-prices-a-cost-plus-estimate-from-nadac-instead)).

**What you were charged stays with you.** The amount is worked out in your browser. OpenBill
never sends or saves it. It is kept after the `#` in the address, so you can share your own card
if you want to, and so your browser's history keeps it like any other page you visit
([decision 40](docs/DECISIONS.md#40-what-you-were-charged-the-readers-own-number-never-stored-or-sent)).

**Drug pages.** On the website every product also has a static page with its numbers in the
page itself, plus a page per FDA drug class and an A to Z index. They are built when the site
is deployed, are not committed, and run no script; each links to its interactive card
([decision 41](docs/DECISIONS.md#41-static-drug-pages-built-on-deploy-and-not-committed)).

Drugs only so far. No procedures, no insurance matching, no accounts. Hospital price files
come later.

## How it works

```
tools/fetch_*.py      network -> tools/cache/ + manifest.json (sha256, ETag, dates)
tools/build_drugs.py  tools/cache/ -> data/drugs.json      (offline; filed facts only)
build.js              src/ + data/ -> openbill.html, methodology.html, docs/DATA-QUALITY.md
tools/site.mjs        the built pages + data/ -> _site/ (drug, class and A-Z pages, previews,
                      sitemap; on deploy only, never committed)
```

1. **Fetch.** Each fetcher downloads its government files into `tools/cache/`, skipping
   any file the server reports unchanged (same ETag and Last-Modified), and records each
   file's sha256 in the manifest. With no network it checks the cached copies instead.
2. **Build data.** `tools/build_drugs.py` reads the cache and writes
   `data/drugs.json`. Python only copies numbers printed in a source file and joins them on
   identity keys (the NDC, or names for Part D). It calculates nothing.
3. **Build the page.** `build.js` inlines the code, styles, fonts and data into
   [openbill.html](openbill.html), and writes [methodology.html](methodology.html) and
   [docs/DATA-QUALITY.md](docs/DATA-QUALITY.md). Every calculation is a rule in
   `src/core/rules.js`, the same code the page, the methodology page and the tests use.

Every number is in one of four states, shown on the card:

- `filed`: read from a published government file (NADAC, ASP, a fee schedule). Strongest.
- `published`: from a payer's or provider's own published rate.
- `derived`: computed from a published rule (e.g. Medicare pays 80% of the fee schedule).
- `estimated`: inferred, with the reason recorded.

## Accuracy and provenance

- A price is a **range to expect**, never a quote.
- **Medicare's price is not your price.** Say so on every screen that shows it.
- State which dataset and which effective date produced every figure.
- If a source is stale or a file is empty, show that rather than a zero.
- Disclaimer footer: not medical advice, no warranty, other people's data can be wrong.

Every number on the card shows its state, source, file, effective date and retrieved date,
always visible. The provenance panel adds the reason, the NADAC explanation codes, the NDCs
and the formula. A blank or unreadable cell in a source file is never shown as zero: the
card says "We don't know yet" and explains why.

The sources, their licences and terms are in [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).
The design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and the reasons behind it are
in [docs/DECISIONS.md](docs/DECISIONS.md).

## Run it

Visit [https://destinjones.github.io/openbill/](https://destinjones.github.io/openbill/), or download
[openbill.html](openbill.html) and open it in a browser. It works from a `file://` URL, offline,
and makes no network requests. Its data is inlined compressed, unpacked by the browser's
own `DecompressionStream` and checked against the sha256 the build recorded, so it needs Chrome or Edge 103+, Firefox 113+ or Safari 16.4+; an
older browser gets a plain message saying it cannot unpack the data, and no figures.

`openbill.html` is an ordinary file, but the data it is built from, `data/drugs.json` (~38 MB),
is stored with [Git LFS](https://git-lfs.com) so each weekly refresh doesn't add a full copy to
the repository's history. Install Git LFS before you clone, or run `git lfs install && git lfs pull`
afterwards; without it the file is a small pointer and `node build.js` and the tests say so.

To rebuild from scratch you need Python 3.10+ (standard library only) and Node 20+. The
commands below say `python3`; on Windows the command is usually `python` (the npm scripts
`npm run fetch` and `npm run data` call `python`).

```bash
python3 tools/fetch_all.py     # download every source into tools/cache/ (NADAC alone is 107 MB)
python3 tools/build_drugs.py   # tools/cache/ -> data/drugs.json
node build.js                  # -> openbill.html, methodology.html, docs/DATA-QUALITY.md
```

To run the tests:

```bash
npm ci                                  # the one dev dependency, @playwright/test
node --test                             # unit, data, spot-check, sync, quality and link tests
node build.js --check                   # fails if a generated file is out of date
npx playwright install chromium firefox webkit   # add --with-deps on Linux
npx playwright test                     # Chromium, Firefox and WebKit; 360px and desktop
```

The browser checks run in Chromium at 360px and desktop, light and dark; in Firefox at desktop,
light (Playwright's Firefox has no phone emulation); and in WebKit, Safari's engine, at 360px
light and desktop dark. Those are Playwright's current builds, so the oldest versions named
above are when those browsers added the format the page needs to `DecompressionStream`, not a
tested result ([decision 33](docs/DECISIONS.md#33-the-page-checks-the-inline-datas-sha256-browser-checks-run-in-chromium-firefox-and-webkit)).

`node tools/shots.mjs` remakes the README screenshots in `docs/img/` from `openbill.html`
(run `node build.js` first). `node tools/site.mjs --out ../openbill-site --limit 20` builds a
small copy of the website, with drug pages for the first 20 products and the showcase; see
[CONTRIBUTING.md](CONTRIBUTING.md#the-website).

To check the numbers by hand against the government files, use
[docs/HAND-CHECK.md](docs/HAND-CHECK.md): ten products, where each figure is in each raw file,
and the value to expect.

## Cite it

Each release is archived on Zenodo with the data inside it. To cite OpenBill, use the DOI for
all versions, [10.5281/zenodo.23457871](https://doi.org/10.5281/zenodo.23457871), which always resolves to the newest
release; v0.1.0 alone is [10.5281/zenodo.23457872](https://doi.org/10.5281/zenodo.23457872). GitHub's "Cite this repository"
button gives the same citation from [CITATION.cff](CITATION.cff).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): how to run and test it, the house rules, a map of
the repo and six good first issues. Found a wrong number? Use "Wrong? Tell us" on the card;
[CONTRIBUTING.md](CONTRIBUTING.md#reporting-a-wrong-price) explains what to include.
Security issues go privately, as described in [SECURITY.md](SECURITY.md).

MIT licensed; see [LICENSE](LICENSE). The data comes from US government sources, each with
its own terms, listed in [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).
