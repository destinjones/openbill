#!/usr/bin/env python3
"""Run every fetcher in turn: NADAC, FDA NDC Directory, Part D, Part B (ASP).

Each runs in its own isolated Python process (-I) with --offline / --force passed through,
prints its own report, and is run even if an earlier one failed. Exit status is non-zero if
any fetcher failed.

Usage:
  python tools/fetch_all.py [--offline] [--force]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FETCHERS = ["fetch_nadac.py", "fetch_fda_ndc.py", "fetch_partd.py", "fetch_asp.py"]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--offline", action="store_true", help="use the cache only; never touch the network")
    ap.add_argument("--force", action="store_true", help="re-download even if the server says unchanged")
    args = ap.parse_args(argv)
    flags = [f for f, on in (("--offline", args.offline), ("--force", args.force)) if on]

    results = []
    for name in FETCHERS:
        print(f"\n=== {name} {' '.join(flags)}".rstrip(), flush=True)
        code = subprocess.call([sys.executable, "-I", str(HERE / name), *flags])
        results.append((name, code))

    print("\n=== summary")
    for name, code in results:
        print(f"  {name:<18} {'ok' if code == 0 else f'FAILED (exit {code})'}")
    failed = [n for n, c in results if c != 0]
    if failed:
        print(f"{len(failed)} of {len(results)} fetchers failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
