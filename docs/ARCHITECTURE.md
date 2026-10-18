# Architecture

This is the contract every part of OpenBill builds against. If code and this file disagree,
fix one of them in the same change.

## Pipeline

```
tools/fetch_*.py   network -> tools/cache/<file> + tools/cache/manifest.json (sha256, ETag, dates)
tools/build_drugs.py   tools/cache/ -> data/drugs.json      (offline, deterministic, filed facts only)
build.js           src/ + data/ -> openbill.html, methodology.html, docs/DATA-QUALITY.md
                                                            (offline, deterministic, no timestamps)
```

- **Python reads files; JavaScript applies rules.** Python builders only extract numbers that
  are printed in a source file (state `filed`) and join them on identity keys. Every
  calculation (pack totals, unit conversions, coinsurance, the spread) is a rule in
  `src/core/rules.js`, so the page, the methodology page and the tests use the same code.
- Builders run offline against `tools/cache/`. With no network, `fetch_*.py` verify the cached
  file's sha256 against the manifest and report on it; `build_drugs.py` never touches the network.
- Nothing generated contains a build time. The same inputs give byte-identical outputs.
- Raw downloads (`tools/cache/`) are never committed. `data/`, `openbill.html`,
  `methodology.html` and `docs/DATA-QUALITY.md` are generated and committed; tests fail if they
  are out of sync with their inputs.

## Commands

| Command | What it does |
|---|---|
| `python tools/fetch_all.py` | fetch every source into `tools/cache/` (skips unchanged files) |
| `python tools/fetch_nadac.py` (and `fetch_fda_ndc.py`, `fetch_partd.py`, `fetch_asp.py`) | fetch one source; `--offline` never touches the network, `--force` re-downloads |
| `python tools/build_drugs.py` | cache -> `data/drugs.json` |
| `node build.js` | write `openbill.html`, `methodology.html`, `docs/DATA-QUALITY.md` |
| `node build.js --check` | exit 1 if any generated file is out of date |
| `node --test` | unit, data, spot-check, sync, quality-floor and docs-link tests |
| `npx playwright test` | browser checks in Chromium (360px and desktop, light and dark), Firefox (desktop) and WebKit (360px and desktop) |

Python 3.10+ standard library only; `python` here means Python 3, which is `python3` on most
macOS and Linux systems. Node 20+ with no runtime dependencies; the only dev dependency is
`@playwright/test`.

## Sources (ids used in `data/drugs.json` → `sources`)

| id | Source | Keyed by | Cadence |
|---|---|---|---|
| `nadac` | CMS NADAC, data.medicaid.gov | NDC-11 | weekly |
| `fda_ndc` | FDA NDC Directory (`ndctext.zip`), accessdata.fda.gov | package NDC | daily |
| `partd` | Medicare Part D Spending by Drug (latest data year), data.cms.gov | brand + generic name | annual |
| `asp_limits` | Medicare Part B payment limit file (current quarter), cms.gov | HCPCS | quarterly |
| `asp_crosswalk` | ASP NDC-HCPCS crosswalk (current quarter), cms.gov | NDC-11 → HCPCS | quarterly |

`openfda_ndc` (openFDA NDC bulk file, for RxCUI) is optional; if used it is a source like the others.

## Price records

Every number OpenBill shows is a **record**:

```json
{
  "value": 0.01451,
  "kind": "usd",
  "state": "filed",
  "reason": "Read from the NADAC file, dollars per EA. Explanation code 1: calculated from the most recent pharmacy survey.",
  "source_name": "CMS NADAC",
  "source_url": "https://data.medicaid.gov/dataset/fbb83258-11c7-47f5-8b18-5f8e79f7e704",
  "source_file": "nadac-national-average-drug-acquisition-cost-20261014.csv",
  "effective_date": "2026-09-23",
  "retrieved_date": "2026-10-17",
  "as_of_date": "2026-10-14",
  "per": "EA"
}
```

| field | required | meaning |
|---|---|---|
| `value` | yes | finite number. `kind: "usd"` values are > 0. A blank or unparseable source cell is **never** written as 0; the record is omitted and the absence is explained instead. |
| `kind` | yes | `usd`, `percent` (20 means 20%), `count` (a whole number of things), `quantity` (a measured amount such as 0.4 mL; `per` names the unit when the source states it — an unreconciled crosswalk package size has none), or `ratio` (the spread) |
| `state` | yes | one of `PRICE_STATES` (below) |
| `reason` | yes | non-empty. Why this state; what the number is. Required in substance for `derived` and `estimated`. |
| `source_name` | yes | short label shown on the card, e.g. `CMS NADAC`, `Medicare Part D`, `OpenBill calculation` |
| `source_url` | yes | `https://` landing page for the dataset, or `methodology.html#<rule-id>` for a calculation |
| `source_file` | yes | exact file name the value was read from; for calculations, input files joined with ` + ` |
| `effective_date` | yes | ISO date the value applies from. For period data (an annual average, a quarterly limit) the **start** of the period, and `period` is always set and always shown next to it. |
| `retrieved_date` | yes | ISO date (UTC) the source file was downloaded |
| `as_of_date` | no | ISO date of the source file itself (NADAC "As of Date", dataset release date) |
| `per` | no | denominator for `usd`: `EA`, `ML`, `GM`, a HCPCS dosage like `5 UNITS`, or `claim`; the unit of a `quantity` |
| `period` | no | `YYYY-MM-DD/YYYY-MM-DD` for period data |

Optional fields are left out rather than written as `null`. No other fields are allowed on a
record. All dates are UTC calendar dates, and so is the page's "today": the UTC date of the
viewer's clock, so a time zone never changes an age. An age that comes out negative (a clock set
wrong) is shown as 0 days.

### Price states (defined in `src/core/provenance.js`, strongest first)

- `filed` — read from a published government file (NADAC, ASP, a fee schedule). Strongest.
- `published` — from a payer's or provider's own published rate.
- `derived` — computed from a published rule (e.g. Medicare pays 80% of the fee schedule).
- `estimated` — inferred, with the reason recorded.

A calculated record is `derived` only when every input is `filed`, `published` or `derived`
**and** the inputs are comparable (same product, same period basis, same unit). Otherwise it is
`estimated` and its reason lists each mismatch. Its `effective_date` and `retrieved_date` are the
oldest of its inputs'.

One exception: multiplying a unit price by the quantity the reader picked (60 tablets) is the
reader's own arithmetic, not a rule. A pack total keeps the state and source fields of the unit
price it scales, and its reason shows the multiplication ("60 × $0.01451 per EA, rounded to cents").

## `data/drugs.json` — schema `openbill.drugs/3`

Medicare Part D publishes one figure per drug **name** (all strengths and forms together) and
Part B one payment limit per HCPCS **code**. So those figures live once, in tables keyed the way
CMS keys them, and each row points at them. Facts that really are per NDC (NADAC, FDA identity,
the crosswalk's package numbers) stay on the row.

```jsonc
{
  "schema": "openbill.drugs/3",
  "sources": {
    "nadac": {
      "name": "CMS NADAC",                // short label
      "title": "...",                      // official dataset title
      "publisher": "...",
      "license": "https://...",
      "source_url": "https://...",         // human landing page; REQUIRED, never empty
      "download_url": "https://...",
      "source_file": "...",
      "sha256": "...", "bytes": 0,
      "period": null,                      // "YYYY-MM-DD/YYYY-MM-DD" for period data
      "as_of_date": "YYYY-MM-DD",
      "retrieved_date": "YYYY-MM-DD"
      // builders may add source-specific metadata fields here (not on records)
    }
    // fda_ndc, partd, asp_limits, asp_crosswalk
  },
  "counts": { "rows": 0, "...": "builder-defined summary counts" },
  "part_d_names": {                        // keyed "<Brnd_Name>|<Gnrc_Name>" exactly as CMS writes them
    "Eliquis|Apixaban": {
      "brand_name": "Eliquis",
      "generic_name": "Apixaban",
      "avg_per_unit": <record usd, per = the NADAC unit its rows share, period = data year>,  // Avg_Spnd_Per_Dsg_Unt_Wghtd
      "claims": <record count, per = "claim">,                                                // Tot_Clms
      "outlier": false                     // Outlier_Flag: true | false | null (blank in the file)
    }
  },
  "part_b_codes": {                        // keyed by HCPCS
    "J0402": {
      "hcpcs": "J0402",
      "hcpcs_dosage": "1 MG",
      "short_description": "Inj, abilify asimtufii, 1 mg",   // null for CPT codes (AMA licence)
      "payment_limit": <record usd, per = hcpcs_dosage, period = quarter>,
      "coinsurance_pct": <record percent>,
      "labelers": ["Otsuka America Pharmaceutical, Inc"]     // distinct labeler names on this code's crosswalk lines, sorted
    }
  },
  "rows": [ /* one per NDC in the newest NADAC week, sorted by name then ndc, one per line */ ]
}
```

### Row

Real example values (ELIQUIS 5 MG TABLET in the 2026-10-14 NADAC file):

```jsonc
{
  "ndc": "00003089421",              // NDC-11, the identity key. Unique.
  "name": "ELIQUIS 5 MG TABLET",     // NADAC description; the product grouping key
  "unit": "EA",                      // NADAC pricing unit: EA | ML | GM
  "otc": false,
  "rate_class": "B",                 // G | B | B-ANDA | B-BIO
  "explanation_codes": ["1"],
  "carried_forward": false,          // explanation code 2 or 4
  "identity": null | {               // exact NDC join to the FDA NDC Directory
    "source": "fda_ndc",
    "package_ndc": "0003-0894-21",   // as FDA writes it; normalizeNdc() of it === row.ndc
    "proprietary_name": "ELIQUIS",
    "nonproprietary_name": "apixaban",
    "dosage_form": "TABLET, FILM COATED",
    "route": "ORAL",
    "strength": "5 mg/1",
    "labeler": "E.R. Squibb & Sons, L.L.C.",
    "package_description": "60 TABLET, FILM COATED in 1 BOTTLE, PLASTIC (0003-0894-21)"
    // "rxcui": optional and reserved (DECISIONS.md, decision 14); not built yet. It would come
    // from the optional `openfda_ndc` source, and its join rule must be written here first.
  },
  "nadac": <record usd, per = unit>,           // value 5.52114, effective_date 2026-09-23
  "generic_nadac": <record usd>,               // optional: brand rows whose NADAC row lists a generic NADAC
  "part_d": null | {
    "key": "Eliquis|Apixaban",                 // into part_d_names
    "basis": "brand" | "generic"               // how CMS names the matched row: a trade name, or the generic name itself
  },
  "part_b": null | {
    "hcpcs": "J0402",                          // into part_b_codes
    "bill_units_per_package": <record count>,  // crosswalk BILLUNITSPKG, billable units in the whole 11-digit NDC
    "package_size": <record quantity, per = package_unit when reconciled>,
    "package_qty": <record count>,
    "package_unit": "ML" | "EA" | "GM" | null  // crosswalk package unit reconciled to row.unit, or null if it cannot be
  }
}
```

`null` means "looked, found nothing". Each `null` is explained in `counts` and in the
methodology; the page says "We don't know yet" rather than showing a zero.

`linkRows(doc)` in `src/core/pack.js` returns the rows with `part_d` and `part_b` expanded to
the full objects the rules read:
`part_d = { key, basis, brand_name, generic_name, avg_per_unit, claims, outlier }` and
`part_b = { hcpcs, hcpcs_dosage, short_description, payment_limit, coinsurance_pct, labelers,
bill_units_per_package, package_size, package_qty, package_unit }`. The tables are shared, so
linked rows must be treated as read-only.

A Part D name that CMS marks with `*` combines routes whose unit prices may differ. A row joins
such a name only when it has an FDA identity whose route is shared by every row joined to that
name; a row whose route is unknown (no FDA identity) or in the minority does not join it, and
`counts.part_d_unmatched` records why. Routes are compared by component (FDA's
`INTRAMUSCULAR; INTRAVENOUS` shares `INTRAMUSCULAR` with `INTRAMUSCULAR; SUBCUTANEOUS`); the
component covering the most rows keeps them, and when two components cover as many rows but not
the same rows, no row joins (`multi_route_tie`).

## `src/core/` — DOM-free, unit-tested

ES modules. Conventions (the bundler in `build.js` relies on them):

- Imports are single-line named imports from relative paths: `import { a, b } from './x.js';`
- Exports are `export function name`, `export async function name`, `export const name` or
  `export class Name`. No default exports, no `export { ... }` lists, no re-exports.
- No DOM, no `window`, no `document`, no network, no `Date.now()` without an injected clock.

| module | exports (minimum) |
|---|---|
| `provenance.js` | `PRICE_STATES`, `STATE_INFO`, `RECORD_FIELDS`, `KINDS`, `isPriceState`, `validateRecord(rec) → string[]`, `makeRecord(fields)`, `weakestState(states)`, `deriveRecord({ value, kind, per, rule, inputs, comparable, caveats })` |
| `money.js` | `formatMoney(dollars)` → `$1,234.57`; `formatUnitPrice(dollars)` → source precision, ≥ 2 decimals (`$0.01451`, `$5.52114`); `multiplyMoney(unit, qty)`; `formatMultiple(ratio)` → `4.9×`, `11.5×`, `167×`, `0.92×`; `formatMultipleWithin(ratio, low, high)` (more digits only for a ratio strictly inside the bounds that would otherwise show as a bound or beyond); `formatPercent`, `formatCount` |
| `ndc.js` | `isNdc11`, `normalizeNdc(input) → ndc11 \| null`, `ndcCandidates(input) → ndc11[]`, `formatNdc(ndc11)` → `00378-7185-05`, `looksLikeNdc(query)` |
| `dates.js` | `isIsoDate`, `daysBetween(a, b)`, `isoDate(dateObj)` |
| `sources.js` | `SOURCE_INFO` (label, cadence, `stale_after_days`, what it measures), `NADAC_EXPLANATION_CODES` |
| `rules.js` | `RULES` (id, title, formula, description; feeds methodology.html), `HONESTY` (verbatim wording), `EXTREME_HIGH`, `EXTREME_LOW`, `EXTREME_HEADLINE`, `isExtremeSpread(rec)`, `formatSpreadMultiple(ratio)`, `inputDates(inputs)`, `labelerKey(name)`, `distinctLabelers(labelers)`, `NAME_OUTLIER_FACTOR`, `partDNameContext(rows)`, `nameOutlier(row, ctx)`, `unitTotal(record, qty)`, `partBPerNadacUnit(row)`, `partBCoinsurance(row)`, `referencePrice(row)`, `spread(nadacRec, refRec, opts)`, `describeSpread(ratio)`, `freshness(record, sourceInfo, todayIso)`, `summarizeProduct(rows, qty, { partDContext })` |
| `search.js` | `normalizeQuery`, `groupProducts(rows)`, `buildIndex(products)`, `search(index, query, { limit })` |
| `pack.js` | `packDrugs(doc) → compact`, `unpackDrugs(compact) → doc` — lossless: `unpackDrugs(packDrugs(doc))` deep-equals `doc`; `linkRows(doc) → rows` with `part_d`/`part_b` expanded from the tables |
| `report.js` | `issueUrl({ template, title, fields })` → prefilled GitHub issue-form URL |
| `esc.js` | `esc(value)` — HTML-escapes `& < > " '` and backtick; everything rendered goes through it |
| `sha256.js` | `sha256Hex(bytes)` → 64 lowercase hex digits; the page's check of the inline data where `crypto.subtle` is unavailable |
| `config.js` | `REPO_URL = 'https://github.com/destinjones/openbill'`, `APP_NAME = 'OpenBill'` |

### Rules the page applies

- **Reference price:** NADAC measures retail pharmacies, and Part D is the Medicare program
  that pays for drugs dispensed by pharmacies, so Part D comes first: the data-year average for
  the matched name, when its unit equals the row's unit and CMS does not flag it as an outlier.
  Otherwise Part B: the current quarter's payment limit, joined by exact NDC through the
  crosswalk and converted to the NADAC unit, when the package unit is reconciled. Otherwise
  none, with the reason. When both exist the card shows Part D and the provenance panel also
  shows Part B, with the coverage setting in its reason (Part B pays for a pharmacy drug only in
  specific settings).
- **Spread:** reference per unit ÷ NADAC per unit, stated plainly ("Medicare paid 4.9× what
  pharmacies pay." — "pays" for the current Part B quarter).
  - Part D: always `estimated` — all strengths and forms averaged under one name, a different
    year, and the spending basis CMS documents (quoted from the Part D record's reason).
  - Part B: `derived` only when the HCPCS code has a single labeler on the crosswalk (the limit
    is then that product's own); otherwise `estimated`, because a multi-source code's limit is
    an average across every labeler's product billed under it. Labelers are counted as companies:
    `distinctLabelers()` folds case, punctuation and a trailing corporate suffix (Inc, LLC, Ltd …),
    and the reason quotes every spelling. A single-labeler code whose payment limit file Notes say
    "lesser of" or "reference add-on" stays `estimated`, because its limit is not that company's
    own price alone.
  - Any `estimated` spread at or above 20× or at or below 0.2× (tested on the unrounded ratio,
    so 0.2046 does not qualify; near a threshold the card shows it as `formatSpreadMultiple()` does,
    "0.205×", never as the threshold's own "0.20×") also carries the caveat that the two figures may
    not describe the same unit or product. The number is shown, never hidden —
    but the card does not lead with a sentence such as "Medicare paid 99% less" for it: the
    headline becomes "These two figures may not measure the same thing", the multiple is shown
    beside it, and the caveat says why.
  - A Part D spread whose product's middle (lower-median) NADAC is at least `NAME_OUTLIER_FACTOR`
    (20) times the lower median of the other products' medians under the same Part D name and unit
    leads its caveats with both prices (`nameOutlier()`, rule `part-d-name-outlier`): the average
    may mostly describe those other products. Only the high side is tested, and no join is refused.
  - A calculated record carries `period` only when every input shares it. Next to any calculated
    figure the card shows each input's own date or period (e.g. "NADAC eff. 2026-09-23 · Part D
    2024-01-01 to 2024-12-31"), never the oldest date alone.
- **Pack totals:** quantity × unit price, rounded half-up to cents; keeps the unit price's state
  (see above). A non-zero total under half a cent shows as `<$0.01`.
- **Coinsurance:** payment limit × the coinsurance percentage printed in the Part B file.
- **Freshness:** a source is stale when its age passes `SOURCE_INFO[...].stale_after_days`. Age
  is counted from the NADAC as-of date, from the start of a Part B quarter, and from the end of
  the Part D data year. A stale source is labelled on the card; it is never hidden or zeroed.

### Honesty wording (in `HONESTY`, shown on the page and the methodology page verbatim)

- A price is a **range to expect**, never a quote.
- **Medicare's price is not your price.** Say so on every screen that shows it.
- State which dataset and which effective date produced every figure.
- If a source is stale or a file is empty, show that rather than a zero.
- Disclaimer footer: not medical advice, no warranty, other people's data can be wrong.

## `build.js` — the bundler and generator

- A tiny module bundler: reads `src/app/app.js` and every module it imports (transitively),
  orders them topologically, strips `import` lines and `export` keywords, wraps each module in
  its own function scope that returns its exports, and wires imports by destructuring. No
  third-party tooling.
- Inlines: CSS (`src/app/styles.css`), fonts (`src/app/fonts/*.woff2` as `data:` URIs), the packed
  data, and the bundled script. The packed JSON is ~6.5 MB, so it is deflate-raw compressed and
  base64-encoded inside `<script type="application/json" id="openbill-data">` as
  `{ format: "openbill.inline/1", encoding, json_bytes, sha256, data }`. The page inflates it with
  the browser's built-in `DecompressionStream("deflate-raw")` (Chrome/Edge 103+, Firefox 113+,
  Safari 16.4+), checks the sha256, and says plainly if the browser cannot unpack it.
- Every page gets a CSP meta tag built from hashes of its own inline script and style:
  `default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'`.
  So: no inline `style=""` attributes, no inline event handlers, no `eval`.
- Generates `methodology.html` from `src/build/methodology.js` (`renderMethodology(ctx) →
  { title, description, bodyHtml }`, wrapped by build.js in the shared shell) and
  `docs/DATA-QUALITY.md` from `src/build/quality.js` (`renderDataQuality(doc) → markdown`).
- Exports `buildAll() → { files: { [path]: content } }` with no side effects on import, so
  `tests/build.test.js` can check the committed files are in sync.

## The page (`src/app/`)

- `index.html` (shell with placeholders), `styles.css`, `app.js` (the only DOM code),
  `fonts/` (IBM Plex Sans + IBM Plex Mono, OFL, latin subset).
- Works from `file://`, offline, with zero network requests.
- Phone-first: 44px minimum controls, 16px minimum input text, no horizontal scroll from
  360px up, light and dark via `prefers-color-scheme`.
- State lives in the URL hash (`#drug=<name>&qty=<n>`), so a card is a shareable link.
- The state chip and the provenance line (source, file, effective date, retrieved date) are
  on the card for every number, always visible. The provenance panel (reason, explanation
  codes, NDCs, the formula) opens from the card.
- Every card has "Wrong? Tell us", a prefilled `wrong-price.yml` issue.

## Issue-form field ids (shared by `.github/ISSUE_TEMPLATE/*.yml` and `src/core/report.js`)

GitHub prefills issue forms from the URL only for text fields, so every id below stays an
`input` or `textarea`.

| template | field ids |
|---|---|
| `wrong-price.yml` | `product`, `ndc`, `figure`, `shown_value`, `source_file`, `what_is_wrong`, `evidence`, `build_id` |
| `missing-drug.yml` | `drug_name`, `ndc`, `where_seen`, `notes` |
| `bug.yml` | `what_happened`, `steps`, `device`, `build_id` |

## Tests (`node --test`)

`tests/*.test.js`: core units; `data.test.js` (schema and provenance shape on every record,
NDC join); `spotchecks.test.js` driven by `tests/spotchecks.json` (each entry names the
source file and how it was independently verified; at least ten must apply to the current
data); `build.test.js` (generated files in sync); `quality.test.js` (floors: at least 70% of
rows `filed`, no source without a URL); `docs-links.test.js` (every relative link and anchor
resolves; external links when `OPENBILL_CHECK_EXTERNAL=1`). Browser checks live in
`tests/browser/*.spec.js` (Playwright), not picked up by `node --test`.
