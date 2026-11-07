#!/usr/bin/env node
// Do the pipeline tests fail when a rule in tools/*.py breaks? For each rule below this breaks it
// in a temporary copy of tools/ and tests/fixtures/pipeline/, runs the harness and
// tests/pipeline.test.js against that copy, and reports whether the tests noticed. It exits 1 if
// any mutant survives, or if a rule's text is gone from the source (a rename must update this).
// Not part of `node --test`: run it after changing a fetcher or a rule (decision 53).
//
// Usage: node tools/mutate_pipeline.mjs [id ...]

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// [id, file, the rule's text, what it becomes]
const MUTANTS = [
  ['P01-newest-quarter', 'fetch_asp.py', 'q = max(started)', 'q = min(started)'],
  ['P02-newest-nadac-year', 'fetch_nadac.py', 'year, ident = max(candidates)', 'year, ident = min(candidates)'],
  ['P03-newest-partd-period', 'fetch_partd.py', 'newest = max(f[0] for f in found)', 'newest = min(f[0] for f in found)'],
  ['P04-newest-nadac-week', 'build_drugs.py', 'if latest is None or week > latest:', 'if latest is None or week < latest:'],
  ['P05-etag-compare', 'cachelib.py', 'return now_headers.get("etag") == old.get("etag") and now_headers.get("last_modified") == old.get("last_modified")', 'return True'],
  ['P05b-etag-never-same', 'cachelib.py', 'return now_headers.get("etag") == old.get("etag") and now_headers.get("last_modified") == old.get("last_modified")', 'return False'],
  ['P06-hash-check', 'cachelib.py', 'if got != entry["sha256"]:', 'if False:'],
  ['P07-carried-codes', 'build_drugs.py', 'CARRIED_FORWARD = {"2", "4"}', 'CARRIED_FORWARD = {"4"}'],
  ['P08-positive-price', 'build_drugs.py', 'return d if d > 0 else None', 'return d if d >= 0 else None'],
  ['P09-nadac-header', 'fetch_nadac.py', 'if header != EXPECTED_COLUMNS:', 'if False:'],
  ['P10-quarter-in-file', 'fetch_asp.py', 'if eff and eff != period:', 'if False:'],
  ['P11-fda-link', 'fetch_fda_ndc.py', 'if spec["download_url"] not in page:', 'if False:'],
  ['P12-truncated', 'cachelib.py', 'if expected is not None and int(expected) != size:', 'if False:'],
  ['P13-partd-year-column', 'fetch_partd.py', 'if max(years) != year:', 'if False:'],
  ['P14-quarters-agree', 'build_drugs.py', 'sys.exit(f"Part B files are for different quarters: {limits_src[\'period\']} vs {xwalk_src[\'period\']}")', 'pass'],
  ['P15-as-of-agrees', 'build_drugs.py', 'sys.exit(f"Manifest says NADAC as of {nadac_src.get(\'as_of_date\')}, the file\'s newest week is {as_of}. Re-run fetch_nadac.py.")', 'pass'],
  // INFRA-04, -05, -15, -16, -17.
  ['Q01-reject-share', 'build_drugs.py', 'MAX_REJECT_SHARE = 0.005', 'MAX_REJECT_SHARE = 1.0'],
  ['Q02-quarter-started', 'fetch_asp.py', 'started = [', 'started = [q for q in complete] or ['],
  ['Q03-quarter-grace', 'fetch_asp.py', 'QUARTER_GRACE_DAYS = 10', 'QUARTER_GRACE_DAYS = 10000'],
  ['Q04-nadac-retitle', 'fetch_nadac.py', 'TITLE_RE = re.compile(r"\\bNADAC\\b.*\\b(20\\d{2})$")', 'TITLE_RE = re.compile(r"^NADAC \\(National Average Drug Acquisition Cost\\) (20\\d{2})$")'],
  ['Q05-nadac-age', 'fetch_nadac.py', 'if age > MAX_AS_OF_AGE_DAYS:', 'if False:'],
  ['Q06-validate-new-file', 'cachelib.py', 'if validate is not None:\n            validate(part)', 'pass'],
  ['Q07-shape-errors', 'cachelib.py', 'except SHAPE_ERRORS as e:\n        raise FetchError(f"the source\'s response', 'except ZeroDivisionError as e:\n        raise FetchError(f"the source\'s response'],
  ['Q08-require-online', 'cachelib.py', 'if args.require_online:', 'if False:'],
  ['Q09-partd-lookalike', 'fetch_partd.py', 'newer = [ds.get("title") for ds in lookalikes if _period_end(ds) > end]', 'newer = []'],
  ['Q10-asp-renamed-link', 'fetch_asp.py', 'LOOKS_LIKE_THESE_FILES_RE = re.compile(r"limit|pricing|crosswalk|hcpcs", re.I)', 'LOOKS_LIKE_THESE_FILES_RE = re.compile(r"NOTHING", re.I)'],
  // tools/check_refresh.py
  ['R01-min-rows', 'check_refresh.py', 'MIN_ROW_SHARE = 0.97', 'MIN_ROW_SHARE = 0.5'],
  ['R02-rejects', 'check_refresh.py', 'if c["reject_share"] > MAX_REJECT_SHARE:', 'if False:'],
  ['R03-big-move', 'check_refresh.py', 'if ratio >= BIG_MOVE or ratio <= 1 / BIG_MOVE:', 'if ratio > BIG_MOVE or ratio < 1 / BIG_MOVE:'],
  ['R04-big-move-down', 'check_refresh.py', 'if ratio >= BIG_MOVE or ratio <= 1 / BIG_MOVE:', 'if ratio >= BIG_MOVE:'],
  ['R05-max-movers', 'check_refresh.py', 'MAX_BIG_MOVERS = 20', 'MAX_BIG_MOVERS = 21'],
  ['R06-median', 'check_refresh.py', 'elif not MEDIAN_RANGE[0] <= m <= MEDIAN_RANGE[1]:', 'elif False:'],
  ['R07-accept-movers', 'check_refresh.py', 'if not accept_movers and len(c["big_movers"])', 'if len(c["big_movers"])'],
  // tools/reverify_spotchecks.py
  ['S01-disagree', 'reverify_spotchecks.py', 'if mine is None or not same(got["value"], mine):', 'if False:'],
  ['S02-writes-on-disagree', 'reverify_spotchecks.py', 'if r["disagree"]:\n        print(f"{len(r[\'disagree\'])} spot checks disagree', 'if False:\n        print(f"{len(r[\'disagree\'])} spot checks disagree'],
  ['S03-dry-run', 'reverify_spotchecks.py', 'if not args.dry_run and r["done"]:', 'if r["done"]:'],
  ['S04-api-failure', 'reverify_spotchecks.py', 'except (FetchError, *cachelib.NETWORK_ERRORS) as e:', 'except ZeroDivisionError as e:'],
  ['S07-any-manufacturer', 'reverify_spotchecks.py', 'if r["Mftr_Name"] == "Overall":', 'if True:'],
  ['S06-no-second-ask', 'reverify_spotchecks.py', 'API_TRIES = 3', 'API_TRIES = 1'],
  ['S05-as-of-condition', 'reverify_spotchecks.py', '&conditions[1][property]=as_of_date&conditions[1][value]={self.as_of}', ''],
];

const only = process.argv.slice(2);
const chosen = only.length ? MUTANTS.filter((m) => only.includes(m[0])) : MUTANTS;
const work = mkdtempSync(path.join(tmpdir(), 'openbill-mutants-'));
const lines = (s) => s.replace(/\r\n/g, '\n');
let survivors = 0;
let missing = 0;
let lastCrash = false; // the harness stopped, rather than an assertion noticing: a weaker kill

function testsPass() {
  const r = spawnSync(process.execPath, ['--test', path.join(work, 'tests', 'pipeline.test.js')], { encoding: 'utf8', maxBuffer: 1 << 26 });
  lastCrash = /the harness stopped/.test(r.stdout);
  return r.status === 0;
}

function copyIn() {
  rmSync(path.join(work, 'tools'), { recursive: true, force: true });
  cpSync(path.join(ROOT, 'tools'), path.join(work, 'tools'), { recursive: true, filter: (p) => !/[\\/](cache|__pycache__)([\\/]|$)/.test(p) });
}

try {
  cpSync(path.join(ROOT, 'tests', 'fixtures', 'pipeline'), path.join(work, 'tests', 'fixtures', 'pipeline'), { recursive: true });
  cpSync(path.join(ROOT, 'tests', 'pipeline.test.js'), path.join(work, 'tests', 'pipeline.test.js'));
  copyIn();
  if (!testsPass()) {
    console.error('The tests fail before any mutation, so this run would prove nothing.');
    process.exit(2);
  }
  for (const [id, file, from, to] of chosen) {
    const p = path.join(work, 'tools', file);
    const source = lines(readFileSync(p, 'utf8'));
    if (!source.includes(from)) {
      console.log(`MISSING   ${id}: the rule's text is not in tools/${file}`);
      missing += 1;
      continue;
    }
    writeFileSync(p, source.replace(from, to));
    const survived = testsPass();
    writeFileSync(p, source);
    console.log(`${survived ? 'SURVIVED' : lastCrash ? 'crashed ' : 'killed  '}  ${id}`);
    if (survived) survivors += 1;
  }
} finally {
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
}
console.log(`${chosen.length - survivors - missing} of ${chosen.length} mutants killed.`);
process.exit(survivors || missing ? 1 : 0);
