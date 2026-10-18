// What each source is, how often it is published and when it counts as stale.
// The ids match `sources` in data/drugs.json. Rendered on the page and on methodology.html.

/**
 * @typedef {object} SourceInfo
 * @property {string} id               key in data/drugs.json → sources
 * @property {string} label            short label shown on the card
 * @property {string} publisher
 * @property {string} cadence          how often a new file is published
 * @property {number} stale_after_days age after which the figure is shown as stale
 * @property {'as_of_date'|'period_start'|'period_end'} age_from
 *           which date of a record the age is measured from (see freshness() in rules.js)
 * @property {string} stale_note       why that threshold, in plain English
 * @property {string} measures         one plain sentence: what the source measures
 */

/** @type {Readonly<Record<string, SourceInfo>>} */
export const SOURCE_INFO = Object.freeze({
  nadac: Object.freeze({
    id: 'nadac',
    label: 'CMS NADAC',
    publisher: 'Centers for Medicare & Medicaid Services, on data.medicaid.gov',
    cadence: 'weekly',
    stale_after_days: 14,
    age_from: 'as_of_date',
    stale_note:
      'NADAC is published every week. A file more than 14 days old means at least one weekly update was missed, so the price may have changed.',
    measures:
      'The national average price retail pharmacies pay to buy a drug from their suppliers (their acquisition cost), per unit, from a CMS survey of pharmacy invoices.',
  }),
  fda_ndc: Object.freeze({
    id: 'fda_ndc',
    label: 'FDA NDC Directory',
    publisher: 'U.S. Food and Drug Administration',
    cadence: 'daily',
    stale_after_days: 30,
    age_from: 'as_of_date',
    stale_note:
      'The FDA updates the directory every business day. It only supplies names and package details, which change slowly, so it is shown as stale after 30 days rather than after one missed day.',
    measures:
      'The FDA listing of each drug package: its NDC, brand and generic names, dosage form, strength, labeler and package description. It identifies drugs; it has no prices.',
  }),
  partd: Object.freeze({
    id: 'partd',
    label: 'Medicare Part D',
    publisher: 'Centers for Medicare & Medicaid Services, on data.cms.gov',
    cadence: 'annual',
    stale_after_days: 913,
    age_from: 'period_end',
    stale_note:
      'Part D spending is published once a year, about 18 months after the data year ends (about 548 days), and the next year follows about a year after that. So a data year is the newest one available until roughly 2.5 years (913 days) after it ends; older than that, a newer year should exist.',
    measures:
      'What Medicare Part D spent on a drug in one calendar year, averaged per dosage unit across every strength and form sold under the same brand and generic name.',
  }),
  asp_limits: Object.freeze({
    id: 'asp_limits',
    label: 'Medicare Part B',
    publisher: 'Centers for Medicare & Medicaid Services, on cms.gov',
    cadence: 'quarterly',
    stale_after_days: 100,
    age_from: 'period_start',
    stale_note:
      'Part B payment limits are set for one calendar quarter (about 91 days). Once more than 100 days have passed since the quarter began, the next quarter’s file should be in use.',
    measures:
      'The most Medicare Part B pays for a drug given in a clinic or doctor’s office, per HCPCS billing unit, for one calendar quarter, and the coinsurance percentage for it.',
  }),
  asp_crosswalk: Object.freeze({
    id: 'asp_crosswalk',
    label: 'Medicare Part B crosswalk',
    publisher: 'Centers for Medicare & Medicaid Services, on cms.gov',
    cadence: 'quarterly',
    stale_after_days: 100,
    age_from: 'period_start',
    stale_note:
      'The NDC-HCPCS crosswalk is published with each quarter’s payment limits. Once more than 100 days have passed since the quarter began, the next quarter’s file should be in use.',
    measures:
      'Which HCPCS billing code each NDC is paid under in Medicare Part B, and how many billing units are in one package of that NDC.',
  }),
});

/**
 * NADAC "Explanation Code" meanings, from the NADAC data dictionary. The same wording is
 * used in the reasons written by tools/build_drugs.py.
 * @type {Readonly<Record<string, string>>}
 */
export const NADAC_EXPLANATION_CODES = Object.freeze({
  1: 'calculated from the most recently completed pharmacy survey',
  2: 'the latest survey was within 2% of the current NADAC, so the NADAC was carried forward from the previous file',
  3: 'the survey-based NADAC was adjusted for changes in published pricing, or after a help-desk inquiry',
  4: 'carried forward from the previous file',
  5: 'calculated based on package size',
  6: 'the CMS Covered Outpatient Drug Product File S/I/N drug category was not applied when grouping drugs for the calculation',
});

/**
 * Explanation codes that mean the NADAC was carried forward rather than newly surveyed.
 * @type {readonly string[]}
 */
export const NADAC_CARRIED_FORWARD_CODES = Object.freeze(['2', '4']);
