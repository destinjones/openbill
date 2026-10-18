#!/usr/bin/env python3
"""Fetch the current NADAC file into tools/cache/.

NADAC (National Average Drug Acquisition Cost) is CMS's weekly survey of what retail
pharmacies pay for drugs. data.medicaid.gov publishes one dataset per calendar year; its CSV
is cumulative, every weekly file of the year stacked, told apart by the "As of Date" column.

What this does:
  1. Finds the newest "NADAC (National Average Drug Acquisition Cost) <year>" dataset
     through the data.medicaid.gov DKAN API and reads its CSV download URL.
  2. Downloads it only if it changed (new URL, or a different ETag / Last-Modified).
  3. Records sha256, size, ETag and retrieved date in tools/cache/manifest.json (key "nadac"),
     and verifies the cached file against that hash on every run.
  4. Checks the header is the schema we parse, then prints the row count and the file's
     effective (as-of) date.

With no network it verifies and reports on the cached copy instead. Standard library only.

Usage:
  python tools/fetch_nadac.py            # fetch if changed, then report
  python tools/fetch_nadac.py --offline  # never touch the network
  python tools/fetch_nadac.py --force    # re-download even if unchanged
"""

from __future__ import annotations

import csv
import datetime as dt
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cachelib  # noqa: E402
from cachelib import FetchError  # noqa: E402

KEY = "nadac"

API = "https://data.medicaid.gov/api/1"
LANDING = "https://data.medicaid.gov/dataset/{id}"
TITLE_RE = re.compile(r"^NADAC \(National Average Drug Acquisition Cost\) (\d{4})$")

# The columns build_drugs.py parses. If CMS changes the file, stop rather than guess.
EXPECTED_COLUMNS = [
    "NDC Description",
    "NDC",
    "NADAC Per Unit",
    "Effective Date",
    "Pricing Unit",
    "Pharmacy Type Indicator",
    "OTC",
    "Explanation Code",
    "Classification for Rate Setting",
    "Corresponding Generic Drug NADAC Per Unit",
    "Corresponding Generic Drug Effective Date",
    "As of Date",
]


def us_date_to_iso(s: str) -> str:
    return dt.datetime.strptime(s.strip(), "%m/%d/%Y").date().isoformat()


def find_current_dataset() -> dict:
    """Newest-year NADAC dataset and its CSV distribution, from the DKAN API."""
    found = cachelib.get_json(f"{API}/search?fulltext=NADAC%20National%20Average%20Drug%20Acquisition%20Cost&page-size=100")
    results = found["results"]
    candidates = []
    for item in results.values() if isinstance(results, dict) else results:
        m = TITLE_RE.match(item.get("title", "").strip())
        if m:
            candidates.append((int(m.group(1)), item["identifier"]))
    if not candidates:
        raise FetchError("no 'NADAC (National Average Drug Acquisition Cost) <year>' dataset found")
    year, ident = max(candidates)

    ds = cachelib.get_json(f"{API}/metastore/schemas/dataset/items/{ident}?show-reference-ids=false")
    # DKAN wraps referenced objects as {"identifier": ..., "data": {...}}.
    unwrap = lambda o: o.get("data", o) if isinstance(o, dict) else {}
    dists = [unwrap(d) for d in ds.get("distribution", [])]
    csvs = [d for d in dists if str(d.get("format", "")).lower() == "csv" or str(d.get("downloadURL", "")).endswith(".csv")]
    if len(csvs) != 1:
        raise FetchError(f"expected one CSV distribution on dataset {ident}, found {len(csvs)}")
    url = csvs[0]["downloadURL"]
    return {
        "year": year,
        "dataset_id": ident,
        "title": ds["title"],
        "dataset_title": ds["title"],
        "dataset_modified": ds.get("modified"),
        "license": ds.get("license"),
        "publisher": unwrap(ds.get("publisher")).get("name") or "data.medicaid.gov",
        "landing_url": LANDING.format(id=ident),
        "download_url": url,
        "file": url.rsplit("/", 1)[-1],
        "period": None,  # weekly reference prices, not period data
    }


def summarise(path: Path) -> dict:
    """Validate the header and count rows per weekly as-of date."""
    weeks: Counter[str] = Counter()
    eff_by_week: dict[str, list[str]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if header != EXPECTED_COLUMNS:
            raise FetchError(f"unexpected NADAC header:\n  got      {header}\n  expected {EXPECTED_COLUMNS}")
        ia, ie = header.index("As of Date"), header.index("Effective Date")
        for row in reader:
            if not row:
                continue
            week = us_date_to_iso(row[ia])
            weeks[week] += 1
            eff = us_date_to_iso(row[ie])
            lo_hi = eff_by_week.setdefault(week, [eff, eff])
            lo_hi[0], lo_hi[1] = min(lo_hi[0], eff), max(lo_hi[1], eff)
    if not weeks:
        raise FetchError(f"{path.name} has a header but no rows")
    latest = max(weeks)
    return {
        "rows_total": sum(weeks.values()),
        "weeks": len(weeks),
        "first_as_of": min(weeks),
        "as_of_date": latest,
        "rows_latest_week": weeks[latest],
        "effective_range_latest_week": eff_by_week[latest],
    }


def main(argv: list[str] | None = None) -> int:
    args = cachelib.arg_parser(__doc__.split("\n\n")[0]).parse_args(argv)
    entry, happened, code = cachelib.run_source(KEY, "NADAC", find_current_dataset, args.offline, args.force)
    if code:
        return code
    path = cachelib.cached_path(entry)

    try:
        s = summarise(path)
    except FetchError as e:
        print(f"FAILED: {e}", file=sys.stderr)
        return 4
    if not args.offline and entry.get("as_of_date") != s["as_of_date"]:
        entry = cachelib.update_entry(KEY, as_of_date=s["as_of_date"], weeks_in_file=s["weeks"])

    lo, hi = s["effective_range_latest_week"]
    print(f"""
NADAC  {entry.get('title') or entry.get('dataset_title')}
  status          {happened}
  file            {entry['file']}  ({entry['bytes'] / 1e6:,.1f} MB)
  sha256          {entry['sha256']}  (verified)
  source          {entry['landing_url']}
  retrieved       {entry['retrieved_date']}
  rows in file    {s['rows_total']:,}  across {s['weeks']} weekly files ({s['first_as_of']} .. {s['as_of_date']})
  effective date  {s['as_of_date']}  (As of Date of the newest weekly file)
  current rows    {s['rows_latest_week']:,}  in the {s['as_of_date']} file; per-NDC effective dates {lo} .. {hi}
""".rstrip())
    if entry.get("as_of_date") != s["as_of_date"]:
        print(f"WARNING: manifest as_of_date {entry.get('as_of_date')} differs from the file ({s['as_of_date']}); run online to record it.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
