# Decisions

A numbered log of the choices behind OpenBill: context, decision, consequences. Entries are
not rewritten; a later entry supersedes or amends an earlier one by number, and the earlier
entry carries a one-line note pointing at it. Entries 1 to 23 were recorded on 2026-10-17,
during phase 1; entries 24 to 32 were recorded later the same day, after a review and a
rebuild of `data/drugs.json`, entries 33 to 48 on 2026-10-18, and entries 49 and 50 on 2026-10-19.
Entries 39 to 49 are phase 2: the cost-plus estimate, "what you were charged" and the drug
pages. The contract
they produce is [ARCHITECTURE.md](ARCHITECTURE.md).

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

*Amended by [decision 43](#43-fda-pharmacologic-classes-for-class-pages-and-related-drugs): a brand and its generic are still separate products, but each drug page links its brand and generic siblings, found through FDA's nonproprietary names.*

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

*Amended by [decision 41](#41-static-drug-pages-built-on-deploy-and-not-committed): the sitemap's `lastmod` dates come from git commit dates, which are inputs, not the clock.*

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

*Amended by [decision 41](#41-static-drug-pages-built-on-deploy-and-not-committed): the static drug pages have no script and load one shared stylesheet and the fonts from the same origin, under their own CSP. The app page is unchanged.*

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

*Amended by [decision 50](#50-links-into-openbills-own-website-are-checked-against-this-commits-build): links into OpenBill's own website are checked against a local build, not the network.*

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

*Amended by [decision 43](#43-fda-pharmacologic-classes-for-class-pages-and-related-drugs): the FDA identity now carries FDA's pharmacologic classes; RxNorm is still not built.*

**Context.** The brief's Tier 2 join keys are the FDA NDC Directory, RxNorm (one identity for
brand, generic and dose) and openFDA (labels, shortages), to be built before anything joins.

**Decision.** Phase 1 ships with the FDA NDC Directory, joined by exact package NDC, as the
only identity. RxNorm and openFDA are not built. `identity.rxcui` is reserved and optional.

**Consequences.** Tier 2 isn't finished, which departs from the brief's order. The Part D
name join runs without RxNorm, which is one reason it is strict (decision 8). Brand and
generic stay separate products (decision 2). RxNorm and FDA drug shortages are good first
issues in [CONTRIBUTING.md](../CONTRIBUTING.md#good-first-issues).

## 15. The brief's mock card numbers were illustrative

*Amended by [decision 39](#39-no-cash-prices-a-cost-plus-estimate-from-nadac-instead): there is still no cash price source; the card adds a cost-plus estimate, labelled `estimated`, and the headline multiple stays Medicare ÷ NADAC.*

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

*Amended by [decision 48](#48-starting-quantity-by-dosage-form-preview-images-stay-png): only an oral tablet or capsule (or lozenge or troche) priced per EA starts at 30; every other product priced per EA starts at 1, with 1 / 2 / 3 buttons.*

*Amended by [decision 49](#49-starting-quantity-case-packs-tablets-and-films-under-the-tongue-fda-listing-outliers): an NDC whose FDA package is a shipping case, or a carton of at least 10 identical bottles, tubes, vials, jars or ampules, counts one inner unit instead of the whole package.*

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

*Amended by [decision 36](#36-the-owner-keeps-multi-route-part-d-averages-on-majority-route-rows): majority-route rows keep the `*` average, disclosed. Amended by [decision 37](#37-a-row-missing-from-the-fda-directory-may-take-its-route-from-its-product-record): a row with no exact package match may take its route from its FDA product record.*

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

*Amended by [decision 37](#37-a-row-missing-from-the-fda-directory-may-take-its-route-from-its-product-record): for a `*` name, the product-code record may now supply a route, following the identity rows' choice.*

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

## 35. data/drugs.json is stored in Git LFS

**Context.** `data/drugs.json` is about 35 MB and every weekly NADAC refresh rewrites it, so
each refresh would add another full copy to the git history and every clone would carry all
of them. The first commit (2026-10-17) stored it as an ordinary file.

**Decision.** From 2026-10-18, `.gitattributes` routes `data/drugs.json` through Git LFS. The
history is not rewritten, so the one ordinary copy in the first commit stays there; every later
version is one LFS object. `openbill.html`, which carries the data compressed inside it, stays
an ordinary file, so opening the page needs nothing. Building or testing needs the real file:
`build.js` stops with a plain message when it finds an LFS pointer, and `tests/lfs.test.js` fails
first with the same instructions. CI fetches the LFS objects and caches them by object id, so a
run downloads the file only when it has changed. The devcontainer installs Git LFS.

**Consequences.** Contributors need Git LFS (README, CONTRIBUTING). LFS use counts against the
repository owner's account: GitHub's free plan includes 10 GiB of storage and 10 GiB of bandwidth
a month ([GitHub Docs](https://docs.github.com/en/billing/concepts/product-billing/git-lfs)). At
one ~35 MB object a week that is about 1.8 GB a year of storage, so storage needs watching after
a few years; bandwidth is spent by clones and CI cache misses. A clone without Git LFS still gets
a working `openbill.html`, but not the data behind it.

## 36. The owner keeps multi-route Part D averages on majority-route rows

**Context.** [Decision 24](#24-multi-route-part-d-names-a-row-joins-only-on-the-route-its-rows-share)
left one question open: a row on the majority route of a `*` name still takes CMS's average,
which includes the other routes' spending (diazepam tablets show 44.3× against `Diazepam*`, which
is mostly rectal gel by spend). Refusing every such name would refuse nearly all of them.

**Decision.** On 2026-10-18 the owner decided to keep these figures. A majority-route row keeps
its `*` figure; the spread stays `estimated`; the Part D record's reason says the average spans
several routes; and the large-gap caveat and headline apply as usual.

**Consequences.** No code change. The disclosure on the card and in the provenance panel is the
safeguard, so it must not be shortened.

## 37. A row missing from the FDA directory may take its route from its product record

**Context.** Under [decision 24](#24-multi-route-part-d-names-a-row-joins-only-on-the-route-its-rows-share)
a row joins a `*` Part D name only when its FDA identity names a route. 371 rows were left out as
`multi_route_no_identity`. 263 of them have a product-code record that `product_code_fda()`
already accepts for the join's other checks
([decision 30](#30-part-d-join-refinements-product-code-matching-trade-name-release-forms-generic-presentations)):
FDA lists the product (labeler + product code) but not that NDC as a package of its own.

**Decision.** On 2026-10-18 the owner decided that such a row may take its route from that same
product-code record, with the same guards, and never from a looser lookup.

- *Follow, never vote.* Rows with an FDA identity choose the name's route exactly as before. A
  row whose route comes from the product record is kept only if its route includes every part
  of the chosen route, and is left out on a tie. Only when no row of a name has an identity
  route would product-record rows choose among themselves (no such name exists today). Letting
  them vote flipped three names (Estradiol\*, Pilocarpine HCl\*, Ivermectin\*), because one
  product's inner unit-dose NDCs counted again beside its listed NDC.
- *On the row.* A row whose Part D join depends on it carries `part_d.route_from: "fda_product"`,
  `part_d.route` (FDA's route), `part_d.product_ndc` (FDA's product NDC as FDA writes it, e.g.
  `50268-662`) and `part_d.inner_of` (the FDA-listed packages of the same product whose
  description prints this NDC as an inner unit; display only, never used to match).
- *On the page.* The provenance panel says FDA's directory does not list the NDC as a package of
  its own, names the package it is listed inside when there is one, and gives the route and the
  product NDC it was taken from.

**Consequences.** In the 2026-10-18 rebuild 146 rows gain a Part D join and none lose one; no
existing join changes key or basis, and every row with an FDA identity keeps its committed
outcome. Of the 263 rows with a product-record route, 117 still don't join (`mixed_units` 58,
`multi_route_minority` 55, `multi_route_tie` 4); 108 rows still have no route at all. 139 of the
146 are unit-dose inner packages FDA prints inside a listed package of the same product. No
product gains a Medicare figure on its card: 145 of the 146 rows belong to products whose listed
NDCs already had it, so the gain is per NDC (fewer "NDCs without this Medicare figure"). An
independent check of all 146 against FDA's `product.txt` and `package.txt` and the Part D file
found no false match.

## 38. The website is GitHub Pages, deployed by a workflow

*Amended by [decision 41](#41-static-drug-pages-built-on-deploy-and-not-committed): the workflow now also builds the drug, class and index pages, the preview images and the sitemap into the deployed site.*

**Context.** OpenBill was a file to download and open. The owner's other projects are websites
on GitHub Pages, deployed by a GitHub Actions workflow, and people expect to open a link.

**Decision.** On 2026-10-18 the owner decided to publish OpenBill the same way, at
`destinjones.github.io/openbill`. `.github/workflows/pages.yml` runs on every push to
`main` and deploys only the three files the pages load: `openbill.html` (also served as
`index.html`), `methodology.html`, and `data/drugs.json`. The workflow fetches the real data file
from Git LFS ([decision 35](#35-datadrugsjson-is-stored-in-git-lfs)), sharing CI's cache, and
refuses to publish an LFS pointer. It also runs `node build.js --check` and `node --test` before
deploying, so the site is always the committed, tested build.

**Consequences.** Opening the site needs nothing; the page behaves the same over https as from
`file://`, with the same CSP and no third-party requests. Reading `data/drugs.json` from the site
uses Pages bandwidth, not LFS bandwidth; a deploy uses LFS bandwidth only when the data changed.
Pages' source must stay set to "GitHub Actions".

## 39. No cash prices; a cost-plus estimate from NADAC instead

*Amended by [decision 47](#47-corrections-from-the-phase-2-review): the KFF Health News article reports a lower ($3, 2023) labor fee, so it is cited for the method only; the $5.00 fee rests on the company's site on 2026-10-18.*

**Context.** The brief's card mock pairs what pharmacies pay with a "cash list price", and
phase 1 had no source for one ([decision 15](#15-the-briefs-mock-card-numbers-were-illustrative)).
No free source of retail cash prices can be reused. These terms were read on 2026-10-18.
GoodRx's API terms forbid storing its data, and pharmacy websites' terms forbid scraping them.
Cost Plus Drugs' Terms of Service say users will not "copy, modify or harvest data, Content, or
materials from the Online Services". They grant only a "personal, noncommercial" licence.

**Decision.** On 2026-10-18 the owner decided that OpenBill shows no one's cash price. It shows
a **cost-plus estimate**: what a pharmacy would charge if it priced the way Cost Plus Drugs
publicly describes (its cost, plus a 15% markup, plus a pharmacy fee) and paid what NADAC says
pharmacies pay.

```
cost-plus estimate = qty × NADAC per unit, rounded half-up to the cent
                   + 15% of that, rounded half-up to the cent
                   + $5.00 per fill                     (shipping not included)
```

- The parameters live in `COST_PLUS` in `src/core/rules.js`: `markup_pct: 15` and
  `fee_usd: 5`. Each one cites where it comes from: KFF Health News's coverage of the company
  for the method, and the company's own website, which showed a $5.00 pharmacy labor fee on
  2026-10-18. Those two parameters are all OpenBill takes from Cost Plus Drugs. No Cost Plus
  price, and no "retail price at other pharmacies" figure from its site, is copied, stored or
  shown anywhere; a unit test checks that `COST_PLUS` holds no dollar figure but the fee.
- `costPlusEstimate()` works in integer cents, so a reader can check each step on the card.
  The record is `estimated`: `source_name` "OpenBill calculation", `source_url`
  `methodology.html#cost-plus`, NADAC's file and dates. Its reason gives the formula with the
  numbers and says it is a model, not a price any pharmacy quoted. It also says that Cost Plus
  Drugs' own costs differ from NADAC and that shipping is not included.
- The card labels it "Cost-plus estimate", never "typical cash price".
- **No spread against it.** A multiple of our own formula over NADAC would be circular: it is
  NADAC × 1.15 plus a fee, so it only measures the fee. For cheap generics the fee dominates:
  for 30 metformin 500 mg tablets the estimate is $5.51 against $0.44 at NADAC, and for 30
  lisinopril 10 mg tablets $5.62 against $0.54. The headline multiple stays Medicare ÷ NADAC.

**Consequences.** Every product with a pack total gets an estimate: 5,924 of 5,936 in the
2026-10-14 build. The other 12 show "We don't know yet" for the same reason as their pack total
(their NDCs are priced per different units). The estimate is a reasonable expectation for a
cash buyer to compare with, and the card does not present it as more than that. If Cost Plus
Drugs changes its fee or markup, `COST_PLUS` and its cited date must change together, and the
methodology page follows from it.

## 40. What you were charged: the reader's own number, never stored or sent

*Amended by [decision 47](#47-corrections-from-the-phase-2-review): the amount rides in the address, so the browser's history keeps it; the card now says so, and over-long input is refused before any arithmetic.*

**Context.** A reader's real question is often "was I overcharged?". The card can answer that
only with a number the reader supplies.

**Decision.** The card has an optional "What were you charged?" input for the pack it shows.
`paidComparison()` in `src/core/rules.js` turns it into a multiple of what pharmacies pay for
that pack (NADAC) and of the cost-plus estimate. The card labels both "your number", for
example "You paid 3.6× what pharmacies pay for this pack, and 1.4× the cost-plus estimate." for
$12.00 on the showcase card.

- Input is checked by `parsePaid()`: more than $0, at most $100,000.00 (`PAID_MAX_USD`), at
  most two decimals; "$", ".50" and "1,234.50" are accepted. Anything else gets a sentence
  saying why, which never repeats what was typed, and no multiple.
- The amount is never stored, logged or sent anywhere. The only place it may live is the URL
  hash (`&paid=12.00`). Browsers do not send the hash to the server, and it is there so that a reader
  can share their own card if they choose.
- A range of NDC prices gives a range of multiples ("between A and B …, depending on the NDC").

**Consequences.** OpenBill never sees what anyone paid, so it cannot publish or aggregate
reader prices. A link a reader shares does carry their amount, and the methodology page says
so. Insurance, coupons and deductibles change what people pay, so the page presents the
multiple as a question to ask the pharmacy, not proof of a mistake. Static drug pages have no
script, so the input lives only on the app card.

## 41. Static drug pages, built on deploy and not committed

*Amended by [decision 46](#46-product-names-that-share-a-slug-each-get-a-suffix-from-their-own-name): product names that share a slug each get a suffix from their own name, so the build no longer stops on them.*

*See [decision 48](#48-starting-quantity-by-dosage-form-preview-images-stay-png): JPEG preview images were tried, measured larger and reverted, so the preview images stay PNG files, `og/<slug>.png` and `og/site.png`.*

**Context.** The app is one page whose data is unpacked in the browser. Search engines and link
previews see none of its numbers, and a person searching "aripiprazole price" never reaches it.

**Decision.** On 2026-10-18 the owner decided that `tools/site.mjs`, run by
`.github/workflows/pages.yml`, writes the site into `_site/` on every deploy. The site has one
static page per product (`drug/<slug>/`), one per FDA pharmacologic class (`class/<slug>/`),
an A–Z index (`drugs/<letter>/`), a 1200×630 preview image per product (`og/<slug>.png`,
rendered with Playwright) and `sitemap.xml`. None of it is committed
([ARCHITECTURE.md](ARCHITECTURE.md#drug-pages-built-on-deploy-not-committed)).

- **The app stays one self-contained page.** `openbill.html` is unchanged in kind. It works from
  `file://` and offline, and it carries its data inline. Each static page links to its
  interactive card (`../../#drug=…`).
- **Static pages have no JavaScript.** Their numbers are in the HTML source, built by the same
  core rules, with the state chips and source lines a card shows. Their CSP is
  `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'`.
  They share one stylesheet (`assets/site.css`) and the IBM Plex fonts (`assets/fonts/`) from
  the same origin: still no third-party request.
- **Slugs:** `slugify()` in `src/core/slug.js`. The build fails on a collision rather than
  guessing.
- **`lastmod`** in the sitemap comes from git: for data pages, the last commit that touched
  `data/drugs.json`. The build reads no clock.

**Consequences.** The repository does not grow by thousands of pages per refresh, and the
committed files stay the reviewed source of truth. The deployed pages are not in the
repository, but anyone can regenerate them from a commit with `tools/site.mjs`. Deploys take
longer, mostly for the preview images. The 2026-10-14 data
has two pairs of product names that differ only in punctuation and share a slug ("MICONAZOLE 7
CREAM" and "MICONAZOLE-7 CREAM"; "TIOCONAZOLE 1 6.5% OINTMENT" and "TIOCONAZOLE-1 6.5%
OINTMENT"), so `uniqueSlugs()` refuses the data until a rule for such pairs is chosen and
recorded here.

## 42. JSON-LD uses DrugCost, not Offer or PriceSpecification

**Context.** Structured data on the drug pages helps search engines read the numbers.
schema.org's `Offer` and `PriceSpecification` describe something for sale at a price.

**Decision.** Each drug page carries one JSON-LD `@graph`. It holds a `BreadcrumbList`, a `Drug`
whose `cost` is a list of `DrugCost` entries, and a `FAQPage` whose answers come from the
page's own data. The NADAC entry's `costOrigin` names the NADAC file; the Medicare entry
carries its period. No `Offer`, `PriceSpecification` or `AggregateOffer` is used.
Every number in the JSON-LD equals the one in the HTML.

**Consequences.** OpenBill never tells a search engine that a drug is for sale at a price,
which would be a quote, and the brief forbids claiming one. Only the NADAC and Medicare figures
are `DrugCost` entries. The cost-plus estimate is not a cost anyone paid or charged, so it is
not one. Rich results for `DrugCost` are not guaranteed; correctness comes first.

## 43. FDA pharmacologic classes for class pages and related drugs

**Context.** Drug pages need "related drugs" and class pages. RxNorm is not built
([decision 14](#14-rxnorm-is-deferred-identity-is-the-fda-ndc-directory-for-now)). The FDA NDC
Directory already in the build lists each product's pharmacologic classes (`PHARM_CLASSES`).

**Decision.** `identity.pharm_classes` holds FDA's `PHARM_CLASSES` for the row's exact package
match. FDA's text is split into entries at each `, ` that follows an entry's closing `]`,
because some class names contain `, ` (such as `Anti-Inflammatory Agents, Non-Steroidal [CS]`).
Each entry is kept once, in FDA's order. The field is left out (never `null` or `[]`) when FDA
gives no classes, and it is never borrowed from another package of the product code. Classes
use the `[EPC]` (Established Pharmacologic Class) entries. `src/core/related.js` gives:

- `epcClasses(product)`: a product's EPC classes, from its rows that have an identity
  (some NDCs of a product have none);
- `siblings(product, products)`: the brand and generic versions, which share at least one
  nonproprietary name with it. A shared name is enough, not the full set of names, because
  labelers spell one ingredient several ways;
- `related(product, products, index, 5)`: up to five other drugs in the same classes, siblings
  left out, each drug once, ranked by classes shared, then Part D claims, then name.

**Consequences.** In the 2026-10-14 build, 24,902 of the 27,083 rows with an FDA identity carry
classes. They span 329 EPC classes. 2,181 identity rows have none, because FDA's cell is
blank (over-the-counter loratadine, for one). Those products get no class page link, and the page
says nothing rather than guessing. Brand and generic stay separate products, now linked to each
other. Classes are FDA's labels for what a drug does. They are not advice about substituting
one drug for another, and no page may present them that way.

## 44. No robots.txt for a project site; the sitemap is submitted instead

**Context.** The site is a GitHub Pages project site at `destinjones.github.io/openbill/`.
Crawlers read `robots.txt` only at the root of a host, here `destinjones.github.io/robots.txt`,
which belongs to the account's user site, not to this repository.

**Decision.** The generator writes no `robots.txt`. `sitemap.xml` is published at
`/openbill/sitemap.xml` and submitted to search engines directly, for example through Google
Search Console.

**Consequences.** A `robots.txt` inside `_site/` would never be read, so it would only mislead.
If the account later gets a user site, its `robots.txt` may list this sitemap. If OpenBill moves to its own
domain, it should add a `robots.txt` then.

## 45. The showcase: aripiprazole 10 mg tablets, 30

**Context.** The default card, the README, the screenshots and the site's preview image need one
product. It should be a real, widely used drug with a gap that is large enough to matter, and
it must not be an extreme case where the two figures may not measure the same thing
([decision 25](#25-an-extreme-estimated-spread-leads-with-a-warning-not-a-sentence)).

**Decision.** On 2026-10-18 the owner chose **ARIPIPRAZOLE 10 MG TABLET at 30**:

- Pharmacies pay **$3.35**: 30 × $0.11173 per EA, the NADAC for all 31 NDCs, effective
  2026-09-23 in the file as of 2026-10-14 (`filed`).
- Medicare Part D paid **$46.50**: 30 × $1.5499353611, the 2024 average spending per dosage
  unit of the generic `Aripiprazole` / `Aripiprazole` row, all 24 manufacturers, 3,844,727
  claims, outlier flag 0. This is an average for one data year. It covers all strengths
  together, and it is gross of rebates.
- **13.9×**, `estimated`, under the 20× warning threshold. Cost-plus estimate $8.85.

Checked in the raw Part D file: the generic row leaves out the orally disintegrating tablets
(`Aripiprazole ODT`, $15.551425783 per unit) and the injectables (`Abilify Maintena`,
`Abilify Asimtufii`, `Aristada`), which CMS reports on their own rows. One form it may include
is the oral solution. NADAC prices 7 of the 184 NDCs that join the name per ML, and the card's
reason says so.

**Consequences.** One product's numbers appear in the README and in the preview images, so
each data refresh must recheck them. `docs/HAND-CHECK.md` lists it first. If the gap moves past
a threshold or the join changes, the showcase is chosen again and recorded here.

## 46. Product names that share a slug each get a suffix from their own name

**Context.** [Decision 41](#41-static-drug-pages-built-on-deploy-and-not-committed) made the site
build stop when two product names share a slug, until a rule was chosen. The 2026-10-14 data has
two such pairs, which differ only in punctuation: "MICONAZOLE 7 CREAM" and "MICONAZOLE-7 CREAM",
and "TIOCONAZOLE 1 6.5% OINTMENT" and "TIOCONAZOLE-1 6.5% OINTMENT". The deploy failed on them, and
the required CI checks did not build the site, so nothing caught it before merge.

**Decision.** Recorded by the phase 2 fixer on 2026-10-18, for the owner to confirm or replace.
`siteSlugs(names)` in `src/core/slug.js` gives every product its slug. A name whose `slugify()`
slug no other name shares keeps it. Names that do share one each get `-` and the first 8 hex
digits of the SHA-256 of their exact UTF-8 name appended (for example
`miconazole-7-cream-` plus 8 hex digits). Neither name is picked to keep the plain URL, and each
suffix depends only on that name, not on the order of the data or on which other names exist.
If two final slugs still matched, the build stops. The app's "Shareable page" link and
`tools/site.mjs` both call `siteSlugs()`, so they always agree. Class slugs keep
`uniqueSlugs()`, which stops on any collision. CI now builds the site (without preview images)
in the required `test` job, so a name the rules cannot place fails before merge, not at deploy.

**Consequences.** Four products have suffixed URLs today. A suffixed URL changes back to the
plain slug if its twin leaves the NADAC file; a re-submitted sitemap carries the new URL. NADAC
names are not merged: the two spellings may be different products, and NADAC prices them
separately.

## 47. Corrections from the phase 2 review

*Amended by [decision 48](#48-starting-quantity-by-dosage-form-preview-images-stay-png): kits and the other products priced per EA that are not oral tablets or capsules start at 1, so titles, descriptions and preview alt text quote the card's own 1-unit pack total instead of the unit price, and the starting-quantity question this entry left open is settled.*

**Context.** The honesty, SEO and security reviews of phase 2 found statements that were not
true in every case, and a few hardening gaps. Recorded on 2026-10-18 by the phase 2 fixer.

**Decision.**

- **Part D unmatched.** Rows without a Part D join said "No Medicare Part D spending row matched
  this drug by brand or generic name". That is false where Part D has a row with the name that the
  builder refused (amoxicillin 500 mg capsules: Part D row 700 exists, refused for mixed units).
  Rows do not record the builder's reason, so the card now says only what is always true
  (`PART_D_UNMATCHED_REASON`): OpenBill did not match the NDC to a usable Part D row; either Part D
  has none, or the rows that share its name could not safely be tied to it. Storing the builder's
  per-row reason in `data/drugs.json` is left for a later schema change.
- **The cost-plus fee's source.** KFF Health News (17 February 2023) describes the method but
  reports a $3 labor fee. `COST_PLUS` and methodology.html now cite it for the method only and
  say the $5.00 fee is what Cost Plus Drugs' website showed on 2026-10-18. No archived copy of
  that page could be retrieved; the owner should record one.
- **What you were charged.** The amount is written into the address with
  `history.replaceState`, so the browser's history keeps it. The card, the rule and
  methodology.html now say so in one sentence (`PAID_PRIVACY`). `parsePaid()` refuses text longer
  than 32 characters, or with more than six whole-dollar digits, before any arithmetic: a crafted
  `&paid=` of 400,000 digits used to crash the card in WebKit and Firefox.
- **Drug pages.** A counter question names a generic only when FDA lists it with the same
  dosage forms, routes and strengths (Ambien CR is no longer offered immediate-release
  zolpidem). Titles, descriptions and preview alt text give the per-unit price where 30 units is
  not a plain supply (kits, pens, syringes, vials, patches; anything not an oral tablet or
  capsule), state the Part D figure as a yearly average over all strengths and forms, and repeat
  "Medicare's price is not your price." The five honesty lines are introduced as the rules
  OpenBill holds its pages to; the brief's wording stays verbatim. Pages no longer say "this
  week's" NADAC file; they name its date.
- **Site build.** The preview-card renderer runs with JavaScript off and every request aborted,
  and fails on a dialog or a card whose content overflows. `--out` is emptied only when it holds the
  `.openbill-site` marker and no `.git`. The Pages workflow's build job has read-only
  permissions and a started deploy is never cancelled. The site has a `404.html`; class pages of
  one or two products stay out of the sitemap; a page's `lastmod` follows its code as well as its
  data.

**Consequences.** A unit, site or browser test covers each change above except the workflow permissions and the sitemap's `lastmod` inputs, and the preview-card fit, which `tools/site.mjs` checks on every card it renders. Two owner decisions remain open:
the starting quantity for kits and injectables
([decision 23](#23-starting-quantity-30-per-ea-one-package-per-ml-or-gm-when-fda-agrees-else-1)),
which the page bodies and preview cards still use, and whether reader-facing pages should show
the brief's house-rule sentences at all.

## 48. Starting quantity by dosage form; preview images stay PNG

*Amended by [decision 49](#49-starting-quantity-case-packs-tablets-and-films-under-the-tongue-fda-listing-outliers): tablets and films taken under the tongue or against the cheek start at 30, a product whose NDCs are mostly oral tablets or capsules (and whose NADAC name says so) starts at 30 despite an outlier FDA listing, and a wholesale case or multi-pack priced per ML or GM starts at one inner unit.*

**Context.** [Decision 23](#23-starting-quantity-30-per-ea-one-package-per-ml-or-gm-when-fda-agrees-else-1)
started every product priced per EA at 30, a month of a once-a-day tablet. NADAC prices kits,
pens, syringes, vials, patches, inhalers and suppositories per EA too, so a kit opened at
"Pharmacies pay $263,287.57 for 30 kits" (AVONEX 30 MCG/0.5 ML SYRINGE KIT (4 PACK), 30 ×
$8,776.25195). [Decision 47](#47-corrections-from-the-phase-2-review) worked around it on the
drug pages by putting the unit price in titles, and left the starting quantity to the owner.
Separately, the preview images of [decision 41](#41-static-drug-pages-built-on-deploy-and-not-committed)
were PNG files, and the owner asked for JPEG to make them smaller.

**Decision.** On 2026-10-18 the owner decided the starting quantity and asked for JPEG preview
images; on 2026-10-19, after the measurement below, the owner reverted the images to PNG.
Recorded by the phase 2 fixer.

- **Oral solids start at 30; everything else priced per EA starts at 1.** `eaForm()` and
  `defaultQuantity()` in `src/core/rules.js` decide from the FDA identity when any NDC of the
  product has one: an oral solid is a dosage form starting `TABLET`, `CAPSULE`, `LOZENGE` or
  `TROCHE` (so film coated, extended and delayed release, orally disintegrating and chewable
  tablets all count) with FDA's route `ORAL` and nothing else, on every listed NDC. Such a
  product starts at 30 (`DEFAULT_EA_QUANTITY`) with buttons 30, 60 and 90. Any other product
  priced per EA starts at 1 (`DEFAULT_EA_OTHER_QUANTITY`) with buttons 1, 2 and 3. A product FDA
  does not list is decided from its NADAC description: an oral solid's word (`TABLET`, `TAB`,
  `TB`, `CAPSULE`, `CAP`, `CAPLET`, `CPLT`, `SOFTGEL`, `GELCAP`, `ODT`, `LOZENGE`, `TROCHE`) and no
  word for another form or route (`KIT`, `SYRINGE`, `PEN`, `VIAL`, `VL`, `PATCH`, `SUPP`, `SPRAY`,
  `SL`, `VAGINAL` …). When neither says, it starts at 1 and the reason says so: a smaller start
  is the honest failure. ML and GM are unchanged.
- **The reason names the form.** For example, "the FDA NDC Directory lists its NDC as dosage form
  “KIT” with route “INTRAMUSCULAR”. Only a tablet, capsule, lozenge or troche with route “ORAL”
  starts at 30, and this is not one." The card shows it under the quantity for every product that
  is not an oral solid, as it already did for ML and GM.
- **What one EA is, only where it is plain.** The quantity reads "1 patch", "1 suppository",
  "1 ring", "1 film" where FDA's dosage form is itself the unit. For kits and for forms of a
  substance (injections, powders, solutions, sprays) it reads "1 unit (EA)", and the reason says
  NADAC's EA may be the whole package or one dose in it. The owner's example wording was
  "1 kit — priced per kit"; it is not used, because the data contradict it for some kits and
  devices. The three AFREZZA kits, each 180 cartridges by FDA's package description, are priced
  at $7.78053 to $13.03769 per EA, in line with one cartridge (the cartridge cartons are $5.20552
  to $15.65297 per EA), not with a kit. ADVAIR 100-50 DISKUS, one inhaler of 60 doses by FDA, is
  $2.48669 per EA.
- **Sublingual and buccal tablets start at 1.** The rule follows FDA's route literally, so a
  `TABLET` with route `SUBLINGUAL`, `BUCCAL` or `VAGINAL` starts at 1 tablet, and so does a name
  with `SL`. Pastilles, gums and gummies are not on the list of oral solids either. The owner
  may widen the list; it is one regular expression.
- **Titles quote the card's own total again.** With kits and the like at 1, decision 47's
  workaround (the unit price in titles, descriptions and preview alt text for anything not an
  oral tablet or capsule) is gone: every title quotes the pack total for the quantity the card
  starts at ("pharmacies pay $8,776.25 for 1 unit (EA)"), and every description carries the
  cost-plus estimate.
- **Preview images: JPEG was tried, measured larger, and reverted to PNG.** On 2026-10-18
  `tools/site.mjs` was switched to write `og/<slug>.jpg` and `og/site.jpg` with Playwright's
  `type: 'jpeg'` at quality 80, with `og:image:type` `image/jpeg` on every page. Quality 80 was
  chosen on six cards rendered at 70, 80, 85 and 90 and compared with the PNG at full size and at
  400px wide: all four kept the text crisp to the eye, 70 left a few pixels more than 48 levels
  off the PNG, and 80 left none. A full build then showed JPEG larger, not smaller (below),
  because the cards are flat colour and text, which PNG compresses well and JPEG does not. On
  2026-10-19 the owner reverted it: `tools/site.mjs` writes `og/<slug>.png` and `og/site.png`
  with Playwright's `type: 'png'` (`OG_IMAGE_EXT` and `OG_IMAGE_TYPE` in
  `src/build/drugpage.js`), and every page's `og:image` and `twitter:image` point at them, with
  `og:image:type` `image/png`.

**Consequences.** In the 2026-10-14 build, of the 4,221 products priced per EA, 3,520 start at
30 (3,460 by FDA's listing, 60 by their NADAC name) and 701 start at 1 (672 by FDA's listing,
20 by a name word, 9 because nothing says). Of those 701, 475 read "1 unit (EA)", 115 "1 patch",
35 "1 suppository", 29 "1 tablet" (28 sublingual or vaginal; SEVELAMER HCL 800 MG TABLET because
FDA lists two of its NDCs with route PARENTERAL), 26 "1 film", 8 "1 piece of gum", 5 "1 ring",
5 "1 insert", 2 "1 capsule" and 1 "1 lozenge". FEBUXOSTAT 40 MG and 80 MG TABLET also start at 1
unit (EA), because FDA lists one NDC of each as dosage form FILM. The 1,703 products priced per ML
or GM and the 12 priced in mixed units are unchanged. The five largest pack totals on a card as
it first opens were all kits, pens or vials at 30, from $202,362.84 to $263,287.57; now they are
$22,774.36 to $49,672.20, and the largest is a GM product whose one FDA package is a case of 40
bottles (TACLONEX 0.005%-0.064% SUSPENSION, 2,400 g), which decision 23's package rule allows.
The JPEG measurement: the site's 5,937 preview images went from 439,920,693 bytes (419.5 MiB) as
PNG to 503,425,099 bytes (480.1 MiB) as JPEG at quality 80, 14.4% more, and the whole site from
629,519,151 bytes (600.4 MiB) to 693,558,780 bytes (661.4 MiB). So the preview images are PNG
again, as decision 41 first had them.

## 49. Starting quantity: case packs, tablets and films under the tongue, FDA listing outliers

**Context.** Three cases in [decision 48](#48-starting-quantity-by-dosage-form-preview-images-stay-png)'s
starting quantities, in the 2026-10-14 build, went back to the owner:

- A product priced per ML or GM started at the amount in one FDA package
  ([decision 23](#23-starting-quantity-30-per-ea-one-package-per-ml-or-gm-when-fda-agrees-else-1)),
  even when that package is a shipping case. TACLONEX 0.005%-0.064% SUSPENSION, whose one FDA
  package is "40 CARTON in 1 CASE (50222-501-06) / 1 BOTTLE in 1 CARTON / 60 g in 1 BOTTLE",
  opened at 2,400 g and $49,672.20, the largest pack total on any card as it first opens.
  Injectables sold to clinics in trays of 25 vials opened at the whole tray.
- Tablets and films taken under the tongue or against the cheek started at 1, because the rule
  followed FDA's route `ORAL` literally: buprenorphine, buprenorphine/naloxone, Zubsolv,
  asenapine, zolpidem SL.
- FEBUXOSTAT 40 MG and 80 MG TABLET started at 1 because FDA lists one NDC of each as dosage form
  `FILM`, and SEVELAMER HCL 800 MG TABLET because FDA lists two of its NDCs with route
  `PARENTERAL`. Febuxostat's reason then said NADAC's EA "may be a whole package (such as a kit,
  pen, syringe, vial or inhaler)", and both reasons said "the 13 of its 14 NDCs it has".

**Decision.** On 2026-10-19 the owner decided all three. Recorded the same day by the phase 2
fixer.

- **A wholesale case or multi-pack starts at one inner unit.** `packageStart()` in
  `src/core/rules.js` reads each NDC's FDA package description. When its outermost level is a
  `CASE` of 2 or more inner units, or a `CARTON`, `BOX`, `PACKAGE` or `TRAY` of at least 10
  (`WHOLESALE_MIN_UNITS`) identical `BOTTLE`s, `TUBE`s, `VIAL`s, `JAR`s or `AMPULE`s whose amount
  is printed on the next level, that NDC counts the amount in one inner unit ("40 CARTON in 1
  CASE / 1 BOTTLE in 1 CARTON / 60 g in 1 BOTTLE" is 60 g) instead of the whole package. Decision
  23's rule then applies unchanged: every listed NDC must give the same usable amount. The inner
  unit's amount must read on its own in NADAC's unit, and when counting inner units leaves the
  NDCs disagreeing, the whole packages decide exactly as before. The reason names the NDC, what
  the pack is and how many units it holds. Smaller cartons, and cartons of pens, syringes,
  cartridges, packets, cups or pouches, stay whole: in this data they are packs a pharmacy hands
  over as they are (a two-bottle bowel prep, four weekly alendronate bottles, seven nightly
  enemas, twin-pack eye drops, five insulin pens).
- **Tablets and films under the tongue or against the cheek are oral solids.** An NDC whose FDA
  dosage form starts with `TABLET` or `FILM` and whose route is `SUBLINGUAL` or `BUCCAL` (alone,
  together, or with `ORAL`) counts like a swallowed tablet: the product starts at 30 with buttons
  30, 60 and 90. Vaginal tablets, capsules and gums with these routes, oral films, and every
  other route still start at 1. For a product FDA does not list, a NADAC name whose only word for
  another route is `SL`, `SUBLINGUAL` or `BUCCAL`, next to a tablet or film word, counts the same
  way. The owner's decision named FDA's route; the name rule follows it so that no card says only
  swallowed tablets start at 30 while FDA-listed sublingual ones do (it moves GRASTEK and
  RAGWITEK), and the owner may narrow it. The reason says how the product is taken and that
  OpenBill counts it as an oral solid, and the card shows it under the quantity.
- **An outlier FDA listing does not decide.** When the NADAC name has a tablet or capsule word
  (`TABLET`, `TAB`, `TB`, `ODT`, `CAPSULE`, `CAP`, `CAPLET`, `CPLT`, `SOFTGEL`, `GELCAP`) and more than
  half of the product's FDA-listed NDCs, by count, are oral solids by the rules above, it starts
  at 30. The reason names each other NDC with FDA's form and route, says it matches neither the
  NADAC name nor the product's other NDCs and looks like an error in the listing, and the card
  shows it under the quantity. Exactly half, or a name without such a word, still starts at 1,
  and the reason says which.
- **Reason wording.** "13 of its 14 NDCs (it does not list the other one)" replaces "the 13 of
  its 14 NDCs it has". A product whose NDCs are partly tablets and still starts at 1 says its
  NDCs are listed as different dosage forms, not that its EA may be a kit, pen or vial.

**Consequences.** In the 2026-10-14 build, 132 products start at a different quantity; a test
in `tests/rules.test.js` lists each one, before and after. 45 priced per EA go from 1 to 30: 42
tablets and films under the tongue or against the cheek (40 by FDA's route, GRASTEK and RAGWITEK
by their NADAC names), and FEBUXOSTAT 40 MG TABLET, FEBUXOSTAT 80 MG TABLET and SEVELAMER HCL
800 MG TABLET by the majority of their listings. 87 priced per ML or GM change, 81 per ML and 6
per GM: 78 go down to one inner unit (TACLONEX from 2,400 g to 60 g, $1,241.81; heparin trays
from 25 mL to 1 mL; CALCIUM CARB 1,250 MG/5 ML SUS from a case of 12 to one 473 mL bottle), and
9 go up from 1 to one inner unit, because counting one unit made their NDCs agree (DESOXIMETASONE
0.05% CREAM 60 g, VALPROIC ACID 250 MG/5 ML SOLN 473 mL). Four more start at one inner unit whose
amount is the 1 they started at before. Of the 4,221 products priced per EA, 3,565 start at
30 (3,503 by FDA's listing, 62 by their NADAC name) and 656 start at 1. Of the 1,703 products
priced per ML or GM, 1,117 start at one package (890 per ML, 227 per GM), 91 at one inner unit
of a wholesale pack (85 per ML, 6 per GM) and 495 at 1 (281 per ML, 214 per GM); the 12 priced in
mixed units are unchanged. The largest pack total on a card as it first opens is now STELARA 90
MG/ML SYRINGE at 1 mL, $29,792.79. Two judgement calls are flagged for the owner: TESTIM 1% (50
MG) GEL and TESTOSTERONE 50 MG/5 GRAM GEL now start at one 5 g tube of a carton of 30 (it was
150 g), though such a carton may be a month's supply handed over whole; and the NADAC-name rule
for `SL` above. None of the ten products in [HAND-CHECK.md](HAND-CHECK.md) changes.

## 50. Links into OpenBill's own website are checked against this commit's build

**Context.** [Decision 13](#13-external-link-checks-are-opt-in) checks external links over the
network and skips links to this repository's GitHub URLs. Pages now link into the website itself
(for example the A–Z index at `drugs/a/`), and a page added by a change does not exist on the
live site until that change is merged and deployed, so the required `links` check would fail on
every pull request that adds one.

**Decision.** Links that start with `SITE_URL` are checked against a local build of the site made
from the same commit (`node tools/site.mjs --out <dir> --no-og`), compared path segment by path
segment with exact case, as GitHub Pages serves them. The CI `links` job builds the pages first
and passes the folder as `OPENBILL_SITE_DIR`; without it, `tests/docs-links.test.js` skips those
links and says so.

**Consequences.** A link into a page the build does not produce still fails before merge, and a
new page can be linked in the same change that adds it. The live deploy itself is checked after
merge, by hand or by loading the site.
