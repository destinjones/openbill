# Contributing to OpenBill

Thanks for helping. One thing matters more than the rest: every number OpenBill shows needs a
source and a date. If a change adds a number, it adds where that number came from.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before you write code. It is the contract
the code is built against; if the code and that file disagree, fix one of them in the same
change. [docs/DECISIONS.md](docs/DECISIONS.md) says why things are the way they are.

## Run it

Open [openbill.html](openbill.html) in a browser. That's the whole product: one file that
works offline from a `file://` URL. The data inside it is compressed and unpacked with the
browser's own `DecompressionStream`, so it needs Chrome or Edge 103+, Firefox 113+ or Safari
16.4+ (decision 26 in [docs/DECISIONS.md](docs/DECISIONS.md)).

To work on it you need Python 3.10+ (standard library only) and Node 20+ (CI uses 22). The
commands below say `python3`, which is the name on macOS and most Linux systems; on Windows
it is usually `python`. The npm scripts `npm run fetch` and `npm run data` call `python`.
`npm ci` installs the only dev dependency, `@playwright/test`. Or open the repo in the
devcontainer (`.devcontainer/devcontainer.json`), which sets up Node 22, Python 3.12, Git LFS
and Playwright's Chromium, Firefox and WebKit for you.

`data/drugs.json` (~38 MB) is stored with [Git LFS](https://git-lfs.com), so each data refresh
adds one LFS object instead of a full copy to the git history (decision 35). Install Git LFS
before you clone, or run `git lfs install && git lfs pull` afterwards. Without it the file is a
short pointer: `node build.js` stops with that message, and `tests/lfs.test.js` fails first.
A refresh commits the rebuilt file as usual; the LFS filter in `.gitattributes` does the rest.

| Command | What it does |
|---|---|
| `python3 tools/fetch_all.py` | fetch every source into `tools/cache/` (skips unchanged files) |
| `python3 tools/fetch_nadac.py` | fetch one source; `--offline` never touches the network, `--force` re-downloads |
| `python3 tools/build_drugs.py` | `tools/cache/` -> `data/drugs.json` |
| `node build.js` | write `openbill.html`, `methodology.html`, `docs/DATA-QUALITY.md` |
| `node tools/shots.mjs` | remake the README screenshots in `docs/img/` from `openbill.html` (after `node build.js`) |
| `node tools/site.mjs --out <dir>` | build the website (drug, class and A–Z pages, the press kit, preview images, sitemap) into `<dir>`; see [The website](#the-website) |
| `node tools/record.mjs --out <dir>` | record the reveal clips (6-second GIFs of the card, 16:9 and 9:16) into `<dir>`, outside the repository |

The other fetchers are `fetch_fda_ndc.py`, `fetch_partd.py` and `fetch_asp.py`, with the same
flags. The builders never need the network once `tools/cache/` is filled; `tools/cache/` is
never committed.

If you change anything in `src/` or `data/`, run `node build.js` and commit the regenerated
files with your change. The sync test fails otherwise.

### The website

The deployed site is more than the app. `tools/site.mjs` writes one static page per product
(`drug/<slug>/`), one per FDA pharmacologic class (`class/<slug>/`), an A–Z index
(`drugs/<letter>/`), a preview image per product (`og/<slug>.png`), the press kit (`press/`,
with its pictures and the reveal clips) and `sitemap.xml`, next to
copies of `openbill.html`, `methodology.html` and `data/drugs.json`. The Pages workflow runs it
on every deploy. Its output is never committed
([decision 41](docs/DECISIONS.md#41-static-drug-pages-built-on-deploy-and-not-committed)).

To look at it locally, run `node build.js` first (the generator copies the built pages), then
write a small site to a folder outside the repository:

```bash
node tools/site.mjs --out ../openbill-site --limit 20 --no-og   # 20 drug pages + the showcase, no images
node tools/site.mjs --out ../openbill-site --only "ARIPIPRAZOLE 10 MG TABLET"
node tools/site.mjs --out ../openbill-site                      # the whole site, as deployed
```

The press kit's numbers, counts and paragraph come from the data on every build. Its pictures
(the wordmark, three screenshots and the reveal clips) are rendered with the preview images, so
`--no-og` skips them too; `node tools/record.mjs --out ../openbill-media` records just the clips
([decision 51](docs/DECISIONS.md#51-launch-assets-a-press-kit-and-a-reveal-clip-built-on-every-deploy)).

`--limit N` builds drug pages and preview images only for the first N products by name, plus
the showcase; class and A–Z pages are always complete, so some of their links lead nowhere in a
limited build. `--only NAME` (repeatable) builds just those products. `--no-og` skips the
preview images, which need Playwright's Chromium (`npx playwright install chromium`). The output
folder must be empty or one the tool wrote before. The pages run no script and load their
stylesheet and fonts by relative links, so a page opens from `file://`. Links between pages
point at folders, though, so browsing is easier with any static file server pointed at the
folder.

The generator stops if two product names share a slug, instead of picking one URL for both.

## Test it

```bash
node --test              # unit, data, spot-check, sync, quality-floor and docs-link tests
node build.js --check    # exit 1 if openbill.html, methodology.html or DATA-QUALITY.md is stale
npx playwright test      # browser checks in Chromium, Firefox and WebKit
```

The first time, run `npx playwright install chromium firefox webkit` (add `--with-deps` on
Linux). The projects in `playwright.config.js` run Chromium at 360px and desktop, light and
dark; Firefox at desktop, light (Playwright's Firefox has no phone emulation); and WebKit,
Safari's engine, at 360px light and desktop dark. Run one engine with
`npx playwright test --project=webkit-mobile-light` and so on; `--browser` is refused because
the config defines projects. These are Playwright's current browser builds, so the oldest
versions named above are not a tested result
([decision 33](docs/DECISIONS.md#33-the-page-checks-the-inline-datas-sha256-browser-checks-run-in-chromium-firefox-and-webkit)). The docs
link test checks relative links and anchors; to check external links too, run
`OPENBILL_CHECK_EXTERNAL=1 node --test tests/docs-links.test.js`. CI runs all of this on
every push and pull request.

## House rules

From the project brief. Do not break these.

- **One self-contained page.** Vanilla JS, no framework, data inlined by a build script.
  It must work from a `file://` URL and keep working offline.
- **No runtime third-party requests.** Fonts self-hosted. No CDN at runtime.
- **Phone-first.** 44px minimum controls, 16px inputs, tested from 360px up, light and dark.
- **Every number carries provenance.** No exceptions, no "approximately".
- **Never invent a number.** If you can't source it, mark it `estimated` and write why.
- **Core is DOM-free and unit-tested.** Maths and rules never touch the DOM.
- `esc()` everything rendered. CSP meta on every page. SRI on any external file.
- Honest edges over polished lies. "We don't know yet" is a valid answer to show.

And from the same brief:

- Do not scaffold endlessly before producing a real number from real data.
- Do not add a framework, a router, a state library or a CSS framework.
- Do not download all hospital price files in phase 1.
- Do not soften the provenance panel to make the UI cleaner.
- Do not claim a number is a quote.

What that means in practice:

- A blank or unparseable cell in a source file is never written as 0. Leave the record out
  and explain the gap.
- Python reads files and copies filed facts. Every calculation is a rule in
  `src/core/rules.js`.
- Downloaded files are untrusted data. Parse them with the standard library; never execute
  anything from them.
- Nothing generated contains a build time. The same inputs give byte-identical outputs.

## Where to start

```
tools/
  cachelib.py          shared download cache: ETag check, sha256 manifest, --offline, --force
  fetch_all.py         run every fetcher
  fetch_nadac.py       CMS NADAC, weekly (the pattern for every other fetcher)
  fetch_fda_ndc.py     FDA NDC Directory, the identity key for every drug
  fetch_partd.py       Medicare Part D Spending by Drug, annual
  fetch_asp.py         Medicare Part B payment limits + NDC-HCPCS crosswalk, quarterly
  build_drugs.py       tools/cache/ -> data/drugs.json
  shots.mjs            README screenshots of openbill.html -> docs/img/ (Playwright)
  site.mjs             the website: drug, class and A–Z pages, press kit, previews, sitemap -> --out
  record.mjs           the reveal clip, 6-second GIFs of the card (Playwright) -> --out
  gif.mjs              the GIF encoder record.mjs uses (no dependency)
  cache/               raw downloads + manifest.json (sha256). Never committed.
data/drugs.json        schema openbill.drugs/3: Part D and Part B tables, then one row per
                       NDC, one per line
src/core/              DOM-free ES modules, unit-tested:
                         provenance, money, ndc, dates, sources, rules, search,
                         pack, report, esc, sha256, config, slug, related
src/app/               the page: index.html, styles.css, app.js (the only DOM code), fonts/
src/build/             methodology.js and quality.js, used by build.js;
                       drugpage.js, presspage.js and reveal.js, used by tools/site.mjs
src/site/              the static pages' stylesheet, the preview card's and the reveal clip's
build.js               bundler and generator
openbill.html          generated page, committed
methodology.html       generated, committed
tests/                 *.test.js (node --test), spotchecks.json, browser/*.spec.js (Playwright)
docs/                  ARCHITECTURE (the contract), DATA_SOURCES, DECISIONS,
                       DATA-QUALITY (generated), HAND-CHECK (the by-hand worksheet)
.github/               CI, issue forms, pull request template
```

Pick by what you know:

- **Data and Python:** `tools/`. Copy the shape of `tools/fetch_nadac.py` for a new source
  (it does its downloading and hashing through `tools/cachelib.py`), add it to the sources
  table in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and document it in
  [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).
- **Rules and numbers:** `src/core/rules.js` and its tests. The methodology page is built from
  the same `RULES`, so a new rule documents itself.
- **The page:** `src/app/`. Check it at 360px, light and dark.
- **Checking our work:** add a spot check to `tests/spotchecks.json`. Find the row in the
  source file yourself and record which file and how you verified it.
  [docs/HAND-CHECK.md](docs/HAND-CHECK.md) shows how to find each figure of ten products in
  the raw files. The NADAC CSV is too long for Excel, so search it as text.

## Reporting a wrong price

Use "Wrong? Tell us" on the card. It opens the
[wrong price form](https://github.com/destinjones/openbill/issues/new?template=wrong-price.yml)
with the details from the card (product, NDC, figure, value shown, source file, build)
filled in.

Then add:

- **what is wrong**, and what you think the number should be
- **evidence**: the source file and the row, or a link to the official dataset page. A
  pharmacy receipt or a price from a website is useful context, but it isn't evidence that a
  government file was read wrong.

Don't post your own or anyone else's health information.

A maintainer checks the number against the source file. If OpenBill read, joined or
calculated it wrong, we fix it and add a spot check. If the source file itself is wrong, we
don't change the number; we say so on the issue and point to the publisher. The details are
in [GOVERNANCE.md](GOVERNANCE.md#data-corrections).

A drug that's missing goes in the
[missing drug form](https://github.com/destinjones/openbill/issues/new?template=missing-drug.yml).
Anything else broken goes in the
[bug form](https://github.com/destinjones/openbill/issues/new?template=bug.yml).

## Pull requests

- Keep them small: one source, one rule or one screen per pull request.
- Fill in the checklist in the pull request template. In short: every new number has a
  provenance record, nothing is invented, `node build.js --check`, `node --test` and
  `npx playwright test` pass, UI changes come with 360px light and dark screenshots, sources
  are documented in [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md), and
  [CHANGELOG.md](CHANGELOG.md) has a line under Unreleased.
- A change to the contract, a source or how a number is computed also adds an entry to
  [docs/DECISIONS.md](docs/DECISIONS.md).

By contributing you agree your work is released under the [MIT licence](LICENSE) and that
you'll follow the [code of conduct](CODE_OF_CONDUCT.md).

## Maintainer notes

A new repository needs its issue labels created once. The issue forms in
`.github/ISSUE_TEMPLATE/` apply the labels `wrong-price`, `missing-drug` and `data` (and `bug`,
which GitHub creates in every new repository). GitHub does not apply a form label that does not
exist in the repository, so without these, reports arrive unlabelled and triage by label finds
nothing. With the [GitHub CLI](https://cli.github.com/):

```sh
gh label create wrong-price --description "A figure on a card looks wrong"
gh label create missing-drug --description "A drug OpenBill does not show"
gh label create data --description "About the data, not the code"
```

Git LFS use counts against the repository owner's account. GitHub's free plan includes 10 GiB
of LFS storage and 10 GiB of LFS bandwidth a month
([GitHub Docs](https://docs.github.com/en/billing/concepts/product-billing/git-lfs)). Each
refresh stores one ~38 MB object, about 2 GB a year. CI caches the LFS objects by id
(`.github/workflows/ci.yml`), so a run downloads the file only when it has changed; clones and
CI cache misses spend bandwidth. Check usage under the account's billing settings now and then,
and decide on more storage or another home for old data well before storage reaches the limit.

## Good first issues

Each is scoped to a few files and builds on code that exists. Say on the issue (or open
one) before you start, so two people don't do the same one.

### 1. Federal Upper Limits as a second filed reference

The "ACA Federal Upper Limits" dataset on data.medicaid.gov is the Medicaid ceiling for
multiple-source drugs, priced per unit and listed by NDC (written 5-4-2, like
`23155-0051-01`). Like NADAC, its CSV is cumulative: over two million rows with `year` and
`month` columns, so keep only the newest month. Its units are Medicaid unit types such as
`TAB`, not NADAC's `EA`, `ML` and `GM`: reconcile them explicitly, or leave the record out.

- Files: new `tools/fetch_ful.py` (reuse the DKAN lookup in `tools/fetch_nadac.py` and the
  cache and manifest code in `tools/cachelib.py`), `tools/build_drugs.py` (a `ful` source
  and row field), `docs/ARCHITECTURE.md` (sources table and row schema),
  `docs/DATA_SOURCES.md`, `tests/data.test.js`, `tests/spotchecks.json`.
- Why: a second government price joined by exact NDC. For generics with no Part B price,
  it is a filed comparison where today there is only a name-matched Part D estimate.

### 2. RxNorm identity: one product for brand, generic and dose

Products are grouped by NADAC description, so `ATORVASTATIN 20 MG TABLET` (69 NDCs) and
`LIPITOR 20 MG TABLET` (1 NDC) are two separate products with separate cards. Search can
reach Lipitor through its FDA generic name, and the drug pages list the two as brand and
generic versions because they share it, but nothing says they are the same drug and dose. The openFDA NDC bulk file carries `openfda.rxcui` per product, and the contract
already reserves `identity.rxcui` and an optional `openfda_ndc` source. Careful: RxCUIs are
listed per product NDC and there can be several (product `0378-7185`, metformin 500 mg,
lists three: 861004, 861007 and 861010), so the join needs a rule and a test. Ambiguous
means no match.

- Files: new `tools/fetch_openfda_ndc.py`, `tools/build_drugs.py` (`identity.rxcui`),
  `src/core/search.js` (`groupProducts`), the search tests, `docs/DATA_SOURCES.md`, and a
  new entry in `docs/DECISIONS.md` that supersedes decision 14.
- Why: the brief makes RxNorm a Tier 2 join key, and it closes the gap between what people
  type and what NADAC calls a drug.

### 3. FDA drug shortages on the card

openFDA publishes the FDA Drug Shortages database as an API and a small daily bulk file.
Each record has a `package_ndc` (like `0409-4776-01`), a `status` (`Current`,
`To Be Discontinued`, `Resolved`) and an `availability`. Join on exact NDC with
`normalizeNdc()` and show a line on the card when an NDC is in a current shortage.

- Files: new `tools/fetch_shortages.py`, `tools/build_drugs.py`, `src/core/sources.js`
  (`SOURCE_INFO`, daily cadence), `src/app/app.js`, `docs/ARCHITECTURE.md`,
  `docs/DATA_SOURCES.md`, tests.
- A shortage is a status, not a number, and price records require a numeric `value`.
  Propose how its provenance is recorded in `docs/ARCHITECTURE.md` first.
- Why: a low price doesn't help if the drug can't be bought. Shortages are Tier 2 in the
  brief.

### 4. An `?embed=1` light card

A stripped-down view for embedding a card in an article: the card, its state chips and
provenance line, "Medicare's price is not your price", the disclaimer and a link to the
full page. Nothing else.

- Files: `src/app/app.js` (read `location.search` once at start; the card state stays in
  the hash), `src/app/styles.css`, a new spec in `tests/browser/` at 360px light and dark,
  and the parameter documented in `docs/ARCHITECTURE.md`.
- The embed still loads the whole inlined page, so measure it. A CSP in a meta tag can't
  set `frame-ancestors`; whoever hosts the page controls framing.
- Why: a card is the unit people share, and an embed must not drop the provenance to fit.

### 5. Medicare negotiated prices for 2026

The first ten Medicare negotiated prices (maximum fair prices) took effect on 1 January
2026, for Eliquis and nine other drugs. CMS publishes them as a CSV inside a ZIP
(`CMS_Negotiation_Program_Selected_Drug_List_and_Maximum_Fair_Price_Data_File_20260921.csv`),
listed by NDC-11 with an `NDC-9 MFP per Unit Price`, an `MFP Effective Date` and an
`MFP End Date`. Rows are
effective-dated: an NDC can have a 2026 row and an inflation-adjusted row from
2027-01-01, so pick the row in effect on the NADAC as-of date. Check its unit against the
row's NADAC unit before comparing them.

- Files: new `tools/fetch_mfp.py` (read the CSV member with `zipfile` in memory),
  `tools/build_drugs.py` (an `mfp` source and row field), `src/core/rules.js`
  (`referencePrice`: where it ranks against Part B and Part D), `docs/ARCHITECTURE.md`,
  `docs/DATA_SOURCES.md`, `docs/DECISIONS.md`, `tests/spotchecks.json`.
- Why: for these drugs it is a filed 2026 price keyed by NDC, which is better evidence than
  a 2024 Part D average matched by name.

### 6. Pack-size presets from the FDA package description

Every row with an FDA identity has a `package_description`. For NDC 0003-0893-21
(`ELIQUIS 2.5 MG TABLET` in NADAC) the FDA NDC Directory says
`60 TABLET, FILM COATED in 1 BOTTLE, PLASTIC (0003-0893-21)`. Parse the simple
"N UNIT in 1 CONTAINER" shape into a count and offer it as a quantity preset on the card.
Skip anything else (kits, nested packages, units that don't match the NADAC unit) rather than
guess.

- Files: `src/core/rules.js` (`packageAmount()` and `packageStart()` already read the mL or g in
  one package, or in one inner unit of a wholesale case or multi-pack, for the starting quantity
  of ML and GM products, decisions 23 and 49; counts of EA units are not read yet) with unit tests in `tests/`, `src/app/app.js` for the presets, a Playwright check in
  `tests/browser/`.
- Why: the card offers 30, 60 and 90 for EA products, which are common supplies, not this
  product's packs. A package count is a filed fact already in `data/drugs.json`, so a preset
  is a real pack size rather than a number we picked.
