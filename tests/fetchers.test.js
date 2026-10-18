// The fetchers' defences against hostile pages, catalogs and servers (review PY-1 to PY-4):
// cache file names, URL scheme and host, redirects, HTTP errors against network errors, size
// caps, zip bombs and the ASP link scan. The checks run in Python (python -I, standard library
// only), against tools/cachelib.py and tools/fetch_asp.py, with a temporary cache directory and
// stubbed network calls: nothing is downloaded and tools/cache/ is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TOOLS = fileURLToPath(new URL('../tools/', import.meta.url));

const HARNESS = String.raw`
import io, json, os, sys, tempfile, time, urllib.error, urllib.request, zipfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import cachelib, fetch_asp
from cachelib import FetchError

out = {}
def refused(fn, *a):
    try:
        fn(*a)
    except FetchError as e:
        return str(e)
    return None

real = json.loads((cachelib.CACHE / "manifest.json").read_text(encoding="utf-8")) if (cachelib.CACHE / "manifest.json").exists() else {}
tmp = Path(tempfile.mkdtemp(prefix="openbill-fetch-"))
cachelib.CACHE = tmp
cachelib.MANIFEST = tmp / "manifest.json"
cachelib.MANIFEST.write_text(json.dumps({"nadac": {"file": "nadac-2026.csv"}, "asp_limits": {"file": "october-2026-limits.zip"}}), encoding="utf-8")

# PY-1: cache file names.
out["names_ok"] = [n for n in ["nadac-2026.csv", "october-2026-limits.zip", "DSD_PTD_RY26_P04_V10_DY24_BGM.csv", "ndctext.zip"] if refused(cachelib.safe_cache_name, "nadac" if n.startswith("nadac") else "asp_limits" if n.startswith("october") else "partd", n)]
out["real_names_ok"] = [e["file"] for k, e in real.items() if isinstance(e, dict) and e.get("file") and not cachelib.SAFE_NAME_RE.match(e["file"])]
bad = ["D:evil.csv", "x.csv:stream", "manifest.json", "manifest.json.part", "a.csv.part", "CON.csv", "nul.zip", "com1.zip", "../x.csv", "..\\x.csv", "sub/x.csv", ".hidden.csv", "-x.csv", "\u00fcml.csv", "evil.exe", "x.csv?v=2", "", "a" * 200 + ".csv"]
out["names_not_refused"] = [n for n in bad if not refused(cachelib.safe_cache_name, "partd", n)]
out["other_source_name"] = refused(cachelib.safe_cache_name, "asp_crosswalk", "october-2026-limits.zip")
try:
    cachelib.cached_path({"file": "D:evil.csv"})
    out["cached_path_unsafe"] = None
except cachelib.HashMismatch as e:
    out["cached_path_unsafe"] = str(e)
link = {"url": "https://www.cms.gov/files/zip/manifest.json#.zip", "link_text": "October 2027 Medicare Part B Payment Limit Files", "posted": None}
out["fragment_zip_link"] = refused(fetch_asp.meta_for, "limits", {"quarter": (2027, 10), "limits": link, "crosswalk": link})
link2 = {**link, "url": "https://www.cms.gov/files/zip/D:evil.zip"}
out["drive_zip_link"] = fetch_asp.meta_for("limits", {"quarter": (2027, 10), "limits": link2, "crosswalk": link2})["file"]

# PY-2: scheme and host, before every request and on every redirect.
urls = [u for e in real.values() if isinstance(e, dict) for u in (e.get("download_url"), e.get("landing_url")) if u]
out["real_urls_refused"] = [u for u in urls if refused(cachelib.check_url, u)]
badu = ["file:///C:/Windows/win.ini", "http://www.cms.gov/x.zip", "https://evil.example/x.zip", "data:text/plain,x", "ftp://www.cms.gov/x.zip",
        "https://user:pw@www.cms.gov/x.zip", "https://www.cms.gov:8443/x.zip", "https://www.cms.gov.evil.example/x.zip", "//www.cms.gov/x.zip", "HTTPS://evil.example/"]
out["urls_not_refused"] = [u for u in badu if not refused(cachelib.check_url, u)]
req = urllib.request.Request("https://www.cms.gov/files/zip/a.zip")
h = cachelib._CheckedRedirects()
out["redirect_http"] = refused(h.redirect_request, req, None, 302, "Found", {}, "http://www.cms.gov/files/zip/a.zip")
out["redirect_host"] = refused(h.redirect_request, req, None, 302, "Found", {}, "https://evil.example/a.zip")
out["redirect_same_host_ok"] = h.redirect_request(req, None, 302, "Found", {}, "https://www.cms.gov/files/zip/b.zip").full_url
out["opener_has_no_file_handler"] = not any(isinstance(x, (urllib.request.FileHandler, urllib.request.FTPHandler, urllib.request.DataHandler)) for x in cachelib._OPENER.handlers)

# PY-4: an HTTP error status is a failure (exit 4), a network failure falls back to the cache,
# and a local OSError is a failure.
def raise_http(*a, **k):
    raise urllib.error.HTTPError("https://www.cms.gov/x.zip", 404, "Not Found", {}, io.BytesIO(b""))
cachelib._OPENER.open = raise_http
out["http_404"] = refused(cachelib.http, "https://www.cms.gov/x.zip")
body = b"cached,bytes\n"
(tmp / "cached.csv").write_bytes(body)
import hashlib
entry = {"file": "cached.csv", "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(), "download_url": "https://www.cms.gov/cached.csv", "landing_url": "https://www.cms.gov/"}
man = json.loads(cachelib.MANIFEST.read_text(encoding="utf-8")); man["partd"] = entry
cachelib.MANIFEST.write_text(json.dumps(man), encoding="utf-8")
def resolve_404():
    cachelib.http("https://www.cms.gov/catalog.json")
def resolve_offline():
    raise urllib.error.URLError(OSError("getaddrinfo failed"))
def resolve_disk():
    raise PermissionError(13, "Permission denied", str(tmp / "x.csv.part"))
out["run_404"] = cachelib.run_source("partd", "T", resolve_404, False, False)[2]
out["run_network_down"] = cachelib.run_source("partd", "T", resolve_offline, False, False)[2]
out["run_local_oserror"] = cachelib.run_source("partd", "T", resolve_disk, False, False)[2]
out["network_errors_exclude_oserror"] = OSError not in cachelib.NETWORK_ERRORS and urllib.error.HTTPError.__mro__[1] is urllib.error.URLError

# PY-3: size caps on pages, downloads and zip members.
class Resp:
    def __init__(self, data, length=None):
        self.headers = {"Content-Length": length} if length is not None else {}
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
out["page_over_cap"] = refused(cachelib._read_capped, Resp(b"x" * 101), 100, "u")
out["page_declared_over_cap"] = refused(cachelib._read_capped, Resp(b"", "1000000"), 100, "u")
out["page_at_cap_ok"] = len(cachelib._read_capped(Resp(b"x" * 100), 100, "u"))
cachelib.http = lambda url, method="GET", headers=None, timeout=60: Resp(b"y" * 5000)
out["download_over_cap"] = refused(cachelib._download, "https://www.cms.gov/big.csv", tmp / "big.csv", 4096)
out["download_part_left"] = sorted(p.name for p in tmp.glob("*.part"))
bomb = tmp / "bomb.zip"
with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("big.csv", b"\0" * (48 << 20))
    z.writestr("small.csv", b"a,b\n1,2\n")
out["zip_bomb_check"] = refused(cachelib.check_zip, bomb)
with zipfile.ZipFile(bomb) as z:
    out["zip_bomb_read"] = refused(cachelib.read_zip_member, z, "big.csv")
    out["zip_small_read"] = cachelib.read_zip_member(z, "small.csv").decode()
out["real_zips_pass"] = [e["file"] for k, e in real.items() if isinstance(e, dict) and str(e.get("file", "")).endswith(".zip") and (Path(sys.argv[1]) / "cache" / e["file"]).exists() and refused(cachelib.check_zip, Path(sys.argv[1]) / "cache" / e["file"])]

# PY-3: the ASP link scan is linear and finds what the page links.
page = '<p><a href="/files/zip/october-2026-medicare-part-b-payment-limit-files-final.zip">October 2026 Medicare Part B Payment Limit Files <span>(ZIP)</span></a> 09/17/2026</p><a href="/x.pdf">pdf</a><A HREF="/files/zip/b.zip" class=x>B</A>tail'
out["links"] = [list(x) for x in fetch_asp.iter_zip_links(page)]
t = time.perf_counter()
list(fetch_asp.iter_zip_links('<a href="x.zip">' * 40000))
list(fetch_asp.iter_zip_links('<a href="x.zip">y</a>' * 40000))
out["scan_seconds"] = time.perf_counter() - t
print(json.dumps(out))
`;

function python() {
  for (const exe of ['python', 'python3']) {
    const r = spawnSync(exe, ['-I', '-c', 'import sys; print(sys.version_info[:2] >= (3, 10))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return exe;
  }
  return null;
}

test('fetchers refuse hostile names, URLs, redirects, sizes and zips; HTTP errors are failures', (t) => {
  const exe = python();
  if (!exe) {
    t.skip('Python 3.10+ is not on PATH');
    return;
  }
  const r = spawnSync(exe, ['-I', '-', path.resolve(TOOLS)], { input: HARNESS, encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim().split('\n').pop());
  // PY-1
  assert.deepEqual(o.names_ok, [], 'real-looking names are accepted');
  assert.deepEqual(o.real_names_ok, [], 'every name in tools/cache/manifest.json passes');
  assert.deepEqual(o.names_not_refused, [], 'drive letters, streams, the manifest, device names, separators');
  assert.match(o.other_source_name, /already belongs to source 'asp_limits'/);
  assert.match(o.cached_path_unsafe, /unsafe cache file/);
  assert.match(o.fragment_zip_link, /does not point at a \.zip file/);
  assert.equal(o.drive_zip_link, 'D-evil.zip', 'a drive-letter name from a link becomes a plain name inside the cache');
  // PY-2
  assert.deepEqual(o.real_urls_refused, [], 'every URL in the manifest is allowed');
  assert.deepEqual(o.urls_not_refused, [], 'file:, http:, data:, ftp:, other hosts, credentials and ports');
  assert.match(o.redirect_http, /refusing URL/);
  assert.match(o.redirect_host, /refusing URL/);
  assert.equal(o.redirect_same_host_ok, 'https://www.cms.gov/files/zip/b.zip');
  assert.equal(o.opener_has_no_file_handler, true);
  // PY-4
  assert.match(o.http_404, /HTTP 404/);
  assert.equal(o.run_404, 4, 'an HTTP 404 is "source not as expected", not "offline"');
  assert.equal(o.run_network_down, 0, 'no network still falls back to the verified cache');
  assert.equal(o.run_local_oserror, 4, 'a local file error is a failure');
  assert.equal(o.network_errors_exclude_oserror, true);
  // PY-3
  assert.match(o.page_over_cap, /over the 100-byte limit/);
  assert.match(o.page_declared_over_cap, /over the 100-byte limit/);
  assert.equal(o.page_at_cap_ok, 100);
  assert.match(o.download_over_cap, /passed the 4,096-byte limit/);
  assert.deepEqual(o.download_part_left, [], 'a stopped download leaves no .part file');
  assert.match(o.zip_bomb_check, /would expand/);
  assert.match(o.zip_bomb_read, /would expand/);
  assert.equal(o.zip_small_read, 'a,b\n1,2\n');
  assert.deepEqual(o.real_zips_pass, [], 'the cached ASP and FDA zips pass the zip checks');
  assert.deepEqual(o.links, [
    ['/files/zip/october-2026-medicare-part-b-payment-limit-files-final.zip', 'October 2026 Medicare Part B Payment Limit Files <span>(ZIP)</span>', ' 09/17/2026</p><a href="/x.pdf">pdf</a><A HREF="/files/zip/b.zip" class=x>B</A>tail'],
    ['/files/zip/b.zip', 'B', 'tail'],
  ]);
  assert.ok(o.scan_seconds < 2, `the link scan took ${o.scan_seconds}s over 80,000 links`);
});
