#!/usr/bin/env python3
"""Fetch Medicare Part D Spending by Drug (newest data year) into tools/cache/.

CMS publishes one row per brand name + generic name (and one per manufacturer under it, with an
"Overall" row aggregating manufacturers): total spending, dosage units, claims and the
claim-weighted average spending per dosage unit, for five data years side by side.

The dataset is resolved from the data.cms.gov DCAT catalog (https://data.cms.gov/data.json):
the dataset whose title starts "Medicare Part D Spending by Drug" (never the "Quarterly"
dataset, which has no per-dosage-unit figure), its newest temporal period, and that period's
single CSV distribution. The official data dictionary and methodology PDFs are found through
the dataset's resources API and recorded in the manifest (key "partd").

Fails if the catalog has a look-alike dataset (a title with both "Part D" and "spending") for a
newer period than the one chosen: CMS may have retitled the next year, and keeping the old year
quietly is the failure this catches. Warns when the chosen year is older than the page's own
stale threshold. A new file is validated before it replaces the cached one.

Usage:
  python tools/fetch_partd.py [--offline | --require-online] [--force]
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cachelib  # noqa: E402
from cachelib import FetchError  # noqa: E402

KEY = "partd"
CATALOG = "https://data.cms.gov/data.json"
TITLE_PREFIX = "Medicare Part D Spending by Drug"
YEAR_COL = re.compile(r"^Avg_Spnd_Per_Dsg_Unt_Wghtd_(\d{4})$")
ID_COLUMNS = ["Brnd_Name", "Gnrc_Name", "Tot_Mftr", "Mftr_Name"]
YEAR_COLUMNS = ["Tot_Spndng_{y}", "Tot_Dsg_Unts_{y}", "Tot_Clms_{y}", "Avg_Spnd_Per_Dsg_Unt_Wghtd_{y}", "Outlier_Flag_{y}"]
# SOURCE_INFO.partd.stale_after_days in src/core/sources.js: past this, a newer year should exist.
STALE_AFTER_DAYS = 913


def _pick_resource(resources: list[dict], word: str) -> str | None:
    hits = [r["downloadURL"] for r in resources if word in r.get("name", "").lower() and r.get("downloadURL")]
    return hits[0] if len(hits) == 1 else None


def _period_end(ds: dict) -> str:
    """The newest temporal end date anywhere on a catalog dataset ('' if none)."""
    ends = [t.get("endDate", "") for t in (ds.get("temporal") or [])]
    for d in ds.get("distribution", []):
        ends += [t.get("endDate", "") for t in (d.get("temporal") or [])]
    return max(ends, default="")


def resolve() -> dict:
    catalog = cachelib.get_json(CATALOG, timeout=300)
    found = []
    lookalikes = []
    for ds in catalog.get("dataset", []):
        title = ds.get("title", "")
        low = title.lower()
        if "quarterly" in low:
            continue
        if not title.startswith(TITLE_PREFIX):
            if "part d" in low and "spending" in low:
                lookalikes.append(ds)
            continue
        for d in ds.get("distribution", []):
            if d.get("mediaType") != "text/csv" and str(d.get("format", "")).upper() != "CSV":
                continue
            t = (d.get("temporal") or ds.get("temporal") or [{}])[0]
            found.append((t.get("endDate", ""), t.get("startDate", ""), ds, d))
    if not found:
        raise FetchError(f"no CSV distribution of a '{TITLE_PREFIX}' dataset in {CATALOG}")
    newest = max(f[0] for f in found)
    pick = [f for f in found if f[0] == newest]
    if len(pick) != 1:
        raise FetchError(f"expected one CSV for the period ending {newest}, found {len(pick)}")
    end, start, ds, dist = pick[0]
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", start or "") or not re.match(r"^\d{4}-\d{2}-\d{2}$", end or ""):
        raise FetchError(f"unparseable temporal period {start!r}..{end!r}")
    newer = [ds.get("title") for ds in lookalikes if _period_end(ds) > end]
    if newer:
        raise FetchError(f"the newest '{TITLE_PREFIX}' period ends {end}, but the catalog has a newer dataset with a different title: {newer}. "
                         "CMS may have retitled it; check it and update TITLE_PREFIX if so")
    age = (cachelib.utc_now().date() - dt.date.fromisoformat(end)).days
    if age > STALE_AFTER_DAYS:
        print(f"WARNING: the newest '{TITLE_PREFIX}' period ended {end}, {age} days ago; a newer data year should exist.", file=sys.stderr)

    landing = (ds.get("landingPage") or {}).get("accessURL")
    resources = []
    for d in ds.get("distribution", []):  # the series' "latest" API distribution lists the PDFs
        if d.get("resourcesAPI") and d.get("description") == "latest":
            resources = cachelib.get_json(d["resourcesAPI"]).get("data", [])
            break
    url = dist["downloadURL"]
    return {
        "title": f"{TITLE_PREFIX}, data year {start[:4]}",
        "catalog_title": ds.get("title"),
        "publisher": "Centers for Medicare & Medicaid Services (CMS), "
        + ((ds.get("publisher") or {}).get("name") or "data.cms.gov"),
        "license": dist.get("license") or ds.get("license"),
        "landing_url": landing,
        "download_url": url,
        "file": url.rsplit("/", 1)[-1],
        "period": f"{start}/{end}",
        "data_year": int(start[:4]),
        "as_of_date": dist.get("modified") or ds.get("modified"),
        "catalog_url": CATALOG,
        "dataset_id": ds.get("identifier"),
        "description_from_catalog": ds.get("description"),
        "data_dictionary_url": _pick_resource(resources, "dictionary"),
        "methodology_url": _pick_resource(resources, "methodology"),
    }


def summarise(path: Path, year: int) -> dict:
    text = path.read_bytes().decode("utf-8-sig")
    reader = csv.reader(io.StringIO(text, newline=""))
    header = next(reader, None) or []
    need = ID_COLUMNS + [c.format(y=year) for c in YEAR_COLUMNS]
    missing = [c for c in need if c not in header]
    if missing:
        raise FetchError(f"{path.name} lacks columns {missing}")
    years = sorted(int(m.group(1)) for c in header if (m := YEAR_COL.match(c)))
    if max(years) != year:
        raise FetchError(f"newest year column is {max(years)}, catalog period says {year}")
    ix = {c: header.index(c) for c in need}
    rows = [r for r in reader if r]
    overall = [r for r in rows if r[ix["Mftr_Name"]] == "Overall"]
    outlier = Counter(r[ix[f"Outlier_Flag_{year}"]] for r in overall)
    blank_avg = sum(1 for r in overall if not r[ix[f"Avg_Spnd_Per_Dsg_Unt_Wghtd_{year}"]].strip())
    keys = Counter((r[ix["Brnd_Name"]], r[ix["Gnrc_Name"]]) for r in overall)
    return {
        "rows": len(rows), "overall": len(overall), "years": years, "outlier": outlier,
        "blank_avg": blank_avg, "dup_keys": sum(1 for v in keys.values() if v > 1),
    }


def main(argv: list[str] | None = None) -> int:
    args = cachelib.arg_parser(__doc__.split("\n\n")[0]).parse_args(argv)
    validate = lambda part, meta: summarise(part, meta["data_year"])
    entry, happened, code = cachelib.run_source(KEY, "Part D", resolve, args.offline, args.force, validate)
    if code:
        return code
    try:
        s = summarise(cachelib.cached_path(entry), entry["data_year"])
    except (FetchError, UnicodeDecodeError) as e:
        print(f"Part D: FAILED: {e}", file=sys.stderr)
        return 4
    o = s["outlier"]
    print(f"""
Part D  {entry['title']}
  status          {happened}
  file            {entry['file']}  ({entry['bytes'] / 1e6:,.1f} MB)
  sha256          {entry['sha256']}  (verified)
  source          {entry['landing_url']}
  retrieved       {entry['retrieved_date']}   catalog modified {entry['as_of_date']}
  period          {entry['period']}  (columns for {s['years'][0]}..{s['years'][-1]}; using {entry['data_year']})
  rows            {s['rows']:,}  ({s['overall']:,} "Overall" brand+generic rows; {s['dup_keys']} duplicate brand+generic keys)
  {entry['data_year']} figures    {s['overall'] - s['blank_avg']:,} Overall rows with an average per dosage unit; outlier flag 1: {o.get('1', 0):,}, 0: {o.get('0', 0):,}, blank: {o.get('', 0):,}
  dictionary      {entry.get('data_dictionary_url')}
  methodology     {entry.get('methodology_url')}
""".rstrip())
    return cachelib.finish(0, args)


if __name__ == "__main__":
    sys.exit(main())
