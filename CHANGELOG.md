# Changelog

All notable changes to OpenBill are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Data refreshes are listed too, with the source dates they bring in.

## [Unreleased]

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
  `docs/ARCHITECTURE.md`, `docs/DATA_SOURCES.md` and `docs/DECISIONS.md` (34 decisions); issue forms for a
  wrong price, a missing drug and a bug; a pull request template; the CI workflow; a
  devcontainer.
- README screenshots of the card (`docs/img/`, 360px light and dark, 1280px light), made
  from `openbill.html` by `node tools/shots.mjs`.

[Unreleased]: https://github.com/destinjones/openbill/commits/main
