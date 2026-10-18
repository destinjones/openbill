# Decisions

A numbered log of the choices behind OpenBill: context, decision, consequences. Entries are
not rewritten; a later entry supersedes or amends an earlier one by number, and the earlier
entry carries a one-line note pointing at it. Entries 1 to 23 were recorded on 2026-10-17,
during phase 1; entries 24 to 32 were recorded later the same day, after a review and a
rebuild of `data/drugs.json`, and entries 33 and 34 on 2026-10-18. The contract they produce is
[ARCHITECTURE.md](ARCHITECTURE.md).

## 1. NADAC from the yearly cumulative CSV, newest As of Date only

**Context.** data.medicaid.gov publishes one NADAC dataset per calendar year. Its CSV stacks
every weekly file of that year, told apart by the "As of Date" column. The 2026 file
retrieved on 2026-10-17 is 107 MB and holds 41 weekly files.

**Decision.** `tools/fetch_nadac.py` finds the newest "NADAC (National Average Drug
Acquisition Cost) <year>" dataset through the data.medicaid.gov API and downloads its CSV
only when the URL, ETag or Last-Modified changes. `tools/build_drugs.py` keeps only the rows
with the newest As of Date: 30,031 rows for 2026-10-14.

**Consequences.** Every refresh downloads the whole year to use one week. Older weeks stay in
the cache and are not used. If CMS changes the columns, the fetcher stops instead of
guessing.

## 2. One row per NDC-11; products grouped by NADAC description

**Context.** NADAC prices each NDC separately, and many NDCs share a description: 57 NDCs
are "METFORMIN HCL 500 MG TABLET". The 2026-10-14 week has 30,031 NDCs under 5,936
descriptions.

**Decision.** A row is one NDC-11, unique: the identity key. A product, which is what people
search for and what a card shows, is the group of rows that share a NADAC description.

**Consequences.** A brand and its generic are separate products (`LIPITOR 20 MG TABLET`,
`ATORVASTATIN 20 MG TABLET`) until there is an RxNorm identity (decision 14). NDCs in one
product can carry different prices and dates, so the card has to show that rather than pick
one.

## 3. A provenance record on every number, with kind, as_of_date, per and period

*Amended by
[decision 28](#28-an-unreconciled-crosswalk-package-size-is-a-quantity-with-no-unit): `kind`
also has `quantity`, a measured amount whose `per` is set only when the source states the unit.*

**Context.** The brief asks for `value, state, reason, source_name, source_url,
source_file, effective_date, retrieved_date` on every number. That isn't enough to show a
number correctly or to compare two: $0.01451 per what, and from which week's file?

**Decision.** Every record also has `kind` (`usd`, `percent`, `count`, `ratio`), and where
they apply `as_of_date` (the source file's own date), `per` (the unit) and `period` (the
span of period data). `validateRecord()` in `src/core/provenance.js` defines a valid
record, and the tests run it over every record in `data/drugs.json`.

**Consequences.** The same source fields repeat on thousands of records, so the page inlines
a packed form (decision 6). A calculation can now see its inputs' units and periods, which is
what decides whether it is `derived` or `estimated`.

## 4. Python extracts filed facts; the JavaScript core applies every rule

**Context.** Two languages computing the same thing will drift, and the methodology page
would describe one of them.

**Decision.** The Python builders only copy numbers printed in a source file (state
`filed`) and join them on identity keys. Every calculation (pack totals, unit conversions,
coinsurance, the spread) is a rule in `src/core/rules.js`. Its `RULES` and `HONESTY`
constants also render `methodology.html`.

**Consequences.** `data/drugs.json` holds no computed numbers. The page, the methodology page
and the tests run the same code, so the methodology can't describe a formula the page
doesn't use.

## 5. Deterministic builds: no timestamps, LF line endings

**Context.** Generated files are committed and a test checks they match their inputs. A
build time, an unsorted key or a CRLF would make every build a diff.

**Decision.** No output contains a build time. Rows and keys are written in a fixed order.
Every text file uses LF (`.gitattributes`, `.editorconfig`, and writers that set the line
ending). Dates come from the sources and the manifest, never the clock; core code that
needs today's date takes it as an argument.

**Consequences.** `node build.js --check` can compare bytes, and anyone can rebuild from the
same cache and get the same files.

## 6. data/drugs.json committed in full; the page inlines a lossless packed form

*Amended by [decision 26](#26-inline-data-is-deflate-raw-and-base64-the-browser-floor): the
packed form is now inlined deflate-raw compressed and base64-encoded.*

**Context.** Reviewers need to see what a data refresh changed. A page that inlines the full
JSON would repeat the same provenance fields on every record.

**Decision.** `data/drugs.json` is committed in full, one row per line, so a refresh diff
shows which NDCs changed. The page inlines `packDrugs(doc)`; `unpackDrugs(packDrugs(doc))`
must deep-equal `doc`, and a test checks it.

**Consequences.** Anyone can audit a number from the JSON without running the page. The
repository grows with every refresh.

## 7. Medicare reference: Part B by exact NDC when available, else Part D by name

*Superseded by [decision 18](#18-reference-price-part-d-first-then-part-b-both-in-the-panel)
(Part D comes first) and
[decision 19](#19-a-part-b-spread-is-derived-only-for-a-single-labeler-code) (a Part B spread
is derived only for a single-labeler code).*

**Context.** Medicare publishes two drug prices that can sit beside NADAC. The Part B payment
limit is quarterly, per HCPCS billing unit, and joins to an NDC through CMS's crosswalk;
Part B mostly covers drugs given in a clinic or doctor's office. Part D Spending by Drug is
annual and lists drugs by brand and generic name only.

**Decision.** If the crosswalk maps a row's NDC to a HCPCS code and its package unit is the
NADAC unit, the reference is the Part B payment limit converted to the NADAC unit, and the
spread is `derived`: same NDC, same quarter, an exact unit conversion. Otherwise the
reference is Part D, matched by name, unless the Part D file flags the figure as an outlier
or it is per a different unit. Otherwise there is no reference, and the card says why
(`referencePrice()` in `src/core/rules.js`).

**Consequences.** A Part D spread is always `estimated`: Part D averages all strengths and
forms of a drug, covers a different year (data year 2024), and is gross of rebates. The
reason on the record says so.

## 8. The Part D join is by name, helped by the FDA NDC Directory; precision over recall

*Superseded in part by
[decision 16](#16-schema-v3-part-d-and-part-b-figures-in-tables-keyed-the-way-cms-keys-them):
`part_d.match` is gone. Later join rules are in decisions 22, 24 and 30.*

**Context.** Part D Spending by Drug has no NDCs. NADAC descriptions are not the names Part D
uses: "METFORMIN HCL 500 MG TABLET" against brand and generic names with no strength or form.

**Decision.** A row is matched to Part D brand and generic names using its NADAC description
and, when its NDC is in the FDA NDC Directory (exact package NDC), the FDA proprietary and
nonproprietary names. If more than one Part D row matches, or the brand or generic basis is
unclear, there is no match. `part_d.match` records which names matched and on which basis;
the exact rules are in `tools/build_drugs.py`.

**Consequences.** Some rows say "We don't know yet" where a looser match would show a number.
A wrong Medicare price is worse than none. Rows with no FDA identity have only the NADAC
description to match on, so they match less often.

## 9. effective_date for period data is the end of the period

*Superseded by
[decision 21](#21-effective_date-for-period-data-is-the-start-of-the-period-dates-are-utc):
period data is now effective from the start of its period.*

**Context.** Annual and quarterly data describe a span, but a record has one
`effective_date`, and derived records take the oldest date of their inputs.

**Decision.** For period data, `effective_date` is the last day of the period, and the span
goes in `period` (`YYYY-MM-DD/YYYY-MM-DD`). Part D data year 2024 is effective 2024-12-31.

**Consequences.** For a quarter still in progress the date is in the future: the October
2026 Part B quarter is effective 2026-12-31, later than the date it was retrieved. Read
`effective_date` together with `period`. Freshness is not measured from `effective_date`
for period data: `SOURCE_INFO` in `src/core/sources.js` counts a Part B figure's age from
the start of its quarter and a Part D figure's from the end of its data year.

## 10. Strict CSP from hashes; everything inlined; IBM Plex self-hosted

**Context.** The page must work from `file://`, offline, with no third-party requests, while
rendering strings from files nobody here controls.

**Decision.** `build.js` inlines the script, the CSS, the fonts (as `data:` URIs) and the
data, hashes the inline script and style, and writes a CSP meta tag:
`default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'`.
The type is IBM Plex Sans and IBM Plex Mono, one family under the SIL Open Font License,
latin subset, self-hosted.

**Consequences.** No inline `style=""` attributes, no inline event handlers, no `eval`. Any
change to the script or CSS changes its hash, so the page must be rebuilt, and the sync test
enforces that. A meta CSP can't set `frame-ancestors`; anyone hosting the page has to send
that as a header.

## 11. The repo URL comes from the maintainer's GitHub login and lives in one constant

**Context.** "Wrong? Tell us" links, the methodology page and the docs need the repository
URL, and the repository didn't exist yet.

**Decision.** The URL is `https://github.com/destinjones/openbill`, built from the
maintainer's GitHub login. The page takes it from `REPO_URL` in `src/core/config.js`;
`repository.url` in `package.json` repeats it, and a unit test pins the constant.

**Consequences.** A fork changes `REPO_URL` for the page. Markdown and YAML can't import a
constant, so the docs that need an absolute URL (the badges, the security advisory link, the
issue-form contact link, the changelog link) spell it out. Search for `destinjones/openbill`
when forking.

## 12. Spot checks are pinned to source files; every refresh re-verifies at least ten

**Context.** Unit tests show the code does what we meant. They can't show the number matches
the government file.

**Decision.** `tests/spotchecks.json` lists known values. Each entry names the source file it
was read from and how it was independently verified. The test fails if fewer than ten apply
to the current data. Each data refresh re-verifies at least ten against the new files.

**Consequences.** A refresh takes a person, not just a script. A spot check pinned to an old
file stops counting toward the ten instead of passing quietly.

## 13. External link checks are opt-in

**Context.** The docs link to the project's own GitHub pages (the CI badge, the issue forms,
security advisories), which can't resolve before the first push. Some government sites also
refuse scripted requests: on 2026-10-17 www.medicaid.gov answered 403 to a request sent
with OpenBill's fetcher user agent, and 200 to the same request from curl.

**Decision.** `tests/docs-links.test.js` always checks relative links and anchors. It checks
external links only when `OPENBILL_CHECK_EXTERNAL=1`. CI runs that as a separate `links` job
with `continue-on-error: true`.

**Consequences.** A dead external link doesn't block a merge, so someone has to read the
`links` job.

## 14. RxNorm is deferred; identity is the FDA NDC Directory for now

**Context.** The brief's Tier 2 join keys are the FDA NDC Directory, RxNorm (one identity for
brand, generic and dose) and openFDA (labels, shortages), to be built before anything joins.

**Decision.** Phase 1 ships with the FDA NDC Directory, joined by exact package NDC, as the
only identity. RxNorm and openFDA are not built. `identity.rxcui` is reserved and optional.

**Consequences.** Tier 2 isn't finished, which departs from the brief's order. The Part D
name join runs without RxNorm, which is one reason it is strict (decision 8). Brand and
generic stay separate products (decision 2). RxNorm and FDA drug shortages are good first
issues in [CONTRIBUTING.md](../CONTRIBUTING.md#good-first-issues).

## 15. The brief's mock card numbers were illustrative

**Context.** The brief's card mock shows metformin HCl 500 mg, 60 count: "Pharmacy pays
$4.12", "Cash list price $47.30", "11.5× the spread", and says its numbers are illustrative.

**Decision.** The page shows only numbers read from the data or computed from it by a rule.

**Consequences.** Real NADAC for 60 metformin HCl 500 mg tablets is $0.87, not $4.12: 60 ×
$0.01451 per tablet, rounded half-up to cents. That is the NADAC for all 57 NDCs described
as "METFORMIN HCL 500 MG TABLET" in the file with As of Date 2026-10-14, effective
2026-09-23. Phase 1 has no cash list price source; the second number on the card is a
Medicare reference price, and the multiple is computed from it. The mock's "eff. 2026-10-14"
is the file's As of Date; the metformin rows are effective 2026-09-23. Those are two
different fields, `as_of_date` and `effective_date`.

## 16. Schema v3: Part D and Part B figures in tables keyed the way CMS keys them

**Context.** Medicare Part D publishes one figure per drug name, covering every strength and
form, and Part B one payment limit per HCPCS code. Schema 2 copied those figures onto every NDC
row that joined them (in the 2026-10-14 build, 19,321 rows share 1,461 Part D figures and 1,427
rows share 138 Part B limits). That made `data/drugs.json` 60.2 MB, and it made the figures
look as if they were per NDC. They are not.

**Decision.** Schema `openbill.drugs/3` writes those figures once, in tables keyed the way CMS
keys them: `part_d_names`, keyed `"<Brnd_Name>|<Gnrc_Name>"` with CMS's own strings, and
`part_b_codes`, keyed by HCPCS code. A row points at them: `part_d = { key, basis }`, and
`part_b = { hcpcs, ... }` with the crosswalk's package figures for that NDC, which really are
per NDC. NADAC and the FDA identity stay on the row. `linkRows(doc)` in `src/core/pack.js`
expands the pointers for the rules, and a pointer to a missing entry throws rather than reading
as "not found".

**Consequences.** `data/drugs.json` is 35.1 MB (35,127,111 bytes) for the 2026-10-14 build. A
refresh diff shows a changed Part D figure once, on its name, not on every NDC. The page and
the tests read rows through `linkRows()`; linked rows share the table objects, so they are
read-only. Decision 8's `part_d.match` is gone: `basis` says how CMS names the Part D row, and
`counts.part_d_by_join` counts which step of the join matched. The packed form (decision 6)
packs the tables with the rows.

## 17. Pack totals keep the unit price's state

**Context.** A pack total is a calculation: 60 tablets × $0.01451. Under the record rules alone
a calculation is `derived` at best, so a `filed` NADAC price would turn into a `derived` total
on the card's main line, although nothing was inferred and no published rule was applied.

**Decision.** Multiplying a unit price by the quantity the reader picked is the reader's own
arithmetic, not a rule. `unitTotal()` keeps the state and every source field of the price it
scales (source, file, dates, period). Only the value, `per` ("60 EA") and the reason change, and
the reason shows the multiplication: "60 × $0.01451 per EA, rounded to cents: $0.87 (exactly
$0.8706, rounded half-up)." The total is rounded half-up to cents. A total above zero but under
half a cent shows as `<$0.01`, never as $0.00.

**Consequences.** A pack total of a `filed` NADAC price is `filed`, and its source link is the
NADAC dataset, not methodology.html. The rule stays in `RULES` (`unit-total`), so
methodology.html still explains it. It is the one exception in ARCHITECTURE.md to "a calculated
record is derived or estimated".

## 18. Reference price: Part D first, then Part B, both in the panel

*Counts updated in [decision 32](#32-counts-after-the-2026-10-17-rebuild); the rule stands.*

**Context.** Decision 7 compared NADAC with Part B first, because the crosswalk joins by exact
NDC and the spread could be `derived`. But Part B pays for a drug only in specific settings,
mostly a clinic or doctor's office: Humulin R vials and Humalog cartridges bill under J1817,
whose short description in the payment limit file is "Insulin for insulin pump use". NADAC
measures what retail pharmacies pay, and Part D is the Medicare program that pays for drugs
dispensed by pharmacies.

**Decision.** Part D comes first: the data-year average for the matched name, when it is per
the row's NADAC unit and CMS does not flag it as an outlier. A blank flag counts as not flagged,
and the reason says so. Otherwise Part B: the current quarter's payment limit converted to the
NADAC unit, when the package unit is reconciled. Otherwise there is no reference, and the card
gives the reason for each. When both exist, the card shows Part D and the provenance panel also
shows Part B, with the coverage setting in its reason (`referencePrice()` in
`src/core/rules.js`). This supersedes decision 7.

**Consequences.** In the 2026-10-14 build, 18,590 rows have a Part D reference, 719 a Part B
one and 10,722 none. 571 rows show Part B beside Part D, and 73 use Part B because CMS flags
their Part D figure. Every Part D spread is `estimated`, for decision 7's reasons, so most
spreads on cards are estimated: a figure from the same setting is worth more than a stronger
label on a figure from a different one.

## 19. A Part B spread is derived only for a single-labeler code

*Counts updated in [decision 32](#32-counts-after-the-2026-10-17-rebuild); the rule stands.*
*Amended by [decision 34](#34-spreads-near-a-threshold-labeler-spellings-the-part-d-name-outlier-caveat): labelers are counted as companies, however the crosswalk spells them.*

**Context.** Part B sets one payment limit per HCPCS code, worked out from the average sales
price of every product billed under it. When several labelers sell under one code, the limit
is an average across their products, not the joined NDC's own price.

**Decision.** A Part B spread is `derived` only when its code has a single labeler on the
crosswalk. `part_b_codes[code].labelers` lists the distinct names in the crosswalk's own
LABELER NAME column over all of the code's lines. Otherwise the spread is `estimated`, and its
reason says how many labelers share the code. Names are compared as CMS spells them; variants
that differ only in capitals or punctuation are not merged.

**Consequences.** 36 of the 138 joined codes have a single labeler, and 75 rows point at them.
Of the 719 Part B spreads on cards, 32 are derived and 687 estimated; of the 571 Part B figures
shown beside a Part D reference, 23 are derived and 548 estimated. Two codes, J0717 and Q5099,
would have a single labeler if their spelling variants were merged; their spreads stay
estimated, the cautious side.

## 20. Very large and very small estimated spreads carry a caveat, and are shown

*Amended by
[decision 25](#25-an-extreme-estimated-spread-leads-with-a-warning-not-a-sentence): such a
spread no longer leads with its sentence; the headline says the two figures may not measure the
same thing. Counts updated in [decision 32](#32-counts-after-the-2026-10-17-rebuild).*

**Context.** Some estimated spreads are far from 1×. In the 2026-10-14 build the highest is
ALYQ 20 MG TABLET at 119× and the lowest METFORMIN HCL 750 MG TABLET at under 0.01×. A gap that
large often means the two figures do not describe the same thing: a Part D name that averages
strengths costing far more or far less, a different dosage unit, or a price that has moved
since the data year. It can also be a real gap, so hiding it would be wrong too.

**Decision.** An `estimated` spread at or above 20× or at or below 0.2× (`EXTREME_HIGH` and
`EXTREME_LOW` in `src/core/rules.js`) carries a caveat in its reason, worded for its direction,
that the two figures may not describe the same unit or product. The number is always shown with
the caveat; it is never hidden or capped. A `derived` spread (one product, one quarter, an exact
unit conversion) does not carry it.

**Consequences.** 428 rows in 125 products carry the caveat in the 2026-10-14 build.
`docs/DATA-QUALITY.md` lists the ten products with the highest spreads and the ten with the
lowest, for review.

## 21. effective_date for period data is the start of the period; dates are UTC

*Amended by [decision 27](#27-calculated-figures-show-the-date-or-period-of-each-input) (a
calculated figure shows each input's own date) and
[decision 29](#29-today-for-ages-on-the-page-is-the-utc-date) (the page's today is the UTC
date, so a time zone never makes an age negative).*

**Context.** Decision 9 put the effective date of period data at the end of the period. The
October 2026 Part B quarter was then "effective 2026-12-31", later than the day it was
downloaded, so a limit in force now read as if it applied from the end of the year. Dates also
need one clock: the build reads none, and the page counts ages against the viewer's own today.

**Decision.** For period data, `effective_date` is the first day of the period, `period` is
always set, and the period is always shown next to the date (`deriveRecord()` writes "for
2024-01-01 to 2024-12-31"). Every date is a UTC calendar date; `retrieved_date` is the UTC date
of the download. An age that comes out negative, because a viewer's clock or time zone is
behind UTC, is shown as 0 days and is never stale (`freshness()`). This supersedes decision 9.

**Consequences.** Part D data year 2024 is effective 2024-01-01, period 2024-01-01/2024-12-31;
the October 2026 Part B files are effective 2026-10-01, period 2026-10-01/2026-12-31. The
effective date alone would suggest a Part D price in force since 2024-01-01, which is why the
period is always shown. Freshness is measured as decision 9 described: from the NADAC and FDA
file date, the start of a Part B quarter and the end of the Part D data year. A
`retrieved_date` can be a day later than the local date of the download.

## 22. Part D precision rules from the 2026-10-17 audit; two sources not used

*Amended by [decision 24](#24-multi-route-part-d-names-a-row-joins-only-on-the-route-its-rows-share)
and [decision 30](#30-part-d-join-refinements-product-code-matching-trade-name-release-forms-generic-presentations)
(more join rules) and [decision 32](#32-counts-after-the-2026-10-17-rebuild) (new counts, and
what the 27,086 below counts).*

**Context.** A review of the Part D join on 2026-10-17 found wrong matches: buprenorphine
sublingual tablets given the patch figure ($61.65 per unit, 222× NADAC), methylphenidate
tablets given the patch figure, OTC bacitracin ointment given `Bacitracin*` (438×), OTC
ibuprofen, naproxen, adapalene and phenazopyridine given the prescription product, insulin pens
given the vial (Tresiba FlexTouch U-200 got the U-100 vial's $32.17 per mL instead of $63.98),
an omeprazole and sodium bicarbonate packet given plain omeprazole, and timolol hemihydrate
given timolol maleate. Two more sources were evaluated to raise the identity match.

**Decision.** The Part D name join (`PartD.match` in `tools/build_drugs.py`) gained these
rules. Each leaves the row without a Part D figure when it cannot be sure.

- **OTC.** A row FDA lists under an OTC monograph gets no Part D figure, and an OTC row never
  takes a Part D row named by the generic name. Part D excludes OTC drugs, so those Part D rows
  are the prescription product.
- **Salt families.** Where Part D carries one substance under names that differ only by salt
  (Buprenorphine is the patches, Buprenorphine HCl* the sublingual tablets), the NADAC
  description or FDA's nonproprietary name must state the salt and it must fit exactly one,
  unless every other salt form is one FDA lists only for other routes.
- **Presentations.** Where Part D lists presentations under their own names (Novolog and
  Novolog Flexpen), the Part D name with the most words found in the NADAC description wins. If
  a longer name shares a presentation word with the description but does not fit, there is no
  match.
- **Ingredient counts.** A combination product's NADAC name must name as many ingredients as
  the Part D generic name.
- **Hydrates.** A hydrate that is the only qualifier counts as the salt, so timolol hemihydrate
  is not timolol maleate.

Considered and not used, both for the identity join:

- FDA's `ndc_excluded.zip` would raise the exact NDC match from 27,086 to 27,969 NDCs (90.2%
  to 93.1%), but its product records carry only the proprietary name, labeler and marketing
  category, with no nonproprietary name, dosage form, route or strength, and 62 of the added
  packages have no product record at all.
- The openFDA NDC bulk file attaches RxCUIs per SPL document, not per product, so products of
  different strengths in one SPL share one list (terazosin 2 mg and 5 mg both list the same two
  RxCUIs), and 57,816 of its 138,319 products have none.

**Consequences.** In the 2026-10-14 build, `counts.part_d_unmatched` gives these rules as the
reason for 1,303 rows (OTC monograph), 155 (a Part D row named by the generic name), 248 (an
unsettled salt) and 1 (an unsettled presentation). After the change, 24
matched rows were checked by hand against the raw Part D CSV and the FDA product rows, and all
were correct. Identity stays the FDA NDC Directory alone (decision 14). The measurements are in
[DATA_SOURCES.md](DATA_SOURCES.md).

## 23. Starting quantity: 30 per EA, one package per ML or GM when FDA agrees, else 1

**Context.** A pack total needs a quantity before the reader types one. NADAC prices a drug per
EA (a tablet, capsule or other single unit), per ML or per GM. For a liquid, a cream or a pen,
1 mL or 1 g is rarely what anyone is given, and a guessed amount would be a number without a
source.

**Decision.** `defaultQuantity()` in `src/core/rules.js`: 30 for a product priced per EA
(`DEFAULT_EA_QUANTITY`), a common one-month supply of a once-a-day medicine. For a product
priced per ML or GM, the amount in one package, read from the FDA package description ("5
SYRINGE in 1 CARTON / 3 mL in 1 SYRINGE" is 15 mL), when every NDC of the product with an FDA
identity gives the same amount and it is a usable quantity; otherwise 1. A product whose NDCs
are priced in different units starts at 1. The result carries a reason saying which case
applied, and the reader can change the quantity.

**Consequences.** Of the 5,936 products in the 2026-10-14 build, 4,221 start at 30. Of those
priced per ML or GM, 1,195 start at one package (963 per ML, 232 per GM) and 508 start at 1
because their FDA package descriptions disagree, cannot be read or are missing (293 per ML, 215
per GM). 12 products start at 1 because their NDCs are priced in different units. The starting
quantity is not a prescription, and its pack total keeps the NADAC price's state (decision 17).

## 24. Multi-route Part D names: a row joins only on the route its rows share

**Context.** CMS marks a Part D name with `*` when its figure combines routes of
administration: `Olanzapine*` covers tablets and injection vials under one average per dosage
unit. The first build joined rows to those names by name alone. 2,350 rows pointed at 80 `*`
names, 254 of them with no FDA identity, and 16 of the 80 names had rows of more than one route.
OLANZAPINE 10 MG VIAL (an intramuscular vial, NADAC $20.923) took the name's one figure,
$0.6961710607 per unit, a spread of 0.033×. Pantoprazole IV vials, a diazepam rectal gel and a
zolmitriptan nasal spray likewise took the one figure of a `*` name they shared with other
routes.

**Decision.** The contract rule ([ARCHITECTURE.md](ARCHITECTURE.md)): a row joins a `*` name only
when it has an FDA identity whose route is shared by every row joined to that name. A row whose
route is unknown, or in the minority, does not join it, and `counts.part_d_unmatched` says why.
`star_route_split()` in `tools/build_drugs.py` applies it:

- Routes are compared by component. FDA's route `INTRAMUSCULAR; INTRAVENOUS` shares
  `INTRAMUSCULAR` with `INTRAMUSCULAR; INTRAVENOUS; SUBCUTANEOUS`. Each component is counted over
  the rows whose route includes it, and the component covering the most rows keeps them, so every
  kept row shares that route. Components that cover exactly the same rows are one choice, not a
  tie.
- Routes are FDA's own words, not merged: `PARENTERAL` is not `INTRAMUSCULAR` or `INTRAVENOUS`,
  and `INTRAOCULAR` is not `OPHTHALMIC`.
- Reasons: `multi_route_no_identity` (no FDA identity, or an identity with no route),
  `multi_route_minority` (the row's route is not the kept one) and `multi_route_tie` (two
  components cover the same number of rows but different rows, so no route wins and every row is
  left out).
- "Has an FDA identity" means the exact package match (decision 14). The product-code records of
  [decision 30](#30-part-d-join-refinements-product-code-matching-trade-name-release-forms-generic-presentations)
  are not used to give a row a route.
- The unit rule (`mixed_units`) still counts every NDC the name join matched, before the route
  split, so dropping the other-route rows cannot unlock a name whose CMS average mixes units.

**Consequences.** In the rebuild, 342 of the 2,350 rows lost their `*` figure: 254 with no FDA
identity and 88 on another route or in a tie. Four names have no rows left (Hydromorphone HCl*,
Ondansetron HCl*, Sumatriptan Succinate*, Zomig*). 2,008 rows now point at 76 `*` names, every
one with an FDA identity and one shared route; `tests/data.test.js` checks that. The new reasons
cover 857 rows (`multi_route_minority` 446, `multi_route_no_identity` 371, `multi_route_tie` 40);
because the route split runs before the unit rule, `mixed_units` fell from 3,190 to 2,681 in the
same rebuild. The rule costs recall: 222 NDCs with no FDA identity in names whose other rows all
share one route (propranolol, chlorpromazine and levothyroxine tablets), and 8 budesonide
respules that FDA lists as ORAL, lose Part D. Inheriting a route from the product code would keep
them, but it is a contract change and is open. Also open: a row on the majority route still takes
a CMS average that includes the other routes' spending. `Diazepam*` is mostly rectal gel by
spend, and diazepam tablets show 44.3× with the large-gap caveat. Refusing every `*` name whose
products span several routes would refuse nearly all of them, because that is what `*` means, so
this waits for an owner decision.

## 25. An extreme estimated spread leads with a warning, not a sentence

*Amended by
[decision 34](#34-spreads-near-a-threshold-labeler-spellings-the-part-d-name-outlier-caveat): a spread just
inside a threshold is no longer shown as the threshold's value (0.2046 is "0.205×").*

**Context.** Decision 20 kept every extreme spread on the card with a caveat below it, but the
card still led with the spread's plain sentence, such as "Medicare paid 99% less than pharmacies
pay." The loudest line on the card then stated as fact a comparison that the caveat beneath it
says may not hold.

**Decision.** For an `estimated` spread at or above 20× or at or below 0.2× (`EXTREME_HIGH`,
`EXTREME_LOW`), the card's headline is "These two figures may not measure the same thing". The
multiple is shown beside it, and the caveat, worded for its direction, says why. The number is
still never hidden or capped, and a `derived` spread never takes this headline. The test uses
the ratio at full precision, as `spread()` in `src/core/rules.js` computes it, not the rounded
multiple on the card. KENALOG-40 200 MG/5 ML VIAL (NDC 00003-0293-20) has a ratio of 0.2046,
shown as 0.20×, and carries no warning.

**Consequences.** `EXTREME_HEADLINE` and `isExtremeSpread()` in `src/core/rules.js` hold the
wording and the test, so the card, methodology.html and `docs/DATA-QUALITY.md` agree on which
spreads take the headline; the generated pages give the current count. A spread just inside a
threshold can display the threshold's own value, as Kenalog does, and methodology.html says the
test is made before rounding.

## 26. Inline data is deflate-raw and base64; the browser floor

*Amended by
[decision 33](#33-the-page-checks-the-inline-datas-sha256-browser-checks-run-in-chromium-firefox-and-webkit):
the page now checks the sha256, and the browser checks run in Firefox and WebKit too.*

**Context.** Decision 6 inlined the JSON text of `packDrugs(doc)` in the page. That text is 6.5
MB (6,502,204 bytes for the first build, 6,515,285 for the rebuilt data), which is a lot to put
on a phone for a page that must work offline from one file.

**Decision.** `build.js` compresses the packed JSON with its own deflate encoder
(`deflateRawFixed`, one fixed-Huffman block, written in the repository because zlib's output can
differ between builds and machines and the page must be byte-identical everywhere), base64-encodes
it, and inlines a descriptor:
`{ format: "openbill.inline/1", encoding: "deflate-raw+base64", content, json_bytes, sha256, data }`.
The page inflates it with the browser's built-in `DecompressionStream("deflate-raw")`. That sets
the browser floor: Chrome and Edge 103, Firefox 113, Safari 16.4. When a browser cannot unpack the
data, the page says so in plain words and shows no figures rather than wrong ones. Decision 6's
guarantee is unchanged: the inflated text unpacks to exactly `data/drugs.json`, and
`tests/build.test.js` checks it.

**Consequences.** openbill.html is about 1.6 MB (1,618,980 bytes as built from the first data).
Older browsers get a message instead of a card; there is no uncompressed fallback. The contract
says the page checks the descriptor's sha256; at the time of this entry `src/app/app.js` checks
the unpacked byte count against `json_bytes`, and the sha256 check is open. Also open: Chrome
and Edge 80 to 102 have `DecompressionStream` but not its deflate-raw format, so there the
message carries the browser's own error text rather than the page's plain sentence.

## 27. Calculated figures show the date or period of each input

**Context.** A calculated record takes the oldest `effective_date` and `retrieved_date` of its
inputs (ARCHITECTURE.md). Next to a spread of a 2024 Part D average over a NADAC price effective
2026-09-23, that oldest date alone says when the older input applied from. It does not say that
the other figure is from this autumn, which is exactly what a reader needs to judge the gap.

**Decision.** The record rules stay as they are, and a calculated record carries `period` only
when every input shares it. Next to any calculated figure the card shows each input's own date or
period, for example "NADAC eff. 2026-09-23 · Part D 2024-01-01 to 2024-12-31", never the oldest
date alone.

**Consequences.** The provenance line of a spread or a Part B conversion is longer, and it
states the gap in time between its inputs. This amends decision 21, which covered how one
record's period is shown.

## 28. An unreconciled crosswalk package size is a quantity with no unit

**Context.** The ASP NDC-HCPCS crosswalk's PKG SIZE column has no unit. OpenBill accepts it as
milliliters, grams or a count of items only when FDA's package description for the same NDC
gives the same total (decision 31 adds kits and a strength check). Where they do not agree, the
number is still a filed fact, but its unit is unknown, and decision 3's kinds (`usd`, `percent`,
`count`, `ratio`) had no place for a measured amount.

**Decision.** `package_size` is a record of kind `quantity`: a measured amount above 0. Its `per`
is the reconciled `package_unit` when there is one. When the package unit is not reconciled,
`per` is left out, because the crosswalk does not state the unit, and the page shows the number
with no unit. OpenBill never guesses ML or EA for it. `KINDS` in `src/core/provenance.js` is
`usd`, `percent`, `count`, `quantity`, `ratio`.

**Consequences.** In the rebuilt data, 1,338 of the 1,427 Part B rows have a reconciled package
size with its unit, and 89 have a quantity with no unit. Those 89 cannot be converted to a price
per NADAC unit, so they have no Part B spread.

## 29. Today, for ages on the page, is the UTC date

**Context.** Decision 21 says the page counts ages "against the viewer's own today" and that an
age can come out negative when "a viewer's clock or time zone is behind UTC". The page takes
today from `isoDate(new Date())` in `src/core/dates.js`, which reads the UTC calendar date. A
viewer in Los Angeles at 19:00 on 17 October and one in Kiritimati at 16:00 on 18 October both
see the same age, counted from 18 October.

**Decision.** Today, for every age on the page, is the UTC calendar date of the viewer's clock,
the same calendar as every date in the data. The time zone never changes an age. A negative age,
which can come only from a device clock set wrong, is still shown as 0 days and is never stale
(`freshness()`).

**Consequences.** Near midnight UTC an age can be a day more or less than the viewer's local
calendar suggests. ARCHITECTURE.md and methodology.html say "the UTC date".

## 30. Part D join refinements: product-code matching, trade-name release forms, generic presentations

**Context.** A review of the rebuilt join found two kinds of inconsistency. Packages of one
product disagreed: an NDC with no exact FDA package match got a Part D figure that its FDA-listed
sibling of the same description was refused, or the reverse (47 products, 54 rows; a zolpidem
sublingual tablet, 49884-0898-52, took the plain zolpidem figure at 0.0359×). And all 26
metformin extended-release gastric and osmotic rows (GASTR-TB, GASTRC-TB, OSM-TAB, OSMOTIC TB)
pointed at the plain `Metformin HCl ER|Metformin HCl` figure, although Part D lists the gastric
and osmotic tablets under names of their own.

**Decision.** Three rules in `tools/build_drugs.py`. Each leaves the row unmatched when it is not
sure.

- **Product-code records for matching only.** A row with no exact FDA package match is matched
  using the FDA product record of its 9-digit product code. It is used only when the code has one
  product record, and only when a sibling NDC of the same NADAC description and code is
  FDA-listed, or FDA's trade name begins the NADAC description, or the name and a strength are
  printed in it. `identity` stays null: it is not an identity, and it never supplies a route
  (decision 24). Counted in `counts.part_d_fda_by_product_code`.
- **Trade-name release forms.** A trade name whose NADAC description carries no release marker
  joins its one unmarked Part D trade-name row when the NADAC description and FDA's proprietary
  name are the same unmarked name and every Rx product FDA lists under that name is in the same
  release family (`_brand_release_ok`). This joins patches and long-acting products whose names
  carry no ER marker: Vivelle-Dot, Exelon, Butrans, Invega Trinza and Hafyera, Abilify Asimtufii,
  Phenytek and others.
- **Generic-name presentations.** A row matched to a Part D row named by the plain generic name
  moves to the row of the same generic name and release family whose extra words all appear in
  the NADAC description, for example `Metformin ER Gastric` and `Metformin ER Osmotic`. If a
  sibling shares a word without fitting, the row is left out (`ambiguous_presentation`). A row
  matched by a name that already names a presentation stays where it is, which keeps the insulin
  pen rules of decision 22.

**Consequences.** Product-code records were tried for 2,035 rows without an identity, and 1,239
of them join. No product now has an unlisted NDC with a Part D figure that a listed sibling is
refused; `tests/data.test.js` checks that. The trade-name rule joins 54 rows, with spreads from
0.59× to 2.39×. 12 gastric rows point at Metformin ER Gastric, which CMS flags as an outlier, so
those cards show no Part D reference; 18 point at Metformin ER Osmotic. Four spot checks, verified
against data.cms.gov and data.medicaid.gov on 2026-10-17, pin both names.

## 31. Part B package reconciliation: kits and the strength check

**Context.** Of the 1,427 Part B rows, 137 had no reconciled package unit. 32 were single kits
(Lupron Depot, Risperdal Consta, Sandostatin LAR, Vivitrol, glucagon emergency kits and others),
which NADAC prices per EA, meaning the whole kit, while FDA describes the kit's contents. 17 had
crosswalk billing-unit columns that disagreed with each other. And one NDC was reconciled wrongly:
Cimzia 50474-0710-79, NADAC $6,094.025 per EA for a kit, was reconciled as one syringe of the
two in its carton, about $628 per "EA".

**Decision.** Two rules in `PartB.block` in `tools/build_drugs.py`.

- **Kits.** For an NDC NADAC prices per EA: when FDA's package chain has a KIT level, the EA
  count is the number of kits. When NADAC's own description says KIT or KT and the NDC has an FDA
  identity with no KIT level, the whole NDC is one EA. PKG SIZE × PKG QTY must equal that count,
  or the package unit stays unreconciled, with the reason.
- **Strength check.** Where the crosswalk's billing-unit columns disagree but FDA's amount equals
  PKG SIZE × PKG QTY, BILLUNITSPKG is used only if FDA's single-ingredient strength × that amount
  ÷ the HCPCS dosage equals it exactly. The `bill_units_per_package` reason spells out the sum.

**Consequences.** `counts.part_b_unit_reconciled_by` gives how each reconciled row was settled:
1,289 by FDA's amount, 32 as kits, 17 by the strength check. 1,338 of 1,427 rows are reconciled,
up from 1,290. Lupron Depot 3.75 now shows Part B $1,799.05 against NADAC $1,822.08. Cimzia's
crosswalk count (2) does not equal one kit, so its package unit is null and it has no Part B
spread. Still open: a per-kit Part B figure for Cimzia needs a rule and schema change, and three
fluticasone-salmeterol rows mix a per-inhaler and a per-blister EA, which no source field tells
apart.

## 32. Counts after the 2026-10-17 rebuild

**Context.** Decisions 18 to 20 and 22 quote counts from the first build of the 2026-10-14
NADAC week. Decisions 24, 30 and 31 changed the joins, and `data/drugs.json` was rebuilt from the
same cached files.

**Decision.** The rules of those entries stand. Their counts are, in the rebuilt data and with
`src/core/rules.js` as it stood at the rebuild (methodology.html and `docs/DATA-QUALITY.md`,
generated from the data with the current rules, carry the figures to rely on):

- Decision 18: 18,390 rows have a Part D reference, 767 a Part B one and 10,874 none. 571 rows
  show Part B beside Part D, and 73 use Part B because CMS flags their Part D figure.
- Decision 19: still 36 single-labeler codes of 138, with 75 rows pointing at them. Of the 767
  Part B spreads on cards, 33 are derived and 734 estimated; of the 571 Part B figures shown
  beside a Part D reference, 32 are derived and 539 estimated.
- Decision 20: 382 rows in 113 products carry the large-gap caveat (was 428 in 125).
- Decision 22: `counts.part_d_unmatched` gives 1,320 rows for an OTC monograph, 152 for a Part D
  row named by the generic name, 175 for an unsettled salt and 1 for an unsettled presentation.
  Its "27,086" is the number of NADAC NDCs found in FDA's `package.txt`; 27,083 of them have a
  product record, and that is the identity count used everywhere else.
- Overall: 19,131 rows (was 19,321) point at 1,458 Part D names (was 1,461). `data/drugs.json` is
  35,129,162 bytes and holds 38,503 records, all `filed`.

**Consequences.** `docs/DATA-QUALITY.md` and methodology.html are generated from the data, so
they carry these numbers once rebuilt; the counts in this log are a record of each change.

## 33. The page checks the inline data's sha256; browser checks run in Chromium, Firefox and WebKit

*Amended by
[decision 34](#34-spreads-near-a-threshold-labeler-spellings-the-part-d-name-outlier-caveat): the Chrome and
Edge 80 to 102 case now gets the page's own sentence, and the Firefox project has run.*

**Context.** Decision 26 left two things open: the page checked only the unpacked byte count,
not the sha256 the contract says it checks, and Chrome and Edge 80 to 102 fail on the
deflate-raw format with the browser's own error text. The docs also state a browser floor for
Firefox and Safari, while the browser checks ran only in Chromium.

**Decision.** `inflate()` in `src/app/app.js` checks the unpacked bytes against `json_bytes`
and their SHA-256 against the descriptor's `sha256`, using `crypto.subtle` where the browser
offers it and `sha256Hex()` from `src/core/sha256.js` where it does not (plain `http://` is
not a secure context). On a mismatch the page shows no figures and says the data may have been
changed or damaged; `tests/browser/openbill.spec.js` checks both a wrong checksum and a changed
price. `playwright.config.js` runs the browser checks in Chromium (360px and desktop, light and
dark), Firefox (desktop, light; Playwright's Firefox has no phone emulation) and WebKit, Safari's
engine (360px light, desktop dark). CI and the devcontainer install all three. Playwright ships
current builds of each engine, so the oldest versions of the floor (Firefox 113, Safari 16.4,
when each added deflate-raw to `DecompressionStream`) are still not a tested result, and README.md
and CONTRIBUTING.md say so. `tests/docs-links.test.js` checks that README.md and CONTRIBUTING.md
name the engines the config runs and that CI installs them.

**Consequences.** A damaged or edited copy of `openbill.html` shows no figures rather than wrong
ones. On 2026-10-18 the two WebKit projects passed 64 of 64 checks in Playwright 1.63's WebKit
on Windows.
Playwright's Firefox could not be started on that machine, so the Firefox project stays
unchecked until it runs elsewhere, such as in CI. Still open from decision 26: Chrome and Edge 80 to 102 show the browser's error text for
the unsupported format rather than the page's own sentence.

## 34. Spreads near a threshold, labeler spellings, the Part D name-outlier caveat

**Context.** After decision 33 the page changed in four ways this log did not record, and three
statements here and in methodology.html went out of date: that a spread just inside a threshold
shows the threshold's value (decision 25), that the crosswalk's labeler spellings are not merged
(methodology.html), and that Chrome and Edge 80 to 102 still show the browser's error text and the
Firefox project has not run (decision 33).

**Decision.**

- *Display precision near a threshold.* `formatSpreadMultiple()` in `src/core/rules.js` (with
  `formatMultipleWithin()` in `src/core/money.js`) adds digits only when a ratio strictly inside
  (0.2, 20) would otherwise show as 0.2× or 20× or beyond: KENALOG-40 200 MG/5 ML VIAL's 0.2046 is
  shown as 0.205×, 19.97 as 19.97×. Every other multiple is unchanged, and the extreme test still
  uses the unrounded ratio. In this build it changes one spread.
- *Labeler spellings.* `distinctLabelers()` counts a code's crosswalk labelers as companies: it
  folds case, punctuation and whitespace and drops a trailing corporate suffix (Inc, LLC, LLP, LP,
  Ltd, Limited, Corp, Corporation, Co, Company, PLC), and keeps words such as USA. The spread's
  reason quotes every spelling. Six of the 138 codes change count (J0717, J2543, J7512, J9260,
  Q0162, Q5099), so 38 codes have a single company where 36 have a single name; no spread changes
  state, because J0717 has no Part B spread and Q5099's Notes keep it estimated. `counts` in
  `data/drugs.json` still counts names; methodology.html counts companies, as the page does.
- *The Part D name-outlier caveat.* `nameOutlier()` (rule `part-d-name-outlier`): when the lower
  median of a product's NADAC prices is at least `NAME_OUTLIER_FACTOR` (20) times the lower median
  of the other products' medians under the same Part D name and unit, the spread's first caveat
  names both prices. Only the high side is tested, and no join is refused. It applies to 34
  products, 32 of them also extreme.
- *Browsers.* `inflate()` catches the TypeError that Chrome and Edge 80 to 102 throw for
  `new DecompressionStream('deflate-raw')` and shows the same sentence as a browser with no
  `DecompressionStream`; a browser spec covers it. On 2026-10-18 all seven Playwright projects,
  Firefox included, passed 245 of 245 checks twice in a row on Windows. Playwright's Firefox could
  not start from its default install folder under that machine's sandbox, so those runs used a
  copy of the same browser builds through `PLAYWRIGHT_BROWSERS_PATH`; nothing in the repository
  depends on it.

**Consequences.** methodology.html and ARCHITECTURE.md describe the four changes. Decision 25's
example now reads 0.205× on the card, and decision 33's two open items are closed. The oldest
browser versions of the floor are still not a tested result.
