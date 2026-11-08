#!/usr/bin/env python3
"""Re-verify tests/spotchecks.json against the government datastore APIs after a data refresh.

The spot checks tie a shown value to its government source, by a path that does not go through
OpenBill's parsers (docs/DECISIONS.md, decisions 12 and 55). After a refresh, entries pinned to an
old file stop applying. For each of those this tool reads the value from the publisher's API, a
different route from the CSV the pipeline parsed, and compares it with what data/drugs.json holds:

  nadac           data.medicaid.gov datastore, by NDC and the data's as-of date
  partd           data.cms.gov data API, every page, the row of that brand, generic and Mftr_Name "Overall"

If every value agrees, each entry is rewritten: its value, source file, how it was verified, and
today's date. If any value disagrees, nothing is written and it exits 1: the pipeline and the
government's own API differ, so the refresh stops. An entry whose NDC or name has left the source
is left as it is, pinned to its old file, so it no longer counts.

The Part B entries (asp_limits, asp_crosswalk) and the Part D join entries have no API. They are
listed for a person to check against the new files (docs/HAND-CHECK.md), and the per-source floor
in tests/spotchecks.test.js fails until enough of them apply.

Exit codes: 0 done; 1 a value disagrees; 2 an API could not be read (nothing is written).

Usage:
  python tools/reverify_spotchecks.py [--dry-run] [--all] [--data FILE] [--checks FILE]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
from collections import Counter
from decimal import Decimal, InvalidOperation
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cachelib  # noqa: E402
from cachelib import FetchError  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "drugs.json"
CHECKS = ROOT / "tests" / "spotchecks.json"

NADAC_API = "https://data.medicaid.gov/api/1/datastore/query"
CMS_API = "https://data.cms.gov/data-api/v1/dataset"
CMS_CATALOG = "https://data.cms.gov/data.json"
PARTD_TITLE_PREFIX = "Medicare Part D Spending by Drug"

# Either API can say it is busy. Ask again before giving up.
API_TRIES = 3
API_WAIT_SECONDS = 30
# data.cms.gov's largest page. Its filters are not used: on 2026-11-06 a filter took most of a minute
# or answered 503 on every try, while all 14,536 rows came in three pages in under a second each.
PARTD_PAGE = 5000
PARTD_MAX_PAGES = 20

# Entry path -> the API's field for it.
NADAC_FIELDS = {"nadac.value": "nadac_per_unit", "nadac.effective_date": "effective_date", "nadac.per": "pricing_unit"}
PARTD_FIELDS = {"avg_per_unit.value": "Avg_Spnd_Per_Dsg_Unt_Wghtd_{y}", "claims.value": "Tot_Clms_{y}"}


def read_api(url: str, timeout: int = 120):
    """The API's JSON, asking again when the server says it is busy. Anything else raises at once.
    Every read goes through here: NADAC's datastore, the CMS catalog and Part D's pages."""
    for tries_left in range(API_TRIES - 1, -1, -1):
        try:
            return cachelib.get_json(url, timeout=timeout)
        except FetchError as e:
            if not tries_left or not re.match(r"HTTP (503|504) ", str(e)):
                raise
            print(f"{e}; asking again in {API_WAIT_SECONDS} s", file=sys.stderr)
            time.sleep(API_WAIT_SECONDS)


def source_of(e: dict) -> str:
    """Which source in data/drugs.json an entry's fact comes from."""
    if e["where"] == "part_d_names" or e["path"].startswith("part_d."):
        return "partd"
    if e["where"] == "part_b_codes":
        return "asp_limits"
    if e["path"].startswith("part_b."):
        return "asp_crosswalk"
    return "nadac"


def pipeline_value(doc: dict, rows: dict, e: dict):
    """The value data/drugs.json holds at the entry's path, or None if it is not there."""
    node = rows.get(e["ndc"]) if e["where"] == "row" else (doc.get(e["where"]) or {}).get(e["key"])
    for p in e["path"].split("."):
        if not isinstance(node, dict) or p not in node:
            return None
        node = node[p]
    return node


def same(api, value) -> bool:
    """An API value (always text or a number) against a JSON value: as decimals when numeric."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return Decimal(str(api).strip()) == Decimal(str(value))
        except InvalidOperation:
            return False
    return str(api).strip() == str(value)


class Nadac:
    """data.medicaid.gov's datastore, for the dataset and week data/drugs.json was built from."""

    def __init__(self, source: dict):
        self.dataset = source["source_url"].rstrip("/").rsplit("/", 1)[-1]
        self.as_of = source["as_of_date"]
        self.file = source["source_file"]
        self.title = source.get("title") or "NADAC"

    def url(self, ndc: str) -> str:
        return (f"{NADAC_API}/{self.dataset}/0?conditions[0][property]=ndc&conditions[0][value]={ndc}"
                f"&conditions[1][property]=as_of_date&conditions[1][value]={self.as_of}&limit=5")

    def read(self, e: dict) -> dict | None:
        """{value, via, note} for an entry, or None if the NDC is not in that week."""
        url = self.url(e["ndc"])
        results = read_api(url)["results"]
        if not results:
            return None
        # The pipeline keeps the newest effective date when an NDC repeats in a week; so does this, and
        # the recipe names the result it took, so a reader looks at the same one.
        i = max(range(len(results)), key=lambda k: str(results[k].get("effective_date") or ""))
        r = results[i]
        field = NADAC_FIELDS[e["path"]]
        return {
            "value": r[field],
            "via": f'curl -g "{url}" -> results[{i}]: ndc_description "{r["ndc_description"]}", nadac_per_unit "{r["nadac_per_unit"]}", '
                   f'pricing_unit "{r["pricing_unit"]}", effective_date "{r["effective_date"]}", explanation_code "{r["explanation_code"]}", as_of_date "{r["as_of_date"]}"',
            "note": f'{r["ndc_description"]}. Read from the data.medicaid.gov datastore API for dataset {self.dataset} ({self.title}), As of Date {self.as_of}, the week {self.file} is built from.',
        }


class PartD:
    """data.cms.gov's data API, for the data year data/drugs.json was built from."""

    def __init__(self, source: dict):
        self.year = int(source["data_year"])
        self.period_end = (source.get("period") or "/").split("/")[1]
        self.file = source["source_file"]
        self.dataset = None
        self.table = None

    def dataset_id(self) -> str:
        """The API distribution of this data year in the CMS catalog (found once, on first use)."""
        if self.dataset is None:
            catalog = read_api(CMS_CATALOG, timeout=300)
            hits = []
            for ds in catalog.get("dataset", []):
                if not ds.get("title", "").startswith(PARTD_TITLE_PREFIX):
                    continue
                for d in ds.get("distribution", []):
                    ends = [t.get("endDate") for t in (d.get("temporal") or [])]
                    m = re.search(r"/dataset/([0-9a-f-]{36})/data$", str(d.get("accessURL") or ""))
                    if m and str(d.get("format", "")).upper() == "API" and self.period_end in ends:
                        hits.append(m.group(1))
            if not hits:
                raise FetchError(f"no API distribution of {PARTD_TITLE_PREFIX!r} for the period ending {self.period_end} in {CMS_CATALOG}")
            self.dataset = hits[0]
        return self.dataset

    def overall_rows(self) -> dict:
        """Every "Overall" row by "brand|generic", with the page it came from (read once, on first use)."""
        if self.table is None:
            table = {}
            for number in range(PARTD_MAX_PAGES):
                url = f"{CMS_API}/{self.dataset_id()}/data?size={PARTD_PAGE}&offset={number * PARTD_PAGE}"
                page = read_api(url)
                for r in page:
                    if r["Mftr_Name"] == "Overall":
                        table[f'{r["Brnd_Name"]}|{r["Gnrc_Name"]}'] = (r, url)
                if len(page) < PARTD_PAGE:
                    break
            else:
                raise FetchError(f"{CMS_API}/{self.dataset_id()}/data has more than {PARTD_MAX_PAGES} pages of {PARTD_PAGE}")
            self.table = table
        return self.table

    def read(self, e: dict) -> dict | None:
        hit = self.overall_rows().get(e["key"])
        if hit is None:
            return None
        r, url = hit
        field = PARTD_FIELDS[e["path"]].format(y=self.year)
        return {
            "value": r[field],
            "via": f'curl -g "{url}" -> row Brnd_Name "{r["Brnd_Name"]}", Gnrc_Name "{r["Gnrc_Name"]}", Mftr_Name "Overall": {field} "{r[field]}"',
            "note": f"Part D data year {self.year} ({field}), all strengths and forms under the name. Same CMS dataset as {self.file}, read through the data.cms.gov data API rather than the CSV.",
        }


def reverify(doc: dict, checks: list[dict], today: str, every: bool = False) -> dict:
    """Pure apart from the API reads. Returns {checks (rewritten), done, gone, disagree, by_hand}."""
    rows = {r["ndc"]: r for r in doc["rows"]}
    sources = doc["sources"]
    readers = {"nadac": Nadac(sources["nadac"]), "partd": PartD(sources["partd"])}
    out, done, gone, disagree, by_hand = [], [], [], [], []
    for e in checks:
        src = source_of(e)
        current = sources[src]["source_file"]
        if e["source_file"] == current and not every:
            out.append(e)
            continue
        fields = NADAC_FIELDS if src == "nadac" else PARTD_FIELDS if src == "partd" and e["where"] == "part_d_names" else None
        if fields is None or e["path"] not in fields:
            by_hand.append(e["id"])
            out.append(e)
            continue
        got = readers[src].read(e)
        if got is None:
            gone.append(e["id"])
            out.append(e)
            continue
        mine = pipeline_value(doc, rows, e)
        if mine is None or not same(got["value"], mine):
            disagree.append({"id": e["id"], "api": got["value"], "data": mine, "via": got["via"]})
            out.append(e)
            continue
        done.append(e["id"])
        out.append({**e, "value": mine, "source_file": current, "verified_via": got["via"], "verified_on": today, "note": got["note"]})
    return {"checks": out, "done": done, "gone": gone, "disagree": disagree, "by_hand": by_hand}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data", type=Path, default=DATA)
    ap.add_argument("--checks", type=Path, default=CHECKS)
    ap.add_argument("--dry-run", action="store_true", help="read and compare, but write nothing")
    ap.add_argument("--all", action="store_true", help="also re-read entries already pinned to the current files")
    args = ap.parse_args(argv)
    doc = json.loads(args.data.read_text(encoding="utf-8"))
    checks = json.loads(args.checks.read_text(encoding="utf-8"))
    today = cachelib.utc_now().date().isoformat()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    try:
        r = reverify(doc, checks, today, args.all)
    except (FetchError, *cachelib.NETWORK_ERRORS) as e:
        print(f"FAILED: an API could not be read, so nothing was written: {e}", file=sys.stderr)
        return 2
    except cachelib.SHAPE_ERRORS as e:
        print(f"FAILED: an API answered in an unexpected shape ({type(e).__name__}: {e}), so nothing was written", file=sys.stderr)
        return 2
    for d in r["disagree"]:
        print(f"DISAGREES {d['id']}: the API says {d['api']!r}, data/drugs.json has {d['data']!r}\n  {d['via']}", file=sys.stderr)
    if r["disagree"]:
        print(f"{len(r['disagree'])} spot checks disagree with the government API. Nothing was written. Do not merge this refresh.", file=sys.stderr)
        return 1
    write = not args.dry_run and bool(r["done"])
    print(f"Agreed with the API{' and rewritten' if write else ''}: {len(r['done'])}")
    for label, ids in (("No longer in the source, left pinned to the old file", r["gone"]),
                       ("No API, for a person (docs/HAND-CHECK.md)", r["by_hand"])):
        if ids:
            print(f"{label}: {len(ids)}\n  " + "\n  ".join(ids))
    current = {s["source_file"]: sid for sid, s in doc["sources"].items()}
    counts = Counter(current[e["source_file"]] for e in r["checks"] if e["source_file"] in current)
    print("Entries pinned to the current files, per source: " + ", ".join(f"{k} {counts.get(k, 0)}" for k in doc["sources"]))
    if write:
        args.checks.write_text(json.dumps(r["checks"], indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        print(f"Wrote {args.checks}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
