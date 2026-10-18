#!/usr/bin/env python3
"""Fetch the current quarter's Medicare Part B drug payment files into tools/cache/.

CMS posts two zips per quarter on https://www.cms.gov/medicare/payment/part-b-drugs/asp-pricing-files:
  asp_limits      "<Month> <Year> Medicare Part B Payment Limit Files" (called "ASP Pricing File"
                  before 2026): the payment allowance limit per HCPCS code dosage, with the
                  coinsurance percentage, for the quarter.
  asp_crosswalk   "<Month> <Year> NDC-HCPCS Crosswalk" (before 2026 "ASP NDC-HCPCS Crosswalk"):
                  which NDCs bill under which HCPCS code, with package size, package quantity
                  and billable units.

Both namings are matched; the newest quarter is chosen by parsing month and year from the link
text, and both zips must be present for it. Members are read in memory (zipfile), never
extracted; the Section 508 CSV versions are parsed (Windows-1252: they contain 0xA0 no-break
spaces and are not valid UTF-8).

Usage:
  python tools/fetch_asp.py [--offline] [--force]
"""

from __future__ import annotations

import calendar
import csv
import datetime as dt
import html
import io
import re
import sys
import urllib.parse
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cachelib  # noqa: E402
from cachelib import FetchError  # noqa: E402

PAGE = "https://www.cms.gov/medicare/payment/part-b-drugs/asp-pricing-files"
PUBLISHER = "Centers for Medicare & Medicaid Services (CMS)"
# US government work; CPT codes inside (e.g. vaccine codes 90xxx) remain AMA copyright: see
# docs/DATA_SOURCES.md. No dataset-specific licence is published for these files.
LICENSE = "https://www.usa.gov/government-copyright"
ENCODING = "cp1252"
QUARTER_MONTHS = {"january": 1, "april": 4, "july": 7, "october": 10}

# Links are found by a linear scan (iter_zip_links), not one regular expression over the page:
# the old pattern backtracked super-linearly on a page with many "<a" and no "</a>" (review PY-3).
OPEN_A_RE = re.compile(r"<a(?![A-Za-z0-9_])", re.I)
CLOSE_A_RE = re.compile(r"</a>", re.I)
HREF_ZIP_RE = re.compile(r'(?<![A-Za-z0-9_])href="([^"]+\.zip)"', re.I)
AFTER_CHARS = 160
PAGE_LIMIT = 8 << 20  # the real page is about 0.2 MB
LIMITS_RE = re.compile(r"^(january|april|july|october)\s+(\d{4})\s+(?:medicare part b payment limit files?|asp pricing file)\b", re.I)
XWALK_RE = re.compile(r"^(january|april|july|october)\s+(\d{4})\s+(?:asp\s+)?ndc-hcpcs crosswalks?\b", re.I)
POSTED_RE = re.compile(r"(\d{2})/(\d{2})/(\d{4})")
NEXT_LINK_RE = re.compile(r"<a\b", re.I)  # the posted date sits between a link and the next one
EFFECTIVE_RE = re.compile(r"effective\s+(\w+)\s+(\d{1,2}),\s+(\d{4})\s+through\s+(\w+)\s+(\d{1,2}),\s+(\d{4})", re.I)

LIMIT_COLUMNS = ["HCPCS Code", "Short Description", "HCPCS Code Dosage", "Payment Limit", "Co-insurance Percentage"]
XWALK_COLUMNS = ["Short Description", "LABELER NAME", "NDC", "Drug Name", "HCPCS dosage", "PKG SIZE", "PKG QTY", "BILLUNITS", "BILLUNITSPKG"]


def _text(fragment: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", fragment)).replace("\xa0", " ").split())


def iter_zip_links(page: str):
    """(href, inner html, the next 160 characters) for each <a ... href="....zip" ...>...</a>.

    One forward pass: each "<a" tag start, its first ">", the href in that tag and the first
    "</a>" after it are each found once, so the work is linear in the page. With no ">" or no
    "</a>" left, no later link can be complete, so the scan stops.
    """
    pos = 0
    while True:
        m = OPEN_A_RE.search(page, pos)
        if not m:
            return
        gt = page.find(">", m.end())
        if gt < 0:
            return
        h = HREF_ZIP_RE.search(page, m.end(), gt)
        if not h:
            pos = gt + 1
            continue
        c = CLOSE_A_RE.search(page, gt + 1)
        if not c:
            return
        yield h.group(1), page[gt + 1:c.start()], page[c.end():c.end() + AFTER_CHARS]
        pos = c.end()


def quarter_period(year: int, month: int) -> str:
    end_month = month + 2
    last = calendar.monthrange(year, end_month)[1]
    return f"{year:04d}-{month:02d}-01/{year:04d}-{end_month:02d}-{last:02d}"


def find_quarter() -> dict:
    """Newest quarter with both zips, from the ASP pricing files page."""
    page = cachelib.get_text(PAGE, limit=PAGE_LIMIT)
    found: dict[tuple[int, int], dict] = {}
    for href, inner, after in iter_zip_links(page):
        text = _text(inner)
        for kind, rx in (("limits", LIMITS_RE), ("crosswalk", XWALK_RE)):
            m = rx.match(text)
            if not m:
                continue
            q = (int(m.group(2)), QUARTER_MONTHS[m.group(1).lower()])
            posted = POSTED_RE.search(_text(NEXT_LINK_RE.split(after)[0]))
            found.setdefault(q, {})[kind] = {
                "url": urllib.parse.urljoin(PAGE, html.unescape(href)),
                "link_text": text,
                "posted": f"{posted.group(3)}-{posted.group(1)}-{posted.group(2)}" if posted else None,
            }
    complete = [q for q, v in found.items() if "limits" in v and "crosswalk" in v]
    if not complete:
        raise FetchError(f"no quarter on {PAGE} has both a payment limit zip and an NDC-HCPCS crosswalk zip")
    q = max(complete)
    return {"quarter": q, **found[q]}


def meta_for(kind: str, q: dict) -> dict:
    year, month = q["quarter"]
    link = q[kind]
    url = link["url"]
    parts = urllib.parse.urlparse(url)
    # The link itself must name a .zip file, not hide ".zip" in a query or a #fragment
    # ("…/manifest.json#.zip" would otherwise pass the link pattern; review PY-1).
    if parts.query or parts.fragment or not parts.path.lower().endswith(".zip"):
        raise FetchError(f"{kind} link {url!r} does not point at a .zip file")
    name = urllib.parse.unquote(url.rsplit("/", 1)[-1])
    if not re.match(r"^[a-z]+-\d{4}-[\w.-]+\.zip$", name, re.I | re.A):
        # Some older links put dates with slashes in the path; keep a safe, unique name.
        tail = urllib.parse.unquote(parts.path).split("/files/zip/")[-1]
        name = re.sub(r"[^A-Za-z0-9._-]+", "-", tail).lstrip(".-_")
    cachelib.safe_cache_name(f"asp_{kind}", name)
    return {
        "title": link["link_text"],
        "publisher": PUBLISHER,
        "license": LICENSE,
        "landing_url": PAGE,
        "download_url": url,
        "file": name,
        "period": quarter_period(year, month),
        "quarter": f"{year}-{month:02d}",
        "posted_date": link["posted"],
    }


def pick_member(names: list[str], kind: str) -> str:
    csvs = [n for n in names if n.lower().endswith(".csv")]
    if kind == "limits":
        hits = [n for n in csvs if re.search(r"payment limit file|asp pricing file", n, re.I) and not re.search(r"not payable|noc", n, re.I)]
    else:
        hits = [n for n in csvs if re.search(r"ndc-hcpcs crosswalk", n, re.I) and not re.search(r"awp|opps|prep|introduction|vaccine", n, re.I)]
    if len(hits) != 1:
        raise FetchError(f"expected one {kind} CSV member, found {hits} among {names}")
    return hits[0]


def read_member(path: Path, kind: str) -> tuple[str, list[str], list[list[str]], list[list[str]]]:
    """(member name, header, data rows, preamble rows) of the CSV inside a cached zip."""
    with zipfile.ZipFile(path) as z:
        member = pick_member(z.namelist(), kind)
        text = cachelib.read_zip_member(z, member).decode(ENCODING)
    rows = list(csv.reader(io.StringIO(text, newline="")))
    want = LIMIT_COLUMNS if kind == "limits" else XWALK_COLUMNS
    for i, r in enumerate(rows):
        cells = [c.strip() for c in r]
        if all(w in cells for w in want):
            data = [x for x in rows[i + 1:] if any(c.strip() for c in x)]
            return member, cells, data, rows[:i]
    raise FetchError(f"{member}: no header row with {want}")


def effective_period(preamble: list[list[str]]) -> str | None:
    for r in preamble:
        m = EFFECTIVE_RE.search(" ".join(r))
        if m:
            try:
                a = dt.datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)}", "%B %d %Y").date()
                b = dt.datetime.strptime(f"{m.group(4)} {m.group(5)} {m.group(6)}", "%B %d %Y").date()
            except ValueError:
                return None
            return f"{a.isoformat()}/{b.isoformat()}"
    return None


def main(argv: list[str] | None = None) -> int:
    args = cachelib.arg_parser(__doc__.split("\n\n")[0]).parse_args(argv)
    quarter: dict | None = None

    def resolver(kind: str):
        def resolve() -> dict:
            nonlocal quarter
            if quarter is None:
                quarter = find_quarter()
            return meta_for(kind, quarter)
        return resolve

    worst = 0
    for key, kind, label in (("asp_limits", "limits", "Part B payment limits"), ("asp_crosswalk", "crosswalk", "Part B NDC-HCPCS crosswalk")):
        entry, happened, code = cachelib.run_source(key, label, resolver(kind), args.offline, args.force)
        if code:
            worst = worst or code
            continue
        try:
            member, header, data, preamble = read_member(cachelib.cached_path(entry), kind)
        except (FetchError, zipfile.BadZipFile, UnicodeDecodeError) as e:
            print(f"{label}: FAILED: {e}", file=sys.stderr)
            worst = worst or 4
            continue
        eff = effective_period(preamble)
        if eff and eff != entry["period"]:
            print(f"{label}: FAILED: file says effective {eff}, link text says quarter {entry['period']}", file=sys.stderr)
            worst = worst or 4
            continue
        as_of = entry.get("posted_date") or cachelib.http_date_to_iso(entry.get("last_modified"))
        if not args.offline and (entry.get("member") != member or entry.get("as_of_date") != as_of or entry.get("effective_in_file") != eff):
            entry = cachelib.update_entry(key, member=member, as_of_date=as_of, effective_in_file=eff)
        extra = ""
        if kind == "limits":
            codes = {r[header.index("HCPCS Code")].strip() for r in data}
            extra = f"{len(codes):,} HCPCS codes"
        else:
            ndcs = {r[header.index("NDC")].strip() for r in data}
            extra = f"{len(ndcs):,} distinct NDC / alternate IDs; first column {header[0]!r}"
        print(f"""
{label}  {entry['title']}
  status          {happened}
  file            {entry['file']}  ({entry['bytes'] / 1e6:,.2f} MB)
  member          {member}
  sha256          {entry['sha256']}  (verified)
  source          {entry['landing_url']}
  retrieved       {entry['retrieved_date']}   posted {entry.get('posted_date')} (Last-Modified {entry.get('last_modified')})
  period          {entry['period']}  (file header: {eff or 'not stated'})
  rows            {len(data):,}  ({extra})
""".rstrip())
    return worst


if __name__ == "__main__":
    sys.exit(main())
