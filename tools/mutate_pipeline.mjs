#!/usr/bin/env node
// Do the pipeline tests fail when a rule in tools/*.py breaks? For each rule below this breaks it
// in a temporary copy of tools/ and tests/fixtures/pipeline/, runs the harness and
// tests/pipeline.test.js against that copy, and reports whether the tests noticed. It exits 1 if
// any mutant survives, or if a rule's text is gone from the source (a rename must update this).
// Not part of `node --test`: run it after changing a fetcher or a rule (decision 55).
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
  // Decision 56: the rules the 2026-11 review found untested.
  ['Q11-asp-renamed-in-complete', 'fetch_asp.py', 'if x > q and x not in complete}', 'if x > q}'],
  ['Q12-asp-renamed-older', 'fetch_asp.py', 'if x > q and x not in complete}', 'if x not in complete}'],
  ['Q13-asp-finish', 'fetch_asp.py', 'return cachelib.finish(worst, args)', 'return worst'],
  ['Q14-partd-finish', 'fetch_partd.py', 'return cachelib.finish(0, args)', 'return 0'],
  ['Q15-fda-finish', 'fetch_fda_ndc.py', 'return cachelib.finish(worst, args)', 'return worst'],
  ['Q16-nadac-not-weekly', 'fetch_nadac.py', 'if m and not NOT_THE_WEEKLY_FILE_RE.search(title):', 'if m:'],
  ['Q17-nadac-age-after-fallback', 'fetch_nadac.py', 'if not args.offline and KEY not in cachelib.FELL_BACK:', 'if not args.offline:'],
  ['Q18-broken-stream-new', 'cachelib.py', 'zipfile.BadZipFile, zlib.error, EOFError)', 'zipfile.BadZipFile)'],
  ['Q19-broken-stream-cached', 'fetch_asp.py', 'except (FetchError, zipfile.BadZipFile, UnicodeDecodeError, zlib.error, EOFError) as e:', 'except (FetchError, zipfile.BadZipFile, UnicodeDecodeError) as e:'],
  // tools/check_refresh.py
  ['R01-min-rows', 'check_refresh.py', 'MIN_ROW_SHARE = 0.97', 'MIN_ROW_SHARE = 0.5'],
  ['R02-rejects', 'check_refresh.py', 'if c["reject_share"] > MAX_REJECT_SHARE:', 'if False:'],
  ['R03-big-move', 'check_refresh.py', 'if ratio >= BIG_MOVE or ratio <= 1 / BIG_MOVE:', 'if ratio > BIG_MOVE or ratio < 1 / BIG_MOVE:'],
  ['R04-big-move-down', 'check_refresh.py', 'if ratio >= BIG_MOVE or ratio <= 1 / BIG_MOVE:', 'if ratio >= BIG_MOVE:'],
  ['R05-max-movers', 'check_refresh.py', 'MAX_BIG_MOVERS = 20', 'MAX_BIG_MOVERS = 21'],
  ['R06-median', 'check_refresh.py', 'elif not MEDIAN_RANGE[0] <= m <= MEDIAN_RANGE[1]:', 'elif False:'],
  ['R07-accept-movers', 'check_refresh.py', 'if not accept_movers and len(c["big_movers"])', 'if len(c["big_movers"])'],
  ['R08-shared', 'check_refresh.py', 'MIN_SHARED_SHARE = 0.9', 'MIN_SHARED_SHARE = 0.0'],
  ['R08b-shared-edge', 'check_refresh.py', 'c["shared"] < MIN_SHARED_SHARE * c["rows_old"]', 'c["shared"] <= MIN_SHARED_SHARE * c["rows_old"]'],
  ['R09-older-week', 'check_refresh.py', 'elif isinstance(c["as_of_old"], str) and c["as_of_new"] < c["as_of_old"]:', 'elif False:'],
  ['R09b-no-week', 'check_refresh.py', 'if not isinstance(c["as_of_new"], str) or not c["as_of_new"]:', 'if not isinstance(c["as_of_new"], str):'],
  ['R10-no-counts', 'check_refresh.py', 'if c["rejected"] is None:', 'if False:'],
  ['R11-shift-share', 'check_refresh.py', 'MAX_SHIFT_SHARE = 0.05', 'MAX_SHIFT_SHARE = 0.5'],
  ['R11b-shift-move', 'check_refresh.py', 'SHIFT_MOVE = 1.5', 'SHIFT_MOVE = 1.6'],
  ['R11c-shift-down', 'check_refresh.py', 'if ratio >= SHIFT_MOVE or ratio <= 1 / SHIFT_MOVE:', 'if ratio >= SHIFT_MOVE:'],
  ['R11d-shift-accept', 'check_refresh.py', 'if not accept_movers and c["shared"] and c["shifted"]', 'if c["shared"] and c["shifted"]'],
  ['R12-bad-values', 'check_refresh.py', 'if isinstance(ndc, str) and positive_number(v):', 'if isinstance(ndc, str) and v is not None:'],
  ['R12b-positive', 'check_refresh.py', 'math.isfinite(v) and v > 0', 'math.isfinite(v)'],
  ['R12c-finite', 'check_refresh.py', 'math.isfinite(v) and v > 0', 'v > 0'],
  ['R12d-bool', 'check_refresh.py', 'and not isinstance(v, bool) and', 'and'],
  ['R12e-old-file', 'check_refresh.py', 'for which, bad in (("new", c["bad_new"]), ("previous", c["bad_old"])):', 'for which, bad in (("new", c["bad_new"]),):'],
  // tools/reverify_spotchecks.py
  ['S01-disagree', 'reverify_spotchecks.py', 'if mine is None or not same(got["value"], mine):', 'if False:'],
  ['S02-writes-on-disagree', 'reverify_spotchecks.py', 'if r["disagree"]:\n        print(f"{len(r[\'disagree\'])} spot checks disagree', 'if False:\n        print(f"{len(r[\'disagree\'])} spot checks disagree'],
  ['S03-dry-run', 'reverify_spotchecks.py', 'write = not args.dry_run and bool(r["done"])', 'write = bool(r["done"])'],
  ['S04-api-failure', 'reverify_spotchecks.py', 'except (FetchError, *cachelib.NETWORK_ERRORS) as e:', 'except ZeroDivisionError as e:'],
  ['S07-any-manufacturer', 'reverify_spotchecks.py', 'if r["Mftr_Name"] == "Overall":', 'if True:'],
  ['S06-no-second-ask', 'reverify_spotchecks.py', 'API_TRIES = 3', 'API_TRIES = 1'],
  ['S05-as-of-condition', 'reverify_spotchecks.py', '&conditions[1][property]=as_of_date&conditions[1][value]={self.as_of}', ''],
  ['S08-newest-result', 'reverify_spotchecks.py', 'i = max(range(len(results)), key=lambda k: str(results[k].get("effective_date") or ""))', 'i = 0'],
  ['S09-names-its-result', 'reverify_spotchecks.py', '-> results[{i}]:', '-> results[0]:'],
  ['S10-same-number', 'reverify_spotchecks.py', 'return Decimal(str(api).strip()) == Decimal(str(value))', 'return str(api).strip() == str(value)'],
  ['S11-next-page', 'reverify_spotchecks.py', 'if len(page) < PARTD_PAGE:\n                    break', 'break'],
  ['S12-page-limit', 'reverify_spotchecks.py', 'PARTD_MAX_PAGES = 20', 'PARTD_MAX_PAGES = 1'],
  ['S13-busy-only', 'reverify_spotchecks.py', 'if not tries_left or not re.match(r"HTTP (503|504) ", str(e)):', 'if not tries_left:'],
  ['S14-nadac-asks-again', 'reverify_spotchecks.py', 'results = read_api(url)["results"]', 'results = cachelib.get_json(url, timeout=120)["results"]'],
  ['S15-api-distribution', 'reverify_spotchecks.py', 'if m and str(d.get("format", "")).upper() == "API" and self.period_end in ends:', 'if m and self.period_end in ends:'],
  ['S16-part-b-source', 'reverify_spotchecks.py', 'if e["where"] == "part_b_codes":\n        return "asp_limits"', 'if False:\n        return "asp_limits"'],
  ['S17-not-in-data', 'reverify_spotchecks.py', 'if mine is None or not same(got["value"], mine):', 'if mine is not None and not same(got["value"], mine):'],
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
