#!/usr/bin/env python3
"""Compare a freshly built data/drugs.json with the previous one. Standard library only.

No test can tell a real price from a unit shift: nothing else compares new data with old, and a
partial fault (some rows ×100, a fifth of the file gone) passes the build and every test. This
stops such a file before anyone merges it. Run it after tools/build_drugs.py. It exits 1 when any
of these fails (docs/DECISIONS.md, decision 55):

  values          every row's NADAC value is a positive, finite number, in both files
  rows            at least MIN_ROW_SHARE of the previous row count
  shared          at least MIN_SHARED_SHARE of the previous NDCs are still there
  week            the new NADAC as-of date is not older than the previous one
  rejected        at most MAX_REJECT_SHARE of the week's rows (counts.rejected, which must be there)
  big movers      at most MAX_BIG_MOVERS NDCs whose NADAC moved BIG_MOVE times or more, either way
  shift           at most MAX_SHIFT_SHARE of the shared NDCs moved SHIFT_MOVE times or more, either way
  median ratio    the median new ÷ old NADAC over shared NDCs stays within MEDIAN_RANGE

The limits rest on one real three-week diff (2026-10-14 to 2026-11-04: largest moves 0.353× and
1.965×, 0 rows at 3× or more, median 1.0, 176 NDCs added and 105 removed, 99.65% of the NDCs
shared, 55 of 29,926 (0.18%) moved 1.5× or more), so they are starting points (decision 56). A real market event may need a person to look and pass the override below; that is the
point.

The previous data comes from --previous, or else from HEAD through Git LFS. It prints a summary
for the pull request body, and --summary FILE also writes it to a file.

Usage:
  python tools/check_refresh.py [--new data/drugs.json] [--previous FILE] [--summary FILE]
                                [--accept-movers]
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEW = ROOT / "data" / "drugs.json"
LFS_POINTER = b"version https://git-lfs.github.com/spec/"

MIN_ROW_SHARE = 0.97
MIN_SHARED_SHARE = 0.9
MAX_REJECT_SHARE = 0.005
BIG_MOVE = 5
MAX_BIG_MOVERS = 20
SHIFT_MOVE = 1.5
MAX_SHIFT_SHARE = 0.05
MEDIAN_RANGE = (0.9, 1.1)
TOP_MOVERS = 15


def load_previous_from_git(rel: str = "data/drugs.json") -> dict:
    """data/drugs.json at HEAD, through the LFS filter when HEAD holds a pointer."""
    run = lambda args, **kw: subprocess.run(args, cwd=ROOT, capture_output=True, check=True, **kw).stdout
    try:
        blob = run(["git", "show", f"HEAD:{rel}"])
        if blob.startswith(LFS_POINTER):
            blob = run(["git", "lfs", "smudge"], input=blob)
    except (OSError, subprocess.CalledProcessError) as e:
        sys.exit(f"Could not read the previous {rel} from git ({e}). Pass --previous FILE.")
    if blob.startswith(LFS_POINTER):
        sys.exit(f"HEAD's {rel} is an LFS pointer and the object is not available. Run git lfs pull, or pass --previous FILE.")
    return json.loads(blob.decode("utf-8"))


def positive_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0


def nadac_values(doc: dict) -> tuple[dict[str, tuple[str, float]], list[str]]:
    """NDC → (name, NADAC) for each row whose NADAC value is a positive, finite number, and the NDC
    (or "row N") of each row whose value is not: 0, negative, null, text, NaN, or no nadac at all."""
    good, bad = {}, []
    for i, r in enumerate(doc.get("rows") or []):
        r = r if isinstance(r, dict) else {}
        n = r.get("nadac")
        v = n.get("value") if isinstance(n, dict) else None
        ndc = r.get("ndc")
        if isinstance(ndc, str) and positive_number(v):
            good[ndc] = (r.get("name"), float(v))
        else:
            bad.append(ndc if isinstance(ndc, str) and ndc else f"row {i + 1}")
    return good, bad


def as_of(doc: dict):
    return ((doc.get("sources") or {}).get("nadac") or {}).get("as_of_date")


def compare(new: dict, old: dict) -> dict:
    """The figures the checks and the summary use. Pure, so the tests can feed it tiny documents."""
    (a, bad_old), (b, bad_new) = nadac_values(old), nadac_values(new)
    shared = sorted(a.keys() & b.keys())  # sorted, so ties print in the same order every run
    movers = []
    shifted = 0
    ratios = []
    for ndc in shared:
        ratio = b[ndc][1] / a[ndc][1]
        ratios.append(ratio)
        if ratio >= BIG_MOVE or ratio <= 1 / BIG_MOVE:
            movers.append(ndc)
        if ratio >= SHIFT_MOVE or ratio <= 1 / SHIFT_MOVE:
            shifted += 1
    top = sorted(shared, key=lambda n: max(b[n][1] / a[n][1], a[n][1] / b[n][1]), reverse=True)[:TOP_MOVERS]
    names_old, names_new = {v[0] for v in a.values()}, {v[0] for v in b.values()}
    rejected = (new.get("counts") or {}).get("rejected")
    if not isinstance(rejected, int) or isinstance(rejected, bool) or rejected < 0:
        rejected = None  # missing or not a count: a problem, never read as 0
    return {
        "rows_old": len(a) + len(bad_old),
        "rows_new": len(b) + len(bad_new),
        "bad_old": bad_old,
        "bad_new": bad_new,
        "shared": len(shared),
        "shifted": shifted,
        "as_of_old": as_of(old),
        "as_of_new": as_of(new),
        "added": len(b.keys() - a.keys()),
        "removed": len(a.keys() - b.keys()),
        "changed": sum(1 for n in shared if a[n][1] != b[n][1]),
        "names_gone": sorted(names_old - names_new),
        "names_new": sorted(names_new - names_old),
        "rejected": rejected,
        "reject_share": (rejected or 0) / max(len(b) + (rejected or 0), 1),
        "big_movers": sorted(movers),
        "median_ratio": statistics.median(ratios) if ratios else None,
        "smallest_ratio": min(ratios, default=None),
        "largest_ratio": max(ratios, default=None),
        "top": [{"ndc": n, "name": b[n][0], "old": a[n][1], "new": b[n][1], "ratio": b[n][1] / a[n][1]} for n in top],
    }


def problems(c: dict, accept_movers: bool = False) -> list[str]:
    out = []
    for which, bad in (("new", c["bad_new"]), ("previous", c["bad_old"])):
        if bad:
            one = len(bad) == 1
            out.append(f"{len(bad):,} row{'' if one else 's'} of the {which} file {'has' if one else 'have'} no NADAC value that is a positive number, the first {bad[0]}; {'it is' if one else 'they are'} left out of the comparison")
    if c["rows_old"] and c["rows_new"] < MIN_ROW_SHARE * c["rows_old"]:
        out.append(f"rows fell from {c['rows_old']:,} to {c['rows_new']:,}, below {MIN_ROW_SHARE:.0%} of the previous count")
    if c["rows_old"] and c["shared"] < MIN_SHARED_SHARE * c["rows_old"]:
        out.append(f"only {c['shared']:,} of the previous {c['rows_old']:,} NDCs are in the new file, below {MIN_SHARED_SHARE:.0%}: most of it is other NDCs")
    if not isinstance(c["as_of_new"], str) or not c["as_of_new"]:
        out.append("the new file names no NADAC as-of date (sources.nadac.as_of_date)")
    elif isinstance(c["as_of_old"], str) and c["as_of_new"] < c["as_of_old"]:
        out.append(f"the new file's NADAC is as of {c['as_of_new']}, older than the previous file's {c['as_of_old']}")
    if c["rejected"] is None:
        out.append("the new file has no count of rejected rows (counts.rejected), so their share cannot be checked")
    elif c["reject_share"] > MAX_REJECT_SHARE:
        out.append(f"{c['rejected']:,} rows were rejected ({c['reject_share']:.2%}), over {MAX_REJECT_SHARE:.1%}")
    if not accept_movers and len(c["big_movers"]) > MAX_BIG_MOVERS:
        out.append(f"{len(c['big_movers']):,} NDCs moved {BIG_MOVE}× or more, over {MAX_BIG_MOVERS}; pass --accept-movers only after a person has read them")
    if not accept_movers and c["shared"] and c["shifted"] > MAX_SHIFT_SHARE * c["shared"]:
        out.append(f"{c['shifted']:,} of {c['shared']:,} shared NDCs ({c['shifted'] / c['shared']:.1%}) moved {SHIFT_MOVE}× or more, over {MAX_SHIFT_SHARE:.0%}: part of the file may have shifted; pass --accept-movers only after a person has read them")
    m = c["median_ratio"]
    if m is None:
        out.append("no NDC is in both files, so nothing can be compared")
    elif not MEDIAN_RANGE[0] <= m <= MEDIAN_RANGE[1]:
        out.append(f"the median new ÷ old NADAC is {m:.3f}, outside {MEDIAN_RANGE[0]} to {MEDIAN_RANGE[1]}: the whole file may have shifted")
    return out


def source_lines(new: dict, old: dict) -> list[str]:
    lines = []
    for sid, s in (new.get("sources") or {}).items():
        o = (old.get("sources") or {}).get(sid) or {}
        was = o.get("as_of_date") or o.get("period")
        now = s.get("as_of_date") or s.get("period")
        lines.append(f"- `{sid}`: {s.get('source_file')}, {now}" + ("" if was == now else f" (was {was})"))
    return lines


def summary(c: dict, found: list[str], new: dict, old: dict) -> str:
    ratio = lambda x: "none" if x is None else f"{x:.3f}×"
    rejected = "not counted" if c["rejected"] is None else f"{c['rejected']:,}"
    lines = [
        "## Data refresh check",
        "",
        "**FAILED:**" if found else "All checks passed.",
        *[f"- {p}" for p in found],
        "",
        *source_lines(new, old),
        "",
        f"Rows {c['rows_old']:,} → {c['rows_new']:,} (+{c['added']:,}, −{c['removed']:,}); {c['changed']:,} NADAC values changed; rejected {rejected}.",
        f"NADAC as of {c['as_of_old']} → {c['as_of_new']}; {c['shared']:,} NDCs in both.",
        f"New ÷ old NADAC: median {ratio(c['median_ratio'])}, smallest {ratio(c['smallest_ratio'])}, largest {ratio(c['largest_ratio'])}; {len(c['big_movers']):,} at {BIG_MOVE}× or more, {c['shifted']:,} at {SHIFT_MOVE}× or more.",
        f"Product names gone: {len(c['names_gone'])}. New: {len(c['names_new'])}.",
    ]
    if c["names_gone"]:
        lines.append("Gone: " + "; ".join(c["names_gone"][:20]) + (" …" if len(c["names_gone"]) > 20 else ""))
    if c["top"]:
        lines += ["", "| NDC | product | old | new | new ÷ old |", "|---|---|---|---|---|"]
        lines += [f"| {t['ndc']} | {t['name']} | {t['old']} | {t['new']} | {t['ratio']:.3f} |" for t in c["top"]]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--new", type=Path, default=NEW, help="the freshly built file (default data/drugs.json)")
    ap.add_argument("--previous", type=Path, help="the previous data file (default HEAD's, through Git LFS)")
    ap.add_argument("--summary", type=Path, help="also write the summary to this file")
    ap.add_argument("--accept-movers", action="store_true", help="a person has read the big movers; do not fail on their number")
    args = ap.parse_args(argv)
    new = json.loads(args.new.read_text(encoding="utf-8"))
    old = json.loads(args.previous.read_text(encoding="utf-8")) if args.previous else load_previous_from_git()
    c = compare(new, old)
    found = problems(c, args.accept_movers)
    text = summary(c, found, new, old)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(text)
    if args.summary:
        args.summary.write_text(text, encoding="utf-8", newline="\n")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
