// The data pipeline against tiny files (tests/fixtures/pipeline/): which week, quarter and year are
// chosen, each refusal, each exit code, what a malformed new file leaves behind, and the refresh
// checks. Python runs it (python -I, standard library only) with a temporary cache and a stubbed
// network, so nothing is downloaded and tools/cache/ is never touched.
//
// Every assertion here exists to fail when a rule in tools/*.py breaks. Run
// `node tools/mutate_pipeline.mjs` to see each one do so (docs/DECISIONS.md, decision 55).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TOOLS = path.resolve(fileURLToPath(new URL('../tools/', import.meta.url)));
const FIXTURES = path.resolve(fileURLToPath(new URL('./fixtures/pipeline/', import.meta.url)));

function python() {
  for (const exe of ['python', 'python3']) {
    const r = spawnSync(exe, ['-I', '-c', 'import sys; print(sys.version_info[:2] >= (3, 10))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return exe;
  }
  return null;
}

const exe = python();
let o;

before(() => {
  if (!exe) return;
  const r = spawnSync(exe, ['-I', path.join(FIXTURES, 'harness.py'), TOOLS, FIXTURES], { encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, PYTHONIOENCODING: 'utf-8', OPENBILL_SAMPLES: '' } });
  assert.equal(r.status, 0, `the harness stopped:\n${r.stderr}`);
  o = JSON.parse(r.stdout.trim().split('\n').pop());
});

const pipelineTest = (name, fn) =>
  test(name, (t) => {
    if (!exe) {
      t.skip('Python 3.10+ is not on PATH');
      return;
    }
    fn();
  });

const NO_NETWORK = /NOT REFRESHED/;

// ---------------------------------------------------------------- choosing the newest

pipelineTest('NADAC: the newest year of the weekly dataset, never the other NADAC datasets', () => {
  assert.equal(o.nadac_year_title, 'NADAC (National Average Drug Acquisition Cost) 2026');
  assert.equal(o.nadac_retitled_year, 2027, 'a retitled next year is still found: "NADAC" and a year');
  assert.match(o.nadac_two_for_a_year, /more than one NADAC dataset for 2026/);
  assert.equal(o.nadac_lookalike_titles, 'NADAC (National Average Drug Acquisition Cost) 2026', 'not "NADAC Comparison 2026" or "First Time NADAC Rates 2026"');
});

pipelineTest('build_drugs: only the newest week of the stacked CSV', () => {
  assert.deepEqual(o.read_nadac, { latest: '2026-10-14', weeks: 2, rows: 7, weeks_kept: ['10/14/2026'] });
  assert.equal(o.built.eliquis, 5.52114, 'the 10/14 price, not the 10/07 one');
  assert.equal(o.built.as_of, '2026-10-14');
});

pipelineTest('Part B: the newest complete quarter that has already started', () => {
  assert.deepEqual(o.asp_live.quarter, [2026, 10], 'not July 2026');
  assert.equal(o.asp_live.period, '2026-10-01/2026-12-31');
  assert.deepEqual(o.asp_on_first_day.quarter, [2026, 10], 'a quarter counts from its first day');
  assert.deepEqual(o.asp_day_before.quarter, [2026, 7], 'and not the day before');
  // A future quarter is not adopted early (INFRA-09), and what was seen is printed.
  assert.deepEqual(o.asp_future_posted.quarter, [2026, 10]);
  assert.match(o.asp_future_posted.said, /2027-01 crosswalk and limits posted, not used/);
  assert.deepEqual(o.asp_future_started.quarter, [2027, 1]);
  assert.match(o.asp_all_future.error, /every complete quarter .* starts after 2026-12-20/);
  assert.match(o.asp_no_quarter.error, /no quarter .* has both/);
});

pipelineTest('Part B: missing or renamed files fail loudly, within a short grace window (INFRA-05)', () => {
  // C: the limits are posted and the crosswalk is not. Fine before the quarter starts; then a warning; then a failure.
  assert.deepEqual(o.asp_half_posted.quarter, [2026, 10]);
  assert.match(o.asp_half_posted.said, /2027-01 limits posted, not used/);
  assert.deepEqual(o.asp_half_posted_in_grace.quarter, [2026, 10]);
  assert.match(o.asp_half_posted_in_grace.warned, /ended 2026-12-31/);
  assert.match(o.asp_half_posted_past_grace.error, /ended 2026-12-31, 11 days before 2027-01-11/);
  assert.deepEqual(o.asp_nothing_new_in_grace.quarter, [2026, 10]);
  assert.match(o.asp_nothing_new_past_grace.error, /not posted, or are not named as this script expects/);
  // D, E: a newer quarter's file under a new name stops the run however early it is seen.
  assert.match(o.asp_limits_renamed.error, /may have renamed them.*January 2027 Part B Payment Limits/);
  assert.match(o.asp_crosswalk_renamed.error, /may have renamed them.*January 2027 HCPCS-NDC Crosswalk/);
  // Another file for a newer quarter is not a rename.
  assert.deepEqual(o.asp_noc_only.quarter, [2026, 10]);
  // Nor is an unmatched link for a quarter whose files are both already found, or for an older one.
  assert.deepEqual(o.asp_renamed_but_complete.quarter, [2026, 10]);
  assert.deepEqual(o.asp_renamed_older.quarter, [2026, 10]);
});

pipelineTest('Part D: the newest period; a look-alike dataset for a newer period is a failure (INFRA-05)', () => {
  assert.deepEqual(o.partd_newest, { period: '2024-01-01/2024-12-31', year: 2024, file: 'DSD_PTD_RY26_P04_V10_DY24_BGM.csv' }, 'not 2023, and not the Quarterly, Prescribers, Part B or Medicaid datasets dated 2025 or 2026');
  assert.equal(o.partd_next_year.year, 2025, 'the next year under the same title is simply taken');
  assert.match(o.partd_retitled.error, /newer dataset with a different title.*Medicare Part D Drug Spending : 2025-01-01/);
  assert.match(o.partd_nothing.error, /no CSV distribution/);
  assert.match(o.partd_late_warning, /WARNING: .*ended 2024-12-31, 915 days ago/);
});

// ---------------------------------------------------------------- what the build keeps

pipelineTest('build_drugs: a zero or blank price, a bad unit, a bad NDC and a blank name are rejected, never written', () => {
  assert.deepEqual(o.rejects.kept, ['00003089421']);
  assert.deepEqual(o.rejects.reasons, [
    'NADAC per unit is not a positive number: \'\'',
    'NADAC per unit is not a positive number: \'0.00000\'',
    'NDC is not 11 digits: \'1234\'',
    'empty NDC description',
    'unknown pricing unit \'UN\'',
  ]);
  assert.deepEqual(o.positive, ['None', 'None', 'None', 'None', 'None', '0.01451', '1234.5']);
});

pipelineTest('build_drugs: explanation codes 2 and 4 are carried forward, and only they', () => {
  assert.deepEqual(o.carried, { '90000000041': true, '90000000022': true, '90000000033': false, '00003089421': false });
  assert.deepEqual(o.explanation_codes, ['1', '5']);
  assert.equal(o.built.carried, 2);
});

pipelineTest('build_drugs: records carry full provenance; figures come from the right file, column and join', () => {
  assert.deepEqual(o.build_ok_exit.code, 0, o.build_ok_exit.err);
  assert.equal(o.built.schema, 'openbill.drugs/3');
  assert.equal(o.built.rows, 7);
  assert.equal(o.built.weeks, 2);
  assert.equal(o.built.eliquis_state, 'filed');
  assert.equal(o.built.eliquis_file, 'nadac-national-average-drug-acquisition-cost-20261014.csv');
  assert.equal(o.built.eliquis_identity, 'ELIQUIS');
  assert.equal(o.built.eliquis_join.key, 'Eliquis|Apixaban');
  assert.equal(o.built.part_d_avg, 9.6370356894, 'the 2024 column, not 2023');
  assert.equal(o.built.part_d_period, '2024-01-01/2024-12-31');
  assert.equal(o.built.ondansetron_hcpcs, 'J2405');
  assert.equal(o.built.ondansetron_units, 100);
  assert.equal(o.built.j2405, 0.084);
  assert.equal(o.built.rejected, 0);
  assert.equal(o.build_deterministic, true, 'the same cache rebuilds the same bytes');
  const r = o.nadac_record;
  assert.deepEqual(
    { value: r.value, kind: r.kind, state: r.state, file: r.source_file, effective: r.effective_date, retrieved: r.retrieved_date, asOf: r.as_of_date, per: r.per },
    { value: 5.52114, kind: 'usd', state: 'filed', file: 'f.csv', effective: '2026-09-23', retrieved: '2026-10-17', asOf: '2026-10-14', per: 'EA' },
  );
  assert.deepEqual(o.generic_record, { value: 0.02792, state: 'filed', effective_date: '2026-09-16', per: 'EA' });
});

pipelineTest('build_drugs stops, and writes nothing, when the manifest, the quarters, the hashes or the reject share are wrong', () => {
  assert.equal(o.build_as_of_mismatch.code, 1);
  assert.match(o.build_as_of_mismatch.err, /Manifest says NADAC as of 2026-10-07, the file's newest week is 2026-10-14/);
  assert.equal(o.build_as_of_mismatch.wrote, false);
  assert.equal(o.build_quarter_mismatch.code, 1);
  assert.match(o.build_quarter_mismatch.err, /Part B files are for different quarters/);
  assert.equal(o.build_quarter_mismatch.wrote, false);
  assert.equal(o.build_hash_mismatch.code, 1);
  assert.match(o.build_hash_mismatch.err, /Hash mismatch for ndctext\.zip/);
  assert.equal(o.build_hash_mismatch.wrote, false);
  // INFRA-04: a high reject share is a non-zero exit, with the reasons.
  assert.equal(o.build_reject_share.code, 1);
  assert.match(o.build_reject_share.err, /5 of 6 NADAC rows were rejected \(83\.3%, the limit is 0\.5%\)/);
  assert.match(o.build_reject_share.err, /unknown pricing unit 'UN'/);
  assert.equal(o.build_reject_share.wrote, false);
  assert.equal(o.reject_share_one_percent, null, '0.5% exactly passes');
  assert.equal(o.reject_share_over.type, 'SystemExit', 'over 0.5% stops');
});

// ---------------------------------------------------------------- fetching: flow and exit codes

pipelineTest('fetch_nadac: a good run records the file, the as-of date and the weeks; unchanged means not downloaded', () => {
  assert.equal(o.nadac_flow.code, 0);
  assert.equal(o.nadac_flow.as_of, '2026-10-14');
  assert.equal(o.nadac_flow.weeks, 2);
  assert.equal(o.nadac_unchanged.code, 0);
  assert.equal(o.nadac_unchanged.downloads, 0, 'same ETag: not downloaded');
  assert.equal(o.nadac_unchanged.said, true);
  assert.equal(o.nadac_new_etag.downloads, 1, 'a changed ETag is downloaded');
});

pipelineTest('a cached file that fails its hash stops the run with exit 3', () => {
  assert.equal(o.nadac_hash_mismatch.code, 3);
  assert.match(o.nadac_hash_mismatch.err, /HASH CHECK FAILED/);
  assert.equal(o.verify_hash_mismatch.type, 'HashMismatch');
  assert.match(o.verify_hash_mismatch.message, /sha256 .*manifest says/);
});

pipelineTest('a malformed new file leaves the last good cache and the manifest untouched (INFRA-15)', () => {
  const m = o.nadac_malformed;
  assert.equal(m.code, 4);
  assert.match(m.err, /unexpected NADAC header/);
  assert.match(m.err, /The new file was not kept; the cached copy and the manifest are as they were/);
  assert.equal(m.old_file_kept, true);
  assert.equal(m.manifest_unchanged, true);
  assert.equal(m.new_file_absent, true);
  assert.equal(m.no_part_left, true);
  assert.equal(m.removed_message, false);
  assert.equal(o.nadac_malformed_offline, 0, '--offline still works');
  assert.deepEqual(o.nadac_superseded, { code: 0, old_gone: true, said: true, as_of: '2026-10-15' }, 'a good new file does replace the old one');
  // The same for each other source, including a new file under the same name.
  assert.equal(o.fda_bad_new_file.code, 4);
  assert.match(o.fda_bad_new_file.err, /unexpected header in product\.txt/);
  assert.equal(o.fda_bad_new_file.old_file_kept, true);
  assert.equal(o.fda_bad_new_file.manifest_unchanged, true);
  assert.equal(o.asp_wrong_quarter.code, 4);
  assert.equal(o.asp_wrong_quarter.old_file_kept, true);
  assert.equal(o.asp_wrong_quarter.manifest_unchanged, true);
  assert.equal(o.partd_bad_new_file.code, 4);
  assert.match(o.partd_bad_new_file.err, /lacks columns/);
  assert.equal(o.partd_bad_new_file.kept, true);
  assert.equal(o.asp_no_rows.code, 4);
  assert.match(o.asp_no_rows.err, /a header but no rows/);
  assert.equal(o.asp_bad_zip.code, 4);
  assert.match(o.asp_bad_zip.err, /not a readable zip/);
  // A zip whose directory reads but whose deflate stream does not (decision 56): a reason, not a traceback.
  assert.equal(o.asp_broken_stream.code, 4);
  assert.match(o.asp_broken_stream.err, /not readable as expected \(error: Error -3 while decompressing/);
  assert.match(o.asp_broken_stream.err, /The new file was not kept/);
  assert.doesNotMatch(o.asp_broken_stream.err, /Traceback/);
  assert.equal(o.asp_broken_stream_cached.code, 4);
  assert.match(o.asp_broken_stream_cached.err, /FAILED: Error -3 while decompressing/);
  assert.doesNotMatch(o.asp_broken_stream_cached.err, /Traceback/);
});

pipelineTest('fetch_nadac: an old as-of date is a failure online, not offline (INFRA-05)', () => {
  assert.equal(o.nadac_age_10, 0, 'exactly 10 days passes');
  assert.equal(o.nadac_age_11.code, 4);
  assert.match(o.nadac_age_11.err, /2026-10-14, 11 days old/);
  assert.equal(o.nadac_age_offline, 0);
  assert.match(o.summarise_bad_header, /unexpected NADAC header/);
  assert.match(o.summarise_no_rows, /has a header but no rows/);
});

pipelineTest('a response of the wrong shape is exit 4 with a message, never a traceback (INFRA-16)', () => {
  assert.equal(o.nadac_maintenance.code, 4);
  assert.match(o.nadac_maintenance.err, /not the shape expected \(KeyError: 'results'\)/);
  assert.equal(o.nadac_not_json.code, 4);
  assert.match(o.nadac_not_json.err, /not the shape expected \(JSONDecodeError/);
  assert.equal(o.partd_string_temporal.code, 4);
  assert.match(o.partd_string_temporal.err, /not the shape expected \(AttributeError/);
});

pipelineTest('a truncated or empty download is refused and leaves nothing behind', () => {
  assert.match(o.truncated, /truncated download: got 5 bytes, server said 99/);
  assert.equal(o.truncated_left_nothing, true);
  assert.match(o.empty_download, /empty file/);
});

pipelineTest('--require-online: a fallback to the cache says NOT REFRESHED, and fails only when required (INFRA-17)', () => {
  assert.equal(o.fallback_plain.code, 0);
  assert.match(o.fallback_plain.err, NO_NETWORK);
  assert.match(o.fallback_plain.out, /network failed; using cached copy \(NOT REFRESHED\)/);
  assert.equal(o.fallback_required.code, 5);
  assert.match(o.fallback_required.err, NO_NETWORK);
  assert.equal(o.offline_flag, 0);
  assert.equal(o.offline_and_required_refused, 2, 'argparse refuses both');
  assert.equal(o.no_cache_no_network, 2);
  // Every fetcher, not only NADAC's: the fallback passes plainly and fails when required.
  for (const name of ['asp_required', 'partd_required', 'fda_required']) {
    assert.equal(o[name].online, 0, `${name} online`);
    assert.equal(o[name].plain, 0, `${name} plain`);
    assert.equal(o[name].code, 5, `${name} required`);
    assert.match(o[name].err, NO_NETWORK, name);
  }
  // A cached NADAC week past the age limit, kept because the network failed, is NOT REFRESHED, not FAILED.
  assert.equal(o.nadac_old_fallback.code, 0);
  assert.match(o.nadac_old_fallback.err, NO_NETWORK);
  assert.doesNotMatch(o.nadac_old_fallback.err, /FAILED/);
  assert.equal(o.nadac_old_fallback_required.code, 5);
});

pipelineTest('fetch_all: the summary names what was not refreshed; only --require-online or a real failure is non-zero', () => {
  assert.equal(o.fetch_all_plain.code, 0);
  assert.match(o.fetch_all_plain.out, /fetch_fda_ndc\.py\s+NOT REFRESHED/);
  assert.match(o.fetch_all_plain.out, /fetch_nadac\.py\s+ok/);
  assert.match(o.fetch_all_plain.err, /NOT REFRESHED: fetch_fda_ndc\.py, fetch_asp\.py/);
  assert.ok(o.fetch_all_plain.flags.includes('--require-online'), 'every online child reports a fallback by its exit code');
  assert.equal(o.fetch_all_required, 1);
  assert.equal(o.fetch_all_failed.code, 1);
  assert.match(o.fetch_all_failed.out, /FAILED \(exit 4\)/);
  assert.equal(o.fetch_all_offline.code, 0);
  assert.deepEqual(o.fetch_all_offline.flags, ['--offline']);
});

pipelineTest('fetch_asp: both zips, the member, the posted date and the period; the file must agree with the link', () => {
  assert.equal(o.asp_flow.code, 0, o.asp_flow.err);
  assert.equal(o.asp_flow.limits_period, '2026-10-01/2026-12-31');
  assert.match(o.asp_flow.limits_member, /Payment Limit File/);
  assert.equal(o.asp_flow.xwalk_quarter, '2026-10');
  assert.equal(o.asp_flow.effective_in_file, '2026-10-01/2026-12-31');
  assert.equal(o.asp_flow.as_of, '2026-09-17');
  assert.match(o.asp_wrong_quarter.err, /file says effective 2026-07-01\/2026-09-30, link text says quarter 2026-10-01\/2026-12-31/);
  assert.equal(o.asp_wrong_quarter_cached.code, 4);
  assert.match(o.asp_wrong_quarter_cached.err, /file says effective/);
});

pipelineTest('fetch_partd: the year on the catalog and the columns in the file must agree', () => {
  assert.equal(o.partd_flow.code, 0, o.partd_flow.err);
  assert.equal(o.partd_flow.year, 2024);
  assert.equal(o.partd_flow.dictionary, 'https://data.cms.gov/dict.pdf');
  assert.match(o.partd_newer_column, /lacks columns|newest year column is 2025, catalog period says 2023/);
  assert.match(o.partd_missing_year, /lacks columns/);
  assert.equal(o.partd_column_ok, null);
});

pipelineTest('fetch_fda_ndc: the landing page must still link the zip; a good run dates it by Last-Modified', () => {
  assert.equal(o.fda_flow.code, 0, o.fda_flow.err);
  assert.equal(o.fda_flow.as_of, '2026-10-16');
  assert.match(o.fda_landing_moved, /no longer links/);
});

// ---------------------------------------------------------------- check_refresh

pipelineTest('check_refresh: the row, reject, mover and median limits, each at its boundary (INFRA-04)', () => {
  const ok = (name) => assert.equal(o[name].code, 0, `${name} should pass:\n${o[name].out}`);
  const bad = (name, re) => {
    assert.equal(o[name].code, 1, `${name} should fail:\n${o[name].out}`);
    assert.match(o[name].out, re, name);
  };
  ok('refresh_same');
  ok('refresh_20_movers');
  bad('refresh_21_movers', /21 NDCs moved 5× or more, over 20/);
  bad('refresh_21_movers_down', /21 NDCs moved 5× or more/);
  ok('refresh_21_movers_accepted');
  ok('refresh_21_at_4x');
  bad('refresh_21_at_5x', /21 NDCs moved/);
  bad('refresh_21_at_fifth', /21 NDCs moved/);
  ok('refresh_rows_970');
  bad('refresh_rows_969', /rows fell from 1,000 to 969, below 97% of the previous count/);
  ok('refresh_rejects_5');
  bad('refresh_rejects_6', /6 rows were rejected/);
  ok('refresh_median_edge');
  bad('refresh_median_up', /median new ÷ old NADAC is 1\.110/);
  bad('refresh_median_down', /median new ÷ old NADAC is 0\.890/);
  bad('refresh_unit_shift', /median new ÷ old NADAC is 100\.000/);
  assert.match(o.refresh_nothing_shared.problems.join(' '), /no NDC is in both files/);
});

pipelineTest('check_refresh: the shared, week, count and shift limits, each at its boundary (decision 56)', () => {
  const ok = (name) => assert.equal(o[name].code, 0, `${name} should pass:\n${o[name].out}`);
  const bad = (name, re) => {
    assert.equal(o[name].code, 1, `${name} should fail:\n${o[name].out}`);
    assert.match(o[name].out, re, name);
  };
  // Same row count, other NDCs: the row limit alone let 990 of 1,000 be replaced.
  ok('refresh_shared_900');
  bad('refresh_shared_899', /only 899 of the previous 1,000 NDCs are in the new file, below 90%/);
  bad('refresh_990_replaced', /only 10 of the previous 1,000 NDCs/);
  bad('refresh_older_week', /NADAC is as of 2026-10-28, older than the previous file's 2026-11-04/);
  bad('refresh_no_week', /names no NADAC as-of date/);
  bad('refresh_empty_week', /names no NADAC as-of date/);
  bad('refresh_no_counts', /no count of rejected rows/);
  assert.match(o.refresh_no_counts.out, /rejected not counted\./);
  // Under 21 NDCs at 5×, over 5% of them at 1.5×: a shifted part of the file.
  ok('refresh_shift_50');
  bad('refresh_shift_51', /51 of 1,000 shared NDCs \(5\.1%\) moved 1\.5× or more, over 5%/);
  bad('refresh_shift_51_down', /51 of 1,000 shared NDCs/);
  ok('refresh_shift_51_under');
  ok('refresh_shift_51_accepted');
  bad('refresh_499_at_4x', /499 of 1,000 shared NDCs/);
  assert.doesNotMatch(o.refresh_499_at_4x.out, /NDCs moved 5×/, 'under the 5× limit');
});

pipelineTest('check_refresh: a NADAC value that is not a positive number is a reason, never a traceback', () => {
  for (const label of ['zero', 'negative', 'null', 'text', 'nan', 'infinite', 'true', 'missing']) {
    const r = o[`refresh_value_${label}`];
    assert.equal(r.code, 1, `${label}:\n${r.out}`);
    assert.match(r.out, /1 row of the new file has no NADAC value that is a positive number, the first 00000000000; it is left out of the comparison/, label);
    assert.doesNotMatch(r.out, /Traceback/, label);
  }
  assert.match(o.refresh_value_old_summary, /^## Data refresh check\n\n\*\*FAILED:\*\*\n- 1 row of the previous file has no NADAC value/);
  assert.match(o.refresh_value_old_summary, /NADAC as of 2026-11-04 → 2026-11-04; 999 NDCs in both\./);
});

pipelineTest('check_refresh: the summary is ready for a pull request body, biggest moves first', () => {
  assert.match(o.refresh_summary_file, /^## Data refresh check\n\n\*\*FAILED:\*\*\n- 21 NDCs moved/);
  assert.match(o.refresh_summary_file, /\| 00000000000 \| DRUG 0 \| 1\.0 \| 100\.0 \| 100\.000 \|/);
  assert.match(o.refresh_summary_file, /Rows 1,000 → 1,000 \(\+0, −0\); 21 NADAC values changed; rejected 0\./);
  assert.equal(o.refresh_movers_top, '00000000002', 'a tenfold fall outranks a threefold rise');
});

// ---------------------------------------------------------------- reverify_spotchecks

pipelineTest('reverify_spotchecks: agreement rewrites the value, file, method and date; only what has an API (INFRA-06)', () => {
  const r = o.reverify_ok;
  assert.equal(r.code, 0, r.err);
  const n1 = r.checks.n1;
  assert.equal(n1.value, 5.52144);
  assert.equal(n1.source_file, 'nadac-national-average-drug-acquisition-cost-11-04-2026.csv');
  assert.equal(n1.verified_on, '2026-11-06');
  assert.match(n1.verified_via, /datastore\/query\/fbb83258-11c7-47f5-8b18-5f8e79f7e704\/0\?conditions\[0\]\[property\]=ndc&conditions\[0\]\[value\]=00003089421&conditions\[1\]\[property\]=as_of_date&conditions\[1\]\[value\]=2026-11-04/);
  assert.match(n1.verified_via, /nadac_per_unit "5\.52144"/);
  assert.equal(r.checks.n2.value, '2026-10-21', 'the effective date field');
  assert.equal(r.checks.n3.value, 'EA', 'the unit field');
  assert.equal(r.checks.pd.value, 9.6370356894);
  assert.equal(r.checks.pd.source_file, 'PARTD.csv');
  assert.match(r.checks.pd.verified_via, /da5ff50b-e5da-42de-b68b-6cfac1f64f35\/data\?size=5000&offset=0/);
  // What the API cannot answer stays pinned to its old file, so it stops counting.
  assert.equal(r.checks.gone.source_file, 'nadac-national-average-drug-acquisition-cost-20261014.csv', 'an NDC that left');
  assert.equal(r.checks.gone.value, 1);
  for (const id of ['join', 'limit', 'xwalk']) {
    assert.equal(r.checks[id].verified_via, 'old', `${id} has no API`);
    assert.match(r.out, new RegExp(`\\b${id}\\b`));
  }
  assert.equal(r.checks['pd-current'].verified_via, 'old', 'an entry already current is not re-read by default');
  assert.equal(o.reverify_current_untouched.asked.length, 0);
  assert.equal(o.reverify_all.checks.n1.verified_on, '2026-11-06', '--all re-reads it');
  assert.equal(o.reverify_all.checks['pd-current'].verified_on, '2026-11-06');
  // The newest result is the one compared and the one named, wherever it is in the answer.
  const newest = o.reverify_newest_second;
  assert.equal(newest.code, 0, newest.err);
  assert.equal(newest.checks.n1.value, 5.52144);
  assert.match(newest.checks.n1.verified_via, /-> results\[1\]: .*nadac_per_unit "5\.52144", .*effective_date "2026-10-21"/);
  assert.equal(o.reverify_same_decimal.code, 0, '"5.521440" is the same number as 5.52144');
  // Part D's second page, asked at the page size; a Part B entry pinned to the current file is not listed.
  const pages = o.reverify_partd_two_pages;
  assert.equal(pages.code, 0, pages.err);
  assert.match(pages.checks.pd.verified_via, /size=3&offset=3/);
  assert.ok(pages.asked.includes('https://data.cms.gov/data-api/v1/dataset/da5ff50b-e5da-42de-b68b-6cfac1f64f35/data?size=3&offset=0'));
  assert.equal(o.reverify_current_part_b.code, 0);
  assert.doesNotMatch(o.reverify_current_part_b.out, /limit-current/);
  // A dry run says it agreed, not that it rewrote.
  assert.match(o.reverify_dry_run.out, /^Agreed with the API: 4$/m);
  assert.match(o.reverify_ok.out, /^Agreed with the API and rewritten: 4$/m);
});

pipelineTest('reverify_spotchecks: a disagreement or an unreadable API writes nothing and fails', () => {
  assert.equal(o.reverify_dry_run.code, 0);
  assert.equal(o.reverify_dry_run.written, false);
  assert.equal(o.reverify_ok.written, true);
  for (const [name, re] of [['reverify_nadac_disagrees', /DISAGREES n1: the API says '5\.52000', data\/drugs\.json has 5\.52144/], ['reverify_partd_disagrees', /DISAGREES pd: the API says '9\.7'/]]) {
    assert.equal(o[name].code, 1, name);
    assert.equal(o[name].written, false, name);
    assert.match(o[name].err, re);
    assert.match(o[name].err, /Do not merge this refresh/);
  }
  // data.cms.gov answers 503 to a cold filter and the same request moments later (seen 2026-11-06).
  assert.equal(o.reverify_partd_busy_once.code, 0, 'a busy answer is asked again');
  assert.equal(o.reverify_partd_busy_once.written, true);
  assert.match(o.reverify_partd_busy_once.err, /HTTP 503 .*asking again/);
  assert.equal(o.reverify_nadac_busy_once.code, 0, 'and so is NADAC’s');
  assert.equal(o.reverify_nadac_busy_once.written, true);
  assert.match(o.reverify_nadac_busy_once.err, /HTTP 503 .*data\.medicaid\.gov.*asking again/);
  assert.equal(o.reverify_nadac_404.code, 2, 'a 404 is not asked again');
  assert.equal(o.reverify_nadac_404.nadac_asks, 1);
  // An entry whose NDC is not in data/drugs.json disagrees; it is never taken as agreeing.
  assert.equal(o.reverify_not_in_data.code, 1);
  assert.equal(o.reverify_not_in_data.written, false);
  assert.match(o.reverify_not_in_data.err, /DISAGREES elsewhere: the API says '5\.52144', data\/drugs\.json has None/);
  for (const name of ['reverify_api_down', 'reverify_api_refuses', 'reverify_api_shape', 'reverify_partd_busy_always']) {
    assert.equal(o[name].code, 2, name);
    assert.equal(o[name].written, false, name);
    assert.match(o[name].err, /nothing was written/, name);
  }
});
