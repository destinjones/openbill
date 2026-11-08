"""Drives tools/fetch_*.py, tools/build_drugs.py, tools/check_refresh.py and
tools/reverify_spotchecks.py over the tiny files beside it, with a temporary cache and a stubbed
network: nothing is downloaded and tools/cache/ is never touched. It prints one JSON object of
what happened; tests/pipeline.test.js holds the expectations.

Usage: python -I tests/fixtures/pipeline/harness.py <tools dir> <fixtures dir>
"""

import contextlib
import copy
import csv
import datetime as dt
import email.message
import hashlib
import io
import json
import shutil
import sys
import tempfile
import urllib.error
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True
TOOLS, FIX = Path(sys.argv[1]), Path(sys.argv[2])
sys.path.insert(0, str(TOOLS))

import build_drugs  # noqa: E402
import cachelib  # noqa: E402
import check_refresh  # noqa: E402
import fetch_all  # noqa: E402
import fetch_asp  # noqa: E402
import fetch_fda_ndc  # noqa: E402
import fetch_nadac  # noqa: E402
import fetch_partd  # noqa: E402
import reverify_spotchecks  # noqa: E402
from cachelib import FetchError  # noqa: E402

WORK = Path(tempfile.mkdtemp(prefix="openbill-pipeline-"))
out = {}


# ---------------------------------------------------------------- a temporary cache and network

class Resp:
    def __init__(self, data, headers=None, length="auto"):
        self.headers = email.message.Message()
        for k, v in (headers or {}).items():
            self.headers[k] = v
        if length == "auto":
            self.headers["Content-Length"] = str(len(data))
        elif length is not None:
            self.headers["Content-Length"] = str(length)
        self._b = io.BytesIO(data)

    def read(self, n=-1):
        return self._b.read(n)

    def geturl(self):
        return "https://www.cms.gov/x"

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def close(self):
        pass


routes = {}


def fake_http(url, method="GET", headers=None, timeout=60):
    for prefix, answer in routes.items():
        if url == prefix or url.startswith(prefix + "?"):
            if isinstance(answer, BaseException):
                raise answer
            data, head, length = (answer + ("auto",))[:3] if isinstance(answer, tuple) else (answer, {}, "auto")
            return Resp(b"" if method == "HEAD" else data, head, None if method == "HEAD" else length)
    raise FetchError(f"HTTP 404 Not Found from {url}")


cachelib.http = fake_http


def set_today(iso):
    d = dt.date.fromisoformat(iso)
    cachelib.utc_now = lambda: dt.datetime(d.year, d.month, d.day, 12, tzinfo=dt.timezone.utc)


def new_cache(name):
    d = WORK / name
    d.mkdir()
    cachelib.CACHE = d
    cachelib.MANIFEST = d / "manifest.json"
    build_drugs.CACHE = d
    build_drugs.MANIFEST = d / "manifest.json"
    build_drugs.OUT = d / "drugs.json"
    cachelib.FELL_BACK.clear()
    routes.clear()
    return d


class Captured(io.StringIO):
    """Stands in for sys.stdout, which the tools reconfigure to UTF-8."""

    def reconfigure(self, **kw):
        pass


def run(fn, *args):
    """Call fn, capture what it prints; a SystemExit becomes its code and message."""
    so, se = Captured(), Captured()
    code = None
    with contextlib.redirect_stdout(so), contextlib.redirect_stderr(se):
        try:
            code = fn(*args)
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else 1
            if not isinstance(e.code, int):
                print(e.code, file=sys.stderr)
    return {"code": code, "out": so.getvalue(), "err": se.getvalue()}


def refused(fn, *args):
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            fn(*args)
    except FetchError as e:
        return str(e)
    return None


def raised(fn, *args):
    """The exception type name and message fn raises, or None."""
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            fn(*args)
    except BaseException as e:  # noqa: BLE001
        return {"type": type(e).__name__, "message": str(e)}
    return None


def zip_bytes(members):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in members.items():
            z.writestr(name, data)
    return b.getvalue()


def text(name):
    return (FIX / name).read_text(encoding="utf-8")


def crlf(name):
    return text(name).replace("\n", "\r\n").encode("cp1252")


FDA_ZIP = zip_bytes({"product.txt": crlf("product.txt"), "package.txt": crlf("package.txt")})
LIMITS_MEMBER = "section 508 version of October 2026 Medicare Part B Payment Limit File 091626.csv"
XWALK_MEMBER = "section 508 version of October 2026 ASP NDC-HCPCS Crosswalk 091126.csv"
LIMITS_ZIP = zip_bytes({LIMITS_MEMBER: text("asp_limits.csv").encode("cp1252")})
XWALK_ZIP = zip_bytes({XWALK_MEMBER: text("asp_crosswalk.csv").encode("cp1252")})
PAGE = text("asp_page.html")
LIMITS_URL = "https://www.cms.gov/files/zip/october-2026-medicare-part-b-payment-limit-files-final.zip"
XWALK_URL = "https://www.cms.gov/files/zip/october-2026-ndc-hcpcs-crosswalk-final.zip"

# ---------------------------------------------------------------- NADAC discovery

NADAC_SEARCH = fetch_nadac.API + "/search"
NADAC_CSV_URL = "https://download.medicaid.gov/data/nadac-fixture-10-14-2026.csv"


def nadac_item(ident):
    return fetch_nadac.API + f"/metastore/schemas/dataset/items/{ident}"


def nadac_routes(extra_results=(), csv_bytes=None, etag='"a"'):
    results = [
        {"title": "NADAC (National Average Drug Acquisition Cost) 2025", "identifier": "d2025"},
        {"title": "NADAC (National Average Drug Acquisition Cost) 2026", "identifier": "d2026"},
        {"title": "First Time NADAC Rates", "identifier": "first"},
        {"title": "NADAC Comparison", "identifier": "comparison"},
        *extra_results,
    ]
    routes[NADAC_SEARCH] = json.dumps({"results": results}).encode()
    for r in results:
        routes[nadac_item(r["identifier"])] = json.dumps({
            "title": r["title"],
            "distribution": [{"data": {"format": "csv", "downloadURL": NADAC_CSV_URL.replace("10-14-2026", r["identifier"])}}],
            "publisher": {"data": {"name": "data.medicaid.gov"}},
        }).encode()
    data = (csv_bytes if csv_bytes is not None else text("nadac.csv").encode())
    routes[NADAC_CSV_URL.replace("10-14-2026", "d2026")] = (data, {"ETag": etag})


new_cache("nadac_year")
nadac_routes()
out["nadac_year_title"] = fetch_nadac.find_current_dataset()["title"]
new_cache("nadac_retitled")
nadac_routes([{"title": "National Average Drug Acquisition Cost (NADAC) 2027", "identifier": "d2027"}])
out["nadac_retitled_year"] = fetch_nadac.find_current_dataset()["year"]
new_cache("nadac_two")
nadac_routes([{"title": "NADAC 2026", "identifier": "other"}])
out["nadac_two_for_a_year"] = refused(fetch_nadac.find_current_dataset)
# The other NADAC datasets with a year in their titles are still not the weekly one (R10).
new_cache("nadac_lookalikes")
nadac_routes([{"title": "NADAC Comparison 2026", "identifier": "cmp2026"}, {"title": "First Time NADAC Rates 2026", "identifier": "first2026"}])
out["nadac_lookalike_titles"] = refused(fetch_nadac.find_current_dataset) or fetch_nadac.find_current_dataset()["title"]
new_cache("nadac_maintenance")
routes[NADAC_SEARCH] = json.dumps({"error": "maintenance"}).encode()
r = run(fetch_nadac.main, [])
out["nadac_maintenance"] = {"code": r["code"], "err": r["err"]}
new_cache("nadac_not_json")
routes[NADAC_SEARCH] = b"<html>503 Backend fetch failed</html>"
r = run(fetch_nadac.main, [])
out["nadac_not_json"] = {"code": r["code"], "err": r["err"]}

# ---------------------------------------------------------------- NADAC fetch: flow and refusals

set_today("2026-10-16")
d = new_cache("nadac_flow")
nadac_routes()
r = run(fetch_nadac.main, [])
entry = cachelib.load_manifest()["nadac"]
good_file = entry["file"]
good_sha = entry["sha256"]
out["nadac_flow"] = {"code": r["code"], "as_of": entry["as_of_date"], "weeks": entry["weeks_in_file"], "file": entry["file"], "retrieved": entry["retrieved_date"]}
# Same ETag: not downloaded again. A changed ETag: downloaded.
downloads = []
real_download = cachelib._download
cachelib._download = lambda *a, **k: (downloads.append(a[0]), real_download(*a, **k))[1]
r = run(fetch_nadac.main, [])
out["nadac_unchanged"] = {"code": r["code"], "downloads": len(downloads), "said": "unchanged on server" in r["out"]}
downloads.clear()
nadac_routes(etag='"b"')
r = run(fetch_nadac.main, [])
out["nadac_new_etag"] = {"code": r["code"], "downloads": len(downloads)}
cachelib._download = real_download

# Nothing in the cache checks out: exit 3, and the bytes are never silently replaced.
good_bytes = (d / good_file).read_bytes()
(d / good_file).write_bytes(good_bytes.replace(b"5.52114", b"9.52114"))
r = run(fetch_nadac.main, ["--offline"])
out["nadac_hash_mismatch"] = {"code": r["code"], "err": r["err"]}
out["verify_hash_mismatch"] = raised(cachelib.verify, cachelib.load_manifest()["nadac"])
(d / good_file).write_bytes(good_bytes)

# A malformed new file under next week's name: exit 4, the old file and the manifest stay, and
# --offline still works (INFRA-15).
manifest_before = cachelib.MANIFEST.read_text(encoding="utf-8")
BAD_CSV = b"NDC Description,NDC,Price Per Unit,Effective Date\nFOO,00000000000,1.0,11/11/2026\n"
routes[nadac_item("d2026")] = json.dumps({
    "title": "NADAC (National Average Drug Acquisition Cost) 2026",
    "distribution": [{"data": {"format": "csv", "downloadURL": "https://download.medicaid.gov/data/nadac-fixture-11-11-2026.csv"}}],
}).encode()
routes["https://download.medicaid.gov/data/nadac-fixture-11-11-2026.csv"] = (BAD_CSV, {"ETag": '"bad"'})
r = run(fetch_nadac.main, [])
out["nadac_malformed"] = {
    "code": r["code"],
    "err": r["err"],
    "old_file_kept": (d / good_file).read_bytes() == good_bytes,
    "manifest_unchanged": cachelib.MANIFEST.read_text(encoding="utf-8") == manifest_before,
    "new_file_absent": not (d / "nadac-fixture-11-11-2026.csv").exists(),
    "no_part_left": not list(d.glob("*.part")),
    "removed_message": "removed superseded" in r["out"],
}
r = run(fetch_nadac.main, ["--offline"])
out["nadac_malformed_offline"] = r["code"]

# A good new file under next week's name does supersede the old one.
routes["https://download.medicaid.gov/data/nadac-fixture-11-11-2026.csv"] = (text("nadac.csv").replace("10/14/2026", "10/15/2026").encode(), {"ETag": '"good"'})
r = run(fetch_nadac.main, [])
out["nadac_superseded"] = {"code": r["code"], "old_gone": not (d / good_file).exists(), "said": "removed superseded" in r["out"], "as_of": cachelib.load_manifest()["nadac"]["as_of_date"]}

# An as-of date too old for a weekly file: a dataset this script did not find (INFRA-05 scenario H
# after the title check passes): exit 4 online, but not offline.
set_today("2026-10-24")
d = new_cache("nadac_age_ok")
nadac_routes()
out["nadac_age_10"] = run(fetch_nadac.main, [])["code"]
set_today("2026-10-25")
d = new_cache("nadac_age_old")
nadac_routes()
r = run(fetch_nadac.main, [])
out["nadac_age_11"] = {"code": r["code"], "err": r["err"]}
out["nadac_age_offline"] = run(fetch_nadac.main, ["--offline"])["code"]
set_today("2026-10-16")

# The header check on its own.
p = WORK / "bad_header.csv"
p.write_bytes(BAD_CSV)
out["summarise_bad_header"] = refused(fetch_nadac.summarise, p)
p.write_text(text("nadac.csv").splitlines()[0] + "\n", encoding="utf-8")
out["summarise_no_rows"] = refused(fetch_nadac.summarise, p)

# ---------------------------------------------------------------- a truncated download

d = new_cache("truncated")
routes["https://www.cms.gov/x.csv"] = (b"12345", {}, 99)
out["truncated"] = refused(cachelib._download, "https://www.cms.gov/x.csv", d / "x.csv")
out["truncated_left_nothing"] = not (d / "x.csv").exists() and not (d / "x.csv.part").exists()
routes["https://www.cms.gov/empty.csv"] = (b"", {}, None)
out["empty_download"] = refused(cachelib._download, "https://www.cms.gov/empty.csv", d / "empty.csv")

# ---------------------------------------------------------------- --require-online

DOWN = urllib.error.URLError(OSError("getaddrinfo failed"))
d = new_cache("require_online")
nadac_routes()
run(fetch_nadac.main, [])
routes[NADAC_SEARCH] = DOWN
cachelib.FELL_BACK.clear()
r = run(fetch_nadac.main, [])
out["fallback_plain"] = {"code": r["code"], "err": r["err"], "out": r["out"]}
cachelib.FELL_BACK.clear()
r = run(fetch_nadac.main, ["--require-online"])
out["fallback_required"] = {"code": r["code"], "err": r["err"]}
cachelib.FELL_BACK.clear()
out["offline_flag"] = run(fetch_nadac.main, ["--offline"])["code"]
out["offline_and_required_refused"] = run(fetch_nadac.main, ["--offline", "--require-online"])["code"]
d = new_cache("require_online_empty")
routes[NADAC_SEARCH] = DOWN
out["no_cache_no_network"] = run(fetch_nadac.main, ["--require-online"])["code"]

# A cached week older than MAX_AS_OF_AGE_DAYS, kept because the network failed, is NOT REFRESHED, not
# a dataset this script failed to find (R10).
d = new_cache("nadac_old_fallback")
nadac_routes()
run(fetch_nadac.main, [])
set_today("2026-10-30")
routes[NADAC_SEARCH] = DOWN
cachelib.FELL_BACK.clear()
r = run(fetch_nadac.main, [])
out["nadac_old_fallback"] = {"code": r["code"], "err": r["err"]}
cachelib.FELL_BACK.clear()
r = run(fetch_nadac.main, ["--require-online"])
out["nadac_old_fallback_required"] = {"code": r["code"], "err": r["err"]}
cachelib.FELL_BACK.clear()
set_today("2026-10-16")


def required_fallback(main, down):
    """A fetcher run once online, then with these URLs unreachable: plain, and with --require-online (R06)."""
    online = run(main, [])
    for url in down:
        routes[url] = DOWN
    cachelib.FELL_BACK.clear()
    plain = run(main, [])
    cachelib.FELL_BACK.clear()
    required = run(main, ["--require-online"])
    cachelib.FELL_BACK.clear()
    return {"online": online["code"], "plain": plain["code"], "code": required["code"], "err": required["err"]}

real_call = fetch_all.subprocess.call
seen_flags = []


def fake_call(codes):
    it = iter(codes)

    def call(args):
        seen_flags.append(args[3:])
        return next(it)
    return call


fetch_all.subprocess.call = fake_call([0, 5, 0, 5])
r = run(fetch_all.main, [])
out["fetch_all_plain"] = {"code": r["code"], "out": r["out"], "err": r["err"], "flags": seen_flags[0]}
fetch_all.subprocess.call = fake_call([0, 5, 0, 0])
out["fetch_all_required"] = run(fetch_all.main, ["--require-online"])["code"]
fetch_all.subprocess.call = fake_call([0, 4, 0, 0])
r = run(fetch_all.main, [])
out["fetch_all_failed"] = {"code": r["code"], "out": r["out"]}
seen_flags.clear()
fetch_all.subprocess.call = fake_call([0, 0, 0, 0])
out["fetch_all_offline"] = {"code": run(fetch_all.main, ["--offline"])["code"], "flags": seen_flags[0]}
fetch_all.subprocess.call = real_call

# ---------------------------------------------------------------- Part B: which quarter

JAN_LIMITS = '<a href="/files/zip/january-2027-medicare-part-b-payment-limit-files.zip">January 2027 Medicare Part B Payment Limit Files</a> 12/18/2026 - Final file'
JAN_XWALK = '<a href="/files/zip/january-2027-ndc-hcpcs-crosswalk.zip">January 2027 NDC-HCPCS Crosswalk</a> 12/18/2026 - Final file'
JAN_LIMITS_RENAMED = '<a href="/files/zip/january-2027-part-b-payment-limits.zip">January 2027 Part B Payment Limits</a> 12/18/2026'
JAN_XWALK_RENAMED = '<a href="/files/zip/january-2027-crosswalk.zip">January 2027 HCPCS-NDC Crosswalk</a> 12/18/2026'
JAN_NOC = '<a href="/files/zip/january-2027-noc-pricing-file.zip">January 2027 NOC Pricing File</a> 12/18/2026'


def quarter(page, today):
    """(quarter chosen, or the error) for a doctored page on a given day, and what it printed."""
    new_page = page
    routes[fetch_asp.PAGE] = new_page.encode()
    so, se = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(so), contextlib.redirect_stderr(se):
        try:
            q = fetch_asp.find_quarter(dt.date.fromisoformat(today))
            return {"quarter": list(q["quarter"]), "period": fetch_asp.quarter_period(*q["quarter"]), "said": so.getvalue(), "warned": se.getvalue()}
        except FetchError as e:
            return {"error": str(e)}


new_cache("quarters")
out["asp_live"] = quarter(PAGE, "2026-11-06")
out["asp_on_first_day"] = quarter(PAGE, "2026-10-01")
out["asp_day_before"] = quarter(PAGE, "2026-09-30")
out["asp_future_posted"] = quarter(JAN_LIMITS + JAN_XWALK + PAGE, "2026-12-20")
out["asp_future_started"] = quarter(JAN_LIMITS + JAN_XWALK + PAGE, "2027-01-01")
out["asp_half_posted"] = quarter(JAN_LIMITS + PAGE, "2026-12-20")
out["asp_half_posted_in_grace"] = quarter(JAN_LIMITS + PAGE, "2027-01-10")
out["asp_half_posted_past_grace"] = quarter(JAN_LIMITS + PAGE, "2027-01-11")
out["asp_nothing_new_in_grace"] = quarter(PAGE, "2027-01-10")
out["asp_nothing_new_past_grace"] = quarter(PAGE, "2027-01-11")
out["asp_limits_renamed"] = quarter(JAN_LIMITS_RENAMED + JAN_XWALK + PAGE, "2026-12-20")
out["asp_crosswalk_renamed"] = quarter(JAN_LIMITS + JAN_XWALK_RENAMED + PAGE, "2026-12-20")
out["asp_noc_only"] = quarter(JAN_NOC + PAGE, "2026-12-20")
# A link that matches neither pattern is a rename only for a newer quarter that is not complete (R10).
out["asp_renamed_but_complete"] = quarter(JAN_LIMITS + JAN_XWALK + JAN_LIMITS_RENAMED + PAGE, "2026-12-20")
JAN25_RENAMED = '<a href="/files/zip/january-2025-part-b-payment-limits.zip">January 2025 Part B Payment Limits</a> 12/18/2024'
out["asp_renamed_older"] = quarter(JAN25_RENAMED + PAGE, "2026-11-06")
out["asp_no_quarter"] = quarter("<html></html>", "2026-12-20")
out["asp_all_future"] = quarter(JAN_LIMITS + JAN_XWALK, "2026-12-20")

# ---------------------------------------------------------------- Part B: fetching

d = new_cache("asp_flow")
set_today("2026-10-16")
routes[fetch_asp.PAGE] = PAGE.encode()
routes[LIMITS_URL] = (LIMITS_ZIP, {"ETag": '"l"'})
routes[XWALK_URL] = (XWALK_ZIP, {"ETag": '"x"'})
r = run(fetch_asp.main, [])
m = cachelib.load_manifest()
out["asp_flow"] = {
    "code": r["code"],
    "err": r["err"],
    "limits_period": m["asp_limits"]["period"],
    "limits_member": m["asp_limits"].get("member"),
    "xwalk_quarter": m["asp_crosswalk"]["quarter"],
    "effective_in_file": m["asp_limits"].get("effective_in_file"),
    "as_of": m["asp_limits"].get("as_of_date"),
}
limits_before = (d / m["asp_limits"]["file"]).read_bytes()
manifest_before = cachelib.MANIFEST.read_text(encoding="utf-8")

# A new limits zip that says it is for another quarter (same name, so the old one must survive).
WRONG_QUARTER = zip_bytes({LIMITS_MEMBER: text("asp_limits.csv").replace("October 1, 2026 through December 31", "July 1, 2026 through September 30").encode("cp1252")})
routes[LIMITS_URL] = (WRONG_QUARTER, {"ETag": '"wrong"'})
r = run(fetch_asp.main, [])
out["asp_wrong_quarter"] = {
    "code": r["code"],
    "err": r["err"],
    "old_file_kept": (d / m["asp_limits"]["file"]).read_bytes() == limits_before,
    "manifest_unchanged": cachelib.MANIFEST.read_text(encoding="utf-8") == manifest_before,
}
# And the same check on a file already in the cache.
(d / m["asp_limits"]["file"]).write_bytes(WRONG_QUARTER)
cachelib.update_entry("asp_limits", sha256=hashlib.sha256(WRONG_QUARTER).hexdigest(), bytes=len(WRONG_QUARTER))
r = run(fetch_asp.main, ["--offline"])
out["asp_wrong_quarter_cached"] = {"code": r["code"], "err": r["err"]}

new_cache("asp_empty")
routes[fetch_asp.PAGE] = PAGE.encode()
routes[LIMITS_URL] = (zip_bytes({LIMITS_MEMBER: "\n".join(text("asp_limits.csv").splitlines()[:7]).encode("cp1252")}), {"ETag": '"e"'})
routes[XWALK_URL] = (XWALK_ZIP, {"ETag": '"x"'})
r = run(fetch_asp.main, [])
out["asp_no_rows"] = {"code": r["code"], "err": r["err"]}
new_cache("asp_bad_zip")
routes[fetch_asp.PAGE] = PAGE.encode()
routes[LIMITS_URL] = (b"this is not a zip file", {"ETag": '"z"'})
routes[XWALK_URL] = (XWALK_ZIP, {"ETag": '"x"'})
r = run(fetch_asp.main, [])
out["asp_bad_zip"] = {"code": r["code"], "err": r["err"]}


def broken_stream(z):
    """The zip with the start of its first member's compressed data overwritten: its directory reads,
    its deflate stream does not (zlib.error, R13)."""
    at = 30 + int.from_bytes(z[26:28], "little") + int.from_bytes(z[28:30], "little")
    return z[:at] + b"\xff" * 8 + z[at + 8:]


d = new_cache("asp_broken_stream")
routes[fetch_asp.PAGE] = PAGE.encode()
routes[LIMITS_URL] = (broken_stream(LIMITS_ZIP), {"ETag": '"s"'})
routes[XWALK_URL] = (XWALK_ZIP, {"ETag": '"x"'})
r = run(fetch_asp.main, [])
out["asp_broken_stream"] = {"code": r["code"], "err": r["err"]}
routes[LIMITS_URL] = (LIMITS_ZIP, {"ETag": '"l"'})
run(fetch_asp.main, [])
m = cachelib.load_manifest()["asp_limits"]
(d / m["file"]).write_bytes(broken_stream(LIMITS_ZIP))
cachelib.update_entry("asp_limits", sha256=hashlib.sha256(broken_stream(LIMITS_ZIP)).hexdigest(), bytes=len(LIMITS_ZIP))
r = run(fetch_asp.main, ["--offline"])
out["asp_broken_stream_cached"] = {"code": r["code"], "err": r["err"]}

new_cache("asp_required")
routes[fetch_asp.PAGE] = PAGE.encode()
routes[LIMITS_URL] = (LIMITS_ZIP, {"ETag": '"l"'})
routes[XWALK_URL] = (XWALK_ZIP, {"ETag": '"x"'})
out["asp_required"] = required_fallback(fetch_asp.main, [fetch_asp.PAGE])

# ---------------------------------------------------------------- Part D

PARTD_CSV_2023 = "https://data.cms.gov/sites/default/files/2025-06/x/DSD_PTD_RY25_P04_V10_DY23_BGM.csv"
PARTD_CSV_2024 = "https://data.cms.gov/sites/default/files/2026-06/y/DSD_PTD_RY26_P04_V10_DY24_BGM.csv"
LANDING = {"accessURL": "https://data.cms.gov/summary-statistics-on-use-and-payments/medicare-medicaid-spending-by-drug/medicare-part-d-spending-by-drug"}


def temporal(y):
    return [{"@type": "PeriodOfTime", "startDate": f"{y}-01-01", "endDate": f"{y}-12-31"}]


def dataset(title, year, url, extra=()):
    return {
        "title": title,
        "identifier": "https://data.cms.gov/data-api/v1/dataset/x/data-viewer",
        "landingPage": LANDING,
        "publisher": {"name": "Centers for Medicare & Medicaid Services"},
        "temporal": temporal(year),
        "distribution": [
            {"title": title, "format": "CSV", "mediaType": "text/csv", "downloadURL": url, "temporal": temporal(year), "modified": f"{year + 2}-06-25"},
            {"title": title, "format": "API", "description": "latest", "accessURL": "https://data.cms.gov/data-api/v1/dataset/7e0b4365-fd63-4a29-8f5e-e0ac9f66a81b/data",
             "resourcesAPI": "https://data.cms.gov/data-api/v1/dataset-resources/r", "temporal": temporal(year)},
            *extra,
        ],
    }


PARTD = dataset("Medicare Part D Spending by Drug : 2024-01-01", 2024, PARTD_CSV_2024)
PARTD_OLD = dataset("Medicare Part D Spending by Drug : 2023-01-01", 2023, PARTD_CSV_2023)
OTHERS = [
    dataset("Medicare Quarterly Part D Spending by Drug : 2026-01-01", 2026, "https://data.cms.gov/q.csv"),
    dataset("Medicare Part D Prescribers - by Provider and Drug : 2025-12-01", 2025, "https://data.cms.gov/p.csv"),
    dataset("Medicare Part B Spending by Drug : 2025-01-01", 2025, "https://data.cms.gov/b.csv"),
    dataset("Medicaid Spending by Drug : 2025-01-01", 2025, "https://data.cms.gov/m.csv"),
]


def catalog(*datasets):
    routes[fetch_partd.CATALOG] = json.dumps({"dataset": list(datasets)}).encode()
    routes["https://data.cms.gov/data-api/v1/dataset-resources/r"] = json.dumps({"data": [
        {"name": "Data Dictionary", "downloadURL": "https://data.cms.gov/dict.pdf"},
        {"name": "Methodology", "downloadURL": "https://data.cms.gov/meth.pdf"},
    ]}).encode()


def partd_try():
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            m = fetch_partd.resolve()
        return {"period": m["period"], "year": m["data_year"], "file": m["file"]}
    except FetchError as e:
        return {"error": str(e)}


new_cache("partd_pick")
catalog(PARTD_OLD, PARTD, *OTHERS)
out["partd_newest"] = partd_try()
newer = dataset("Medicare Part D Spending by Drug : 2025-01-01", 2025, "https://data.cms.gov/sites/default/files/2027-06/z/DSD_PTD_RY27_P04_V10_DY25_BGM.csv")
catalog(PARTD_OLD, PARTD, newer)
out["partd_next_year"] = partd_try()
retitled = dataset("Medicare Part D Drug Spending : 2025-01-01", 2025, "https://data.cms.gov/sites/default/files/2027-06/z/DSD_PTD_RY27_P04_V10_DY25_BGM.csv")
catalog(PARTD_OLD, PARTD, retitled)
out["partd_retitled"] = partd_try()
catalog({"dataset": []})
out["partd_nothing"] = partd_try()

new_cache("partd_string_temporal")
s = copy.deepcopy(PARTD)
s["temporal"] = "2024-01-01/2024-12-31"
for x in s["distribution"]:
    x["temporal"] = "2024-01-01/2024-12-31"
catalog(s)
r = run(fetch_partd.main, [])
out["partd_string_temporal"] = {"code": r["code"], "err": r["err"]}

set_today("2027-07-04")
new_cache("partd_late")
catalog(PARTD)
so = io.StringIO()
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(so):
    fetch_partd.resolve()
out["partd_late_warning"] = so.getvalue()
set_today("2026-10-16")

d = new_cache("partd_flow")
catalog(PARTD_OLD, PARTD, *OTHERS)
routes[PARTD_CSV_2024] = (text("partd.csv").encode(), {"ETag": '"p"'})
r = run(fetch_partd.main, [])
m = cachelib.load_manifest()["partd"]
out["partd_flow"] = {"code": r["code"], "err": r["err"], "year": m["data_year"], "period": m["period"], "dictionary": m.get("data_dictionary_url")}

# The file's newest year column disagrees with the catalog's year.
p = WORK / "partd_2025.csv"
p.write_text(text("partd.csv").replace("_2024", "_2025"), encoding="utf-8")
out["partd_newer_column"] = refused(fetch_partd.summarise, p, 2023)
out["partd_missing_year"] = refused(fetch_partd.summarise, p, 2024)
p.write_text(text("partd.csv"), encoding="utf-8")
out["partd_column_ok"] = refused(fetch_partd.summarise, p, 2024)

d = new_cache("partd_bad_new")
catalog(PARTD)
routes[PARTD_CSV_2024] = (b"Brnd_Name,Gnrc_Name\nA,B\n", {"ETag": '"bad"'})
r = run(fetch_partd.main, [])
out["partd_bad_new_file"] = {"code": r["code"], "err": r["err"], "kept": not (d / "DSD_PTD_RY26_P04_V10_DY24_BGM.csv").exists()}

new_cache("partd_required")
catalog(PARTD)
routes[PARTD_CSV_2024] = (text("partd.csv").encode(), {"ETag": '"p"'})
out["partd_required"] = required_fallback(fetch_partd.main, [fetch_partd.CATALOG])

# ---------------------------------------------------------------- FDA

FDA_URL = fetch_fda_ndc.SOURCES["fda_ndc"]["download_url"]
d = new_cache("fda_flow")
routes[fetch_fda_ndc.LANDING] = f'<a href="{FDA_URL}">NDC database file</a>'.encode()
routes[FDA_URL] = (FDA_ZIP, {"ETag": '"f"', "Last-Modified": "Fri, 16 Oct 2026 08:15:39 GMT"})
r = run(fetch_fda_ndc.main, [])
m = cachelib.load_manifest()["fda_ndc"]
out["fda_flow"] = {"code": r["code"], "err": r["err"], "as_of": m["as_of_date"]}
fda_before = (d / "ndctext.zip").read_bytes()
manifest_before = cachelib.MANIFEST.read_text(encoding="utf-8")
routes[FDA_URL] = (zip_bytes({"product.txt": b"WRONG\tHEADER\r\n", "package.txt": crlf("package.txt")}), {"ETag": '"bad"'})
r = run(fetch_fda_ndc.main, [])
out["fda_bad_new_file"] = {"code": r["code"], "err": r["err"], "old_file_kept": (d / "ndctext.zip").read_bytes() == fda_before,
                           "manifest_unchanged": cachelib.MANIFEST.read_text(encoding="utf-8") == manifest_before}
new_cache("fda_landing")
routes[fetch_fda_ndc.LANDING] = b"<p>The NDC Directory has moved.</p>"
out["fda_landing_moved"] = refused(fetch_fda_ndc.resolver("fda_ndc"))

new_cache("fda_required")
routes[fetch_fda_ndc.LANDING] = f'<a href="{FDA_URL}">NDC database file</a>'.encode()
routes[FDA_URL] = (FDA_ZIP, {"ETag": '"f"', "Last-Modified": "Fri, 16 Oct 2026 08:15:39 GMT"})
out["fda_required"] = required_fallback(fetch_fda_ndc.main, [fetch_fda_ndc.LANDING])

# ---------------------------------------------------------------- build_drugs

NADAC_FILE = "nadac-national-average-drug-acquisition-cost-20261014.csv"


def seed_build(name, nadac_csv=None, as_of="2026-10-14", xwalk_period="2026-10-01/2026-12-31"):
    d = new_cache(name)
    files = {
        "nadac": (NADAC_FILE, (nadac_csv or text("nadac.csv")).encode(), {"as_of_date": as_of, "period": None, "landing_url": "https://data.medicaid.gov/dataset/fbb83258"}),
        "fda_ndc": ("ndctext.zip", FDA_ZIP, {"as_of_date": "2026-10-16", "period": None, "landing_url": fetch_fda_ndc.LANDING}),
        "partd": ("DSD_PTD_RY26_P04_V10_DY24_BGM.csv", text("partd.csv").encode(), {"as_of_date": "2026-06-25", "period": "2024-01-01/2024-12-31", "data_year": 2024, "landing_url": LANDING["accessURL"]}),
        "asp_limits": ("october-2026-limits.zip", LIMITS_ZIP, {"as_of_date": "2026-09-17", "period": "2026-10-01/2026-12-31", "member": LIMITS_MEMBER, "landing_url": fetch_asp.PAGE}),
        "asp_crosswalk": ("october-2026-crosswalk.zip", XWALK_ZIP, {"as_of_date": "2026-09-17", "period": xwalk_period, "member": XWALK_MEMBER, "landing_url": fetch_asp.PAGE}),
    }
    for key, (fname, data, meta) in files.items():
        (d / fname).write_bytes(data)
        cachelib.save_entry(key, {
            **{f: None for f in cachelib.ENTRY_FIELDS},
            "file": fname, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
            "download_url": "https://www.cms.gov/" + fname, "title": fname, "publisher": "fixture", "license": "fixture",
            "retrieved_at": "2026-10-17T00:00:00+00:00", "retrieved_date": "2026-10-17", **meta,
        })
    return d


# The newest week, read straight, whatever the manifest says.
p = WORK / "two_weeks.csv"
p.write_text(text("nadac.csv"), encoding="utf-8")
kept, latest, weeks = build_drugs.read_nadac(p)
out["read_nadac"] = {"latest": latest, "weeks": weeks, "rows": len(kept), "weeks_kept": sorted({r["As of Date"] for r in kept})}

p = WORK / "rejects.csv"
p.write_text(text("nadac_rejects.csv"), encoding="utf-8")
raw, _, _ = build_drugs.read_nadac(p)
src = {"landing_url": "https://data.medicaid.gov/dataset/x", "file": "f.csv", "retrieved_date": "2026-10-17", "as_of_date": "2026-10-14"}
rows, rejected, dups = build_drugs.build_nadac_rows(raw, src)
out["rejects"] = {"kept": sorted(rows), "reasons": sorted(why for _, why in rejected), "duplicates": dups}
out["positive"] = [str(build_drugs.positive(x)) for x in ["0", "0.00000", "", "-1", "abc", "0.01451", "1,234.5"]]

kept, latest, weeks = build_drugs.read_nadac(WORK / "two_weeks.csv")
rows, rejected, dups = build_drugs.build_nadac_rows(kept, src)
out["carried"] = {n: rows[n]["carried_forward"] for n in ("90000000041", "90000000022", "90000000033", "00003089421")}
out["explanation_codes"] = rows["00409000925"]["explanation_codes"]
out["nadac_record"] = rows["00003089421"]["nadac"]
out["generic_record"] = {k: rows["90000000033"]["generic_nadac"].get(k) for k in ("value", "state", "effective_date", "per")}

for label, pair in (("one_percent", (1, 200)), ("over", (2, 200))):
    fake = [("n", "why")] * pair[0]
    out[f"reject_share_{label}"] = raised(build_drugs.check_reject_share, fake, pair[1])

d = seed_build("build_ok")
r = run(build_drugs.build)
out["build_ok_exit"] = {"code": r["code"], "err": r["err"]}
doc = json.loads(build_drugs.OUT.read_text(encoding="utf-8"))
by = {x["ndc"]: x for x in doc["rows"]}
out["built"] = {
    "schema": doc["schema"],
    "rows": len(doc["rows"]),
    "as_of": doc["sources"]["nadac"]["as_of_date"],
    "weeks": doc["sources"]["nadac"]["weeks_in_file"],
    "eliquis": by["00003089421"]["nadac"]["value"],
    "eliquis_state": by["00003089421"]["nadac"]["state"],
    "eliquis_file": by["00003089421"]["nadac"]["source_file"],
    "eliquis_join": by["00003089421"]["part_d"],
    "eliquis_identity": by["00003089421"]["identity"]["proprietary_name"],
    "part_d_avg": doc["part_d_names"]["Eliquis|Apixaban"]["avg_per_unit"]["value"],
    "part_d_period": doc["part_d_names"]["Eliquis|Apixaban"]["avg_per_unit"]["period"],
    "ondansetron_hcpcs": by["00409000925"]["part_b"]["hcpcs"],
    "ondansetron_units": by["00409000925"]["part_b"]["bill_units_per_package"]["value"],
    "j2405": doc["part_b_codes"]["J2405"]["payment_limit"]["value"],
    "rejected": doc["counts"]["rejected"],
    "carried": doc["counts"]["carried_forward"],
}
first = build_drugs.OUT.read_bytes()
run(build_drugs.build)
out["build_deterministic"] = build_drugs.OUT.read_bytes() == first

d = seed_build("build_as_of", as_of="2026-10-07")
r = run(build_drugs.build)
out["build_as_of_mismatch"] = {"code": r["code"], "err": r["err"], "wrote": build_drugs.OUT.exists()}
d = seed_build("build_quarters", xwalk_period="2026-07-01/2026-09-30")
r = run(build_drugs.build)
out["build_quarter_mismatch"] = {"code": r["code"], "err": r["err"], "wrote": build_drugs.OUT.exists()}
d = seed_build("build_rejects", nadac_csv=text("nadac_rejects.csv"))
r = run(build_drugs.build)
out["build_reject_share"] = {"code": r["code"], "err": r["err"], "wrote": build_drugs.OUT.exists()}
d = seed_build("build_hash")
(d / "ndctext.zip").write_bytes(b"x" * len(FDA_ZIP))
r = run(build_drugs.build)
out["build_hash_mismatch"] = {"code": r["code"], "err": r["err"], "wrote": build_drugs.OUT.exists()}

# ---------------------------------------------------------------- check_refresh


def tiny_doc(values, rejected=0, as_of="2026-11-04", first=0):
    return {
        "sources": {"nadac": {"source_file": "n.csv", "as_of_date": as_of}},
        "counts": {"rejected": rejected},
        "rows": [{"ndc": f"{first + i:011d}", "name": f"DRUG {first + i}", "nadac": {"value": v}} for i, v in enumerate(values)],
    }


def refresh_docs(old_doc, new_doc, extra=()):
    old_path, new_path = WORK / "old.json", WORK / "new.json"
    old_path.write_text(json.dumps(old_doc), encoding="utf-8")
    new_path.write_text(json.dumps(new_doc), encoding="utf-8")
    r = run(check_refresh.main, ["--new", str(new_path), "--previous", str(old_path), *extra])
    return {"code": r["code"], "out": r["out"]}


def refresh_check(old_values, new_values, rejected=0, extra=()):
    old_path, new_path = WORK / "old.json", WORK / "new.json"
    old_path.write_text(json.dumps(tiny_doc(old_values)), encoding="utf-8")
    new_path.write_text(json.dumps(tiny_doc(new_values, rejected)), encoding="utf-8")
    r = run(check_refresh.main, ["--new", str(new_path), "--previous", str(old_path), *extra])
    return {"code": r["code"], "out": r["out"]}


BASE = [1.0] * 1000
times = lambda n, f: [x * f for x in BASE[:n]] + BASE[n:]
out["refresh_same"] = refresh_check(BASE, BASE)
out["refresh_20_movers"] = refresh_check(BASE, times(20, 100))
out["refresh_21_movers"] = refresh_check(BASE, times(21, 100))
out["refresh_21_movers_down"] = refresh_check(BASE, times(21, 0.01))
out["refresh_21_movers_accepted"] = refresh_check(BASE, times(21, 100), extra=["--accept-movers"])
out["refresh_21_at_4x"] = refresh_check(BASE, times(21, 4.9))
out["refresh_21_at_5x"] = refresh_check(BASE, times(21, 5))
out["refresh_21_at_fifth"] = refresh_check(BASE, times(21, 0.2))
out["refresh_rows_970"] = refresh_check(BASE, BASE[:970])
out["refresh_rows_969"] = refresh_check(BASE, BASE[:969])
out["refresh_rejects_5"] = refresh_check(BASE, BASE, rejected=5)
out["refresh_rejects_6"] = refresh_check(BASE, BASE, rejected=6)
out["refresh_median_up"] = refresh_check(BASE, [1.11] * 1000)
out["refresh_median_edge"] = refresh_check(BASE, [1.1] * 1000)
out["refresh_median_down"] = refresh_check(BASE, [0.89] * 1000)
out["refresh_unit_shift"] = refresh_check(BASE, [100.0] * 1000)
out["refresh_nothing_shared"] = {"problems": check_refresh.problems(check_refresh.compare(tiny_doc([]), tiny_doc([1.0])))}
summary_path = WORK / "summary.md"
refresh_check(BASE, times(21, 100), extra=["--summary", str(summary_path)])
out["refresh_summary_file"] = summary_path.read_text(encoding="utf-8")
out["refresh_movers_top"] = check_refresh.compare(tiny_doc([1.0, 1.0, 1.0]), tiny_doc([1.0, 3.0, 0.1]))["top"][0]["ndc"]

# R05: what the four checks above let through.
replaced = lambda n: {**tiny_doc(BASE[: 1000 - n]), "rows": tiny_doc(BASE[: 1000 - n])["rows"] + tiny_doc([1.0] * n, first=5000)["rows"]}
out["refresh_shared_900"] = refresh_docs(tiny_doc(BASE), replaced(100))
out["refresh_shared_899"] = refresh_docs(tiny_doc(BASE), replaced(101))
out["refresh_990_replaced"] = refresh_docs(tiny_doc(BASE), {**replaced(990), "rows": replaced(990)["rows"][:10] + [{**r, "nadac": {"value": 500.0}} for r in replaced(990)["rows"][10:]]})
out["refresh_older_week"] = refresh_docs(tiny_doc(BASE), tiny_doc(BASE, as_of="2026-10-28"))
out["refresh_no_week"] = refresh_docs(tiny_doc(BASE), {**tiny_doc(BASE), "sources": {"nadac": {"source_file": "n.csv"}}})
out["refresh_empty_week"] = refresh_docs(tiny_doc(BASE), tiny_doc(BASE, as_of=""))
out["refresh_no_counts"] = refresh_docs(tiny_doc(BASE), {k: v for k, v in tiny_doc(BASE).items() if k != "counts"})
out["refresh_shift_50"] = refresh_check(BASE, times(50, 1.5))
out["refresh_shift_51"] = refresh_check(BASE, times(51, 1.5))
out["refresh_shift_51_down"] = refresh_check(BASE, times(51, 1 / 1.5))
out["refresh_shift_51_under"] = refresh_check(BASE, times(51, 1.49))
out["refresh_shift_51_accepted"] = refresh_check(BASE, times(51, 1.5), extra=["--accept-movers"])
out["refresh_499_at_4x"] = refresh_check(BASE, times(499, 4.9))

# R13: a value that is not a positive number is a reason, in the summary, never a traceback.
bad_value = lambda v: {**tiny_doc(BASE), "rows": [{"ndc": "00000000000", "name": "DRUG 0", "nadac": {"value": v}}] + tiny_doc(BASE)["rows"][1:]}
for label, v in (("zero", 0), ("negative", -1.0), ("null", None), ("text", "n/a"), ("nan", float("nan")), ("infinite", float("inf")), ("true", True)):
    out[f"refresh_value_{label}"] = refresh_docs(tiny_doc(BASE), bad_value(v))
no_nadac = tiny_doc(BASE)
del no_nadac["rows"][0]["nadac"]
out["refresh_value_missing"] = refresh_docs(tiny_doc(BASE), no_nadac)
refresh_docs(bad_value(0), tiny_doc(BASE), extra=["--summary", str(summary_path)])
out["refresh_value_old_summary"] = summary_path.read_text(encoding="utf-8")

# ---------------------------------------------------------------- reverify_spotchecks

NADAC_DS = "fbb83258-11c7-47f5-8b18-5f8e79f7e704"
NEW_FILE = "nadac-national-average-drug-acquisition-cost-11-04-2026.csv"
CHECKS = [
    {"id": "n1", "where": "row", "ndc": "00003089421", "path": "nadac.value", "value": 5.0, "source_file": NADAC_FILE, "verified_via": "old", "verified_on": "2026-10-17", "note": "old"},
    {"id": "n2", "where": "row", "ndc": "00003089421", "path": "nadac.effective_date", "value": "2026-09-23", "source_file": NADAC_FILE, "verified_via": "old", "verified_on": "2026-10-17", "note": "old"},
    {"id": "n3", "where": "row", "ndc": "00003089421", "path": "nadac.per", "value": "EA", "source_file": NADAC_FILE, "verified_via": "old", "verified_on": "2026-10-17", "note": "old"},
    {"id": "gone", "where": "row", "ndc": "90000000099", "path": "nadac.value", "value": 1.0, "source_file": NADAC_FILE, "verified_via": "old", "verified_on": "2026-10-17", "note": "old"},
    {"id": "pd", "where": "part_d_names", "key": "Eliquis|Apixaban", "path": "avg_per_unit.value", "value": 9.5, "source_file": "OLD_PARTD.csv", "verified_via": "old", "verified_on": "2026-10-17", "note": "old"},
    {"id": "pd-current", "where": "part_d_names", "key": "Eliquis|Apixaban", "path": "claims.value", "value": 23500000, "source_file": "PARTD.csv", "verified_via": "old", "verified_on": "2026-10-17", "note": "old"},
    {"id": "join", "where": "row", "ndc": "00003089421", "path": "part_d.key", "value": "Eliquis|Apixaban", "source_file": "OLD_PARTD.csv", "verified_via": "old", "verified_on": "2026-10-17", "note": "old"},
    {"id": "limit", "where": "part_b_codes", "key": "J2405", "path": "payment_limit.value", "value": 0.084, "source_file": "old-limits.zip", "verified_via": "old", "verified_on": "2026-10-17", "note": "old"},
    {"id": "xwalk", "where": "row", "ndc": "00409000925", "path": "part_b.package_size.value", "value": 2, "source_file": "old-xwalk.zip", "verified_via": "old", "verified_on": "2026-10-17", "note": "old"},
]
RDOC = {
    "sources": {
        "nadac": {"source_file": NEW_FILE, "as_of_date": "2026-11-04", "source_url": f"https://data.medicaid.gov/dataset/{NADAC_DS}", "title": "NADAC 2026"},
        "partd": {"source_file": "PARTD.csv", "period": "2024-01-01/2024-12-31", "data_year": 2024},
        "asp_limits": {"source_file": "limits.zip"},
        "asp_crosswalk": {"source_file": "xwalk.zip"},
    },
    "part_d_names": {"Eliquis|Apixaban": {"avg_per_unit": {"value": 9.6370356894, "source_file": "PARTD.csv"}, "claims": {"value": 23500000, "source_file": "PARTD.csv"}}},
    "part_b_codes": {"J2405": {"payment_limit": {"value": 0.084, "source_file": "limits.zip"}}},
    "rows": [
        {"ndc": "00003089421", "name": "ELIQUIS 5 MG TABLET", "nadac": {"value": 5.52144, "effective_date": "2026-10-21", "per": "EA", "source_file": NEW_FILE}, "part_d": {"key": "Eliquis|Apixaban"}},
        {"ndc": "00409000925", "name": "ONDANSETRON", "nadac": {"value": 0.17718, "effective_date": "2026-10-21", "per": "ML", "source_file": NEW_FILE}, "part_b": {"package_size": {"value": 2}}},
    ],
}
NADAC_ROW = {"ndc_description": "ELIQUIS 5 MG TABLET", "ndc": "00003089421", "nadac_per_unit": "5.52144", "effective_date": "2026-10-21", "pricing_unit": "EA", "explanation_code": "1", "as_of_date": "2026-11-04"}
PARTD_ROW = {"Brnd_Name": "Eliquis", "Gnrc_Name": "Apixaban", "Mftr_Name": "Overall", "Avg_Spnd_Per_Dsg_Unt_Wghtd_2024": "9.6370356894", "Tot_Clms_2024": "23500000"}
PARTD_API = "https://data.cms.gov/data-api/v1/dataset/da5ff50b-e5da-42de-b68b-6cfac1f64f35/data"
# The 2024 dataset's first distribution has an API-shaped accessURL but is not the API (R10).
CATALOG = {"dataset": [{"title": "Medicare Part D Spending by Drug : 2023-01-01", "distribution": [
    {"format": "API", "accessURL": "https://data.cms.gov/data-api/v1/dataset/aaaaaaaa-e5da-42de-b68b-6cfac1f64f35/data", "temporal": temporal(2023)}]},
    {"title": "Medicare Part D Spending by Drug : 2024-01-01", "distribution": [
        {"format": "CSV", "accessURL": "https://data.cms.gov/data-api/v1/dataset/bbbbbbbb-e5da-42de-b68b-6cfac1f64f35/data", "temporal": temporal(2024)},
        {"format": "CSV", "downloadURL": PARTD_CSV_2024, "temporal": temporal(2024)},
        {"format": "API", "accessURL": PARTD_API, "temporal": temporal(2024)}]}]}
asked = []


reverify_spotchecks.API_WAIT_SECONDS = 0


def reverify_run(nadac_row=NADAC_ROW, partd_row=PARTD_ROW, nadac_error=None, extra=(), checks=CHECKS, partd_busy=0, nadac_rows=None, nadac_busy=0, partd_pages=None):
    data, chk = WORK / "rdoc.json", WORK / "spot.json"
    data.write_text(json.dumps(RDOC), encoding="utf-8")
    chk.write_text(json.dumps(checks, indent=2) + "\n", encoding="utf-8")
    before = chk.read_text(encoding="utf-8")
    asked.clear()
    busy = [partd_busy]
    nbusy = [nadac_busy]

    def get_json(url, timeout=120, limit=None):
        asked.append(url)
        if url == reverify_spotchecks.CMS_CATALOG:
            return CATALOG
        if url.startswith(PARTD_API):
            if busy[0] > 0:
                busy[0] -= 1
                raise FetchError(f"HTTP 503 Service Unavailable from {url}")
            if partd_pages is not None:
                n = int(url.rsplit("offset=", 1)[1]) // reverify_spotchecks.PARTD_PAGE
                return partd_pages[n] if n < len(partd_pages) else []
            if not partd_row:
                return []
            # The tool reads pages and picks the row for this brand, generic and "Overall".
            other = {"Avg_Spnd_Per_Dsg_Unt_Wghtd_2024": "1.0", "Tot_Clms_2024": "1"}
            return [partd_row, {**partd_row, **other, "Mftr_Name": "A Manufacturer"}, {**partd_row, **other, "Gnrc_Name": "Another"}]
        if nadac_error:
            raise nadac_error
        if nbusy[0] > 0:
            nbusy[0] -= 1
            raise FetchError(f"HTTP 503 Service Unavailable from {url}")
        if "90000000099" in url:
            return {"results": []}
        return {"results": nadac_rows if nadac_rows is not None else [nadac_row]}

    real = cachelib.get_json
    cachelib.get_json = get_json
    try:
        r = run(reverify_spotchecks.main, ["--data", str(data), "--checks", str(chk), *extra])
    finally:
        cachelib.get_json = real
    after = chk.read_text(encoding="utf-8")
    return {"code": r["code"], "out": r["out"], "err": r["err"], "written": after != before, "checks": {e["id"]: e for e in json.loads(after)}, "asked": list(asked)}


set_today("2026-11-06")
out["reverify_ok"] = reverify_run()
out["reverify_dry_run"] = reverify_run(extra=["--dry-run"])
out["reverify_nadac_disagrees"] = reverify_run(nadac_row={**NADAC_ROW, "nadac_per_unit": "5.52000"})
out["reverify_partd_disagrees"] = reverify_run(partd_row={**PARTD_ROW, "Avg_Spnd_Per_Dsg_Unt_Wghtd_2024": "9.7"})
out["reverify_api_down"] = reverify_run(nadac_error=urllib.error.URLError(OSError("down")))
out["reverify_api_refuses"] = reverify_run(nadac_error=FetchError("HTTP 503 Backend fetch failed from x"))
out["reverify_api_shape"] = reverify_run(nadac_error=KeyError("results"))
out["reverify_partd_busy_once"] = reverify_run(partd_busy=1)
out["reverify_partd_busy_always"] = reverify_run(partd_busy=99)
out["reverify_all"] = reverify_run(extra=["--all"], checks=[{**c, "source_file": NEW_FILE, "value": 5.52144} for c in CHECKS[:1]] + [CHECKS[5]])
out["reverify_current_untouched"] = reverify_run(checks=[{**CHECKS[0], "source_file": NEW_FILE, "value": 5.52144}])

# R10, R11, R12.
older = {**NADAC_ROW, "nadac_per_unit": "5.00000", "effective_date": "2026-09-30"}
out["reverify_newest_second"] = reverify_run(nadac_rows=[older, NADAC_ROW], checks=CHECKS[:1])
out["reverify_same_decimal"] = reverify_run(nadac_row={**NADAC_ROW, "nadac_per_unit": "5.521440"}, checks=CHECKS[:1])
out["reverify_not_in_data"] = reverify_run(checks=[{**CHECKS[0], "id": "elsewhere", "ndc": "00003089499"}])
out["reverify_nadac_busy_once"] = reverify_run(nadac_busy=1, checks=CHECKS[:1])
r = reverify_run(nadac_error=FetchError("HTTP 404 Not Found from x"), checks=CHECKS[:1])
out["reverify_nadac_404"] = {**r, "nadac_asks": sum(1 for u in r["asked"] if u.startswith(reverify_spotchecks.NADAC_API))}
reverify_spotchecks.PARTD_PAGE = 3
others = [{**PARTD_ROW, "Gnrc_Name": f"Other {i}"} for i in range(3)]
out["reverify_partd_two_pages"] = reverify_run(partd_pages=[others, [PARTD_ROW]], checks=[CHECKS[4]])
reverify_spotchecks.PARTD_PAGE = 5000
out["reverify_current_part_b"] = reverify_run(checks=[{**CHECKS[7], "id": "limit-current", "source_file": "limits.zip"}])

shutil.rmtree(WORK, ignore_errors=True)
print(json.dumps(out))
