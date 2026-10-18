# Data sources

Every number in `data/drugs.json` comes from one of the files below, read by
`tools/build_drugs.py` from `tools/cache/` after its sha256 has been checked against
`tools/cache/manifest.json`. Fetch them with `python tools/fetch_all.py` (skips anything unchanged
on the server; `--offline` never touches the network; `--force` downloads again).

The source ids (`nadac`, `fda_ndc`, `partd`, `asp_limits`, `asp_crosswalk`) are the keys of
`sources` in `data/drugs.json` and of the manifest. Dates below are those of the files in the
current build, retrieved 2026-10-17 (`nadac`, `fda_ndc`) and 2026-10-18 (`partd`, `asp_limits`,
`asp_crosswalk`). `retrieved_date` is the UTC date of the download.

| id | what it is | publisher | current file | as of / period | rows used |
|---|---|---|---|---|---|
| `nadac` | NADAC weekly reference prices | CMS, via data.medicaid.gov | `nadac-national-average-drug-acquisition-cost-20261014.csv` (107.3 MB) | as of 2026-10-14 (newest of 41 weekly files) | 30,031 current NDCs |
| `fda_ndc` | FDA NDC Directory | FDA, CDER | `ndctext.zip` (10.9 MB; `product.txt`, `package.txt`) | Last-Modified 2026-10-16 | 116,607 products, 219,166 packages |
| `partd` | Medicare Part D Spending by Drug | CMS, Office of Enterprise Data and Analytics | `DSD_PTD_RY26_P04_V10_DY24_BGM.csv` (5.3 MB) | data year 2024 (2024-01-01/2024-12-31); catalog modified 2026-06-25 | 3,625 "Overall" rows |
| `asp_limits` | Medicare Part B payment limit file | CMS | `october-2026-medicare-part-b-payment-limit-files-final.zip` | quarter 2026-10-01/2026-12-31; posted 2026-09-17 | 918 HCPCS codes |
| `asp_crosswalk` | ASP NDC-HCPCS crosswalk | CMS | `october-2026-ndc-hcpcs-crosswalk-final.zip` | quarter 2026-10-01/2026-12-31; posted 2026-09-17 | 7,403 NDC lines |

Join results in the current build: identity 27,083 of 30,031 rows (90.2%); Part D 19,131 rows
(63.7%) pointing at 1,458 Part D names; Part B 1,427 rows (4.8%) pointing at 138 HCPCS codes,
1,338 of those rows with the package unit reconciled to the NADAC unit. `counts` in
`data/drugs.json` breaks every null down by reason.

## How `data/drugs.json` stores the figures (schema `openbill.drugs/3`)

The contract is [ARCHITECTURE.md](ARCHITECTURE.md) (section "`data/drugs.json` — schema
`openbill.drugs/3`"). In short:

- **Per NDC, on the row:** the NADAC record (and the corresponding generic NADAC where the NADAC
  row lists one), the FDA identity, and the crosswalk's package figures for that NDC
  (`part_b.bill_units_per_package`, `package_size`, `package_qty`, `package_unit`).
- **Per Part D name, in `part_d_names`:** CMS publishes one Part D figure per brand name +
  generic name, so it is written once, keyed `"<Brnd_Name>|<Gnrc_Name>"` with CMS's exact strings
  (e.g. `Eliquis|Apixaban`), holding `brand_name`, `generic_name`, `avg_per_unit`, `claims` and
  `outlier` (`true` for flag 1, `false` for 0, `null` where the flag is blank in the file). A row
  carries `part_d = { key, basis }`. There is one entry per Part D "Overall" row that at least one
  NDC joined: 1,458 today. Every NDC that points at an entry is priced by NADAC in the same unit,
  and `avg_per_unit.per` is that unit (1,091 entries per EA, 257 per ML, 110 per GM).
- **Per HCPCS code, in `part_b_codes`:** CMS publishes one payment limit per code, so it is
  written once per code some row joins (138 today), holding `hcpcs`, `hcpcs_dosage`,
  `short_description` (null for CPT codes), `payment_limit`, `coinsurance_pct` and `labelers`.
  A row carries `part_b = { hcpcs, ... }` with its own package figures.
- **Dates of period data.** A Part D or Part B record's `effective_date` is the **start** of its
  period and `period` is always set: Part D data year 2024 records are effective 2024-01-01 with
  period `2024-01-01/2024-12-31`; the October 2026 Part B records (limit file and crosswalk) are
  effective 2026-10-01 with period `2026-10-01/2026-12-31`. NADAC records keep the NADAC row's own
  Effective Date and have no period.
- **Records.** Every number is a record with the fields in the contract's record table and no
  others; optional fields (`as_of_date`, `per`, `period`) are left out rather than written as
  null. `package_size` is kind `quantity`, with `per` set to the package unit only when that unit
  is reconciled to the NADAC unit (below); the 89 unreconciled sizes have no `per`, because the
  crosswalk does not state the unit. Every record in the file is `filed` (38,503 records: each
  shared table record counted once).
- **Size.** 35.1 MB (35,129,162 bytes) for the 2026-10-14 build, down from 60.2 MB when every
  row repeated its Part D and Part B figures.

---

## `nadac` — National Average Drug Acquisition Cost

- **What it is.** CMS's weekly survey-based estimate of what retail community pharmacies pay to
  acquire a drug, per pricing unit (EA, ML or GM), for each NDC. The yearly dataset stacks every
  weekly file of the year; the `As of Date` column tells the weeks apart. OpenBill uses only the
  newest week.
- **Publisher.** Centers for Medicare & Medicaid Services, published on data.medicaid.gov.
- **Landing page.** https://data.medicaid.gov/dataset/fbb83258-11c7-47f5-8b18-5f8e79f7e704
  (dataset "NADAC (National Average Drug Acquisition Cost) 2026").
- **Download URL pattern.** Resolved each run through the DKAN API
  (`https://data.medicaid.gov/api/1/search?fulltext=NADAC...`, newest-year title, its single CSV
  distribution). Today: `https://download.medicaid.gov/data/nadac-national-average-drug-acquisition-cost-YYYYMMDD.csv`.
- **Cadence.** Weekly. The builder warns when the newest week is more than 14 days older than
  the retrieval date.
- **Licence and terms.** The dataset's own metadata (Overview tab, "License" field, read
  2026-10-17) gives `https://www.usa.gov/publicdomain/label/1.0/`, a US public-domain label; that
  URL now redirects to USA.gov's page on copyright and government works
  (https://www.usa.gov/government-copyright), which notes that federal government works are not
  subject to copyright in the US but that not everything on a federal website is a government
  work, that federal material must not be used to imply endorsement, and that agency logos need
  permission. Public access level: public.
- **Fields used.** `NDC`, `NDC Description`, `NADAC Per Unit`, `Effective Date`, `Pricing Unit`,
  `OTC`, `Explanation Code`, `Classification for Rate Setting`, `Corresponding Generic Drug NADAC
  Per Unit`, `Corresponding Generic Drug Effective Date`, `As of Date`. `fetch_nadac.py` stops if
  the header changes.
- **How it is joined.** It is the spine: one `data/drugs.json` row per NDC in the newest week.
- **Explanation codes.** The wording in every NADAC reason follows the dataset's own data
  dictionary (https://data.medicaid.gov/api/1/metastore/schemas/data-dictionary/items/de58d5ec-4515-494e-ae3f-620200f72989,
  field `explanation_code`, read 2026-10-17): 1 most recently completed survey; 2 survey within
  2% of the current NADAC, carried forward; 3 adjusted for published pricing or after a help-desk
  inquiry; 4 carried forward from the previous file; 5 calculated based on package size; 6 the
  CMS S/I/N drug category was not applied when grouping.
- **Known caveats.** Explanation codes 2 and 4 mean the price was carried forward from the
  previous file (955 rows today; `carried_forward: true`). NADAC is an acquisition cost, not what a
  patient pays.

## `fda_ndc` — FDA NDC Directory

- **What it is.** FDA's list of finished drug products labelers have listed, keyed by NDC:
  proprietary and nonproprietary name, dosage form, route, strength, labeler and the package
  description. OpenBill uses it as `row.identity`.
- **Publisher.** U.S. Food and Drug Administration, Center for Drug Evaluation and Research.
- **Landing page.** https://www.fda.gov/drugs/drug-approvals-and-databases/national-drug-code-directory
  (field definitions: https://www.fda.gov/drugs/drug-approvals-and-databases/ndc-product-file-definitions
  and https://www.fda.gov/drugs/drug-approvals-and-databases/ndc-package-file-definitions).
- **Download URL.** https://www.accessdata.fda.gov/cder/ndctext.zip (fixed; the fetcher checks
  the landing page still links it).
- **Cadence.** Daily (the zip's Last-Modified changes every day, so it is downloaded again each
  day; 10.9 MB).
- **Licence and terms.** FDA website policies (https://www.fda.gov/about-fda/about-website/website-policies,
  section "Linking to or Copying Information on the FDA Website", read 2026-10-17): unless
  otherwise noted, FDA website content is not copyrighted, is in the public domain and may be
  republished without permission; credit is appreciated but not required, and FDA recommends that
  copies state the date copied and link back to the source. The directory pages add that listing
  in the directory does not mean FDA approval, that FDA has not verified labeler-submitted data,
  and that it does not mean Medicare or Medicaid coverage.
- **File format.** Tab-delimited, CRLF line ends, Windows-1252 (`product.txt` is not valid
  UTF-8; cp1252 decodes every byte). Members are read in memory, never extracted.
- **Fields used.** `PRODUCTID`, `NDCPACKAGECODE`, `PACKAGEDESCRIPTION`, `PROPRIETARYNAME` +
  `PROPRIETARYNAMESUFFIX` (FDA says the suffix completes the name), `NONPROPRIETARYNAME`,
  `DOSAGEFORMNAME`, `ROUTENAME`, `ACTIVE_NUMERATOR_STRENGTH` + `ACTIVE_INGRED_UNIT`, `LABELERNAME`,
  `PRODUCTTYPENAME`.
- **How it is joined.** Exact NDC-11. FDA writes package NDCs hyphenated 4-4-2, 5-3-2 or 5-4-1;
  the short segment is left-padded with a zero to get 5-4-2, then hyphens are dropped. 4 package
  codes appear twice in `package.txt`; an NDC whose rows give different identities would be left
  null (none today). 27,083 of 30,031 NADAC rows (90.2%) match.
- **Known caveats.** Labeler-reported data, not verified by FDA. Discontinued products leave the
  directory, so some NDCs pharmacies still stock have no identity (`identity: null`).
- **Considered and not used: `ndc_excluded.zip`** (https://www.accessdata.fda.gov/cder/ndc_excluded.zip,
  same landing page, same publisher). It holds listings FDA removed from the directory (flags D
  discontinued by the firm, I inactivated by FDA, E deficient submission, U certification expired).
  Measured 2026-10-17: it would raise the exact NDC match from 27,086 to 27,969 rows (90.2% to
  93.1%; 27,086 NADAC NDCs are in `package.txt`, and 27,083 of them have a product record and
  so an identity), 734 of the additions flag D and 151 flag I. But its product records carry
  only the proprietary name, labeler and marketing category; nonproprietary name, dosage form,
  route and strength are blank, and 62 of the added packages have no product record at all. Not
  material enough for identities that partial.
- **Considered and not used: openFDA NDC bulk file** (`https://download.open.fda.gov/drug/ndc/drug-ndc-0001-of-0001.json.zip`,
  listed in https://api.fda.gov/download.json). It does not give RxCUI cleanly per product: the
  `openfda.rxcui` list is attached per SPL document, so products of different strengths in one
  SPL share the same list (e.g. terazosin 2 mg and 5 mg both list two RxCUIs), and 57,816 of
  138,319 products have none. openFDA terms: https://open.fda.gov/terms/, licence
  https://open.fda.gov/license/.

## `partd` — Medicare Part D Spending by Drug

- **What it is.** Annual spending on drugs dispensed to Medicare Part D enrollees, one row per
  brand name + generic name and one per manufacturer under it (`Mftr_Name == "Overall"` rows
  aggregate manufacturers), with five data years side by side. OpenBill reads the newest year's
  `Avg_Spnd_Per_Dsg_Unt_Wghtd_YYYY` (average spending per dosage unit, claim-weighted),
  `Tot_Clms_YYYY` and `Outlier_Flag_YYYY` from the Overall rows.
- **Publisher.** CMS, Office of Enterprise Data and Analytics (OEDA).
- **Landing page.** https://data.cms.gov/summary-statistics-on-use-and-payments/medicare-medicaid-spending-by-drug/medicare-part-d-spending-by-drug
- **Download URL pattern.** Resolved each run from the data.cms.gov DCAT catalog
  (https://data.cms.gov/data.json): the dataset whose title starts "Medicare Part D Spending by
  Drug" (never the Quarterly dataset, which has no per-dosage-unit figure), its newest temporal
  period, that period's single CSV distribution. Today:
  `https://data.cms.gov/sites/default/files/2026-06/98218f98-166c-4723-8438-c344a4ef96a6/DSD_PTD_RY26_P04_V10_DY24_BGM.csv`.
- **Official documents (read for the wording of every Part D reason).**
  - Methodology: https://data.cms.gov/sites/default/files/2026-06/d7e0a571-9d08-40ec-8278-1b2300f59424/DSD_PTD_RY26_20260603_Methodology_WDDSE_508.pdf
  - Data dictionary: https://data.cms.gov/sites/default/files/2026-06/Medicare%20Part%20D%20Spending%20by%20Drug%20Data%20Dictionary%2020260603_508.pdf
  - What they say, in summary:
    - Spending is the **gross drug cost**: ingredient cost, dispensing fees, sales tax and
      applicable vaccine administration fees, including what the Part D plan and the beneficiary
      paid. It does **not** reflect manufacturer rebates or other price concessions (CMS is
      prohibited from disclosing them).
    - Claims from prescription drug event data were linked by NDC to a commercial drug database
      and **aggregated across all strengths, dosage forms and routes** to the brand name and
      generic name. The average spending per dosage unit is weighted by claims across strength,
      form, route and manufacturer levels.
    - A **dosage unit** is the drug in the form it is marketed, e.g. the number of tablets, grams,
      milliliters or other units; the dictionary calls it the lowest dispensable amount. CMS does
      not state the unit per drug.
    - OTC drugs and drugs with fewer than 11 claims in the most recent year are excluded.
    - `*` after a brand name means the average reflects multiple routes of administration, which
      individually may have different unit prices.
    - `Outlier_Flag = 1` means the drug's average spending per dosage unit is substantially
      affected by outlier records (IQR-based test, difference over 10% and $1); users should be
      cautious.
    - Part D covers the roughly 81% of Medicare beneficiaries enrolled in Part D.
- **Cadence.** Annual (the 2024 data year was published June 2026).
- **Licence and terms.** The catalog's distribution `license` field is
  `https://www.usa.gov/government-works` (redirects to https://www.usa.gov/government-copyright ;
  US government works are not copyrighted in the US; no implied endorsement; no agency logos
  without permission). The landing page lists the privacy level as a free public use file, and
  the methodology says direct identifiers have been removed under the Privacy Act and HIPAA.
- **How it is joined (by name, precision over recall).** Implemented in `PartD.match` and
  `star_route_split` in `tools/build_drugs.py`:
  0. FDA data used for matching. A row with an exact package match in the FDA NDC Directory is
     matched with that product record (its `identity`). A row without one (2,948 rows, often an
     inner package such as one pouch of a carton) is matched with the FDA product record of its
     9-digit product code (labeler + product, the first 9 digits of the NDC-11) when exactly one
     distinct product record has that code and either NADAC lists another NDC of the same code
     under the same description that FDA does list, or FDA's proprietary name is a trade name
     that begins the description word by word, or the record's name and one of its strengths
     (mg, g, mcg; a percentage read as mg per mL) are printed in the description. So every
     package of one product faces the same FDA checks (route, release form, salt, OTC
     monograph): before this, 47 products had a Part D figure only on NDCs FDA does not list,
     while their listed NDCs were refused (the zolpidem 1.75 mg sublingual pouch NDC took
     `Zolpidem Tartrate*` at 0.036x). The product record is used for matching only; `identity`
     stays the exact package match or null. Today 2,035 rows are matched this way and 1,239 of
     them join (`counts.part_d_fda_by_product_code`).
  1. Names are normalised: case, punctuation, salt abbreviations (HCl = hydrochloride, Na/Sod =
     sodium, Bes = besylate ...), combination separators (`/`, `-`, `and`).
  2. Release and formulation markers (ER, XR, XL, SR, DR, CR, LA, EC, CD, 24HR, 12HR, ODT ...)
     are taken from anywhere in the name and must be **identical** on both sides. If FDA's
     dosage form says extended or delayed release and the NADAC description does not (or the
     reverse), or FDA's proprietary name carries a marker the NADAC description lacks, there is
     no match. Two narrow exceptions. A modified-release generic NDC may take an unmarked Part D
     generic row only if no Part D row of that generic carries a release marker, FDA's dosage
     form confirms the release family, and FDA lists no immediate-release prescription product
     of that generic by the same route. A trade name may be taken despite an extended- or
     delayed-release dosage form only if the NADAC description and FDA's proprietary name are the
     same name with no marker, CMS lists exactly one row under it (a trade name, no marker), and
     every prescription product FDA lists under that proprietary name has the same release
     family: the Vivelle-Dot, Minivelle, Dotti, Lyllana, Exelon, Secuado, Xelstrym, Butrans and
     CombiPatch patches, Invega Trinza and Hafyera, Abilify Asimtufii, Phenytek, Equetro and
     Clarinex-D 12 Hour. The 54 rows this lets join have Part D / NADAC spreads from 0.59x to
     2.39x.
  3. Exact product name first: the NADAC description's name (before the strength) and FDA's
     proprietary name against Part D `Brnd_Name`. Brand rows (rate class B, B-ANDA, B-BIO) and
     OTC rows only ever match this way. The Part D generic name must agree with FDA's
     nonproprietary name (same substances; same salt where both state one; a hydrate that is the
     only qualifier counts as the salt, so timolol hemihydrate is not timolol maleate).
     - **OTC rows** (Part D excludes OTC drugs): never when FDA lists the product under an OTC
       monograph (`otc_monograph`), never against a Part D row named by the generic name, which
       is the prescription product (ibuprofen 400-800 mg, not the 200 mg OTC tablet;
       `otc_generic_name`), and only on the NADAC name itself. What remains is insulin and
       naloxone brands that Part D covers (Humulin, Novolin, Narcan).
     - **Presentations.** Part D lists some presentations under their own names (Novolog vs
       Novolog Flexpen, Tresiba vs Tresiba Flextouch U-200, Taltz Syringe vs Taltz
       Autoinjector). NADAC often writes the presentation after the strength (`NOVOLOG 100
       UNIT/ML FLEXPEN`), so among the matched name and the Part D names that extend it, the one
       with the most words all present in the NADAC description wins (`100 UNIT/ML` counts as
       `U-100`); if a longer name shares a presentation word but none fits whole, no match
       (`ambiguous_presentation`). CMS also lists presentations of one generic name as separate
       rows named by the generic name (`Metformin HCl ER`, `Metformin ER Gastric` and `Metformin
       ER Osmotic`, all with generic name `Metformin HCl`). A row matched to the plain one (no
       words beyond the generic name) moves to the family row whose extra words all appear in
       the description, where a description word may be a 3+ letter prefix of the Part D word or
       an abbreviation keeping its first three letters (`GASTR-TB`, `GASTRC-TB` for Gastric,
       `OSM-TAB` for Osmotic); if the description shares such a word with a family row without
       fitting one, no match. Before this, all 26 gastric-retentive and osmotic metformin ER NDCs
       took `Metformin HCl ER` ($0.0599876952 per tablet); `Metformin ER Gastric` is $12.37069734
       (outlier flag 1) and `Metformin ER Osmotic` $2.2030481282.
     - **Salt families.** Part D can carry one substance under generic names that differ only
       by salt (Buprenorphine = the patches, Buprenorphine HCl* = the sublingual tablets;
       Methylphenidate = the patch, Methylphenidate HCl = the tablets; Naproxen and Naproxen
       Sodium). The NADAC description or FDA's nonproprietary name must state the salt and it
       must fit exactly one of them, unless every other salt form is one FDA lists only for
       other routes (Phenobarbital Sodium is injected, so a phenobarbital tablet takes
       Phenobarbital). Otherwise no match (`ambiguous_salt`).
  4. Generic rows (G) with no exact name: FDA's nonproprietary name (or the NADAC name) against
     Part D rows whose brand name is the generic name itself. A combination NADAC name must
     name as many ingredients as the Part D generic name (FDA lists one omeprazole + sodium
     bicarbonate packet as just "omeprazole"), the row must not contradict a salt FDA states,
     and the salt-family rule above applies. NADAC's `DIS TAB` is read as ODT. When several rows
     of one generic-name family match, the presentation rule above settles it only if the
     description names one of their presentations; otherwise no match (`ambiguous_generic`).
  5. More than one possible Part D row: no match. A Part D name whose joined NDCs NADAC prices in
     more than one unit gives its figure only to NDCs in a unit covering at least 90% of them
     (and says so in the reason); the rest get none (`mixed_units`), because CMS's average then
     mixes tablets with milliliters. The unit mix is counted over every NDC the name join matched.
  6. **Names CMS marks with `*`** (the average reflects several routes of administration, which
     may have different unit prices). The contract (ARCHITECTURE.md): a row joins such a name only
     when it has an FDA identity whose route is shared by every row joined to that name. So rows
     with no FDA identity, or an identity with no route, get none (`multi_route_no_identity`).
     Every route FDA names for the remaining rows is counted over the rows whose `ROUTENAME`
     includes it (`INTRAMUSCULAR; INTRAVENOUS` includes INTRAMUSCULAR); the route covering the
     most rows keeps them, so every kept row shares it, and the others get none
     (`multi_route_minority`). If two routes cover equally many rows but not the same rows, no
     route is shared by most of them and no row joins (`multi_route_tie`: the injections and
     tablets under `Medroxyprogesterone Acetate*`, and `Ivermectin*`, `Betaxolol HCl*`,
     `Ondansetron HCl*`). Routes are FDA's own words compared exactly: PARENTERAL is not merged
     with the injection routes, nor INTRAOCULAR with OPHTHALMIC, so a few NDCs of the majority
     product are left out (3 naloxone syringes FDA lists as PARENTERAL; 8 budesonide inhalation
     suspension NDCs that Cipla and Exelan list with route ORAL), and the azelastine eye drops (3
     listed as INTRAOCULAR, 2 as OPHTHALMIC) are a minority to the 5 nasal sprays. Only the exact
     package match counts as an identity here, so the product-code record of rule 0 gives no
     route: 222 NDCs with no identity, in names whose identified NDCs all share one route
     (propranolol, chlorpromazine, levothyroxine tablets ...), get none. Today 446 rows are
     `multi_route_minority`, 371 `multi_route_no_identity` and 40 `multi_route_tie`, among them
     the olanzapine and pantoprazole vials, the diazepam rectal gel, the zolmitriptan and
     ipratropium nasal sprays, the ofloxacin ear drops and oral cyclosporine. The kept rows'
     `avg_per_unit` reason names the route and how many NDCs kept it. CMS's average for the name
     is still the average over every route, and a small claim share at a high unit cost can move
     it a long way: diazepam tablets take `Diazepam*` ($0.9408481898 per tablet), which includes
     the rectal gel's claims.
  - `part_d.basis` is `generic` when CMS's brand name is the generic name itself
    (Atorvastatin Calcium), `brand` when it is a trade name (Eliquis). It is a property of the
    Part D row, so every NDC pointing at one name has the same basis (782 names `brand`, 676
    `generic`).
  - Result: 19,131 rows pointing at 1,458 names in `part_d_names`; by rate class B 1,597/2,240,
    B-ANDA 54/89, B-BIO 15/33, G 17,465/27,669; OTC 10/2,611. Outlier flag 1 on 61 names, which
    741 matched rows point at (kept, `outlier: true`); the flag is blank for 1 name
    (`Wescaps|B Complex W-C No.20/Folic Acid`, 1 row; `outlier: null`, and its reason says the
    flag is blank); 2,008 matched rows point at one of the 76 names that carry a `*`, all with an
    FDA identity sharing one route (rule 6; before rule 6, 2,350 rows pointed at 80 such names).
    45 names are joined by NDCs in more than one NADAC unit; their `avg_per_unit` reason states
    the mix, and only the NDCs in the majority unit point at them (rule 5).
  - Dates: `avg_per_unit` and `claims` are effective 2024-01-01, the start of data year 2024,
    with `period` `2024-01-01/2024-12-31`.
  - Audit 2026-10-17 (data review): the rules above replaced matches that were wrong, among them
    buprenorphine sublingual tablets given the patch figure ($61.65 per unit, 222x NADAC),
    methylphenidate tablets given the patch figure, OTC bacitracin ointment given
    `Bacitracin*` (438x), OTC ibuprofen / naproxen / adapalene / phenazopyridine given the
    prescription product, insulin pens given the vial row (Tresiba FlexTouch U-200 got the U-100
    vial's $32.17 per mL instead of $63.98), an omeprazole + bicarbonate packet given plain
    omeprazole, and timolol hemihydrate given timolol maleate. 24 matched rows were then
    hand-checked against the raw Part D CSV and FDA product rows; all correct.
- **Known caveats.** The figure averages all strengths and forms under the name, for 2024, gross
  of rebates; it can sit far from the NADAC of one NDC. Over matched rows the Part D / NADAC
  ratio has median 2.8x, 1st percentile 0.24x, 99th percentile 43.7x and maximum 181x
  (teriflunomide, whose generic price fell after 2024; tadalafil, dapagliflozin and everolimus
  behave the same way). CMS flags teriflunomide's figure as an outlier, so the page never uses it
  as a reference: over the 18,390 rows whose Part D figure is used, the 99th percentile is 19.8x
  and the largest spread a card shows is 119x (ALYQ 20 MG TABLET, tadalafil). The dosage unit is assumed to be NADAC's unit. The page marks every
  Part D spread `estimated`.

## `asp_limits` — Medicare Part B payment limit file

- **What it is.** The quarterly payment allowance limit for each Part B drug HCPCS code, per
  HCPCS code dosage (e.g. `10 MG`, `50 UNITS`), with the beneficiary coinsurance percentage.
  The Section 508 CSV member is parsed (`section 508 version of October 2026 Medicare Part B
  Payment Limit File 091626.csv`); its header states "Effective October 1, 2026 through December
  31, 2026" and that limits under the ASP methodology use 2Q26 ASP data. Not every limit is
  ASP-based: the file's `Notes` column qualifies some codes ("AMP-based payment limit",
  '"lesser of" methodology applied', "8% of reference add-on applied", "Inflation-adjusted
  coinsurance"), and OpenBill repeats that note verbatim in the record's reason.
- **Publisher.** CMS.
- **Landing page.** https://www.cms.gov/medicare/payment/part-b-drugs/asp-pricing-files
- **Download URL pattern.** Scraped from the landing page: the newest quarter by month and year
  in the link text, matching both namings ("<Month> <Year> Medicare Part B Payment Limit Files"
  from 2026, "<Month> <Year> ASP Pricing File" before). Today
  `https://www.cms.gov/files/zip/october-2026-medicare-part-b-payment-limit-files-final.zip`.
- **Cadence.** Quarterly, sometimes revised within the quarter (the page shows revision dates).
- **Licence and terms.** No dataset licence is published for these files; they are works of a
  US federal agency (https://www.usa.gov/government-copyright). **CPT codes and descriptors are
  copyright of the American Medical Association**: CMS's own CPT end-user agreement, still served
  for the pre-2021 files at https://www.cms.gov/license/ama (read 2026-10-17), limits CPT use to
  CMS programmes and forbids derivative works. The 2026 files are linked without that agreement,
  but some codes in them are CPT (e.g. vaccine codes 90xxx). OpenBill keeps the HCPCS code but
  writes `short_description: null` for any five-digit CPT code; none of today's joined rows has
  one. The landing page and the file both state that presence in the file does not mean Medicare
  covers a drug.
- **Fields used.** `HCPCS Code`, `Short Description`, `HCPCS Code Dosage`, `Payment Limit`,
  `Co-insurance Percentage` (printed per code; mostly 20.000, some lower for inflation-adjusted
  coinsurance, 0.000 for some vaccines), `Notes`. `N/A` limits are never read as numbers.
- **How it is stored.** One `part_b_codes` entry per HCPCS code that a row joins (138 today):
  `payment_limit` (per `hcpcs_dosage`) and `coinsurance_pct`, effective 2026-10-01, the start of
  the quarter, with `period` `2026-10-01/2026-12-31`. 19 of the 138 limits carry a `Notes`
  quote in their reason; of the 138 coinsurance percentages, 134 are 20 and four are lower
  (17.885, 18.505, 19.283, 0.997).
- **Coverage setting in every reason.** Part B pays under a code only in the settings CMS
  describes for it, so the `payment_limit` reason says so and repeats the code's own short
  description from this file, e.g. J1817: "Part B pays under J1817 only in the settings CMS
  describes for this code; the file's short description of it is 'Insulin for insulin pump
  use'." For a CPT code the reason says the descriptor is AMA copyright instead of quoting it
  (no CPT code is joined today).
- **Encoding.** Windows-1252 (0xA0 no-break spaces; not valid UTF-8). Members read in memory.

## `asp_crosswalk` — ASP NDC-HCPCS crosswalk

- **What it is.** Which NDCs bill under which HCPCS code, with package figures. Member parsed:
  `section 508 version of October 2026 ASP NDC-HCPCS Crosswalk 091126.csv` (the AWP, OPPS, PrEP
  and vaccine crosswalks in the same zip are not used).
- **Column meanings** (from `section 508 version of NDC-HCPCS Crosswalk Introduction Text
  090326.csv` in the same zip): `PKG SIZE` is the amount in one item (e.g. 0.5 for 0.5 mL in a
  vial; the unit is not stated); `PKG QTY` the number of items in the NDC; `BILLUNITS` the
  billable units per item (package); `BILLUNITSPKG` the billable units per 11-digit NDC, which
  should equal `BILLUNITS` x `PKG QTY`. In the October 2026 file it does not on 208 of 7,403
  lines (e.g. glycopyrrolate 72572-0225-25: 2 per vial x 25 vials, but 25 per NDC; Prograf
  0469-0607-73: 100 per item x 1, but 50 per NDC), and either column can be the wrong one. The
  intro text also says the crosswalks support ASP-based Part B payment only and are not a
  complete list of NDCs.
- **Publisher, landing page, cadence, licence.** As `asp_limits`. Today
  `https://www.cms.gov/files/zip/october-2026-ndc-hcpcs-crosswalk-final.zip` ("October 2026
  NDC-HCPCS Crosswalk"; before 2026 "ASP NDC-HCPCS Crosswalk").
- **How it is joined.** Exact NDC-11 (the crosswalk writes 5-4-2 with hyphens; alternate IDs
  are skipped). An NDC on more than one HCPCS line is left null (17 rows). Then HCPCS to
  `asp_limits`. `bill_units_per_package` holds `BILLUNITSPKG` (per whole NDC), so
  `payment_limit x bill_units_per_package / (package_size x package_qty)` is Medicare dollars per
  NADAC unit. `package_unit` is set to the NADAC unit only when FDA's package description for the
  same NDC gives a total (mL, g, or count of tablets / capsules / vials ...) equal to
  `PKG SIZE x PKG QTY` **and** the two billable-unit columns agree (a whole-number rounding of
  `BILLUNITS x PKG QTY`, e.g. 12.5 printed as 13, is accepted and stated in the reason);
  otherwise null (89 of 1,427 rows, 1 of them because the billable-unit columns disagree).
  `counts.part_b_unit_reconciled_by` says which check reconciled each row (today 1,289 FDA
  amount, 32 kit, 17 strength check). Two refinements:
  - **Kits.** NADAC prices a kit as one EA (CIMZIA 2X200 MG/ML SYRINGE KIT is $6,094.025 per
    EA, and Part D's `Cimzia (2 Pack)` averages 1.22 units per claim). For an NDC NADAC prices
    per EA whose FDA package description has a KIT level, the EA count is the number of kits
    (`1 KIT in 1 CARTON * 1 mL in 1 SYRINGE * ...` is 1); for one NADAC itself calls a kit
    (`KIT`, `KT`) and FDA lists without a KIT level, the whole NDC is one EA. The crosswalk's
    `PKG SIZE x PKG QTY` must equal that count. This reconciles 32 single kits (Lupron Depot,
    Risperdal Consta and its generics, Sandostatin LAR, Abilify Maintena, Vivitrol, glucagon
    emergency kits, Novarel, Pregnyl, chorionic gonadotropin), and un-reconciles Cimzia
    50474-0710-79, whose crosswalk counts its 2 syringes (size 1 x qty 2), so it no longer shows
    $628 per "EA" (one syringe) against NADAC's price for the kit.
  - **Strength check.** When the billable-unit columns disagree but FDA's amount equals
    `PKG SIZE x PKG QTY`, `BILLUNITSPKG` is used if FDA's single-ingredient strength (mg, g or
    mcg per 1 or per mL) x that amount / the HCPCS dosage equals it exactly; the reason shows the
    sum ("FDA's strength 250 mg/1 x 100 EA per NDC / 5 MG = 5000 = BILLUNITSPKG, so BILLUNITSPKG
    is used and BILLUNITS is not"). 17 rows: mycophenolate capsules and tablets, prednisone dose
    packs, Prograf 0.5 mg capsules and granule packets, ondansetron 8 mg. Where FDA's count
    contradicts the crosswalk's (everolimus 51991-0379-60, -0380-60 and -0381-60, cyclosporine
    60505-4630/4631/4632, levalbuterol 35573-0443/0444/0445, ondansetron 4 mg 62135-0350-05), the
    row stays null.
  These per-NDC figures are on the row (`row.part_b`); `payment_limit` and `coinsurance_pct` are
  in `part_b_codes`. The crosswalk records are effective 2026-10-01, the start of the quarter,
  with `period` `2026-10-01/2026-12-31`. `package_size` is kind `quantity`; its `per` is the
  package unit when reconciled, and absent otherwise.
- **Labelers per code.** `part_b_codes[code].labelers` is the sorted list of distinct names in
  the crosswalk's own `LABELER NAME` column over **all** of that code's crosswalk lines (7,403
  lines, 877 codes, 322 distinct labeler names; the one alternate-ID line, under J7331, is
  included),
  not only the lines of NDCs that NADAC prices. Names are copied as CMS spells them, with runs of
  whitespace collapsed; the builder stops if a line has no labeler name. 36 of the 138 joined
  codes have a single labeler (75 rows point at them, 65 of those with the package unit
  reconciled); the most is 18 (J1596). A single labeler is what lets the page call a Part B
  spread `derived` (the limit is then that product's own). CMS does not spell every labeler the
  same way on every line (`UCB, Inc.` and `UCB, INC.`; `ACCORD HEALTHCARE INC` and `Accord
  Healthcare Inc`): 5 of the 138 codes list such a variant (J0717, J7512, J9260, Q0162, Q5099),
  and 2 of them (J0717 and Q5099) would have a single labeler if the variants were merged.
  OpenBill does not merge them, so those two codes count as multi-labeler and their spreads stay
  `estimated`, the cautious side.
- **Hand-checked** (raw crosswalk, limit file, FDA package and NADAC rows, 2026-10-17):

  | NDC | product | HCPCS | limit x units / (size x qty) | per NADAC unit | NADAC |
  |---|---|---|---|---|---|
  | 00002821501 | Humulin R 100 unit/mL vial | J1817 (50 UNITS) | 3.116 x 20 / (10 x 1) | $6.232 / mL | $4.2629 / mL |
  | 00002751659 | Humalog cartridge 5 x 3 mL | J1817 (50 UNITS) | 3.116 x 30 / (3 x 5) | $6.232 / mL | $9.78555 / mL |
  | 00409000925 | Ondansetron 4 mg/2 mL vial x 25 | J2405 (1 MG) | 0.084 x 100 / (2 x 25) | $0.168 / mL | $0.17588 / mL |
  | 00548560200 | Enoxaparin 40 mg/0.4 mL syringe x 10 | J1650 (10 MG) | 0.497 x 40 / (0.4 x 10) | $4.97 / mL | $7.7791 / mL |
  | 00378204601 | Tacrolimus 1 mg capsule x 100 | J7507 (1 MG) | 0.162 x 100 / (100 x 1) | $0.162 / EA | $0.1535 / EA |
  | 16729007329 | Capecitabine 500 mg tablet x 120 | J8522 (50 MG) | 0.029 x 1200 / (120 x 1) | $0.29 / EA | $0.45556 / EA |

- **Known caveats.** Part B pays for these products only in Part B settings, not for every
  pharmacy fill of the NDC: J1817 is CMS's code for insulin used in an insulin pump (short
  description "Insulin for insulin pump use"); oral anti-cancer and immunosuppressive drugs are
  Part B only in specific circumstances. Each `payment_limit` reason states this with the code's
  own short description (see `asp_limits` above); ARCHITECTURE.md has the page show that reason
  in the provenance panel with every Part B figure. A multi-labeler code's limit is one figure
  across every labeler's product billed under it, not the joined NDC's own. Billable units are
  whole numbers, so a per-unit figure can be slightly off for odd package sizes (albuterol
  1.25 mg/3 mL: 37.5 mg billed as 38 units).

---

## Brief sources not yet used

Tier 1 and Tier 2 sources from the product brief that no builder reads yet:

| source | publisher | status |
|---|---|---|
| Federal Upper Limits (FUL) | CMS, data.medicaid.gov | not yet used |
| Clinical Laboratory Fee Schedule | CMS, cms.gov | not yet used |
| Physician Fee Schedule | CMS, cms.gov | not yet used |
| Medicare Physician & Other Practitioners | CMS, data.cms.gov | not yet used |
| Medicare Inpatient Hospitals by Provider and Service | CMS, data.cms.gov | not yet used |
| Medicare Outpatient Hospitals by Provider and Service | CMS, data.cms.gov | not yet used |
| Hospital cost reports (HCRIS) | CMS, cms.gov | not yet used |
| RxNorm (brand, generic and dose normalisation) | National Library of Medicine | not yet used |
| openFDA (labels, shortages) | FDA, open.fda.gov | not yet used (the NDC bulk file was evaluated and rejected for RxCUI, above) |
| FDA NDC excluded-products file | FDA | evaluated, not used (above) |

Tier 3 (hospital machine-readable price files) is out of scope for phase 1.
