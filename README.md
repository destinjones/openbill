# One page that tells a person what their medical care and drugs actually cost, with a source and a date on every single number.

OpenBill is one offline page that puts what US pharmacies pay for a drug next to what Medicare pays for it. Data as of: NADAC week of 2026-10-14; Medicare Part D data year 2024; Medicare Part B October 2026 quarter.

[![CI](https://github.com/destinjones/openbill/actions/workflows/ci.yml/badge.svg)](https://github.com/destinjones/openbill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Data as of 2026-10-14](https://img.shields.io/badge/data%20as%20of-2026--10--14-informational)](docs/DATA-QUALITY.md)
![Runtime dependencies: none](https://img.shields.io/badge/runtime%20dependencies-none-brightgreen)

Not medical advice. Not a lead-gen funnel. No account, no ads, no tracking, no paywall.

![The OpenBill card on a 360px-wide phone screen, light theme: METFORMIN HCL 500 MG TABLET, 57 NDCs, quantity 60. Pharmacy pays $0.87, filed, 60 × $0.01451 per EA, from the CMS NADAC file as of 2026-10-14, effective 2026-09-23. Below it, Medicare Part D paid $3.39, filed.](docs/img/card-360.png)

## What it shows

Search a drug. The card shows:

1. what pharmacies pay: CMS NADAC, the national average drug acquisition cost
2. Medicare's reference price: Part D, or Part B when there is no usable Part D figure
3. the spread: the multiple between the two, stated plainly
4. the state, source, file, effective date and retrieved date of every number
5. "Wrong? Tell us", a link that opens a prefilled GitHub issue

Phase 1 is drugs only. No procedures, no insurance matching, no accounts. Hospital price
files come later.

## How it works

```
tools/fetch_*.py      network -> tools/cache/ + manifest.json (sha256, ETag, dates)
tools/build_drugs.py  tools/cache/ -> data/drugs.json      (offline; filed facts only)
build.js              src/ + data/ -> openbill.html, methodology.html, docs/DATA-QUALITY.md
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

Open [openbill.html](openbill.html) in a browser. It works from a `file://` URL, offline,
and makes no network requests. Its data is inlined compressed, unpacked by the browser's
own `DecompressionStream` and checked against the sha256 the build recorded, so it needs Chrome or Edge 103+, Firefox 113+ or Safari 16.4+; an
older browser gets a plain message saying it cannot unpack the data, and no figures.

`openbill.html` is an ordinary file, but the data it is built from, `data/drugs.json` (~35 MB),
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
(run `node build.js` first).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): how to run and test it, the house rules, a map of
the repo and six good first issues. Found a wrong number? Use "Wrong? Tell us" on the card;
[CONTRIBUTING.md](CONTRIBUTING.md#reporting-a-wrong-price) explains what to include.
Security issues go privately, as described in [SECURITY.md](SECURITY.md).

MIT licensed; see [LICENSE](LICENSE). The data comes from US government sources, each with
its own terms, listed in [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).
