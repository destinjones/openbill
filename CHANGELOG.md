# Changelog

All notable changes to OpenBill are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Data refreshes are listed too, with the source dates they bring in.

## [Unreleased]

### Added

- The Zenodo DOI in the README and `CITATION.cff`: 10.5281/zenodo.23457871 for all versions, 10.5281/zenodo.23457872
  for v0.1.0.
- The website, `destinjones.github.io/openbill`, deployed from `main` by
  `.github/workflows/pages.yml` with the real data file (decision 38).
- A cost-plus estimate on every card that has a pack total (5,924 of 5,936 products): the pack
  at NADAC, plus 15% rounded to the cent, plus $5.00 per fill, shipping not included. It is
  always `estimated`, and it is a model, not a price any pharmacy quoted. OpenBill copies no
  price from Cost Plus Drugs or anyone else, and no spread is computed against the estimate.
  `COST_PLUS`, `costPlusEstimate()` and the `cost-plus` rule are in `src/core/rules.js`
  (decision 39).
- "What were you charged?": an optional amount on the card, shown as a multiple of what
  pharmacies pay and of the cost-plus estimate and labelled as the reader's own number. It is
  never sent or saved by OpenBill; it rides in the URL hash (`&paid=`), so the browser's history
  keeps it, and the card says so. `parsePaid()`,
  `paidComparison()` and the `what-you-paid` rule are in `src/core/rules.js` (decision 40).
- Static drug pages on the website, built on deploy by `tools/site.mjs` and not committed: one
  per product with its numbers in the HTML, one per FDA pharmacologic class, an A–Z index, a
  preview image per product, and `sitemap.xml`. They run no script and use the same core rules
  as the card (decisions 41 to 44). `src/core/slug.js` and `src/core/related.js` (classes, brand
  and generic siblings, related drugs) are new and unit-tested.
- `identity.pharm_classes` in `data/drugs.json`: FDA's `PHARM_CLASSES` for the row's exact
  package. Present on 24,902 of the 27,083 rows with an FDA identity, 329 established classes,
  with the new counts `identity_with_pharm_classes`, `identity_pharm_classes_ambiguous` and
  `epc_classes` (decision 43).
- methodology.html: the cost-plus parameters, their sources and what the estimate is not;
  what happens to the amount a reader types; a section on the drug pages; a limitation on the
  cost-plus model. `docs/DATA-QUALITY.md`: pharmacologic class coverage and cost-plus coverage.
- `docs/HAND-CHECK.md`: a worksheet for checking ten products by hand against the raw
  government files, with where each figure is and the value to expect.
- Product names that share a slug each get a suffix from their own name (`siteSlugs()`,
  decision 46); CI builds the site's pages in the required `test` job. The site has a
  `404.html`.

### Changed

- Links into the website itself are checked against this commit's build of it, not the live
  deploy; the CI `links` job builds the pages first (decision 50).
- The default card, the README and its screenshots show the showcase, ARIPIPRAZOLE 10 MG
  TABLET at 30: pharmacies pay $3.35, Medicare Part D paid $46.50 (2024 average), 13.9×,
  `estimated` (decision 45). They used to show metformin.
- `data/drugs.json` is about 38 MB (was about 35 MB) with the pharmacologic classes. Every
  other byte is unchanged.
- Starting quantity by dosage form: a product priced per EA starts at 30 only when it is an oral
  tablet or capsule (or lozenge or troche) by FDA's dosage form and route, or by its NADAC
  description when FDA does not list it; kits, pens, syringes, vials, patches, inhalers,
  suppositories and anything undecided start at 1, with 1 / 2 / 3 buttons and a reason that
  names the form. Drug-page titles, descriptions and preview cards quote the card's own pack
  total again (decision 48).
- Starting quantity, refined (decision 49): tablets and films taken under the tongue or against
  the cheek (FDA route `SUBLINGUAL` or `BUCCAL`) start at 30 like swallowed ones; a product whose
  NADAC name says tablet or capsule and most of whose FDA-listed NDCs are oral tablets or
  capsules starts at 30, and the reason names the outlier listing (febuxostat 40 and 80 mg,
  sevelamer 800 mg); a product priced per ML or GM whose FDA package is a shipping case, or a
  carton of 10 or more identical bottles, tubes, vials, jars or ampules, starts at one inner unit
  (TACLONEX: 60 g, not a case of 2,400 g). 132 products change; 3,565 products start at 30 and
  656 at 1 per EA, and 91 priced per ML or GM start at one inner unit.
- The preview images stay PNG (`og/<slug>.png`, `og/site.png`, `og:image:type` `image/png`).
  JPEG at quality 80 was tried and made them 14.4% larger (480.1 MiB against 419.5 MiB), so it
  was reverted (decision 48).

### Fixed

- A row with no Part D join no longer says "No Medicare Part D spending row matched this drug by
  brand or generic name", which was false where Part D has a row with the name that the builder
  refused (decision 47).
- A very long `&paid=` in a link no longer stops the card in WebKit and Firefox: `parsePaid()`
  refuses over-long text before any arithmetic.
- The cost-plus fee cites the company's site for the $5.00 and KFF Health News (2023, $3 fee) for
  the method only.
- Drug pages: a counter question names a generic only when FDA lists the same form, route and
  strength; kit and injectable titles give the unit price; the Part D figure is described as an
  all-strength average with "Medicare's price is not your price."; the preview cards' quantity,
  state chips and dates are legible at link-preview size.
- The Pages build job has read-only permissions and a started deploy is never cancelled; the
  preview renderer runs with JavaScript off; `--out` is emptied only when it holds the
  `.openbill-site` marker.

## [0.1.0] - 2026-10-18

Phase 1: drugs.

### Added

- NADAC fetch and build. `tools/fetch_nadac.py` finds the newest yearly NADAC dataset on
  data.medicaid.gov, downloads it only when it changes, and records its sha256, size and
  ETag in `tools/cache/manifest.json`. `tools/build_drugs.py` keeps the newest weekly file
  in it (As of Date 2026-10-14, 30,031 NDCs) and writes `data/drugs.json`, one row per NDC
  with a provenance record on every price.
- Fetchers for the FDA NDC Directory (`tools/fetch_fda_ndc.py`), Medicare Part D Spending
  by Drug (`tools/fetch_partd.py`) and the Part B payment limit and crosswalk files
  (`tools/fetch_asp.py`), sharing one cache and sha256 manifest (`tools/cachelib.py`);
  `tools/fetch_all.py` runs them all, and `--offline` verifies the cache without the network.
- FDA NDC Directory identity join: each NADAC NDC matched exactly to its FDA package NDC for
  names, dosage form, strength, labeler and package description.
- Medicare reference prices: Part D average spending per dosage unit (data year 2024),
  joined by brand and generic name, and Part B payment limits (October 2026 quarter), joined
  by exact NDC through the ASP NDC-HCPCS crosswalk and converted to the NADAC unit. Part D
  comes first, because NADAC measures retail pharmacies and Part D pays for drugs they
  dispense; Part B is used when there is no usable Part D figure, and both show in the
  provenance panel. A spread against Part D is always `estimated`; a spread against Part B
  is `derived` only when one labeler bills under the code. An estimated spread at or beyond
  20× or 0.2× (tested on the unrounded ratio) is still shown, but the card's headline is
  "These two figures may not measure the same thing" instead of a sentence such as "Medicare
  paid 99% less", with the multiple beside it and a caveat saying why. A spread just inside a
  threshold gets the digits that keep it from reading as the threshold (0.2046 is "0.205×").
  Part B labelers are counted as companies, however the crosswalk spells them. A Part D spread
  for a product whose NADAC is 20× or more the other products' under the same Part D name says
  so in its first caveat.
- Part D join rules: a row joins a Part D name CMS marks with `*` (an average over several
  routes) only when it has an FDA identity on the route the name's rows share; rows with no
  identity, on another route or in a tie are counted under `multi_route_no_identity`,
  `multi_route_minority` and `multi_route_tie`. A row with no exact FDA package match can be
  matched (never given an identity) through FDA's record for its product code; trade names
  without a release marker can join their one unmarked Part D row when FDA lists only one
  release family for them; and rows matched by the plain generic name move to the Part D
  presentation their NADAC description names (metformin ER gastric and osmotic tablets).
- Part B package reconciliation for kits NADAC prices per EA (counted as whole kits) and for
  crosswalk lines whose billing-unit columns disagree (settled only when FDA's strength gives
  the same number exactly). `counts.part_b_unit_reconciled_by` says which rule reconciled each
  row. A package size that cannot be reconciled is kept as a `quantity` with no unit, because
  the crosswalk does not state one.
- `data/drugs.json` schema `openbill.drugs/3`: Part D figures are written once per CMS brand
  and generic name (`part_d_names`) and Part B limits once per HCPCS code (`part_b_codes`),
  and each row points at them, because those figures are not per NDC. The file is 35.1 MB
  instead of 60.2 MB. `linkRows()` in `src/core/pack.js` joins the rows to the tables.
- The page, `openbill.html`: search a drug and see what pharmacies pay, Medicare's
  reference price and the spread between them, with the state, source, file, effective date
  and retrieved date on every number, a provenance panel, and a prefilled "Wrong? Tell us"
  issue link. A pack total for the quantity entered keeps the state of the price it
  multiplies. A calculated figure shows each input's own date or period beside it. Ages are
  counted against today's UTC date. Works from `file://`, offline, at 360px and up, light and
  dark. Unpacking its data needs Chrome or Edge 103+, Firefox 113+ or Safari 16.4+; an older
  browser is told plainly that it cannot unpack the data.
- `build.js`: a dependency-free bundler that inlines the code, styles, fonts and the packed
  data, deflate-raw compressed by its own deterministic encoder and base64-encoded (the
  packed JSON is 6.5 MB), and writes a hash-based CSP on every page. The page inflates the
  data with the browser's `DecompressionStream`, checks it against the byte count and sha256
  the build recorded, and shows no figures if they differ. `node build.js --check` fails when a
  generated file is out of date.
- `methodology.html`, generated by `build.js` from the same constants and rules the page runs
  and from `data/drugs.json`: what OpenBill shows and does not show, the four states, every
  rule, the honesty wording, each source with its file, sha256 and dates, how the joins work
  and what they cover (the multi-route Part D rule and the Part B kit and strength rules
  included), the NADAC explanation codes, known limitations (the browser floor and UTC ages
  included), how to reproduce the build and how to report a wrong number.
- `docs/DATA-QUALITY.md`, generated by `build.js`: rows and records by state, source and
  reference coverage, unmatched reasons, each source's dates and age, carried-forward NADAC
  rows, outliers, rejected rows, and the quality floors with PASS or FAIL.
- Tests (`node --test`): core units; `data.test.js` (schema and provenance on every record,
  the NDC join, table keys, one shared route per `*` Part D name, consistent Part D joins
  within a product, the kit and strength-check rules); `spotchecks.test.js` (34 values in
  `tests/spotchecks.json`, each pinned to its source file and independently verified; at
  least ten must apply);
  `build.test.js` (generated files in sync, CSP hashes, inline data unpacks to
  `data/drugs.json`); `quality.test.js` (at least 70% of rows filed, an https URL on every
  source, a source URL on every record, no dollar value at or below 0, every record valid,
  every unmatched reason described, methodology.html describing what the page does);
  `docs-links.test.js` (every relative link and anchor in the docs and both pages, the same
  browser floor in every doc that states it, the browsers the Playwright config runs named in
  README and CONTRIBUTING; external links with `OPENBILL_CHECK_EXTERNAL=1`). Browser checks in
  `tests/browser/` (Playwright): Chromium at 360px and desktop, light and dark; Firefox at
  desktop, light; WebKit at 360px light and desktop dark.
- Docs: README, CONTRIBUTING, SECURITY, GOVERNANCE, CODE_OF_CONDUCT, LICENSE (MIT),
  `docs/ARCHITECTURE.md`, `docs/DATA_SOURCES.md` and `docs/DECISIONS.md` (38 decisions); issue forms for a
  wrong price, a missing drug and a bug; a pull request template; the CI workflow; a
  devcontainer.
- README screenshots of the card (`docs/img/`, 360px light and dark, 1280px light), made
  from `openbill.html` by `node tools/shots.mjs`.
- `CITATION.cff` and `.zenodo.json`, so GitHub's "Cite this repository" and Zenodo's record
  for each release carry the same title, author, licence and version; `tests/citation.test.js`
  keeps them in step with `package.json`.

### Changed

- `data/drugs.json` is stored in Git LFS, so each data refresh adds one LFS object instead of a
  full copy to the history. CI fetches and caches the LFS objects; the devcontainer installs Git
  LFS; `build.js` and `tests/lfs.test.js` say plainly when the file is only an LFS pointer
  (decision 35).
- An NDC whose package is not in the FDA NDC Directory may take its route from FDA's record for
  the same product, so it can join a Part D name that averages several routes; the provenance
  panel says so (decision 37). Majority-route rows keep the multi-route average, disclosed
  (decision 36).

[Unreleased]: https://github.com/destinjones/openbill/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/destinjones/openbill/releases/tag/v0.1.0
