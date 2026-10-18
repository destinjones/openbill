"""Shared download cache for the tools/fetch_*.py scripts. Standard library only.

Every source lives in tools/cache/ with one entry in tools/cache/manifest.json, keyed by source
id (nadac, fda_ndc, fda_ndc_excluded, partd, asp_limits, asp_crosswalk). An entry records:

  landing_url, download_url, file, sha256, bytes, etag, last_modified,
  retrieved_at, retrieved_date, checked_at,
  title, publisher, license, period, as_of_date      (+ any source-specific metadata)

Rules every fetcher follows through this module:
  * Unchanged on the server (same URL and the same ETag / Last-Modified as recorded) means the
    file is not downloaded again.
  * Every run verifies the cached bytes against the recorded sha256 and refuses to go on if
    they differ.
  * --offline never touches the network; a network failure (no connection, DNS, a timeout)
    falls back to the cache. An HTTP error status, a refused URL or file name, or a local disk
    error is a failure, never a silent fallback.
  * --force downloads again even if the server says nothing changed.
  * Only https:// URLs to the hosts in ALLOWED_HOSTS are fetched, redirects included, and
    every download, page and zip member has a size cap.

Downloaded files are untrusted data: this module only stores and hashes them.
"""

from __future__ import annotations

import argparse
import datetime as dt
import email.utils
import hashlib
import json
import os
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

CACHE = Path(__file__).resolve().parent / "cache"
MANIFEST = CACHE / "manifest.json"
USER_AGENT = "OpenBill/0.1 (open-source price transparency; offline builder)"

# Network failures that mean "use the cache instead". An HTTP error status (404, 500 ...) is not
# one of them: the server answered, and its answer is not the source we expect (FetchError,
# exit 4). Nor is a local OSError (a bad file name, a full disk): that propagates as a failure.
NETWORK_ERRORS = (urllib.error.URLError, TimeoutError, ConnectionError, socket.timeout, socket.gaierror)

# Every request, and every redirect, must be https:// to one of these hosts. The URLs come from
# pages and catalogs OpenBill does not control, so nothing else is fetched: no file://, data:,
# ftp://, plain http://, or another host.
ALLOWED_HOSTS = frozenset({
    "data.medicaid.gov",
    "download.medicaid.gov",
    "data.cms.gov",
    "www.cms.gov",
    "www.fda.gov",
    "www.accessdata.fda.gov",
})

# Size caps. A download stops, and is discarded, past its cap; pages and JSON are read up to
# PAGE_LIMIT; a zip member is never decompressed past ZIP_MEMBER_LIMIT or at a ratio above
# ZIP_MAX_RATIO (a zip bomb). Real sizes on 2026-10-17: NADAC 107 MB, the FDA zip 11 MB (its
# members about 70 MB), Part D 5 MB, the ASP zips under 1 MB, the data.cms.gov catalog 18 MB.
DOWNLOAD_LIMITS = {
    "nadac": 1 << 30,
    "fda_ndc": 256 << 20,
    "partd": 256 << 20,
    "asp_limits": 64 << 20,
    "asp_crosswalk": 64 << 20,
}
DEFAULT_DOWNLOAD_LIMIT = 1 << 30
PAGE_LIMIT = 128 << 20
ZIP_MEMBER_LIMIT = 1 << 30
ZIP_MAX_RATIO = 200

# A cache file name: plain ASCII letters, digits, '.', '_' and '-', starting with a letter or
# digit, ending in .csv or .zip. Also refused: the manifest, partial downloads, Windows device
# names, and a name another source already uses (safe_cache_name).
SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.(?:csv|zip)$")
WINDOWS_DEVICES = frozenset({"con", "prn", "aux", "nul", *(f"com{i}" for i in range(10)), *(f"lpt{i}" for i in range(10))})

# Fields every manifest entry carries (build_drugs.py relies on them).
ENTRY_FIELDS = (
    "landing_url", "download_url", "file", "sha256", "bytes", "etag", "last_modified",
    "retrieved_at", "retrieved_date", "checked_at",
    "title", "publisher", "license", "period", "as_of_date",
)


class FetchError(Exception):
    """The source is not what we expect. Stop rather than guess."""


class HashMismatch(FetchError):
    pass


# ---------------------------------------------------------------- network

def check_url(url: str) -> str:
    """url, if it is https:// to an allowed host with no credentials or other port; else FetchError."""
    try:
        u = urllib.parse.urlsplit(str(url))
        port = u.port
    except ValueError as e:
        raise FetchError(f"refusing malformed URL {url!r}: {e}") from None
    host = (u.hostname or "").lower()
    if u.scheme != "https" or host not in ALLOWED_HOSTS or u.username or u.password or port not in (None, 443):
        raise FetchError(f"refusing URL {url!r}: only https:// to {', '.join(sorted(ALLOWED_HOSTS))} is fetched")
    return url


class _CheckedRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only to another allowed https:// URL: never a downgrade or another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(urllib.parse.urljoin(req.full_url, newurl))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _opener() -> urllib.request.OpenerDirector:
    # Only the http(s) handlers, so a file://, ftp:// or data: URL cannot be opened even if a
    # check above were ever bypassed.
    o = urllib.request.OpenerDirector()
    for h in (urllib.request.ProxyHandler(), urllib.request.UnknownHandler(), urllib.request.HTTPHandler(),
              urllib.request.HTTPDefaultErrorHandler(), _CheckedRedirects(), urllib.request.HTTPErrorProcessor(),
              urllib.request.HTTPSHandler()):
        o.add_handler(h)
    return o


_OPENER = _opener()


def http(url: str, method: str = "GET", headers: dict | None = None, timeout: int = 60):
    """Open url. The URL, every redirect and the final URL must pass check_url. An HTTP error
    status raises FetchError naming it; only a failure to reach the server is a network error."""
    req = urllib.request.Request(check_url(url), method=method, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        r = _OPENER.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        e.close()
        raise FetchError(f"HTTP {e.code} {e.reason} from {url}") from None
    try:
        check_url(r.geturl())
    except FetchError:
        r.close()
        raise
    return r


def _read_capped(r, limit: int, url: str) -> bytes:
    length = r.headers.get("Content-Length")
    if length is not None and length.strip().isdigit() and int(length) > limit:
        raise FetchError(f"{url} is {int(length):,} bytes, over the {limit:,}-byte limit")
    data = r.read(limit + 1)
    if len(data) > limit:
        raise FetchError(f"{url} is over the {limit:,}-byte limit")
    return data


def get_bytes(url: str, timeout: int = 120, accept: str | None = None, limit: int = PAGE_LIMIT) -> bytes:
    with http(url, headers={"Accept": accept} if accept else None, timeout=timeout) as r:
        return _read_capped(r, limit, url)


def get_json(url: str, timeout: int = 120, limit: int = PAGE_LIMIT):
    return json.loads(get_bytes(url, timeout=timeout, accept="application/json", limit=limit).decode("utf-8"))


def get_text(url: str, timeout: int = 60, limit: int = PAGE_LIMIT) -> str:
    with http(url, timeout=timeout) as r:
        charset = r.headers.get_content_charset() or "utf-8"
        data = _read_capped(r, limit, url)
    try:
        return data.decode(charset, errors="replace")
    except LookupError:
        raise FetchError(f"{url}: unknown charset {charset!r}") from None


def server_headers(url: str) -> dict:
    """ETag and Last-Modified for url, by HEAD (falling back to a GET we don't read)."""
    try:
        with http(url, method="HEAD") as r:
            return {"etag": r.headers.get("ETag"), "last_modified": r.headers.get("Last-Modified")}
    except FetchError as e:
        if not re.match(r"HTTP (403|405|501) ", str(e)):
            raise
    with http(url) as r:  # some servers refuse HEAD; close without reading the body
        return {"etag": r.headers.get("ETag"), "last_modified": r.headers.get("Last-Modified")}


# ---------------------------------------------------------------- files

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest() -> dict:
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {}


def save_entry(key: str, entry: dict) -> None:
    """Write one source's entry, re-reading the manifest so other sources' entries survive."""
    CACHE.mkdir(parents=True, exist_ok=True)
    manifest = load_manifest()
    manifest[key] = dict(sorted(entry.items()))
    tmp = MANIFEST.with_name(MANIFEST.name + ".part")
    with tmp.open("w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, MANIFEST)


def _inside_cache(name: str) -> bool:
    return bool(SAFE_NAME_RE.match(str(name))) and (CACHE / name).resolve().parent == CACHE.resolve()


def safe_cache_name(key: str, name: str) -> str:
    """name, if it is a safe file name inside tools/cache for source `key`; else FetchError.

    Refused: anything but plain ASCII letters, digits, '.', '_' and '-' ending in .csv or .zip
    (so no path separator, drive letter such as 'D:evil.csv' or NTFS stream such as
    'x.csv:stream'); the manifest; a partial download; a Windows device name (CON, NUL, COM1 ...);
    and a name another source already uses.
    """
    if not isinstance(name, str) or not SAFE_NAME_RE.match(name):
        raise FetchError(f"{key}: refusing unsafe cache file name {name!r}")
    low = name.lower()
    if low == MANIFEST.name.lower() or low.endswith(".part") or low.split(".", 1)[0] in WINDOWS_DEVICES:
        raise FetchError(f"{key}: refusing reserved cache file name {name!r}")
    for other, e in load_manifest().items():
        if other != key and isinstance(e, dict) and str(e.get("file", "")).lower() == low:
            raise FetchError(f"{key}: cache file name {name!r} already belongs to source {other!r}")
    if not _inside_cache(name):
        raise FetchError(f"{key}: cache file name {name!r} resolves outside {CACHE}")
    return name


def cached_path(entry: dict) -> Path:
    if not _inside_cache(entry["file"]):
        raise HashMismatch(f"the manifest names an unsafe cache file {entry['file']!r}")
    return CACHE / entry["file"]


def check_zip(path: Path) -> None:
    """Refuse a zip whose members would decompress past ZIP_MEMBER_LIMIT or at a ratio above
    ZIP_MAX_RATIO. Reads only the zip's directory; nothing is decompressed."""
    try:
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                _check_zip_info(info, path.name)
    except zipfile.BadZipFile as e:
        raise FetchError(f"{path.name}: not a readable zip ({e})") from None


def _check_zip_info(info: zipfile.ZipInfo, where: str) -> None:
    if info.file_size > ZIP_MEMBER_LIMIT:
        raise FetchError(f"{where}: member {info.filename!r} declares {info.file_size:,} bytes, over the {ZIP_MEMBER_LIMIT:,}-byte limit")
    if info.file_size > (1 << 20) and info.file_size > ZIP_MAX_RATIO * max(info.compress_size, 1):
        raise FetchError(f"{where}: member {info.filename!r} would expand {info.file_size / max(info.compress_size, 1):,.0f} times, over {ZIP_MAX_RATIO}")


def read_zip_member(z: zipfile.ZipFile, member: str) -> bytes:
    """z.read(member), after checking its declared size and ratio, and never reading past
    ZIP_MEMBER_LIMIT whatever it declares (a zip bomb is refused)."""
    info = z.getinfo(member)
    _check_zip_info(info, "zip")
    with z.open(info) as f:
        data = f.read(ZIP_MEMBER_LIMIT + 1)
    if len(data) > ZIP_MEMBER_LIMIT:
        raise FetchError(f"zip member {member!r} is over the {ZIP_MEMBER_LIMIT:,}-byte limit")
    return data


def verify(entry: dict) -> Path:
    """The cached file for entry, after checking size and sha256. Raises HashMismatch."""
    path = cached_path(entry)
    if not path.exists():
        raise HashMismatch(f"cached file missing: {path.name}")
    size = path.stat().st_size
    if size != entry["bytes"]:
        raise HashMismatch(f"{path.name}: {size} bytes on disk, manifest says {entry['bytes']}")
    got = sha256_file(path)
    if got != entry["sha256"]:
        raise HashMismatch(f"{path.name}: sha256 {got}, manifest says {entry['sha256']}")
    return path


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def http_date_to_iso(value: str | None) -> str | None:
    """'Fri, 16 Oct 2026 08:15:39 GMT' -> '2026-10-16' (None if absent or unparseable)."""
    if not value:
        return None
    try:
        return email.utils.parsedate_to_datetime(value).date().isoformat()
    except (TypeError, ValueError):
        return None


def _download(url: str, dest: Path, limit: int = DEFAULT_DOWNLOAD_LIMIT) -> tuple[str, int, dict]:
    part = dest.with_name(dest.name + ".part")
    h = hashlib.sha256()
    size = 0
    try:
        with http(url, timeout=600) as r:
            expected = r.headers.get("Content-Length")
            if expected is not None and (not expected.strip().isdigit() or int(expected) > limit):
                raise FetchError(f"{url}: Content-Length {expected!r} is not a size within the {limit:,}-byte limit")
            headers = {"etag": r.headers.get("ETag"), "last_modified": r.headers.get("Last-Modified")}
            with part.open("wb") as f:
                for chunk in iter(lambda: r.read(1 << 20), b""):
                    size += len(chunk)
                    if size > limit:
                        raise FetchError(f"{url}: the download passed the {limit:,}-byte limit, so it was stopped")
                    f.write(chunk)
                    h.update(chunk)
                    if size % (32 << 20) < len(chunk):
                        print(f"  ... {size / 1e6:,.0f} MB", flush=True)
        if expected is not None and int(expected) != size:
            raise FetchError(f"truncated download: got {size} bytes, server said {expected}")
        if size == 0:
            raise FetchError("server returned an empty file")
        if dest.suffix.lower() == ".zip":
            check_zip(part)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    os.replace(part, dest)
    return h.hexdigest(), size, headers


def _unchanged(old: dict, now_headers: dict) -> bool:
    """Same ETag and Last-Modified as recorded, and the server sent at least one of them."""
    if not (now_headers.get("etag") or now_headers.get("last_modified")):
        return False  # nothing to compare against; we cannot tell, so download
    return now_headers.get("etag") == old.get("etag") and now_headers.get("last_modified") == old.get("last_modified")


def ensure(key: str, meta: dict, force: bool = False) -> tuple[dict, str]:
    """Bring source `key` up to date with meta (must hold download_url and file).

    Returns (manifest entry, what happened). Saves the entry. Raises on network errors so the
    caller can fall back to the cache, and FetchError on a refused URL or file name.
    """
    for need in ("download_url", "file", "landing_url"):
        if not meta.get(need):
            raise FetchError(f"{key}: metadata is missing {need}")
    CACHE.mkdir(parents=True, exist_ok=True)
    safe_cache_name(key, meta["file"])
    check_url(meta["download_url"])
    old = load_manifest().get(key)
    now = utc_now().isoformat()

    same_url = old is not None and old.get("download_url") == meta["download_url"] and old.get("file") == meta["file"]
    if same_url and not force:
        # A cached file that no longer matches its recorded hash is never silently replaced:
        # the run stops, and --force is the explicit way to fetch it again.
        verify(old)
        if _unchanged(old, server_headers(meta["download_url"])):
            entry = {**old, **meta, "checked_at": now}
            save_entry(key, entry)
            return entry, "unchanged on server; cached copy verified, not re-downloaded"

    print(f"Downloading {meta['download_url']}", flush=True)
    digest, size, headers = _download(meta["download_url"], CACHE / meta["file"], DOWNLOAD_LIMITS.get(key, DEFAULT_DOWNLOAD_LIMIT))
    if old and digest == old.get("sha256"):
        happened = "re-downloaded; bytes identical to the cached copy"
        retrieved_at = old["retrieved_at"]
    else:
        happened = "new file downloaded"
        retrieved_at = now
    entry = {
        **meta,
        **headers,
        "sha256": digest,
        "bytes": size,
        "retrieved_at": retrieved_at,
        "retrieved_date": retrieved_at[:10],
        "checked_at": now,
    }
    for f in ENTRY_FIELDS:
        entry.setdefault(f, None)
    save_entry(key, entry)
    if old and old.get("file") and old["file"] != meta["file"]:
        _drop_superseded(old["file"])
    return entry, happened


def _drop_superseded(name: str) -> None:
    """Remove a cached file no manifest entry points at any more."""
    if any(e.get("file") == name for e in load_manifest().values()):
        return
    if not _inside_cache(name) or name.lower() == MANIFEST.name.lower():
        return
    p = CACHE / name
    if p.exists():
        p.unlink()
        print(f"  removed superseded cache file {name}")


def update_entry(key: str, **fields) -> dict:
    """Add fields (e.g. as_of_date read from the file itself) to an existing entry."""
    entry = {**load_manifest()[key], **fields}
    save_entry(key, entry)
    return entry


# ---------------------------------------------------------------- CLI glue

def arg_parser(description: str) -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=description)
    ap.add_argument("--offline", action="store_true", help="use the cache only; never touch the network")
    ap.add_argument("--force", action="store_true", help="re-download even if the server says unchanged")
    return ap


def run_source(key: str, label: str, resolve, offline: bool, force: bool) -> tuple[dict | None, str, int]:
    """Common fetch flow: resolve metadata online, ensure the file, or fall back to the cache.

    resolve() -> meta dict (network). Returns (entry, happened, exit code). Exit codes:
    0 ok, 2 nothing cached and no network, 3 hash mismatch, 4 source not as expected (an HTTP
    error status, a refused URL, file name or size, or a local file error).
    """
    entry, happened = None, None
    if not offline:
        try:
            entry, happened = ensure(key, resolve(), force)
        except HashMismatch as e:
            print(f"{label}: HASH CHECK FAILED: {e}. Refusing to proceed; re-run with --force to fetch it again.", file=sys.stderr)
            return None, "", 3
        except FetchError as e:
            print(f"{label}: FAILED: {e}", file=sys.stderr)
            return None, "", 4
        except NETWORK_ERRORS as e:
            print(f"{label}: network unavailable ({e}); falling back to the cache.", file=sys.stderr)
        except OSError as e:
            print(f"{label}: FAILED: local file error: {e}", file=sys.stderr)
            return None, "", 4
    if entry is None:
        entry = load_manifest().get(key)
        if entry is None:
            print(f"{label}: no cached copy and no network. Run once online first.", file=sys.stderr)
            return None, "", 2
        happened = "offline; using cached copy"
    try:
        verify(entry)
    except HashMismatch as e:
        print(f"{label}: HASH CHECK FAILED: {e}. Refusing to proceed; re-run online with --force.", file=sys.stderr)
        return None, "", 3
    return entry, happened, 0
