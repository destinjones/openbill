#!/usr/bin/env python3
"""Run every fetcher in turn: NADAC, FDA NDC Directory, Part D, Part B (ASP).

Each runs in its own isolated Python process (-I) with --offline / --force passed through,
prints its own report, and is run even if an earlier one failed. Exit status is non-zero if
any fetcher failed.

A fetcher that could only use its cached copy because the network failed is listed as NOT
REFRESHED. That is still exit 0 for a person working offline; with --require-online it is a
failure. A refresh job should always pass --require-online and should not restore tools/cache.

Usage:
  python tools/fetch_all.py [--offline | --require-online] [--force]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FETCHERS = ["fetch_nadac.py", "fetch_fda_ndc.py", "fetch_partd.py", "fetch_asp.py"]
EXIT_NOT_REFRESHED = 5  # cachelib.EXIT_NOT_REFRESHED; this script imports nothing from tools/


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--force", action="store_true", help="re-download even if the server says unchanged")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--offline", action="store_true", help="use the cache only; never touch the network")
    mode.add_argument("--require-online", action="store_true", help="fail if a fetcher could only use its cached copy")
    args = ap.parse_args(argv)
    flags = [f for f, on in (("--offline", args.offline), ("--force", args.force)) if on]
    # Every online child is asked to report a fallback by its exit code, so the summary can say so.
    child_flags = flags if args.offline else [*flags, "--require-online"]

    results = []
    for name in FETCHERS:
        print(f"\n=== {name} {' '.join(flags)}".rstrip(), flush=True)
        code = subprocess.call([sys.executable, "-I", str(HERE / name), *child_flags])
        results.append((name, code))

    print("\n=== summary")
    for name, code in results:
        if code == 0:
            word = "ok"
        elif code == EXIT_NOT_REFRESHED:
            word = "NOT REFRESHED (the network failed; cached copy verified)"
        else:
            word = f"FAILED (exit {code})"
        print(f"  {name:<18} {word}")
    failed = [n for n, c in results if c not in (0, EXIT_NOT_REFRESHED)]
    stale = [n for n, c in results if c == EXIT_NOT_REFRESHED]
    if stale:
        print(f"NOT REFRESHED: {', '.join(stale)} used the cached copy because the network failed.", file=sys.stderr)
    if failed:
        print(f"{len(failed)} of {len(results)} fetchers failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    if stale and args.require_online:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
