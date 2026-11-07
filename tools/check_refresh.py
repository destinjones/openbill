#!/usr/bin/env python3
"""Compare a freshly built data/drugs.json with the previous one. Standard library only.

No test can tell a real price from a unit shift: nothing else compares new data with old, and a
partial fault (some rows ×100, a fifth of the file gone) passes the build and every test. This
stops such a file before anyone merges it. Run it after tools/build_drugs.py. It exits 1 when any
of these fails (docs/DECISIONS.md, decision 53):

  rows            at least MIN_ROW_SHARE of the previous row count
  rejected        at most MAX_REJECT_SHARE of the week's rows (counts.rejected)
  big movers      at most MAX_BIG_MOVERS NDCs whose NADAC moved BIG_MOVE times or more, either way
  median ratio    the median new ÷ old NADAC over shared NDCs stays within MEDIAN_RANGE

The limits rest on one real three-week diff (2026-10-14 to 2026-11-04: largest moves 0.353× and
1.965×, 0 rows at 3× or more, median 1.0, 176 NDCs added and 105 removed), so they are starting
points. A real market event may need a person to look and pass the override below; that is the
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
import statistics
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEW = ROOT / "data" / "drugs.json"
LFS_POINTER = b"version https://git-lfs.github.com/spec/"

MIN_ROW_SHARE = 0.97
MAX_REJECT_SHARE = 0.005
BIG_MOVE = 5
MAX_BIG_MOVERS = 20
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


def nadac_values(doc: dict) -> dict[str, tuple[str, float]]:
    return {r["ndc"]: (r["name"], float(r["nadac"]["value"])) for r in doc["rows"]}


def compare(new: dict, old: dict) -> dict:
    """The figures the checks and the summary use. Pure, so the tests can feed it tiny documents."""
    a, b = nadac_values(old), nadac_values(new)
    shared = sorted(a.keys() & b.keys())  # sorted, so ties print in the same order every run
    movers = []
    ratios = []
    for ndc in shared:
        ratio = b[ndc][1] / a[ndc][1]
        ratios.append(ratio)
        if ratio >= BIG_MOVE or ratio <= 1 / BIG_MOVE:
            movers.append(ndc)
    top = sorted(shared, key=lambda n: max(b[n][1] / a[n][1], a[n][1] / b[n][1]), reverse=True)[:TOP_MOVERS]
    names_old, names_new = {v[0] for v in a.values()}, {v[0] for v in b.values()}
    rejected = (new.get("counts") or {}).get("rejected", 0)
    return {
        "rows_old": len(a),
        "rows_new": len(b),
        "added": len(b.keys() - a.keys()),
        "removed": len(a.keys() - b.keys()),
        "changed": sum(1 for n in shared if a[n][1] != b[n][1]),
        "names_gone": sorted(names_old - names_new),
        "names_new": sorted(names_new - names_old),
        "rejected": rejected,
        "reject_share": rejected / max(len(b) + rejected, 1),
        "big_movers": sorted(movers),
        "median_ratio": statistics.median(ratios) if ratios else None,
        "smallest_ratio": min(ratios, default=None),
        "largest_ratio": max(ratios, default=None),
        "top": [{"ndc": n, "name": b[n][0], "old": a[n][1], "new": b[n][1], "ratio": b[n][1] / a[n][1]} for n in top],
    }


def problems(c: dict, accept_movers: bool = False) -> list[str]:
    out = []
    if c["rows_old"] and c["rows_new"] < MIN_ROW_SHARE * c["rows_old"]:
        out.append(f"rows fell from {c['rows_old']:,} to {c['rows_new']:,}, below {MIN_ROW_SHARE:.0%} of the previous count")
    if c["reject_share"] > MAX_REJECT_SHARE:
        out.append(f"{c['rejected']:,} rows were rejected ({c['reject_share']:.2%}), over {MAX_REJECT_SHARE:.1%}")
    if not accept_movers and len(c["big_movers"]) > MAX_BIG_MOVERS:
        out.append(f"{len(c['big_movers']):,} NDCs moved {BIG_MOVE}× or more, over {MAX_BIG_MOVERS}; pass --accept-movers only after a person has read them")
    m = c["median_ratio"]
    if m is None:
        out.append("no NDC is in both files, so nothing can be compared")
    elif not MEDIAN_RANGE[0] <= m <= MEDIAN_RANGE[1]:
        out.append(f"the median new ÷ old NADAC is {m:.3f}, outside {MEDIAN_RANGE[0]} to {MEDIAN_RANGE[1]}: the whole file may have shifted")
    return out


def source_lines(new: dict, old: dict) -> list[str]:
    lines = []
    for sid, s in new["sources"].items():
        o = old["sources"].get(sid) or {}
        was = o.get("as_of_date") or o.get("period")
        now = s.get("as_of_date") or s.get("period")
        lines.append(f"- `{sid}`: {s.get('source_file')}, {now}" + ("" if was == now else f" (was {was})"))
    return lines


def summary(c: dict, found: list[str], new: dict, old: dict) -> str:
    ratio = lambda x: "none" if x is None else f"{x:.3f}×"
    lines = [
        "## Data refresh check",
        "",
        "**FAILED:**" if found else "All checks passed.",
        *[f"- {p}" for p in found],
        "",
        *source_lines(new, old),
        "",
        f"Rows {c['rows_old']:,} → {c['rows_new']:,} (+{c['added']:,}, −{c['removed']:,}); {c['changed']:,} NADAC values changed; rejected {c['rejected']:,}.",
        f"New ÷ old NADAC: median {ratio(c['median_ratio'])}, smallest {ratio(c['smallest_ratio'])}, largest {ratio(c['largest_ratio'])}; {len(c['big_movers']):,} at {BIG_MOVE}× or more.",
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
