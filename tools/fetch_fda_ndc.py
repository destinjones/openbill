#!/usr/bin/env python3
"""Fetch the FDA NDC Directory into tools/cache/.

The NDC Directory is FDA's list of every finished drug product labelers have listed, keyed by
National Drug Code. OpenBill uses it as the identity of each NADAC row (exact NDC join):
proprietary and nonproprietary names, dosage form, route, strength, labeler, package.

File: https://www.accessdata.fda.gov/cder/ndctext.zip (product.txt + package.txt), linked
from the directory's landing page and refreshed daily. Manifest key "fda_ndc".

Not used: FDA's excluded-products file (ndc_excluded.zip, listings FDA removed from the
directory). Measured on 2026-10-17 against the 30,031 NADAC rows of 2026-10-14 it would raise
the exact NDC match from 27,086 (90.2%) to 27,969 (93.1%), but its product records carry only
the proprietary name, labeler and marketing category: nonproprietary name, dosage form, route
and strength are blank. Not material enough for identities that partial. See
docs/DATA_SOURCES.md.

The members are tab-delimited Windows-1252 text with CRLF line ends (verified: product.txt is not
valid UTF-8; cp1252 decodes every byte). Zip members are read in memory, never extracted.

Usage:
  python tools/fetch_fda_ndc.py [--offline] [--force]
"""

from __future__ import annotations

import sys
import zipfile
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cachelib  # noqa: E402
from cachelib import FetchError  # noqa: E402

LANDING = "https://www.fda.gov/drugs/drug-approvals-and-databases/national-drug-code-directory"
PUBLISHER = "U.S. Food and Drug Administration (FDA), Center for Drug Evaluation and Research"
# FDA website policies: contents are public domain unless otherwise noted.
LICENSE = "https://www.fda.gov/about-fda/about-website/website-policies"
ENCODING = "cp1252"

PRODUCT_COLUMNS = [
    "PRODUCTID", "PRODUCTNDC", "PRODUCTTYPENAME", "PROPRIETARYNAME", "PROPRIETARYNAMESUFFIX",
    "NONPROPRIETARYNAME", "DOSAGEFORMNAME", "ROUTENAME", "STARTMARKETINGDATE", "ENDMARKETINGDATE",
    "MARKETINGCATEGORYNAME", "APPLICATIONNUMBER", "LABELERNAME", "SUBSTANCENAME",
    "ACTIVE_NUMERATOR_STRENGTH", "ACTIVE_INGRED_UNIT", "PHARM_CLASSES", "DEASCHEDULE",
    "NDC_EXCLUDE_FLAG", "LISTING_RECORD_CERTIFIED_THROUGH",
]
PACKAGE_COLUMNS = [
    "PRODUCTID", "PRODUCTNDC", "NDCPACKAGECODE", "PACKAGEDESCRIPTION", "STARTMARKETINGDATE",
    "ENDMARKETINGDATE", "NDC_EXCLUDE_FLAG", "SAMPLE_PACKAGE",
]

SOURCES = {
    "fda_ndc": {
        "label": "FDA NDC Directory",
        "title": "National Drug Code Directory (NDC database file, text version)",
        "download_url": "https://www.accessdata.fda.gov/cder/ndctext.zip",
        "file": "ndctext.zip",
        "members": ("product.txt", "package.txt"),
    },
}


def read_table(z: zipfile.ZipFile, member: str, expected: list[str]) -> list[list[str]]:
    """Rows of a tab-delimited member (header checked, not returned)."""
    text = cachelib.read_zip_member(z, member).decode(ENCODING)
    lines = text.split("\r\n")
    header = lines[0].split("\t")
    if header != expected:
        raise FetchError(f"unexpected header in {member}:\n  got      {header}\n  expected {expected}")
    rows = []
    for i, line in enumerate(lines[1:], start=2):
        if not line:
            continue
        cells = line.split("\t")
        if len(cells) != len(expected):
            raise FetchError(f"{member} line {i}: {len(cells)} fields, expected {len(expected)}")
        rows.append(cells)
    return rows


def open_tables(path: Path, members: tuple[str, str]) -> tuple[list[list[str]], list[list[str]]]:
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        missing = [m for m in members if m not in names]
        if missing:
            raise FetchError(f"{path.name} lacks {missing}; has {sorted(names)}")
        return read_table(z, members[0], PRODUCT_COLUMNS), read_table(z, members[1], PACKAGE_COLUMNS)


def resolver(key: str):
    spec = SOURCES[key]

    def resolve() -> dict:
        # Fixed URLs published on the landing page; confirm the page still links them.
        page = cachelib.get_text(LANDING)
        if spec["download_url"] not in page:
            raise FetchError(f"{LANDING} no longer links {spec['download_url']}")
        return {
            "title": spec["title"],
            "publisher": PUBLISHER,
            "license": LICENSE,
            "landing_url": LANDING,
            "download_url": spec["download_url"],
            "file": spec["file"],
            "period": None,
        }

    return resolve


def main(argv: list[str] | None = None) -> int:
    args = cachelib.arg_parser(__doc__.split("\n\n")[0]).parse_args(argv)
    worst = 0
    for key, spec in SOURCES.items():
        entry, happened, code = cachelib.run_source(key, spec["label"], resolver(key), args.offline, args.force)
        if code:
            worst = worst or code
            continue
        path = cachelib.cached_path(entry)
        try:
            products, packages = open_tables(path, spec["members"])
        except (FetchError, zipfile.BadZipFile, UnicodeDecodeError) as e:
            print(f"{spec['label']}: FAILED: {e}", file=sys.stderr)
            worst = worst or 4
            continue
        # The directory is dated by its publication: the zip's Last-Modified header.
        as_of = cachelib.http_date_to_iso(entry.get("last_modified"))
        if not args.offline and entry.get("as_of_date") != as_of:
            entry = cachelib.update_entry(key, as_of_date=as_of)
        flags = Counter(p[6] for p in packages)
        types = Counter(p[2] for p in products)
        print(f"""
{spec['label']}  {entry['title']}
  status          {happened}
  file            {entry['file']}  ({entry['bytes'] / 1e6:,.1f} MB; members {', '.join(spec['members'])}, {ENCODING}, tab-delimited)
  sha256          {entry['sha256']}  (verified)
  source          {entry['landing_url']}
  retrieved       {entry['retrieved_date']}   as of {entry.get('as_of_date')} (Last-Modified {entry.get('last_modified')})
  products        {len(products):,}   {', '.join(f'{k or "(blank)"} {v:,}' for k, v in types.most_common(4))}
  packages        {len(packages):,}   exclude flags: {', '.join(f'{k or "(none)"} {v:,}' for k, v in sorted(flags.items()))}
""".rstrip())
    return worst


if __name__ == "__main__":
    sys.exit(main())
