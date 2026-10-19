# Hand check: ten cards against the government files

A worksheet for checking OpenBill by hand. It covers ten products of different kinds. For each
one it gives what the card shows, where to find each number in the raw government file, the
value you should find there, and a box to tick. It does not replace the spot checks in
`tests/spotchecks.json` ([decision 12](DECISIONS.md#12-spot-checks-are-pinned-to-source-files-every-refresh-re-verifies-at-least-ten)).
It is the slower check a person does once per data refresh, without trusting any of our code.

Every expected value below was read from the cached raw files with a short standard-library
Python script that does not import OpenBill's code and does not read `data/drugs.json`. The
card values come from `summarizeProduct()` in `src/core/rules.js`, the code the page runs.
Every number agrees. Two places where the card's wording is less exact than the files are
listed under [What did not agree](#what-did-not-agree).

Built from: NADAC as of 2026-10-14, FDA NDC Directory as of 2026-10-16, Medicare Part D data
year 2024, Medicare Part B October 2026 quarter. If a file you download has a different sha256
from the one below, the publisher has replaced it. Your numbers can then differ: that is a data
refresh, not a mistake.

## The files

| file | download it from | sha256 (first 12) | how to open it |
|---|---|---|---|
| `nadac-national-average-drug-acquisition-cost-20261014.csv` (107 MB) | <https://download.medicaid.gov/data/nadac-national-average-drug-acquisition-cost-20261014.csv>, listed on the [NADAC 2026 dataset page](https://data.medicaid.gov/dataset/fbb83258-11c7-47f5-8b18-5f8e79f7e704) | `15335686bbc0` | **Not in Excel** (see below) |
| `DSD_PTD_RY26_P04_V10_DY24_BGM.csv` (5.3 MB) | <https://data.cms.gov/sites/default/files/2026-06/98218f98-166c-4723-8438-c344a4ef96a6/DSD_PTD_RY26_P04_V10_DY24_BGM.csv>, listed on [Medicare Part D Spending by Drug](https://data.cms.gov/summary-statistics-on-use-and-payments/medicare-medicaid-spending-by-drug/medicare-part-d-spending-by-drug) | `5dcc9d7bd7d7` | any spreadsheet; 14,536 rows |
| `october-2026-medicare-part-b-payment-limit-files-final.zip` | <https://www.cms.gov/files/zip/october-2026-medicare-part-b-payment-limit-files-final.zip>, listed on [ASP pricing files](https://www.cms.gov/medicare/payment/part-b-drugs/asp-pricing-files) | `a9b7afa80aae` | open the member `section 508 version of October 2026 Medicare Part B Payment Limit File 091626.csv`; the column headings are on row 9 |
| `october-2026-ndc-hcpcs-crosswalk-final.zip` | <https://www.cms.gov/files/zip/october-2026-ndc-hcpcs-crosswalk-final.zip>, same page | `e6bbf7c61e6d` | open the member `section 508 version of October 2026 ASP NDC-HCPCS Crosswalk 091126.csv`; the column headings are on row 9 |
| `ndctext.zip` | <https://www.accessdata.fda.gov/cder/ndctext.zip>, listed on the [FDA NDC Directory page](https://www.fda.gov/drugs/drug-approvals-and-databases/national-drug-code-directory) | `ee609cef6e4e` | `package.txt` and `product.txt`, tab-separated; FDA replaces the file daily, so expect small differences |

To check a file's sha256: `Get-FileHash <file>` in PowerShell, `shasum -a 256 <file>` on macOS,
`sha256sum <file>` on Linux. If you ran `python tools/fetch_all.py`, the same files are in
`tools/cache/` and `tools/cache/manifest.json` lists their sha256.

### The NADAC file does not fit in Excel

The 2026 NADAC CSV stacks all 41 weekly files of the year: 1,238,214 data rows, oldest week
first. Excel stops at 1,048,576 rows, and the week OpenBill uses (As of Date `10/14/2026`) is on
lines 1,208,185 to 1,238,215, so Excel drops all of it without any warning. A spreadsheet
would also strip the leading zeros from NDCs such as `00904736806`. Search the file as text instead.
Every line ends with its As of Date, and a description that has no comma is not quoted, so
these commands print the product's lines for that week:

```powershell
# PowerShell (Windows). Takes a minute or two.
$f = 'nadac-national-average-drug-acquisition-cost-20261014.csv'
$name = 'ARIPIPRAZOLE 10 MG TABLET'
foreach ($l in [IO.File]::ReadLines((Resolve-Path $f))) { if ($l.StartsWith("$name,") -and $l.EndsWith(',10/14/2026')) { $l } }
```

```bash
# macOS or Linux
grep -F 'ARIPIPRAZOLE 10 MG TABLET,' nadac-national-average-drug-acquisition-cost-20261014.csv | grep '^ARIPIPRAZOLE 10 MG TABLET,' | grep ',10/14/2026$'
```

The columns are, in order: NDC Description, NDC, NADAC Per Unit, Effective Date, Pricing Unit,
Pharmacy Type Indicator, OTC, Explanation Code, Classification for Rate Setting, Corresponding
Generic Drug NADAC Per Unit, Corresponding Generic Drug Effective Date, As of Date. Count the
lines too. The count is the card's number of NDCs.

### The other files

- **Part D:** filter `Brnd_Name` and `Gnrc_Name` to the names given below and `Mftr_Name` to
  `Overall` (one row per name for all manufacturers together; the rows below it are each
  manufacturer). Read the `_2024` columns: `Avg_Spnd_Per_Dsg_Unt_Wghtd_2024`, `Tot_Clms_2024`
  and `Outlier_Flag_2024`. The file also has 2020 to 2023 columns. A spreadsheet may round the
  average for display, so widen the column. The row numbers given below count the heading
  as row 1.
- **Part B payment limit:** the row whose `HCPCS Code` is the code given; read `HCPCS Code Dosage`,
  `Payment Limit`, `Co-insurance Percentage` and `Notes`.
- **Part B crosswalk:** filter `NDC` (written with hyphens, 5-4-2, like `51991-0735-20`). Read
  `_2026_CODE`, `LABELER NAME`, `PKG SIZE`, `PKG QTY` and `BILLUNITSPKG`. Filter
  `_2026_CODE` to count the labelers on a code.
- **FDA:** in `package.txt`, find `NDCPACKAGECODE` as FDA writes it (given below; FDA's
  hyphenated form, padded to 11 digits, is the NADAC NDC). Take its `PRODUCTID` to
  `product.txt` and read `PHARM_CLASSES`. The `[EPC]` entries are the classes OpenBill's drug
  pages use ([the contract](ARCHITECTURE.md#drug-pages-built-on-deploy-not-committed)).

### The arithmetic the card does

- **Pack total:** quantity × NADAC per unit, rounded half-up to the cent. The same for the
  Medicare figure: quantity × Medicare's price per unit.
- **The multiple:** Medicare per unit ÷ NADAC per unit, unrounded. At 1.05 or more the card
  says "Medicare paid N× what pharmacies pay", with one decimal (13.872 is "13.9×"). From 0.95
  to under 1.05 it says "about what pharmacies pay". Under 0.95 it says "N% less" (0.917 is
  "8% less"). Part B says "pays", because its quarter is current.
- **Cost-plus estimate:** the pack total at NADAC, plus 15% of it rounded half-up to the cent,
  plus $5.00 ([the contract](ARCHITECTURE.md#the-cost-plus-estimate-estimated-every-product)).
  It is always `estimated`. No file has it, so you check the arithmetic, not a source.
- **Unit prices on the card** show at most five decimals: Part D's `1.5499353611` shows as
  `$1.54994`, and NADAC's `0.07880` as `$0.0788`. The pack totals use the full figure.

## Summary

Default quantity: 30 for an oral tablet or capsule priced per EA (all nine EA products here),
and one package for the insulin pen. Kits, pens, syringes, patches and other products priced per
EA start at 1 ([decision 48](DECISIONS.md#48-starting-quantity-by-dosage-form-preview-images-stay-png)); none is on this list.
The 2026-10-19 refinements ([decision 49](DECISIONS.md#49-starting-quantity-case-packs-tablets-and-films-under-the-tongue-fda-listing-outliers):
sublingual and buccal tablets, outlier FDA listings, wholesale cases) change none of these ten.

| # | product | kind | qty | pharmacies pay | Medicare | multiple | cost-plus estimate | checked |
|---|---|---|---|---|---|---|---|---|
| 1 | ARIPIPRAZOLE 10 MG TABLET | showcase | 30 | $3.35 | Part D $46.50 | 13.9× | $8.85 | ☐ |
| 2 | METFORMIN HCL 500 MG TABLET | common generic | 30 | $0.44 | Part D $1.69 | 3.9× | $5.51 | ☐ |
| 3 | ATORVASTATIN 20 MG TABLET | common generic | 30 | $0.84 | Part D $4.36 | 5.2× | $5.97 | ☐ |
| 4 | LISINOPRIL 10 MG TABLET | common generic | 30 | $0.54 | Part D $2.67 | 4.9× | $5.62 | ☐ |
| 5 | ELIQUIS 5 MG TABLET | brand | 30 | $165.63 | Part D $289.11 | 1.7× | $195.47 | ☐ |
| 6 | GRANISETRON HCL 1 MG TABLET | Part B reference | 30 | $39.15 | Part B $23.22 | 41% less | $50.02 | ☐ |
| 7 | LANTUS SOLOSTAR 100 UNIT/ML | insulin, per ML | 15 ML | $92.48 | Part D $91.68 | about the same | $111.35 | ☐ |
| 8 | AMOXICILLIN 500 MG CAPSULE | no Medicare reference | 30 | $2.36 | none | none | $7.71 | ☐ |
| 9 | BENICAR 20 MG TABLET | carried-forward NADAC | 30 | $369.49 | Part D $338.92 | 8% less | $429.91 | ☐ |
| 10 | ALLERGY (LORATADINE) 10 MG TAB | over the counter | 30 | $1.59 | none | none | $6.83 | ☐ |

Checked by: ________________ Date: ____________

## 1. ARIPIPRAZOLE 10 MG TABLET (the showcase)

**The card:** 31 NDCs, quantity 30. Pharmacies pay **$3.35**, `filed` (30 × $0.11173 per EA;
CMS NADAC, eff. 2026-09-23, file as of 2026-10-14). Medicare Part D average spending
**$46.50**, `filed` (30 × $1.54994 per EA; Part D 2024-01-01 to 2024-12-31). "Medicare paid
13.9× what pharmacies pay.", `estimated`. Cost-plus estimate **$8.85**, `estimated`
($3.35 + $0.50 + $5.00). Class: Atypical Antipsychotic.

| what | where | expect | ☐ | notes |
|---|---|---|---|---|
| NDC count | NADAC, `ARIPIPRAZOLE 10 MG TABLET`, As of Date 10/14/2026 | 31 lines | ☐ | |
| NADAC per unit | same lines, NADAC Per Unit | `0.11173` on every line, Pricing Unit `EA` | ☐ | |
| dates and codes | same lines | Effective Date `09/23/2026`, Explanation Code `1`, OTC `N`, Classification `G` | ☐ | |
| Part D average | Part D, Brnd_Name `Aripiprazole`, Gnrc_Name `Aripiprazole`, Mftr_Name `Overall` (row 872) | Avg_Spnd_Per_Dsg_Unt_Wghtd_2024 `1.5499353611`; Tot_Clms_2024 `3844727`; Outlier_Flag_2024 `0`; Tot_Mftr `24` | ☐ | |
| ODT and injectables are separate | Part D, Gnrc_Name `Aripiprazole` | their own rows: `Aripiprazole ODT` (15.551425783), `Abilify`, `Abilify Maintena`, `Abilify Asimtufii`, `Abilify Mycite`; `Aristada` is `Aripiprazole Lauroxil` | ☐ | |
| class | FDA `package.txt` `0904-7368-06` → `product.txt` PHARM_CLASSES | `Atypical Antipsychotic [EPC]` | ☐ | |
| arithmetic | | 30 × 0.11173 = 3.3519 → $3.35; 30 × 1.5499353611 = 46.498… → $46.50; 1.5499353611 ÷ 0.11173 = 13.872 → 13.9×; 15% of $3.35 = $0.5025 → $0.50; $3.35 + $0.50 + $5.00 = $8.85 | ☐ | |

Two of the 31 NDCs, `50268-0089-11` and `60687-0179-11`, are not in FDA's `package.txt`. They
have no FDA identity, so no class of their own; the product's class comes from its other NDCs.

## 2. METFORMIN HCL 500 MG TABLET

**The card:** 57 NDCs, quantity 30. Pharmacies pay **$0.44** (30 × $0.01451 per EA, eff.
2026-09-23). Part D **$1.69** (30 × $0.05643 per EA). "Medicare paid 3.9× what pharmacies
pay.", `estimated`. Cost-plus estimate **$5.51**. Class: Biguanide.

| what | where | expect | ☐ | notes |
|---|---|---|---|---|
| NDC count | NADAC, `METFORMIN HCL 500 MG TABLET`, 10/14/2026 | 57 lines | ☐ | |
| NADAC per unit | same lines | `0.01451`, `EA`, Effective Date `09/23/2026`, code `1` | ☐ | |
| Part D average | Part D, `Metformin HCl` / `Metformin HCl` / `Overall` (row 8264) | `0.056431518`; claims `23961097`; outlier `0` | ☐ | |
| class | FDA `0378-7185-05` | PHARM_CLASSES `Biguanide [EPC], Biguanides [CS]` | ☐ | |
| arithmetic | | 30 × 0.01451 = 0.4353 → $0.44; 30 × 0.056431518 = 1.6929… → $1.69; 0.056431518 ÷ 0.01451 = 3.889 → 3.9×; $0.44 + $0.07 + $5.00 = $5.51 | ☐ | |

## 3. ATORVASTATIN 20 MG TABLET

**The card:** 69 NDCs, quantity 30. Pharmacies pay **$0.84** (30 × $0.02792 per EA). Part D
**$4.36** (30 × $0.14518 per EA). "Medicare paid 5.2× what pharmacies pay.", `estimated`.
Cost-plus estimate **$5.97**. Class: HMG-CoA Reductase Inhibitor.

| what | where | expect | ☐ | notes |
|---|---|---|---|---|
| NDC count | NADAC, `ATORVASTATIN 20 MG TABLET`, 10/14/2026 | 69 lines | ☐ | |
| NADAC per unit | same lines | `0.02792`, `EA` on every line; Effective Date `09/23/2026`, `09/30/2026` or `10/07/2026` (same price) | ☐ | |
| Part D average | Part D, `Atorvastatin Calcium` / `Atorvastatin Calcium` / `Overall` (row 1011) | `0.1451833479`; claims `73349032`; outlier `0` | ☐ | |
| class | FDA `0093-5059-10` | `HMG-CoA Reductase Inhibitor [EPC], Hydroxymethylglutaryl-CoA Reductase Inhibitors [MoA]` | ☐ | |
| arithmetic | | 30 × 0.02792 = 0.8376 → $0.84; 30 × 0.1451833479 = 4.3555… → $4.36; ratio 5.19998 → 5.2×; $0.84 + $0.13 + $5.00 = $5.97 | ☐ | |

## 4. LISINOPRIL 10 MG TABLET

**The card:** 34 NDCs, quantity 30. Pharmacies pay **$0.54** (30 × $0.01815 per EA). Part D
**$2.67** (30 × $0.08892 per EA). "Medicare paid 4.9× what pharmacies pay.", `estimated`.
Cost-plus estimate **$5.62**. Class: Angiotensin Converting Enzyme Inhibitor.

| what | where | expect | ☐ | notes |
|---|---|---|---|---|
| NDC count | NADAC, `LISINOPRIL 10 MG TABLET`, 10/14/2026 | 34 lines | ☐ | |
| NADAC per unit | same lines | `0.01815`, `EA`, `09/23/2026`, code `1` | ☐ | |
| Part D average | Part D, `Lisinopril` / `Lisinopril` / `Overall` (row 7684) | `0.0889240964`; claims `36247459`; outlier `0` | ☐ | |
| class | FDA `0591-0407-01` | `Angiotensin Converting Enzyme Inhibitor [EPC], Angiotensin-converting Enzyme Inhibitors [MoA]` | ☐ | |
| arithmetic | | 30 × 0.01815 = 0.5445 → $0.54 (the third decimal is 4, so it rounds down); 30 × 0.0889240964 = 2.6677… → $2.67; ratio 4.899 → 4.9×; $0.54 + $0.08 + $5.00 = $5.62 | ☐ | |

## 5. ELIQUIS 5 MG TABLET

**The card:** 3 NDCs, quantity 30. Pharmacies pay **$165.63** (30 × $5.52114 per EA). Part D
**$289.11** (30 × $9.63704 per EA). "Medicare paid 1.7× what pharmacies pay.", `estimated`.
Cost-plus estimate **$195.47**. Class: Factor Xa Inhibitor.

| what | where | expect | ☐ | notes |
|---|---|---|---|---|
| NDCs | NADAC, `ELIQUIS 5 MG TABLET`, 10/14/2026 | 3 lines: `00003089421`, `00003089431`, `00003089470` | ☐ | |
| NADAC per unit | same lines | `5.52114`, `EA`, `09/23/2026`, code `1`, Classification `B` | ☐ | |
| Part D average | Part D, `Eliquis` / `Apixaban` / `Overall` (row 4421) | `9.6370356894`; claims `24061332`; Tot_Mftr `1`; outlier `0` | ☐ | |
| identity | FDA `0003-0894-21` | `ELIQUIS`, `apixaban`, "60 TABLET, FILM COATED in 1 BOTTLE, PLASTIC (0003-0894-21)"; PHARM_CLASSES `Factor Xa Inhibitor [EPC], Factor Xa Inhibitors [MoA]` | ☐ | |
| arithmetic | | 30 × 5.52114 = 165.6342 → $165.63; 30 × 9.6370356894 = 289.111… → $289.11; ratio 1.745 → 1.7×; 15% of $165.63 = $24.8445 → $24.84; $165.63 + $24.84 + $5.00 = $195.47 | ☐ | |

## 6. GRANISETRON HCL 1 MG TABLET (a Part B reference)

**The card:** 7 NDCs, quantity 30. Pharmacies pay **$39.15** (30 × $1.30504 per EA). Medicare
Part B payment limit **$23.22** (30 × $0.774 per EA), `derived`, October 2026 quarter, for 2 of
the 7 NDCs. The other 5 say they have no Medicare figure. "Medicare pays 41% less than pharmacies
pay.", `derived`, because one labeler bills under the code. Cost-plus estimate **$50.02**.
Class: Serotonin-3 Receptor Antagonist.

| what | where | expect | ☐ | notes |
|---|---|---|---|---|
| NDC count | NADAC, `GRANISETRON HCL 1 MG TABLET`, 10/14/2026 | 7 lines, all `1.30504`, `EA`, `09/23/2026` | ☐ | |
| payment limit | Part B payment limit file, HCPCS Code `Q0166` | Short Description "Granisetron hcl 1 mg oral"; dosage `1 MG`; Payment Limit `0.774`; Co-insurance `20.000`; Notes "Added October 2026" | ☐ | |
| crosswalk lines | crosswalk, `_2026_CODE` = `Q0166` | exactly 2 lines, both "Breckenridge Pharmaceutical, Inc.": `51991-0735-20` (PKG SIZE 20, PKG QTY 1, BILLUNITSPKG 20) and `51991-0735-32` (2, 1, 2) | ☐ | |
| per NADAC unit | | 0.774 × 20 ÷ (20 × 1) = $0.774 per EA (and the same for -32) | ☐ | |
| class | FDA `51991-735-20` | `Serotonin 3 Receptor Antagonists [MoA], Serotonin-3 Receptor Antagonist [EPC]` | ☐ | |
| arithmetic | | 30 × 1.30504 = 39.1512 → $39.15; 30 × 0.774 = $23.22; 0.774 ÷ 1.30504 = 0.593 → 41% less; $39.15 + $5.87 + $5.00 = $50.02 | ☐ | |

The card says next to the figure that Part B pays for this oral drug at a pharmacy only in
specific circumstances CMS sets for the code. Part D has rows named `Granisetron HCl*` / `Granisetron HCl` (outlier flag
`1`) and `Granisetron HCl` / `Granisetron HCl/PF`. OpenBill uses neither, because two rows
carry the name. See [What did not agree](#what-did-not-agree).

## 7. LANTUS SOLOSTAR 100 UNIT/ML (an insulin, priced per ML)

**The card:** 1 NDC, `00088-2219-05`. The quantity starts at 15 ML, one carton, from FDA's package
description. Pharmacies pay **$92.48** (15 × $6.16506 per ML). Part D **$91.68** (15 ×
$6.11195 per ML). "Medicare paid about what pharmacies pay.", `estimated`. Cost-plus estimate
**$111.35**. Class: Insulin Analog.

| what | where | expect | ☐ | notes |
|---|---|---|---|---|
| NADAC | NADAC, `LANTUS SOLOSTAR 100 UNIT/ML`, 10/14/2026 | 1 line: `00088221905`, `6.16506`, `ML`, `09/23/2026`, Explanation Code `1, 5`, Classification `B` | ☐ | |
| package | FDA `0088-2219-05` | "5 SYRINGE in 1 CARTON (0088-2219-05) / 3 mL in 1 SYRINGE (0088-2219-01)" = 15 mL | ☐ | |
| Part D average | Part D, `Lantus Solostar` / `Insulin Glargine,Hum.Rec.Anlog` / `Overall` (row 7268) | `6.1119548718`; claims `5570732`; outlier `0` | ☐ | |
| class | FDA `0088-2219-05` | `Insulin Analog [EPC], Insulin [CS]` | ☐ | |
| arithmetic | | 15 × 6.16506 = 92.4759 → $92.48; 15 × 6.1119548718 = 91.679… → $91.68; ratio 0.9914 → "about"; 15% of $92.48 = $13.872 → $13.87; $92.48 + $13.87 + $5.00 = $111.35 | ☐ | |

CMS does not say which dosage unit it uses per drug. OpenBill assumes it is NADAC's unit,
here ML ([limitations](../methodology.html#limit-dosage-unit)). The near 1× result supports
that assumption for this product, but it does not prove it.

## 8. AMOXICILLIN 500 MG CAPSULE (no Medicare reference)

**The card:** 19 NDCs, quantity 30. Pharmacies pay **$2.36** (30 × $0.0788 per EA). Medicare:
"We don't know yet", with the reason. No multiple. Cost-plus estimate **$7.71**. Class:
Penicillin-class Antibacterial.

| what | where | expect | ☐ | notes |
|---|---|---|---|---|
| NDC count | NADAC, `AMOXICILLIN 500 MG CAPSULE`, 10/14/2026 | 19 lines, all `0.07880` (the file prints five decimals), `EA`; Effective Date `09/23/2026` or `10/07/2026` | ☐ | |
| Part D | Part D, `Amoxicillin` / `Amoxicillin` / `Overall` (row 700) | the row **exists**: `0.1532464245`, claims `9463530`. OpenBill does not use it (see below) | ☐ | |
| Part B | crosswalk, filter NDC to each of the 19 | no lines | ☐ | |
| class | FDA `0093-3109-05` | `Penicillin-class Antibacterial [EPC], Penicillins [CS]` | ☐ | |
| arithmetic | | 30 × 0.0788 = 2.364 → $2.36; 15% of $2.36 = $0.354 → $0.35; $2.36 + $0.35 + $5.00 = $7.71 | ☐ | |

Why there is no Part D figure: CMS's `Amoxicillin` row averages capsules, tablets and
suspensions together. NADAC prices the NDCs that join that name partly per EA and partly per
ML. The EA share is under the 90% the builder requires (`mixed_units`), so nobody can say
that CMS's average per "dosage unit" is per capsule. The card's reason says something
less exact. See [What did not agree](#what-did-not-agree).

## 9. BENICAR 20 MG TABLET (a carried-forward NADAC)

**The card:** 1 NDC, `00713-0941-30`, marked carried forward. Pharmacies pay **$369.49** (30 ×
$12.31644 per EA, eff. 2026-07-01, explanation code 4). Part D **$338.92** (30 × $11.29735 per
EA). "Medicare paid 8% less than pharmacies pay.", `estimated`. Cost-plus estimate
**$429.91**. Class: Angiotensin 2 Receptor Blocker.

| what | where | expect | ☐ | notes |
|---|---|---|---|---|
| NADAC | NADAC, `BENICAR 20 MG TABLET`, 10/14/2026 | 1 line: `00713094130`, `12.31644`, `EA`, Effective Date `07/01/2026`, Explanation Code `4`, Classification `B`, Corresponding Generic Drug NADAC Per Unit `0.08049` (eff. `09/23/2026`) | ☐ | |
| carried forward | the 09/30/2026 and 10/07/2026 weeks | the same price and effective date: code 4 means CMS carried it forward | ☐ | |
| Part D average | Part D, `Benicar` / `Olmesartan Medoxomil` / `Overall` (row 1342) | `11.297346279`; claims `19325`; outlier `0` | ☐ | |
| class | FDA `0713-0941-30` | `Angiotensin 2 Receptor Antagonists [MoA], Angiotensin 2 Receptor Blocker [EPC]` | ☐ | |
| arithmetic | | 30 × 12.31644 = 369.4932 → $369.49; 30 × 11.297346279 = 338.920… → $338.92; ratio 0.917 → 8% less; 15% of $369.49 = $55.4235 → $55.42; $369.49 + $55.42 + $5.00 = $429.91 | ☐ | |

## 10. ALLERGY (LORATADINE) 10 MG TAB (over the counter)

**The card:** 9 NDCs, quantity 30. Pharmacies pay **$1.59** (30 × $0.05294 per EA). Medicare:
"We don't know yet". Part D excludes over-the-counter drugs. Cost-plus estimate **$6.83**.
No class: FDA gives none.

| what | where | expect | ☐ | notes |
|---|---|---|---|---|
| NDC count | NADAC, `ALLERGY (LORATADINE) 10 MG TAB`, 10/14/2026 | 9 lines, all `0.05294`, `EA`, `09/23/2026`, OTC `Y` | ☐ | |
| Part D | Part D, any name containing "loratadine" | only `Desloratadine` rows (`Clarinex`, `Clarinex-D 12 Hour`, `Desloratadine`); no loratadine | ☐ | |
| class | FDA `51660-526-01` | PHARM_CLASSES is blank | ☐ | |
| arithmetic | | 30 × 0.05294 = 1.5882 → $1.59; 15% of $1.59 = $0.2385 → $0.24; $1.59 + $0.24 + $5.00 = $6.83 | ☐ | |

## What did not agree

No number disagreed. Two things are worth a look:

1. **The card's reason for a missing Part D figure is generic.** For every NDC with no Part D
   join, the card used to say "No Medicare Part D spending row matched this drug by brand or
   generic name." For amoxicillin that did not match the file: Part D has an `Amoxicillin` row,
   and the real reason is `mixed_units`. The card now says only what is true in every case: "OpenBill
   did not match this NDC to a usable Medicare Part D spending row. Either Part D has none for
   it, or the rows that share its name could not safely be tied to it …"
   ([decision 47](DECISIONS.md#47-corrections-from-the-phase-2-review)). The rows in
   `data/drugs.json` do not carry the builder's own reason, so the page cannot be more specific. For granisetron it is
   `ambiguous_name`, and for loratadine `otc_no_exact_name`. The builder counts these reasons
   in `counts.part_d_unmatched` but does not store them per row. These reasons came from a
   traced run of `tools/build_drugs.py` on a copy, not from a reading of the raw files.
2. **Not every NDC has an FDA identity.** For example, 2 of the 31 aripiprazole NDCs and 11 of the 69
   atorvastatin NDCs are not in `package.txt`. Their figures are unaffected; they just have no
   class or FDA names of their own.

## Notes

&nbsp;

&nbsp;

&nbsp;
