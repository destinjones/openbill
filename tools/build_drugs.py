#!/usr/bin/env python3
"""Build data/drugs.json (schema openbill.drugs/3) from tools/cache/. Never touches the network.

Inputs (each verified against its sha256 in tools/cache/manifest.json before anything is read):
  nadac          NADAC weekly file: one row per NDC in the newest weekly file.
  fda_ndc        FDA NDC Directory: row.identity, by exact NDC-11 join, with identity.pharm_classes
                 from the product's PHARM_CLASSES (left out when FDA gives none).
  partd          Medicare Part D Spending by Drug: part_d_names (one entry per Part D "Overall"
                 row some NDC joined), and row.part_d = {key, basis} pointing into it, by brand /
                 generic NAME join (precision over recall: ambiguous or release-form-mismatched
                 names stay null; a name CMS marks * keeps only NDCs with a known FDA route, in
                 the route the NDCs joined to it share: the route of the row's FDA identity, or,
                 for an NDC the Directory does not list as a package of its own, the route of
                 the FDA product record of its product code that the join already accepted,
                 which follows the identity rows' route and never votes; recorded on the row as
                 part_d.route_from = "fda_product" with route, product_ndc and inner_of).
  asp_crosswalk  Part B NDC-HCPCS crosswalk: NDC-11 -> HCPCS, package size and billable units
                 (row.part_b), and the labelers billing under each code.
  asp_limits     Part B payment limit file: part_b_codes (HCPCS -> payment limit, coinsurance),
                 one entry per code some row points to.

Part D publishes one figure per drug name and Part B one limit per HCPCS code, so those figures
are written once, in tables keyed the way CMS keys them; facts that are per NDC stay on the row.

Every number written is a full provenance record (value, kind, state, reason, source_name,
source_url, source_file, effective_date, retrieved_date, and where they apply as_of_date, per,
period; optional fields are left out, never null). For period data (the Part D data year, the
Part B quarter) effective_date is the START of the period and period is always set. Only numbers
printed in a source file are written, all as state "filed"; calculations belong to
src/core/rules.js. A blank or unparseable cell is never written as 0: the record (or the
whole join) is left out and counted in "counts".

Output is sorted, one row per line, LF line ends, and depends only on the cached files, so an
unchanged cache rebuilds byte-identical JSON.

Usage:
  python tools/build_drugs.py
Writes review samples to the directory in $OPENBILL_SAMPLES if set.
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import sys
import zipfile
from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / "cache"
MANIFEST = CACHE / "manifest.json"
OUT = ROOT / "data" / "drugs.json"
SCHEMA = "openbill.drugs/3"

# Mirrors PRICE_STATES in src/core/provenance.js, which is canonical.
FILED = "filed"

SOURCE_IDS = ("nadac", "fda_ndc", "partd", "asp_limits", "asp_crosswalk")
SOURCE_NAMES = {
    "nadac": "CMS NADAC",
    "fda_ndc": "FDA NDC Directory",
    "partd": "Medicare Part D",
    "asp_limits": "Medicare Part B",
    "asp_crosswalk": "Medicare Part B crosswalk",
}
STALE_AFTER_DAYS = 14  # NADAC is weekly; two missed weeks means something is wrong upstream.

# From the NADAC data dictionary, "Explanation Code" (data.medicaid.gov data dictionary
# de58d5ec-4515-494e-ae3f-620200f72989, read 2026-10-17).
EXPLANATION = {
    "1": "calculated from the most recently completed pharmacy survey",
    "2": "the latest survey was within 2% of the current NADAC, so the NADAC was carried forward from the previous file",
    "3": "the survey-based NADAC was adjusted for changes in published pricing, or after a help-desk inquiry",
    "4": "carried forward from the previous file",
    "5": "calculated based on package size",
    "6": "the CMS Covered Outpatient Drug Product File S/I/N drug category was not applied when grouping drugs for the calculation",
}
CARRIED_FORWARD = {"2", "4"}

NDC_RE = re.compile(r"^\d{11}$")
PRICE_RE = re.compile(r"^\d+(\.\d+)?$")
UNITS = {"EA", "ML", "GM"}


# ============================================================ small helpers

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def iso(us_date: str) -> str:
    return dt.datetime.strptime(us_date.strip(), "%m/%d/%Y").date().isoformat()


def positive(s: str | None) -> Decimal | None:
    """A positive decimal printed in the file, or None. Never a zero standing in for a blank."""
    s = (s or "").strip().replace(",", "")
    if not PRICE_RE.match(s):
        return None
    try:
        d = Decimal(s)
    except InvalidOperation:
        return None
    return d if d > 0 else None


def non_negative(s: str | None) -> Decimal | None:
    """A printed decimal >= 0 (a coinsurance of 0.000 is a real, printed value)."""
    s = (s or "").strip()
    if not PRICE_RE.match(s):
        return None
    try:
        return Decimal(s)
    except InvalidOperation:
        return None


def num(d: Decimal) -> int | float:
    """JSON number for a printed decimal: an int when it is whole, else the nearest float."""
    return int(d) if d == d.to_integral_value() and abs(d) < 10**15 else float(d)


def period_start(period: str) -> str:
    """Period data is effective from the start of its period (docs/ARCHITECTURE.md, Price records)."""
    return period.split("/")[0]


def ndc11_from_fda(code: str) -> str | None:
    """FDA package NDC (4-4-2, 5-3-2 or 5-4-1, hyphenated) -> 5-4-2 without hyphens."""
    parts = code.strip().split("-")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        return None
    a, b, c = parts
    shape = (len(a), len(b), len(c))
    if shape == (4, 4, 2):
        a = "0" + a
    elif shape == (5, 3, 2):
        b = "0" + b
    elif shape == (5, 4, 1):
        c = "0" + c
    elif shape != (5, 4, 2):
        return None
    return a + b + c


def blank_to_none(s: str) -> str | None:
    s = " ".join((s or "").split())
    return s or None


# ============================================================ sources

def load_sources() -> dict[str, dict]:
    if not MANIFEST.exists():
        sys.exit("No tools/cache/manifest.json. Run tools/fetch_all.py first.")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    out = {}
    for key in SOURCE_IDS:
        src = manifest.get(key)
        if not src:
            sys.exit(f"Manifest has no '{key}' entry. Run tools/fetch_all.py first.")
        path = CACHE / src["file"]
        if not path.exists():
            sys.exit(f"Cached file missing: {path.name}. Run tools/fetch_all.py.")
        got = sha256_file(path)
        if got != src["sha256"] or path.stat().st_size != src["bytes"]:
            sys.exit(f"Hash mismatch for {path.name}: manifest {src['sha256']}, file {got}. Refusing to build.")
        if not src.get("landing_url"):
            sys.exit(f"Manifest entry '{key}' has no landing_url; every source needs one.")
        out[key] = {**src, "path": path}
    return out


def record(value, kind, reason, src, effective_date, per=None, period=None, source_key=None):
    rec = {
        "value": value,
        "kind": kind,
        "state": FILED,
        "reason": reason,
        "source_name": SOURCE_NAMES[source_key],
        "source_url": src["landing_url"],
        "source_file": src["file"],
        "effective_date": effective_date,
        "retrieved_date": src["retrieved_date"],
    }
    # Optional fields are left out rather than written as null.
    if src.get("as_of_date"):
        rec["as_of_date"] = src["as_of_date"]
    if per is not None:
        rec["per"] = per
    if period is not None:
        rec["period"] = period
    return rec


# ============================================================ NADAC

def nadac_reason(codes: list[str], unit: str) -> str:
    parts = [f"{c}: {EXPLANATION.get(c, 'code not in the NADAC data dictionary')}" for c in codes]
    return f"Read from the NADAC file, dollars per {unit}. Explanation code " + "; ".join(parts) + "."


def read_nadac(path: Path) -> tuple[list[dict], str, int]:
    """Rows of the newest weekly file only (the CSV stacks every week of the year)."""
    latest, keep, weeks = None, [], set()
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):  # streamed: the full year is over a million rows
            week = iso(r["As of Date"])
            weeks.add(week)
            if latest is None or week > latest:
                latest, keep = week, []
            if week == latest:
                keep.append(r)
    if not keep:
        sys.exit(f"{path.name} has no rows. Not building an empty drugs.json.")
    return keep, latest, len(weeks)


def build_nadac_rows(raw: list[dict], src: dict) -> tuple[dict[str, dict], list, int]:
    rows: dict[str, dict] = {}
    rejected: list[tuple[str, str]] = []
    duplicates = 0
    for r in raw:
        ndc = r["NDC"].strip()
        name = " ".join(r["NDC Description"].split())
        unit = r["Pricing Unit"].strip()
        value = positive(r["NADAC Per Unit"])
        if not NDC_RE.match(ndc):
            rejected.append((ndc, f"NDC is not 11 digits: {ndc!r}"))
            continue
        if not name:
            rejected.append((ndc, "empty NDC description"))
            continue
        if unit not in UNITS:
            rejected.append((ndc, f"unknown pricing unit {unit!r}"))
            continue
        if value is None:
            rejected.append((ndc, f"NADAC per unit is not a positive number: {r['NADAC Per Unit']!r}"))
            continue
        codes = [c for c in re.split(r"[,\s]+", r["Explanation Code"].strip()) if c]
        row = {
            "ndc": ndc,
            "name": name,
            "unit": unit,
            "otc": r["OTC"].strip() == "Y",
            "rate_class": r["Classification for Rate Setting"].strip(),
            "explanation_codes": codes,
            "carried_forward": bool(CARRIED_FORWARD & set(codes)),
            "identity": None,
            "nadac": record(num(value), "usd", nadac_reason(codes, unit), src, iso(r["Effective Date"]), unit, source_key="nadac"),
        }
        generic = positive(r["Corresponding Generic Drug NADAC Per Unit"])
        if generic is not None:
            row["generic_nadac"] = record(
                num(generic), "usd",
                f"Read from the NADAC file: the NADAC of the corresponding generic drug, listed on this brand NDC's row. Dollars per {unit}.",
                src, iso(r["Corresponding Generic Drug Effective Date"]), unit, source_key="nadac",
            )
        row["part_d"] = None
        row["part_b"] = None
        if ndc in rows:
            duplicates += 1
            if row["nadac"]["effective_date"] <= rows[ndc]["nadac"]["effective_date"]:
                continue
        rows[ndc] = row
    return rows, rejected, duplicates


# ============================================================ FDA NDC Directory

FDA_ENCODING = "cp1252"  # product.txt is not valid UTF-8; Windows-1252 decodes every byte


def read_fda_table(z: zipfile.ZipFile, member: str) -> list[dict]:
    lines = z.read(member).decode(FDA_ENCODING).split("\r\n")
    header = lines[0].split("\t")
    out = []
    for line in lines[1:]:
        if line:
            cells = line.split("\t")
            if len(cells) != len(header):
                sys.exit(f"{member}: a line has {len(cells)} fields, header has {len(header)}")
            out.append(dict(zip(header, cells)))
    return out


def strength(p: dict) -> str | None:
    nums = [x.strip() for x in p["ACTIVE_NUMERATOR_STRENGTH"].split(";")]
    units = [x.strip() for x in p["ACTIVE_INGRED_UNIT"].split(";")]
    if not any(nums):
        return None
    if len(nums) != len(units):
        return blank_to_none(f"{p['ACTIVE_NUMERATOR_STRENGTH']} {p['ACTIVE_INGRED_UNIT']}")
    return "; ".join(f"{n} {u}".strip() for n, u in zip(nums, units))


def load_identities(path: Path) -> tuple[dict[str, dict], dict[str, dict], dict]:
    """NDC-11 -> identity, NDC-11 -> raw product (for matching), and summary counts."""
    with zipfile.ZipFile(path) as z:
        products = {p["PRODUCTID"]: p for p in read_fda_table(z, "product.txt")}
        packages = read_fda_table(z, "package.txt")
    found: dict[str, list[tuple[dict, dict]]] = defaultdict(list)
    bad = 0
    for pk in packages:
        n = ndc11_from_fda(pk["NDCPACKAGECODE"])
        if n is None:
            bad += 1
            continue
        found[n].append((pk, products.get(pk["PRODUCTID"])))
    ident, raw, ambiguous, pharm_ambiguous = {}, {}, set(), set()
    for n, hits in found.items():
        cands = {}
        for pk, pr in hits:
            if pr is None:
                continue
            name = " ".join(x for x in (pr["PROPRIETARYNAME"].strip(), pr["PROPRIETARYNAMESUFFIX"].strip()) if x)
            idn = {
                "source": "fda_ndc",
                "package_ndc": pk["NDCPACKAGECODE"].strip(),
                "proprietary_name": blank_to_none(name),
                "nonproprietary_name": blank_to_none(pr["NONPROPRIETARYNAME"]),
                "dosage_form": blank_to_none(pr["DOSAGEFORMNAME"]),
                "route": blank_to_none(pr["ROUTENAME"]),
                "strength": strength(pr),
                "labeler": blank_to_none(pr["LABELERNAME"]),
                "package_description": blank_to_none(pk["PACKAGEDESCRIPTION"]),
            }
            key = json.dumps(idn, sort_keys=True)
            # The classes of every product record behind this identity (one, except where FDA
            # lists the same package under two product records that describe it identically).
            classes = cands[key][2] if key in cands else set()
            classes.add(pharm_classes(pr))
            cands[key] = (idn, pr, classes)
        if len(cands) == 1:
            idn, pr, classes = next(iter(cands.values()))
            if len(classes) == 1:
                pc = next(iter(classes))
                if pc:
                    idn["pharm_classes"] = list(pc)  # left out, never [] or null, when FDA gives none
            else:
                pharm_ambiguous.add(n)
            ident[n], raw[n] = idn, pr
        elif len(cands) > 1:
            ambiguous.add(n)
    rx_forms: dict[tuple, set] = defaultdict(set)
    # Release families FDA lists under each prescription proprietary name (name tokens before the
    # strength), so a trade name whose every product is extended release can be told apart from
    # one FDA also lists as immediate release (Exelon capsules and the Exelon patch).
    rx_name_forms: dict[tuple, set] = defaultdict(set)
    for pr in products.values():
        if "PRESCRIPTION" in pr["PRODUCTTYPENAME"]:
            rx_forms[(ingredients(pr["NONPROPRIETARYNAME"]), pr["ROUTENAME"].strip())].add(mr_class(pr["DOSAGEFORMNAME"]))
            pname = " ".join(x for x in (pr["PROPRIETARYNAME"].strip(), pr["PROPRIETARYNAMESUFFIX"].strip()) if x)
            if pname:
                rx_name_forms[trade_base(pname)].add(mr_class(pr["DOSAGEFORMNAME"]))
    # FDA product records by product code (the first 9 digits of a 5-4-2 NDC-11). A NADAC NDC
    # that is not in package.txt (often an inner package, such as one pouch of a carton) can still
    # be a package of a listed product; its product record is used for matching only, never as
    # row.identity. Codes with more than one distinct product record are left out.
    by_code: dict[str, dict] = {}
    code_conflict: set = set()
    for pr in products.values():
        code = ndc9_from_fda(pr["PRODUCTNDC"])
        if code is None or code in code_conflict:
            continue
        known = by_code.get(code)
        if known is None:
            by_code[code] = pr
        elif product_facts(known) != product_facts(pr):
            del by_code[code]
            code_conflict.add(code)
    # NDC-11 -> FDA package codes, of the same product code, whose PACKAGEDESCRIPTION prints that
    # NDC in parentheses as an inner unit ('50 BLISTER PACK in 1 BOX (50268-662-15) / 1 TABLET in
    # 1 BLISTER PACK (50268-662-11)'). Shown in the provenance panel for a row whose * route came
    # from the product record; never used to match or to give a route.
    inner_of: dict[str, set] = defaultdict(set)
    for pk in packages:
        own, code = pk["NDCPACKAGECODE"].strip(), ndc9_from_fda(pk["PRODUCTNDC"])
        if code is None:
            continue
        for m in INNER_NDC_RE.findall(pk["PACKAGEDESCRIPTION"]):
            n = ndc11_from_fda(m)
            if n is not None and m != own and n[:9] == code:
                inner_of[n].add(own)
    return ident, raw, {"products": len(products), "packages": len(packages), "bad_ndc": bad,
                        "ambiguous": ambiguous, "pharm_ambiguous": pharm_ambiguous, "rx_forms": rx_forms, "rx_name_forms": rx_name_forms,
                        "by_product_code": by_code, "inner_of": inner_of}


# PHARM_CLASSES lists a product's FDA Established Pharmacologic Classes and the other class
# types, each entry a name and its type in brackets, joined by ", ": "Factor Xa Inhibitor [EPC],
# Factor Xa Inhibitors [MoA]". A few names hold ", " themselves ("Anti-Inflammatory Agents,
# Non-Steroidal [CS]", "Vaccines, Live, Unattenuated [CS]"), so the list is split only at a ", "
# that follows an entry's closing bracket. FDA repeats an entry once per active ingredient that
# carries it (four "Central Nervous System Stimulant [EPC]" for mixed amphetamine salts); each
# entry is kept once, at its first place.
PHARM_CLASS_SPLIT_RE = re.compile(r"(?<=\]), ")
PHARM_CLASS_RE = re.compile(r"^\S(?:.*\S)? \[[^\[\]]+\]$")


def pharm_classes(pr: dict) -> tuple:
    """FDA's PHARM_CLASSES for a product record as a tuple of entries, in FDA's order; () when blank."""
    s = " ".join(pr["PHARM_CLASSES"].split())
    if not s:
        return ()
    out = []
    for c in PHARM_CLASS_SPLIT_RE.split(s):
        if not PHARM_CLASS_RE.match(c):
            sys.exit(f"product.txt {pr['PRODUCTID']}: PHARM_CLASSES entry {c!r} is not 'name [TYPE]'; refusing to guess the split.")
        if c not in out:
            out.append(c)
    return tuple(out)


# An NDC FDA prints in parentheses inside a package description (4-4-2, 5-3-2 or 5-4-1).
INNER_NDC_RE = re.compile(r"\(\s*(\d{4,5}-\d{3,4}-\d{1,2})\s*\)")


PRODUCT_FACT_FIELDS = ("PROPRIETARYNAME", "PROPRIETARYNAMESUFFIX", "NONPROPRIETARYNAME", "DOSAGEFORMNAME", "ROUTENAME",
                       "ACTIVE_NUMERATOR_STRENGTH", "ACTIVE_INGRED_UNIT", "PRODUCTTYPENAME", "MARKETINGCATEGORYNAME")


def trade_base(name: str) -> tuple:
    """Name tokens of an FDA proprietary name before the strength, without parenthesised text
    ('CombiPatch (estradiol/norethindrone acetate transdermal system)' -> (COMBIPATCH,))."""
    return name_split(re.sub(r"\([^)]*\)", " ", name))[0]


def product_facts(pr: dict) -> tuple:
    """The fields of an FDA product record the Part D join reads."""
    return tuple(" ".join(pr[f].split()).upper() for f in PRODUCT_FACT_FIELDS)


def ndc9_from_fda(code: str) -> str | None:
    """FDA product NDC (4-4, 5-3 or 5-4, hyphenated) -> the 9-digit labeler + product code of a 5-4-2 NDC-11."""
    parts = code.strip().split("-")
    if len(parts) != 2 or not all(p.isdigit() for p in parts):
        return None
    a, b = parts
    if (len(a), len(b)) not in ((4, 4), (5, 3), (5, 4)):
        return None
    return a.rjust(5, "0") + b.rjust(4, "0")


NUMBER_RE = re.compile(r"(?<![\d.])(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)")


def _numbers(s: str) -> set:
    out = set()
    for m in NUMBER_RE.findall(s or ""):
        try:
            out.add(Decimal(m.replace(",", "")).normalize())
        except InvalidOperation:
            pass
    return out


def product_code_fda(row: dict, by_code: dict, sibling_listed: bool = False) -> dict | None:
    """The FDA product record of a row's 9-digit product code, if it plainly describes the same drug.

    Used only for a row with no exact package match in the FDA NDC Directory, and only for the
    Part D join, so that every package of one FDA product faces the same checks (route, release
    form, salt, OTC monograph). As a guard against a product code that now belongs to a different
    product, the record is used only when either
      - NADAC lists another NDC of the same product code under the same description, and that NDC
        is in FDA's package file (sibling_listed), or
      - FDA's proprietary name is a trade name (not the substance) that begins the NADAC
        description word by word (KLOR-CON M for KLOR-CON M10 TABLET, Pregnyl), or
      - FDA's proprietary name or a substance of its nonproprietary name is a word of the
        description, and one of FDA's strength figures is a number printed in the description
        (read in mg, g or mcg, and a percentage as mg per mL).
    """
    pr = by_code.get(row["ndc"][:9])
    if pr is None or sibling_listed:
        return pr
    desc = [ABBREV.get(t, t) for t in _toks(row["name"])]
    pname = " ".join(x for x in (pr["PROPRIETARYNAME"].strip(), pr["PROPRIETARYNAMESUFFIX"].strip()) if x)
    pbase = trade_base(pname) if pname else ()
    base = name_split(row["name"])[0]
    subst = substance_words(ingredients(pr["NONPROPRIETARYNAME"]))
    trade = (bool(pbase) and len(pbase) <= len(base) and all(b.startswith(t) for t, b in zip(pbase, base))
             and not any(_close(pbase[0], w) for w in subst))
    if trade:
        return pr
    named = bool(pbase) and bool(base) and pbase[0] == base[0]
    named = named or any(_close(w, d) for w in subst for d in desc if len(w) >= 4)
    strengths = _numbers(pr["ACTIVE_NUMERATOR_STRENGTH"].replace(";", " "))
    printed = _numbers(row["name"])
    printed |= {(n * k).normalize() for n in printed for k in (Decimal(1000), Decimal("0.001"))}  # mg / g / mcg
    printed |= {(Decimal(m.replace(",", "")) * 10).normalize() for m in re.findall(r"(\d*\.?\d+)\s*%", row["name"])}  # % as mg/mL
    if not named or not (strengths & printed):
        return None
    return pr


# ============================================================ name normalisation (Part D join)

# Release / formulation markers. An NDC and a Part D name must carry the same set.
RELEASE = {"ER", "XR", "XL", "SR", "DR", "CR", "LA", "EC", "XT", "CD", "CC", "LAR", "24HR", "12HR", "24H", "12H", "ODT"}
ER_FAMILY = {"ER", "XR", "XL", "SR", "CR", "LA", "XT", "CD", "CC", "LAR", "24HR", "12HR", "24H", "12H"}
DR_FAMILY = {"DR", "EC"}
SAME_MARKER = {"24H": "24HR", "12H": "12HR"}
# Dosage-form words that may trail a product name before the strength.
TRAILING_FORMS = {"TABLET", "TABLETS", "TAB", "TABS", "TB", "CAPSULE", "CAPSULES", "CAP", "CAPS", "CP", "VIAL", "VL",
                  "SYRINGE", "SYR", "SUSP", "SUSPENSION", "SOLN", "SOLUTION", "SOL", "CREAM", "CRM", "OINTMENT", "OINT",
                  "GEL", "LOTION", "DROPS", "SPRAY", "INHALER", "PATCH", "PEN", "KIT", "POWDER", "PACKET", "CAPLET",
                  "OINTM", "OINTMNT"}
# Salt and ester abbreviations used in NADAC descriptions and Part D names.
ABBREV = {"HCL": "HYDROCHLORIDE", "HBR": "HYDROBROMIDE", "NA": "SODIUM", "SOD": "SODIUM", "K": "POTASSIUM",
          "POT": "POTASSIUM", "CALC": "CALCIUM", "CA": "CALCIUM", "MAG": "MAGNESIUM", "BROM": "BROMIDE",
          "FUM": "FUMARATE", "BENZ": "BENZOATE", "BESYL": "BESYLATE", "SULF": "SULFATE", "PHOS": "PHOSPHATE",
          "ACET": "ACETATE", "DIPROP": "DIPROPIONATE", "PROP": "PROPIONATE", "SUCC": "SUCCINATE", "TART": "TARTRATE",
          "BITART": "BITARTRATE", "MALEAT": "MALEATE", "MESYL": "MESYLATE", "CIT": "CITRATE", "HYCL": "HYCLATE",
          "DISOD": "DISODIUM", "MONOHYD": "MONOHYDRATE", "GLUC": "GLUCONATE", "DIHCL": "DIHYDROCHLORIDE",
          "SUCCNT": "SUCCINATE"}
# Counter-ions, hydrates and prodrug esters that only qualify the active substance. Two names
# are compared on them only where both state one for the same ingredient.
HYDRATES = {"ANHYDROUS", "HEMIHYDRATE", "MONOHYDRATE", "DIHYDRATE", "TRIHYDRATE"}
COUNTER_IONS = HYDRATES | {"BISULFATE", "MEDOXOMIL", "CILEXETIL", "PROPANEDIOL", "HYDROCHLORIDE", "DIHYDROCHLORIDE",
                           "HYDROBROMIDE", "BROMIDE", "SODIUM", "DISODIUM", "POTASSIUM", "CALCIUM", "MAGNESIUM",
                           "SULFATE", "PHOSPHATE", "BESYLATE", "MALEATE", "MESYLATE", "DIMESYLATE", "TARTRATE",
                           "BITARTRATE", "SUCCINATE", "FUMARATE", "CITRATE", "HYCLATE", "TROMETHAMINE", "BENZOATE",
                           "OXALATE"}
# Words in FDA nonproprietary names that describe the form or schedule, not the substance.
FORM_WORDS = {"EXTENDED", "RELEASE", "DELAYED", "ENTERIC", "COATED", "ORAL", "TOPICAL", "TRANSDERMAL", "SYSTEM",
              "INHALATION", "INJECTION", "INJECTABLE", "OPHTHALMIC", "SOLUTION", "SUSPENSION", "TABLETS", "TABLET",
              "CAPSULES", "CAPSULE", "USP", "FOR", "FILM", "ORALLY", "DISINTEGRATING", "CHEWABLE", "MG", "MCG", "ML",
              "GM", "UNIT", "UNITS", "CII", "CIII", "CIV", "CV", "MICRONIZED"}


def is_ion(w: str) -> bool:
    """A counter-ion word, or a 3+ letter abbreviation of one ('BES' for besylate, 'MED' for medoxomil)."""
    return w in COUNTER_IONS or (len(w) >= 3 and any(i.startswith(w) for i in COUNTER_IONS))


def _toks(s: str) -> list[str]:
    s = s.upper().replace("*", " ").replace("&", " AND ").replace("DI-HCL", "DIHCL")
    # NADAC also writes orally disintegrating tablets as "DIS TAB" / "DIS TABLET" (CLONAZEPAM 1 MG DIS TABLET).
    s = re.sub(r"\bDIS\s+TAB(?:LET)?S?\b", " ODT ", s)
    return re.sub(r"[(),.;:'\"\[\]]", " ", s).split()


def name_split(s: str) -> tuple[tuple, frozenset]:
    """(name tokens before the strength, release markers anywhere in the name)."""
    base, rel, stopped = [], set(), False
    for t in _toks(s):
        if t in RELEASE:
            rel.add(SAME_MARKER.get(t, t))
            continue
        if stopped:
            continue
        if re.match(r"^\d", t) or t.startswith("-"):
            stopped = True
            continue
        base.append(ABBREV.get(t, t))
    while base and base[-1] in TRAILING_FORMS:
        base.pop()
    return tuple(base), frozenset(rel)


def ingredients(s: str, drop_qualifiers: bool = False) -> frozenset:
    """Set of ingredient word-tuples: 'Amlodipine Bes/Olmesartan Med' -> {(AMLODIPINE, BES), (OLMESARTAN, MED)}.

    drop_qualifiers removes parenthesised text ('Phytonadione (Vit K1)'); used only to check
    that an already-matched name agrees, never to find a match.
    """
    s = (s or "").upper().replace("*", " ").replace("DI-HCL", "DIHCL")
    if drop_qualifiers:
        s = re.sub(r"\([^)]*\)", " ", s)
    out = set()
    for part in re.split(r"\s+AND\s+|/|,|;|&|-", s):
        tt = [ABBREV.get(t, t) for t in _toks(part)]
        tt = [t for t in tt if t not in RELEASE and t not in FORM_WORDS and not re.match(r"^\d", t)]
        if tt:
            out.add(tuple(tt))
    return frozenset(out)


def core(i: tuple) -> tuple:
    """The substance words of one ingredient ('POTASSIUM CITRATE' is all ions: kept whole)."""
    c = tuple(w for w in i if not is_ion(w))
    return c or i


def strip_ions(ing: frozenset) -> frozenset:
    return frozenset(core(i) for i in ing)


def _is_hydrate(w: str) -> bool:
    return w in HYDRATES or (len(w) >= 4 and any(h.startswith(w) for h in HYDRATES))


def ions_of(i: tuple) -> set:
    """The salt words of one ingredient. A hydrate only qualifies another salt (paroxetine HCl
    hemihydrate is paroxetine HCl), but when it is the only qualifier it names the form
    (doxycycline monohydrate is not doxycycline hyclate; timolol hemihydrate is not timolol maleate)."""
    if core(i) == i:
        return set()
    ions = {w for w in i if is_ion(w)}
    return {w for w in ions if not _is_hydrate(w)} or ions


def salt_words(ing: frozenset) -> set:
    return {w for i in ing for w in ions_of(i)}


def same_salts(a: set, b: set) -> bool:
    return (not a and not b) or (bool(a) and bool(b) and _words_close(a, b))


def _name_words(s: str) -> set:
    return {ABBREV.get(w, w) for w in re.split(r"[\s\-/]+", re.sub(r"[(),.;:'\"\[\]*]", " ", s.upper())) if w}


def ions_agree(a: frozenset, b: frozenset) -> bool:
    da = {core(i): ions_of(i) for i in a}
    db = {core(i): ions_of(i) for i in b}
    return all(not da[k] or not db.get(k) or da[k] == db[k] for k in da)


def substance_words(ing: frozenset) -> set:
    return {w for i in ing for w in core(i)}


def _close(a: str, b: str) -> bool:
    # Part D truncates names to 30 characters ("Tetracyc"): allow a prefix of 3+ letters.
    return a == b or (min(len(a), len(b)) >= 3 and (a.startswith(b) or b.startswith(a)))


def _abbrev_of(w: str, x: str) -> bool:
    """Is NADAC word w the word x, a 3+ letter prefix of it, or an abbreviation of it that keeps
    its first three letters and drops letters in between ('GASTRC' for GASTRIC)?"""
    if _close(w, x):
        return True
    if len(w) < 4 or len(w) >= len(x) or not w.isalpha() or w[:3] != x[:3]:
        return False
    it = iter(x)
    return all(c in it for c in w)


def _words_close(wa: set, wb: set) -> bool:
    return bool(wa) and bool(wb) and all(any(_close(x, y) for y in wb) for x in wa) and all(any(_close(y, x) for x in wa) for y in wb)


def _ions_close(x: set, y: set) -> bool:
    return not x or not y or _words_close(x, y)


def same_substance(a: frozenset, b: frozenset) -> bool:
    """Same active substances (prefix-tolerant); where an ingredient states a salt on both sides, the same salt."""
    if not _words_close(substance_words(a), substance_words(b)):
        return False
    for i in a:
        for j in b:
            if _words_close(set(core(i)), set(core(j))) and not _ions_close(ions_of(i), ions_of(j)):
                return False
    return True


def mr_class(form: str | None) -> str:
    f = (form or "").upper()
    if "EXTENDED RELEASE" in f:
        return "ER"
    if "DELAYED RELEASE" in f:
        return "DR"
    return ""


def family(rel: frozenset) -> str:
    if rel & ER_FAMILY:
        return "ER"
    if rel & DR_FAMILY:
        return "DR"
    return ""


# ============================================================ Part D

class PartD:
    """Index of the 'Overall' rows (all manufacturers) of the Part D file for one data year."""

    def __init__(self, src: dict, rx_forms: dict, rx_name_forms: dict | None = None):
        self.src = src
        self.year = int(src["data_year"])
        self.rx_forms = rx_forms
        self.rx_name_forms = rx_name_forms or {}
        text = src["path"].read_bytes().decode("utf-8-sig")
        rows = list(csv.DictReader(io.StringIO(text, newline="")))
        y = self.year
        need = ["Brnd_Name", "Gnrc_Name", "Mftr_Name", f"Avg_Spnd_Per_Dsg_Unt_Wghtd_{y}", f"Tot_Clms_{y}", f"Outlier_Flag_{y}"]
        if not rows or any(c not in rows[0] for c in need):
            sys.exit(f"{src['file']}: missing Part D columns {need}")
        self.entries = []
        for r in rows:
            if r["Mftr_Name"] != "Overall":
                continue
            base, rel = name_split(r["Brnd_Name"])
            g = ingredients(r["Gnrc_Name"])
            words = [x for x in re.split(r"[\s\-/]+", r["Brnd_Name"].upper().replace("*", "")) if re.match(r"^[A-Z]{3,}", x)]
            # "Generic-labeled": CMS's brand name is the generic name itself (Atorvastatin Calcium),
            # as opposed to a trade name (Lipitor).
            generic_labeled = bool(words) and words[0] in {w for i in g for w in i}
            # "Plain": the brand name says nothing beyond the generic name and its salt
            # (Buprenorphine, Buprenorphine HCl*), unlike Glucagon Emergency Kit or Doxycycline Ir-Dr.
            gw = _name_words(r["Gnrc_Name"])
            plain = generic_labeled and all(any(_close(w, x) for x in gw) for w in _name_words(" ".join(base)))
            self.entries.append({"row": r, "base": base, "rel": rel, "g": g, "gs": strip_ions(g), "generic": generic_labeled,
                                 "plain": plain, "salts": salt_words(g)})
        self.by_base = defaultdict(list)
        self.by_g = defaultdict(list)
        self.by_gs = defaultdict(list)
        for e in self.entries:
            self.by_base[e["base"]].append(e)
            if e["generic"]:
                self.by_g[e["g"]].append(e)
                self.by_gs[e["gs"]].append(e)

    def _unmarked_ok(self, e: dict, R: frozenset, fda: dict | None, ing: frozenset) -> bool:
        """May a modified-release generic NDC take a Part D generic row that has no release marker?

        Only when that row cannot be an immediate-release figure: no Part D row of the same
        generic carries a release marker, FDA's dosage form for this NDC confirms the release
        family, and FDA lists no immediate-release prescription product of this generic by the
        same route. (Omeprazole: every product is delayed release, and CMS names it plainly.)
        """
        if e["rel"] or family(R) not in ("ER", "DR") or (R - ER_FAMILY - DR_FAMILY):
            return False
        if any(q["rel"] for q in self.by_gs.get(e["gs"], [])):
            return False
        if not fda or mr_class(fda["DOSAGEFORMNAME"]) != family(R):
            return False
        forms = self.rx_forms.get((ingredients(fda["NONPROPRIETARYNAME"]), fda["ROUTENAME"].strip()))
        return bool(forms) and "" not in forms

    def _salt_routes(self, q: dict) -> set:
        """Routes FDA lists for products whose nonproprietary name is q's generic name with q's salt."""
        if not q["salts"]:
            return set()
        if "routes" not in q:
            out = set()
            for (ing, route) in self.rx_forms:
                if strip_ions(ing) == q["gs"] and same_salts(salt_words(ing), q["salts"]):
                    out |= {x.strip() for x in route.split(";") if x.strip()}
            q["routes"] = out
        return q["routes"]

    def _salt_resolve(self, e: dict, product_salts: set, routes: set) -> dict | None:
        """e, or the one row of its salt family the product's stated salt points to, or None.

        Part D can carry one substance under several generic names that differ only by salt
        (Buprenorphine = the patches, Buprenorphine HCl* = the sublingual tablets; Methylphenidate
        = the patch, Methylphenidate HCl = the tablets). A product joins one of them only when the
        NADAC description or FDA's nonproprietary name states the salt and exactly one row has it,
        or when every other salt form is one FDA lists only for other routes (Phenobarbital Sodium
        is injected; a phenobarbital tablet cannot be it).
        """
        if not e["generic"]:
            return e
        fam = [q for q in self.by_gs.get(e["gs"], []) if q is not e and q["rel"] == e["rel"]
               and not same_salts(q["salts"], e["salts"]) and (q["base"] == e["base"] or (q["plain"] and e["plain"]))]
        if routes:
            fam = [q for q in fam if not (self._salt_routes(q) and not (self._salt_routes(q) & routes))]
        if not fam:
            return e
        fits = [q for q in [e] + fam if same_salts(q["salts"], product_salts)]
        return fits[0] if len(fits) == 1 and product_salts else None

    def _presentation(self, e: dict, words: set) -> dict | None:
        """e, or the Part D row that names this product's presentation, or None if unclear.

        Part D lists some presentations under their own names (Novolog vs Novolog Flexpen;
        Tresiba vs Tresiba Flextouch U-200; Taltz Syringe vs Taltz Autoinjector). NADAC often
        writes the presentation after the strength (NOVOLOG 100 UNIT/ML FLEXPEN), so the name
        before the strength alone would pick the vial's row. Among e and the Part D names that
        extend e's name, the one with the most words, all of them in the NADAC description,
        wins. If a longer name shares a presentation word with the description but none fits
        whole, the match is dropped.
        """
        n = len(e["base"])
        ext = [q for q in self.entries if q is not e and q["rel"] == e["rel"] and len(q["base"]) > n and q["base"][:n] == e["base"]]
        if not ext:
            return e

        def toks(q):
            return [ABBREV.get(t, t) for t in _toks(q["row"]["Brnd_Name"])]

        def inside(q):
            return all(any(_close(t, w) for w in words) for t in toks(q))

        fits = [q for q in [e] + ext if inside(q)]
        if not fits:
            return e
        most = max(len(toks(q)) for q in fits)
        best = [q for q in fits if len(toks(q)) == most]
        if len(best) != 1:
            return None
        pick = best[0]
        # A longer name sharing a presentation word (not a concentration) with the description
        # but not fitting whole means the description is a presentation we cannot place.
        for q in ext:
            if q is pick or inside(q) or len(toks(q)) <= len(toks(pick)):
                continue
            extra = {t for t in q["base"][n:] if not t.startswith("U-")} - set(toks(pick))
            if extra & words:
                return None
        return pick

    def _family(self, e: dict) -> list:
        """The Part D rows named by the generic name that share e's Gnrc_Name and release markers
        (Metformin HCl ER, Metformin ER Gastric, Metformin ER Osmotic)."""
        if not e["generic"]:
            return [e]
        return [q for q in self.by_gs.get(e["gs"], []) if q["generic"] and q["rel"] == e["rel"]
                and q["row"]["Gnrc_Name"] == e["row"]["Gnrc_Name"]]

    @staticmethod
    def _extra_words(q: dict) -> set:
        """Words of a generic-named Part D row's brand name beyond its generic name and release
        markers: the presentation it names ('Metformin ER Gastric' -> {GASTRIC})."""
        gw = _name_words(q["row"]["Gnrc_Name"])
        out = set()
        for t in _toks(q["row"]["Brnd_Name"]):
            for p in ([t] if re.match(r"^U-\d+$", t) else t.split("-")):
                p = ABBREV.get(p, p)
                if p and p not in RELEASE and not re.match(r"^\d", p) and not any(_close(p, g) for g in gw):
                    out.add(p)
        return out

    def _family_presentation(self, e: dict, row_name: str) -> dict | None:
        """e, or the row of its generic-name family that names this product's presentation, or None.

        e is a plain generic-name row (Metformin HCl ER: no words beyond the generic name).
        Part D can list presentations of one generic name as separate generic-named rows (Metformin
        HCl ER, Metformin ER Gastric and Metformin ER Osmotic all have the generic name Metformin
        HCl). The row whose extra words all appear in the NADAC description wins, the one with the
        most such words if several do; NADAC abbreviates (GASTR-TB, GASTRC-TB, OSM-TAB), so a
        description word matches a Part D word it is a 3+ letter prefix of, or an abbreviation of
        (same first three letters, its letters in order). If no row fits whole but one shares such
        a word with the description, the presentation is unclear and there is no match.
        """
        fam = self._family(e)
        if len(fam) < 2 or self._extra_words(e):
            # Only a plain generic-name row (no presentation words of its own) is upgraded; a row
            # matched by a name that already names a presentation stays as matched.
            return e
        words = set()
        for t in _toks(row_name):
            for p in [t] + t.split("-"):
                if p:
                    words.add(ABBREV.get(p, p))
        words |= {f"U-{m}" for m in re.findall(r"\b(\d+) UNITS?/ML\b", row_name.upper())}

        def seen(x):
            return any(_abbrev_of(w, x) for w in words)

        extras = {id(q): self._extra_words(q) for q in fam}
        fits = [q for q in fam if extras[id(q)] and all(seen(x) for x in extras[id(q)])]
        if fits:
            most = max(len(extras[id(q)]) for q in fits)
            best = [q for q in fits if len(extras[id(q)]) == most]
            return best[0] if len(best) == 1 else None
        for q in fam:
            if q is not e and any(seen(x) for x in extras[id(q)] if not x.startswith("U-")):
                return None
        return e

    def _brand_release_ok(self, row: dict, fda: dict, base: tuple, R: frozenset) -> bool:
        """May an NDC whose FDA dosage form says extended or delayed release take a Part D trade
        name that carries no release marker?

        Only when the trade name cannot stand for an immediate-release product: the NADAC
        description and FDA's proprietary name carry no release marker and are the same name,
        CMS lists exactly one row under that name (a trade name, not the generic name), and every
        prescription product FDA lists under that proprietary name is in the same release family
        (the Vivelle-Dot patch is 'PATCH, EXTENDED RELEASE' and Part D names it plainly).
        """
        if row["otc"] or R or not base:
            return False
        fda_name = " ".join(x for x in (fda["PROPRIETARYNAME"], fda["PROPRIETARYNAMESUFFIX"]) if x.strip())
        if not fda_name or name_split(fda_name)[1] or trade_base(fda_name) != base:
            return False
        rows = self.by_base.get(base, [])
        if len(rows) != 1 or rows[0]["generic"] or rows[0]["rel"]:
            return False
        return self.rx_name_forms.get(base) == {mr_class(fda["DOSAGEFORMNAME"])}

    def match(self, row: dict, fda: dict | None) -> tuple[dict | None, str, str, str]:
        """(Part D entry or None, basis, join path, reason code when unmatched)."""
        base, R = name_split(row["name"])
        fda_mr = mr_class(fda["DOSAGEFORMNAME"]) if fda else ""
        brand_release = False
        if fda_mr and fda_mr != family(R):
            if not self._brand_release_ok(row, fda, base, R):
                return None, "", "", "release_form_conflict"
            brand_release = True
        if row["otc"] and fda and fda["MARKETINGCATEGORYNAME"].upper().startswith("OTC MONOGRAPH"):
            # Sold under an OTC monograph: OTC only, and Part D excludes OTC drugs, so any Part D
            # row of the same name is a different (prescription) product.
            return None, "", "", "otc_monograph"
        ing = ingredients(fda["NONPROPRIETARYNAME"]) if fda and fda["NONPROPRIETARYNAME"].strip() else frozenset()
        name_ing = ingredients(" ".join(base)) if base else frozenset()
        product_salts = salt_words(name_ing) | salt_words(ing)
        routes = {x.strip() for x in fda["ROUTENAME"].split(";") if x.strip()} if fda else set()
        fda_name = " ".join(x for x in (fda["PROPRIETARYNAME"], fda["PROPRIETARYNAMESUFFIX"]) if x.strip()) if fda else ""
        names = [base]
        words = {ABBREV.get(t, t) for t in _toks(row["name"])}
        words |= {f"U-{m}" for m in re.findall(r"\b(\d+) UNITS?/ML\b", row["name"].upper())}
        if fda_name:
            fbase, frel = name_split(fda_name)
            if frel and frel != R:
                return None, "", "", "release_form_conflict"
            if not row["otc"]:
                names.append(fbase)

        def substance_ok(e: dict) -> bool:
            if e["generic"]:
                ref = ingredients(fda["NONPROPRIETARYNAME"], True) if ing else ingredients(" ".join(base), True)
                return same_substance(ref, ingredients(e["row"]["Gnrc_Name"], True))
            return not ing or bool(substance_words(e["g"]) & substance_words(ing))

        # 1. Exact product name (NADAC description, FDA proprietary name) with the same release markers.
        by_name = {}
        for k in names:
            for e in self.by_base.get(k, []) if k else []:
                if e["rel"] == R:
                    by_name[id(e)] = e
        if brand_release:
            # The release-form exception holds only for the one trade-name row it was granted for.
            only = self.by_base.get(base, [])
            if len(by_name) != 1 or next(iter(by_name.values())) is not only[0]:
                return None, "", "", "release_form_conflict"
        if len(by_name) > 1:
            return None, "", "", "ambiguous_name"
        if by_name:
            e = next(iter(by_name.values()))
            if row["otc"] and e["generic"]:
                # Part D excludes OTC drugs: a Part D row named by the generic name is the
                # prescription product (ibuprofen 400-800 mg, not the 200 mg OTC tablet).
                return None, "", "", "otc_generic_name"
            if not substance_ok(e):
                return None, "", "", "generic_name_disagrees"
            e = self._presentation(e, words)
            if e is None:
                return None, "", "", "ambiguous_presentation"
            e = self._family_presentation(e, row["name"])
            if e is None:
                return None, "", "", "ambiguous_presentation"
            e = self._salt_resolve(e, product_salts, routes)
            if e is None:
                return None, "", "", "ambiguous_salt"
            if not substance_ok(e):
                return None, "", "", "generic_name_disagrees"
            # basis names the kind of Part D row: "generic" when CMS's brand name is the generic
            # name itself, "brand" when it is a trade name.
            return e, ("generic" if e["generic"] else "brand"), "name", ""
        if row["otc"]:
            return None, "", "", "otc_no_exact_name"
        if row["rate_class"] != "G":
            return None, "", "", "no_brand_name"

        # 2. Generic rows only: the generic name (FDA nonproprietary name, or the NADAC name),
        #    against Part D rows whose brand name is the generic name itself.
        cands = {}
        for s in (ing, name_ing):
            if not s:
                continue
            hits = list(self.by_g.get(s, [])) or [e for e in self.by_gs.get(strip_ions(s), []) if ions_agree(s, e["g"])]
            for e in hits:
                # The NADAC description must name as many ingredients as the Part D generic name
                # (FDA lists one omeprazole + sodium bicarbonate product as just "omeprazole").
                if len(name_ing) > 1 and len(name_ing) != len(e["g"]):
                    continue
                # Found through the NADAC name, the row must still not contradict a salt FDA states
                # (timolol hemihydrate is not timolol maleate).
                if ing and not ions_agree(ing, e["g"]):
                    continue
                if e["rel"] == R or self._unmarked_ok(e, R, fda, s):
                    cands[id(e)] = e
        if len(cands) > 1:
            # Several rows of one generic-name family (same Gnrc_Name and release markers) are
            # presentations of it; the NADAC description may settle which one this is.
            first = next(iter(cands.values()))
            fam = {id(q) for q in self._family(first)}
            if not set(cands) <= fam:
                return None, "", "", "ambiguous_generic"
            plain = [q for q in cands.values() if not self._extra_words(q)]
            e = self._family_presentation(plain[0], row["name"]) if len(plain) == 1 else None
            # Only a row whose presentation words the description names settles it; the plain row
            # is not picked by default, because the candidates were ambiguous to begin with.
            if e is None or not self._extra_words(e):
                return None, "", "", "ambiguous_generic"
            cands = {id(e): e}
        if not cands:
            return None, "", "", "no_generic_name"
        e = self._family_presentation(next(iter(cands.values())), row["name"])
        if e is None:
            return None, "", "", "ambiguous_presentation"
        e = self._salt_resolve(e, product_salts, routes)
        if e is None:
            return None, "", "", "ambiguous_salt"
        return e, "generic", "generic_name", ""


PART_D_UNMATCHED = {
    "release_form_conflict": "FDA's dosage form or name states a release form the NADAC description does not (or the reverse)",
    "ambiguous_name": "more than one Part D row carries this product name and release form",
    "generic_name_disagrees": "a Part D row has this name but its generic name disagrees with FDA's nonproprietary name",
    "otc_no_exact_name": "OTC product with no Part D row of exactly this name (Part D excludes OTC claims)",
    "otc_monograph": "OTC product sold under an FDA OTC monograph; Part D excludes OTC drugs, so a Part D row of this name is a different product",
    "otc_generic_name": "OTC product whose name matches only a Part D row named by the generic name, which is the prescription product (Part D excludes OTC drugs)",
    "ambiguous_presentation": "Part D lists presentations of this name separately (e.g. vial vs pen) and the NADAC description does not settle which one this NDC is",
    "ambiguous_salt": "Part D has rows for this substance under different salts (e.g. Buprenorphine vs Buprenorphine HCl) and neither the NADAC description nor FDA's nonproprietary name settles which",
    "no_brand_name": "no Part D row with this brand name and release form",
    "ambiguous_generic": "more than one Part D generic row could match",
    "no_generic_name": "no Part D row with this generic name and release form",
    "no_value": "the matched Part D row has no average spending per dosage unit for the data year",
    "mixed_units": "NADAC prices the NDCs joined to this Part D name in more than one unit and this NDC's unit is not the clear majority, so CMS's average per dosage unit is not in this NDC's unit",
    "multi_route_no_identity": "the Part D name carries CMS's * (an average over several routes of administration) and this NDC has no FDA identity with a route, and no accepted FDA product record for its product code with one, so its route is unknown",
    "multi_route_minority": "the Part D name carries CMS's * (an average over several routes of administration) and this NDC's FDA route is not the one most NDCs joined to the name share",
    "multi_route_tie": "the Part D name carries CMS's * (an average over several routes of administration) and the NDCs joined to it split evenly between routes, so no route is shared by most of them",
}


def route_parts(route: str | None) -> frozenset:
    """FDA ROUTENAME as a set of routes ('INTRAMUSCULAR; INTRAVENOUS' -> {INTRAMUSCULAR, INTRAVENOUS})."""
    return frozenset(x.strip().upper() for x in (route or "").split(";") if x.strip())


ROUTE_FROM_PRODUCT = "fda_product"


def row_route(row: dict) -> tuple[str | None, str | None]:
    """(route, where it came from) for the multi-route split.

    The route of the row's FDA identity (exact package match) when it has one; otherwise, for an
    NDC the FDA NDC Directory does not list as a package of its own, the route of the FDA product record of its
    product code that product_code_fda() accepted and the name join already used
    (row["_code_route"], set in build()). Never a looser lookup. (None, None) if neither names one.
    """
    if row["identity"] is not None:
        route = row["identity"].get("route")
        return (route, "identity") if route_parts(route) else (None, None)
    route = row.get("_code_route")
    return (route, ROUTE_FROM_PRODUCT) if route_parts(route) else (None, None)


def _route_majority(parts: list) -> tuple[frozenset | None, list, bool]:
    """The majority route over a list of route component sets: (kept indexes, shared components,
    tie). Each component is counted over the sets that include it; the component covering the
    most sets keeps them. Components covering exactly the same sets are one choice. Two
    components covering as many sets but not the same sets are a tie. (None, [], False) if no
    set names a component."""
    cover: dict[str, frozenset] = {}
    for i, ps in enumerate(parts):
        for c in ps:
            cover[c] = cover.get(c, frozenset()) | {i}
    if not cover:
        return None, [], False
    most = max(len(v) for v in cover.values())
    tops = {v for v in cover.values() if len(v) == most}
    if len(tops) > 1:
        return None, [], True
    keep = next(iter(tops))
    return keep, sorted(c for c, v in cover.items() if v == keep), False


def star_route_split(hits: list) -> tuple[list, list, str]:
    """Split the NDCs joined to one Part D name marked * into (kept hits, [(row, reason)], route).

    The contract (docs/ARCHITECTURE.md): a row joins such a name only when its FDA route is known
    and shared by every row joined to that name; a row whose route is unknown or in the minority
    does not. A row's route is its FDA identity's, or, with no package in the Directory, that of
    the FDA product record of its product code the join accepted (row_route()). Rows with neither
    are 'multi_route_no_identity'.

    The rows with an FDA identity decide the route, exactly as before product-record routes were
    used: each route FDA names for them is counted over the rows whose ROUTENAME includes it
    ('INTRAMUSCULAR; INTRAVENOUS' includes INTRAMUSCULAR); the route covering the most rows keeps
    them, and every kept row then shares it. Identity rows outside it are 'multi_route_minority'.
    If two routes cover equally many rows but not the same rows, no route is shared by most of
    them and every row with a route is 'multi_route_tie'. Routes are FDA's own words, compared
    exactly: PARENTERAL is not merged with INTRAVENOUS, nor INTRAOCULAR with OPHTHALMIC.

    A row whose route came from the product record follows that decision and never votes in it:
    it is kept only when its route includes every component of the kept route, else it is
    'multi_route_minority' (or 'multi_route_tie' when the identity rows tie). Such rows are often
    a second package (an inner pouch or blister) of a product whose listed package already
    counts, so letting them vote would count one product twice. Only when no row has an identity
    route do the product-record rows decide among themselves, by the same rule. Kept rows whose
    route came from the product record are marked row["_route_from"] = "fda_product"; route is
    the shared route, as text ("" if none is kept).
    """
    by_identity, by_product, dropped = [], [], []
    for h in hits:
        h[0].pop("_route_from", None)
        route, where = row_route(h[0])
        if route is None:
            dropped.append((h[0], "multi_route_no_identity"))
        elif where == ROUTE_FROM_PRODUCT:
            by_product.append((h, route_parts(route)))
        else:
            by_identity.append((h, route_parts(route)))
    deciders = by_identity or by_product
    followers = by_product if by_identity else []
    keep, shared, tie = _route_majority([ps for _, ps in deciders])
    if keep is None:
        if tie:
            dropped += [(h[0], "multi_route_tie") for h, _ in deciders + followers]
        return [], dropped, ""
    need = frozenset(shared)
    kept = []
    for i, (h, ps) in enumerate(deciders):
        if i in keep:
            kept.append(h)
        else:
            dropped.append((h[0], "multi_route_minority"))
    for h, ps in followers:
        if need <= ps:
            kept.append(h)
        else:
            dropped.append((h[0], "multi_route_minority"))
    for h in kept:
        if row_route(h[0])[1] == ROUTE_FROM_PRODUCT:
            h[0]["_route_from"] = ROUTE_FROM_PRODUCT
    kept_ids = {id(h) for h in kept}
    return [h for h in hits if id(h) in kept_ids], dropped, " and ".join(shared)


def star_route_note(route: str, kept: int, joined: list, matched: int) -> str:
    """The reason note on a * name's figure: which route its rows share, how many of the NDCs
    the name join matched point at it (joined: the kept rows the unit rule also lets through), and
    how many of those took their route from FDA's product record because the FDA NDC Directory does
    not list them as packages of their own."""
    if kept == matched:
        note = f"All {matched} NADAC NDCs the name join matched to it have an FDA route including {route}."
    else:
        note = (f"Only NADAC NDCs whose FDA route includes {route} point at this name ({len(joined)} of the {matched} "
                f"the name join matched); NDCs of another route or with no known FDA route do not.")
    k, n = sum(1 for row in joined if row.get("_route_from") == ROUTE_FROM_PRODUCT), len(joined)
    if k:
        same = "FDA's record for the same product (labeler and product code)"
        if n == 1:
            note += (f" The one NDC that points at this name is not listed in the FDA NDC Directory as a package of its own; "
                     f"its route was taken from {same}.")
        elif k == n:
            note += (f" None of the {n} NDCs that point at this name is listed in the FDA NDC Directory as a package of its own; "
                     f"each one's route was taken from {same}.")
        else:
            verb = "is not listed in the FDA NDC Directory as a package of its own; its" if k == 1 else                 "are not listed in the FDA NDC Directory as packages of their own; their"
            note += f" {k} of the {n} NDCs that point at this name {verb} route was taken from {same}."
    return note


MAJORITY_UNIT_SHARE = 0.9


def part_d_key(e: dict) -> str:
    """Key into part_d_names: CMS's own Brnd_Name and Gnrc_Name strings, exactly as written."""
    return f"{e['row']['Brnd_Name']}|{e['row']['Gnrc_Name']}"


def part_d_entry(e: dict, basis: str, unit: str, pd: PartD, mix: str | None = None) -> dict | None:
    """The part_d_names entry for a matched Part D row, priced per the NADAC unit its joined
    rows share, or None if the file has no figure for the year."""
    r, y, src = e["row"], pd.year, pd.src
    avg = positive(r[f"Avg_Spnd_Per_Dsg_Unt_Wghtd_{y}"])
    claims = positive(r[f"Tot_Clms_{y}"])
    if avg is None:
        return None
    flag = r[f"Outlier_Flag_{y}"].strip()
    outlier = True if flag == "1" else False if flag == "0" else None
    who = f"{r['Brnd_Name']} / {r['Gnrc_Name']}"
    notes = ""
    if "*" in r["Brnd_Name"]:
        notes += " *: CMS says this average reflects multiple routes of administration, which may have different unit prices."
    if outlier:
        notes += " CMS outlier flag 1: the average is substantially affected by outlier records."
    elif outlier is None:
        notes += f" Outlier_Flag_{y} is blank in the file."
    if mix:
        notes += " " + mix
    eff, period = period_start(src["period"]), src["period"]
    entry = {
        "brand_name": r["Brnd_Name"],
        "generic_name": r["Gnrc_Name"],
        # Wording follows CMS's methodology document (see docs/DATA_SOURCES.md).
        "avg_per_unit": record(
            num(avg), "usd",
            f"Part D {y} average spend per dosage unit for {who}: all makers, strengths, forms and routes combined, "
            f"claim-weighted; gross cost incl. dispensing fees and patient pay, before rebates. Unit taken as NADAC's "
            f"{unit}. Joined on {basis} name.{notes}",
            src, eff, unit, period, source_key="partd",
        ),
    }
    if claims is not None:
        entry["claims"] = record(
            num(claims), "count",
            f"Part D {y} claims (fills incl. refills) for {who}, all makers, strengths and forms.",
            src, eff, "claim", period, source_key="partd",
        )
    entry["outlier"] = outlier
    return entry


# ============================================================ Part B

ASP_ENCODING = "cp1252"  # the Section 508 CSVs contain 0xA0 and are not valid UTF-8


def read_asp_csv(src: dict, want: list[str]) -> list[dict]:
    with zipfile.ZipFile(src["path"]) as z:
        member = src.get("member")
        if not member or member not in z.namelist():
            sys.exit(f"{src['file']}: manifest member {member!r} not in the zip; re-run tools/fetch_asp.py online.")
        text = z.read(member).decode(ASP_ENCODING)
    rows = list(csv.reader(io.StringIO(text, newline="")))
    for i, r in enumerate(rows):
        cells = [c.strip() for c in r]
        if all(w in cells for w in want):
            out = []
            for x in rows[i + 1:]:
                if any(c.strip() for c in x):
                    out.append({h: (x[j].strip() if j < len(x) else "") for j, h in enumerate(cells) if h})
            return out
    sys.exit(f"{src['file']}: no header row with {want}")


PKG_LEVEL_RE = re.compile(r"^([\d.]+)\s+(.+?)\s+in\s+1\s+(.+)$", re.I)
DISCRETE = ("TABLET", "CAPSULE", "VIAL", "SYRINGE", "KIT", "PATCH", "INHALER", "AMPULE", "CARTRIDGE", "PEN", "INJECTOR",
            "BAG", "BOTTLE", "PACKET", "POUCH", "APPLICATOR", "SUPPOSITORY", "TROCHE", "LOZENGE", "FILM", "IMPLANT",
            "INSERT", "RING", "DEVICE", "TUBE", "CONTAINER", "CAN", "JAR", "BLISTER")


def _discrete(content: str) -> bool:
    first = re.split(r"[ ,]", content, 1)[0].rstrip("S")
    return first in DISCRETE


def package_totals(desc: str | None) -> dict | None:
    """From an FDA package description, the NDC's total amount in mL / g and its count of discrete items.

    '10 VIAL in 1 CARTON (x) / 2 mL in 1 VIAL' -> {'ML': 20, 'EA': 10}
    '120 TABLET, FILM COATED in 1 BOTTLE (x)'  -> {'EA': 120}
    EA counts the deepest discrete level (tablets, capsules, vials, syringes ...). Kits and
    multi-component packages ('*', '+') and anything that is not one linear chain are not parsed.
    """
    if not desc or "*" in desc or "+" in desc:
        return None
    clean = re.sub(r"\(\s*[\d-]+\s*\)", " ", desc)
    levels = []
    for part in clean.split(" / "):
        m = PKG_LEVEL_RE.match(" ".join(part.split()))
        if not m:
            return None
        try:
            n = Decimal(m.group(1))
        except InvalidOperation:
            return None
        levels.append((n, m.group(2).strip().upper(), m.group(3).strip().upper()))
    for (_, content, _), (_, _, container) in zip(levels, levels[1:]):
        if content != container:
            return None
    out = {}
    total = Decimal(1)
    for n, _, _ in levels:
        total *= n
    inner = levels[-1][1]
    if inner == "ML":
        out["ML"] = total
    elif inner == "G":
        out["GM"] = total
    deepest = max((i for i, (_, content, _) in enumerate(levels) if _discrete(content)), default=None)
    if deepest is not None:
        ea = Decimal(1)
        for n, _, _ in levels[: deepest + 1]:
            ea *= n
        out["EA"] = ea
    return out or None


def kit_count(desc: str | None) -> Decimal | None:
    """Number of kits in an NDC whose FDA package description has a KIT level, else None.

    '1 KIT in 1 CARTON (0074-3641-03) * 1 mL in 1 SYRINGE * 1 mL in 1 PACKET' -> 1. Only the outer
    chain is read (the parts after '*' or '+' are the kit's components), down to the first level
    that holds kits.
    """
    if not desc:
        return None
    outer = re.split(r"[*+]", desc, 1)[0]
    outer = re.sub(r"\(\s*[\d-]+\s*\)", " ", outer)
    count = Decimal(1)
    for part in outer.split(" / "):
        m = PKG_LEVEL_RE.match(" ".join(part.split()))
        if not m:
            return None
        try:
            n = Decimal(m.group(1))
        except InvalidOperation:
            return None
        count *= n
        if re.split(r"[ ,]", m.group(2).strip().upper(), 1)[0] == "KIT":
            return count
    return None


STRENGTH_RE = re.compile(r"^\s*(\d*\.?\d+)\s*(mg|g|mcg)\s*/\s*(1|mL)\s*$", re.I)
DOSAGE_RE = re.compile(r"^\s*(\d*\.?\d+)\s*(MG|GM|G|MCG)\s*$", re.I)
TO_MG = {"MG": Decimal(1), "G": Decimal(1000), "GM": Decimal(1000), "MCG": Decimal("0.001")}


def units_by_strength(identity: dict | None, amount: Decimal, unit: str, dosage: str | None) -> Decimal | None:
    """Billable units in the NDC worked out from FDA's single-ingredient strength: strength per EA
    (or per mL) x the NDC's amount / the HCPCS code dosage. None when any part is not plain."""
    if not identity or not identity.get("strength") or not dosage:
        return None
    s, d = STRENGTH_RE.match(identity["strength"]), DOSAGE_RE.match(dosage)
    if not s or not d or {"1": "EA", "ML": "ML"}[s.group(3).upper()] != unit:
        return None
    total_mg = Decimal(s.group(1)) * TO_MG[s.group(2).upper()] * amount
    per_unit_mg = Decimal(d.group(1)) * TO_MG[d.group(2).upper()]
    return total_mg / per_unit_mg if per_unit_mg else None


class PartB:
    def __init__(self, limits_src: dict, xwalk_src: dict):
        self.limits_src, self.xwalk_src = limits_src, xwalk_src
        if limits_src["period"] != xwalk_src["period"]:
            sys.exit(f"Part B files are for different quarters: {limits_src['period']} vs {xwalk_src['period']}")
        self.limits = {}
        for r in read_asp_csv(limits_src, ["HCPCS Code", "Short Description", "HCPCS Code Dosage", "Payment Limit", "Co-insurance Percentage"]):
            code = r["HCPCS Code"]
            if code:
                self.limits.setdefault(code, []).append(r)
        self.xwalk = defaultdict(list)
        self.alt_ids = 0
        self.reconciled_by: dict[str, str | None] = {}
        lines = read_asp_csv(xwalk_src, ["NDC", "LABELER NAME", "PKG SIZE", "PKG QTY", "BILLUNITS", "BILLUNITSPKG"])
        if not lines:
            sys.exit(f"{xwalk_src['file']}: the crosswalk has no lines.")
        self.code_col = next(iter(lines[0]))  # the first column, e.g. "_2026_CODE"
        # Labelers billing under each code, over ALL of the code's crosswalk lines (alternate-ID
        # lines included), from the crosswalk's own LABELER NAME column, spelled as CMS spells it.
        self.labelers: dict[str, set] = defaultdict(set)
        for r in lines:
            n = r["NDC"].replace("-", "")
            if NDC_RE.match(n) and r["NDC"].count("-") == 2:
                self.xwalk[n].append(r)
            else:
                self.alt_ids += 1
            name = " ".join(r["LABELER NAME"].split())
            if not name:
                sys.exit(f"{xwalk_src['file']}: a line for {r[self.code_col]} has no LABELER NAME; labelers per code would be incomplete.")
            self.labelers[r[self.code_col]].add(name)

    def block(self, row: dict, identity: dict | None) -> tuple[dict | None, dict | None, str]:
        """(row.part_b, the part_b_codes entry for its HCPCS code, reason code when unmatched)."""
        hits = self.xwalk.get(row["ndc"])
        if not hits:
            return None, None, "not_in_crosswalk"
        keys = {(h[self.code_col], h["PKG SIZE"], h["PKG QTY"], h["BILLUNITSPKG"]) for h in hits}
        if len(keys) > 1:
            return None, None, "ambiguous_crosswalk"
        h = hits[0]
        code = h[self.code_col]
        lim = self.limits.get(code)
        if not lim:
            return None, None, "hcpcs_not_in_limits"
        if len(lim) > 1:
            return None, None, "hcpcs_repeated_in_limits"
        lim = lim[0]
        limit = positive(lim["Payment Limit"])
        if limit is None:
            return None, None, "limit_not_a_positive_number"
        coins = non_negative(lim["Co-insurance Percentage"])
        size, qty, units = positive(h["PKG SIZE"]), positive(h["PKG QTY"]), positive(h["BILLUNITSPKG"])
        if None in (size, qty, units) or coins is None:
            return None, None, "blank_package_or_coinsurance"

        L, X = self.limits_src, self.xwalk_src
        eff, period = period_start(L["period"]), L["period"]
        dosage = lim["HCPCS Code Dosage"] or h["HCPCS dosage"]
        desc = identity["package_description"] if identity else None
        totals = package_totals(desc)
        amount = size * qty
        # A kit is one NADAC EA: NADAC prices a kit as a whole, not its syringes or vials. When FDA
        # lists the NDC as kits, the EA count is the number of kits; when NADAC's own description
        # calls the NDC a kit (CIMZIA 2X200 MG/ML SYRINGE KIT) and FDA does not, the whole NDC is
        # one EA (only for an NDC FDA lists, so the package itself is known). Either way the
        # crosswalk's PKG SIZE x PKG QTY must equal that count.
        kits = kit_count(desc) if row["unit"] == "EA" else None
        nadac_kit = identity is not None and row["unit"] == "EA" and bool({"KIT", "KT"} & set(_toks(row["name"])))
        reconcile_rule = None
        if kits is not None:
            unit_confirmed = kits == amount
            have = (f"FDA's package description ({desc}) lists {kits.normalize():f} kit{'s' if kits != 1 else ''} per NDC, "
                    f"and OpenBill reads NADAC's EA for a kit as the whole kit")
            reconcile_rule = "kit" if unit_confirmed else None
        elif nadac_kit:
            unit_confirmed = amount == 1
            have = ("NADAC's description calls this NDC a kit, and OpenBill reads NADAC's EA for a kit as the whole "
                    "kit, which is 1 per NDC")
            reconcile_rule = "kit" if unit_confirmed else None
        else:
            unit_confirmed = bool(totals) and totals.get(row["unit"]) == amount
            have = (f"FDA's package description ({desc}) gives {totals[row['unit']].normalize():f} {row['unit']} per NDC"
                    if unit_confirmed else "")
            reconcile_rule = "fda_amount" if unit_confirmed else None
        package_unit = row["unit"] if unit_confirmed else None
        # CMS prints billable units twice: per item (BILLUNITS) and per NDC (BILLUNITSPKG). They
        # should agree (per item x PKG QTY = per NDC). On 208 of 7,403 lines in the October 2026
        # file they do not, and either column can be the wrong one. BILLUNITSPKG is then used only
        # when FDA's single-ingredient strength x the NDC's confirmed amount / the HCPCS dosage
        # equals it exactly: a third source settles which column is right.
        per_item = positive(h["BILLUNITS"])
        expected = per_item * qty if per_item is not None else None
        by_strength = units_by_strength(identity, amount, row["unit"], dosage) if unit_confirmed and reconcile_rule == "fda_amount" else None
        if expected == units:
            units_note = f"Equals BILLUNITS ({h['BILLUNITS']} per item) x PKG QTY."
        elif expected is not None and units == units.to_integral_value() and abs(expected - units) < 1:
            units_note = (f"BILLUNITS ({h['BILLUNITS']} per item) x PKG QTY is {expected.normalize():f}; CMS prints the whole "
                          f"number {units.normalize():f}.")
        elif by_strength is not None and by_strength == units:
            units_note = (f"Does not equal BILLUNITS ({h['BILLUNITS']} per item) x PKG QTY ({expected.normalize():f})"
                          if expected is not None else f"BILLUNITS is {h['BILLUNITS']!r}")
            units_note += (f", but FDA's strength {identity['strength']} x {amount.normalize():f} {row['unit']} per NDC / "
                           f"{dosage} = {units.normalize():f} = BILLUNITSPKG, so BILLUNITSPKG is used and BILLUNITS is not.")
            reconcile_rule = "strength_check"
        else:
            units_note = (f"Does not equal BILLUNITS ({h['BILLUNITS']} per item) x PKG QTY ({expected.normalize():f}); "
                          f"the crosswalk contradicts itself, so package_unit is null." if expected is not None
                          else f"BILLUNITS is {h['BILLUNITS']!r}, so this cannot be checked; package_unit is null.")
            package_unit = None
            reconcile_rule = None
        if unit_confirmed:
            unit_note = (f"{have}, equal to package size x quantity here, so the package is in NADAC's unit {row['unit']}.")
            if not package_unit:
                unit_note += " But the crosswalk's two billable-unit columns disagree, so package_unit is null."
            elif reconcile_rule == "strength_check":
                unit_note += " The crosswalk's two billable-unit columns disagree; FDA's strength settles it (see bill_units_per_package)."
        elif kits is not None or nadac_kit:
            unit_note = (f"{have}, but package size x quantity is {amount.normalize():f} here, so the crosswalk counts "
                         f"something other than the kit NADAC prices and package_unit is null.")
        else:
            unit_note = ("The crosswalk does not state the unit of package size; it could not be confirmed equal to "
                         f"NADAC's unit {row['unit']} from FDA's package description, so package_unit is null.")
        is_cpt = bool(re.match(r"^\d{4}[0-9A-Z]$", code))
        # The file's own Notes column qualifies some limits ("AMP-based payment limit", "8% of
        # reference add-on applied", "Inflation-adjusted coinsurance"); repeat it verbatim.
        note = " ".join((lim.get("Notes") or "").split())
        cms_note = f" Notes column for this code: '{note}'." if note else ""
        # CPT codes (five digits, e.g. vaccine codes 90xxx) and their descriptors are AMA
        # copyright; OpenBill repeats the code but not the descriptor.
        short = None if is_cpt else (lim["Short Description"] or None)
        # Part B pays under a code only in the settings CMS describes for it (J1817: insulin for
        # insulin pump use), not for every pharmacy fill of an NDC that bills under it.
        if short:
            setting = (f" Part B pays under {code} only in the settings CMS describes for this code; the file's short "
                       f"description of it is '{short}'.")
        elif is_cpt:
            setting = (f" Part B pays under {code} only in the settings CMS describes for this code (a CPT code, whose "
                       f"descriptor is AMA copyright and is not repeated here).")
        else:
            setting = f" Part B pays under {code} only in the settings CMS describes for this code; the file gives it no short description."
        dosage = dosage or None
        code_entry = {
            "hcpcs": code,
            "hcpcs_dosage": dosage,
            "short_description": short,
            "payment_limit": record(
                num(limit), "usd",
                f"Medicare Part B payment allowance limit for HCPCS {code}, dollars per {dosage}, quarter {period} "
                f"(column 'Payment Limit'). CMS: generally 106% of the manufacturer-reported average sales price; "
                f"presence in the file does not mean Medicare covers the drug.{setting}{cms_note}",
                L, eff, dosage, period, source_key="asp_limits",
            ),
            "coinsurance_pct": record(
                num(coins), "percent",
                f"Beneficiary coinsurance percentage printed for HCPCS {code} in the Part B payment limit file (column 'Co-insurance Percentage').{cms_note}",
                L, eff, None, period, source_key="asp_limits",
            ),
            "labelers": sorted(self.labelers[code]),
        }
        b = {
            "hcpcs": code,
            "bill_units_per_package": record(
                num(units), "count",
                f"Billable units of HCPCS {code} ({dosage}) in the whole 11-digit NDC: crosswalk column BILLUNITSPKG "
                f"('Billable Units Per 11-Digit NDC'). {units_note}",
                X, eff, None, period, source_key="asp_crosswalk",
            ),
            "package_size": record(
                num(size), "quantity",
                f"Amount in one item of this NDC, crosswalk column PKG SIZE. {unit_note}",
                X, eff, package_unit, period, source_key="asp_crosswalk",
            ),
            "package_qty": record(
                num(qty), "count",
                "Number of items in this NDC, crosswalk column PKG QTY.",
                X, eff, None, period, source_key="asp_crosswalk",
            ),
            "package_unit": package_unit,
        }
        # Which check reconciled package_unit, for counts.part_b_unit_reconciled_by.
        self.reconciled_by[row["ndc"]] = reconcile_rule if package_unit else None
        return b, code_entry, ""


# ============================================================ build

def write_json(doc_head: dict, tables: dict[str, dict], rows: list[dict]) -> None:
    """Head (schema, sources, counts) indented; then each table sorted by key, one entry per line;
    then the rows, one per line. So a refresh diff shows which names, codes and NDCs changed."""
    OUT.parent.mkdir(parents=True, exist_ok=True)

    def compact(v) -> str:
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))

    head = json.dumps(doc_head, indent=2, ensure_ascii=False)
    parts = [head[:-2]]
    for name, table in tables.items():
        entries = ",\n".join(f"    {compact(k)}:{compact(table[k])}" for k in sorted(table))
        parts.append(f'  {compact(name)}: {{\n{entries}\n  }}' if entries else f'  {compact(name)}: {{}}')
    body = ",\n".join(compact(row) for row in rows)
    tmp = OUT.with_name(OUT.name + ".part")
    with tmp.open("w", encoding="utf-8", newline="\n") as f:
        f.write(",\n".join(parts) + ',\n  "rows": [\n' + body + "\n  ]\n}\n")
    json.loads(tmp.read_text(encoding="utf-8"))  # never leave a broken file behind
    tmp.replace(OUT)


def source_entry(key: str, src: dict, **extra) -> dict:
    e = {
        "name": SOURCE_NAMES[key],
        "title": src.get("title"),
        "publisher": src.get("publisher"),
        "license": src.get("license"),
        "source_url": src["landing_url"],
        "download_url": src["download_url"],
        "source_file": src["file"],
        "sha256": src["sha256"],
        "bytes": src["bytes"],
        "period": src.get("period"),
        "as_of_date": src.get("as_of_date"),
        "retrieved_date": src["retrieved_date"],
    }
    e.update({k: v for k, v in extra.items() if v is not None})
    return e


def write_samples(out_rows: list[dict], pd_reasons: dict, pb_rows: list[dict], fda_raw: dict,
                  pd_names: dict, pb_codes: dict) -> list[str]:
    target = os.environ.get("OPENBILL_SAMPLES")
    if not target:
        return []
    d = Path(target)
    d.mkdir(parents=True, exist_ok=True)
    matched = [r for r in out_rows if r["part_d"]]
    step = max(len(matched) // 60, 1)
    pick = matched[::step][:60]
    unmatched = [r for r in out_rows if not r["part_d"] and not r["otc"]]
    ustep = max(len(unmatched) // 40, 1)
    upick = unmatched[::ustep][:40]
    cols = ["status", "rate_class", "nadac_name", "ndc", "fda_proprietary", "fda_nonproprietary", "fda_dosage_form",
            "partd_brand", "partd_generic", "basis", "partd_avg_per_unit", "nadac_per_unit", "unit", "outlier", "reason"]
    lines = ["\t".join(cols)]
    for r in pick + upick:
        i = r["identity"] or {}
        p = r["part_d"]
        n = pd_names[p["key"]] if p else {}
        vals = ["matched" if p else "unmatched", r["rate_class"], r["name"], r["ndc"], i.get("proprietary_name") or "",
                i.get("nonproprietary_name") or "", i.get("dosage_form") or "",
                n.get("brand_name", ""), n.get("generic_name", ""), p["basis"] if p else "",
                str(n["avg_per_unit"]["value"]) if p else "", str(r["nadac"]["value"]), r["unit"],
                str(n["outlier"]) if p else "", "" if p else pd_reasons.get(r["ndc"], "")]
        lines.append("\t".join(v.replace("\t", " ") for v in vals))
    (d / "part_d_sample.tsv").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    cols = ["nadac_name", "ndc", "unit", "nadac_per_unit", "hcpcs", "hcpcs_dosage", "payment_limit", "coinsurance_pct",
            "bill_units_per_ndc", "package_size", "package_qty", "package_unit", "fda_package_description",
            "medicare_per_nadac_unit_if_reconciled"]
    lines = ["\t".join(cols)]
    bstep = max(len(pb_rows) // 200, 1) if len(pb_rows) > 200 else 1
    for r in (pb_rows[::bstep][:200] if len(pb_rows) > 200 else pb_rows):
        b = r["part_b"]
        c = pb_codes[b["hcpcs"]]
        per = ""
        if b["package_unit"]:
            v = (Decimal(str(c["payment_limit"]["value"])) * Decimal(str(b["bill_units_per_package"]["value"]))
                 / (Decimal(str(b["package_size"]["value"])) * Decimal(str(b["package_qty"]["value"]))))
            per = f"{v:.5f}"
        vals = [r["name"], r["ndc"], r["unit"], str(r["nadac"]["value"]), b["hcpcs"], c["hcpcs_dosage"] or "",
                str(c["payment_limit"]["value"]), str(c["coinsurance_pct"]["value"]), str(b["bill_units_per_package"]["value"]),
                str(b["package_size"]["value"]), str(b["package_qty"]["value"]), b["package_unit"] or "",
                (r["identity"] or {}).get("package_description") or "", per]
        lines.append("\t".join(v.replace("\t", " ") for v in vals))
    (d / "part_b_sample.tsv").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return [str(d / "part_d_sample.tsv"), str(d / "part_b_sample.tsv")]


def build() -> int:
    S = load_sources()
    nadac_src = S["nadac"]
    raw, as_of, weeks = read_nadac(nadac_src["path"])
    if nadac_src.get("as_of_date") not in (None, as_of):
        sys.exit(f"Manifest says NADAC as of {nadac_src.get('as_of_date')}, the file's newest week is {as_of}. Re-run fetch_nadac.py.")
    nadac_src = S["nadac"] = {**nadac_src, "as_of_date": as_of}
    rows, rejected, duplicates = build_nadac_rows(raw, nadac_src)

    identities, fda_raw, fda_info = load_identities(S["fda_ndc"]["path"])
    pd = PartD(S["partd"], fda_info["rx_forms"], fda_info["rx_name_forms"])
    pb = PartB(S["asp_limits"], S["asp_crosswalk"])

    pd_reasons: dict[str, str] = {}
    pd_hits: dict[int, list] = defaultdict(list)
    pd_unmatched = Counter()
    pb_unmatched = Counter()
    pb_codes: dict[str, dict] = {}
    by_code_rows = by_code_matched = 0
    # (NADAC description, product code) pairs with at least one NDC FDA lists exactly.
    listed = {(r["name"], n[:9]) for n, r in rows.items() if n in identities}
    for ndc, row in rows.items():
        row["identity"] = identities.get(ndc)
        fda = fda_raw.get(ndc)
        from_code = False
        if fda is None and row["identity"] is None:
            # No exact package match: match with the record of the FDA product this NDC's product
            # code belongs to, so it faces the same FDA checks as the product's listed packages.
            fda = product_code_fda(row, fda_info["by_product_code"], (row["name"], ndc[:9]) in listed)
            from_code = fda is not None
            by_code_rows += from_code
            if from_code:
                # The route of that same accepted record: a * name's route split may use it.
                row["_code_route"] = blank_to_none(fda["ROUTENAME"])
                row["_code_product_ndc"] = fda["PRODUCTNDC"].strip()
        e, basis, path, code = pd.match(row, fda)
        if from_code and e is not None:
            row["_pd_by_code"] = True
        if e is not None:
            pd_hits[id(e)].append((row, e, basis, path))
        else:
            pd_reasons[ndc] = PART_D_UNMATCHED[code]
            pd_unmatched[code] += 1
        b, code_entry, why = pb.block(row, row["identity"])
        row["part_b"] = b
        if b is None:
            pb_unmatched[why] += 1
            continue
        # One entry per HCPCS code. Every row that joins a code must describe it identically.
        known = pb_codes.setdefault(b["hcpcs"], code_entry)
        if known != code_entry:
            sys.exit(f"HCPCS {b['hcpcs']}: rows describe the code differently (e.g. NDC {ndc}); refusing to pick one.")

    # CMS's "dosage unit" is not stated per drug. When NADAC prices the NDCs that joined one
    # Part D name in more than one unit (capsules per EA, the solution per ML), CMS's average
    # mixes units. Only NDCs in a unit that covers at least MAJORITY_UNIT_SHARE of those NDCs
    # get the figure, with the mix stated; the others get none.
    # part_d_names holds one entry per Part D row that at least one NDC references, priced per the
    # NADAC unit those NDCs share (at most one unit can cover MAJORITY_UNIT_SHARE of them).
    # A Part D name CMS marks with * averages several routes of administration. Only NDCs with a
    # known FDA route that every NDC joined to the name shares keep it (docs/ARCHITECTURE.md): the
    # route of the row's FDA identity, or, for an NDC whose package is not in the Directory, the
    # route of the product-code record product_code_fda() accepted for it above.
    # The unit rule below still counts every NDC the name join matched: it is about what CMS's
    # average mixes, and dropping NDCs of other routes here does not change CMS's average.
    pd_names: dict[str, dict] = {}
    route_notes: dict[int, str] = {}
    all_units = {k: Counter(row["unit"] for row, _, _, _ in hits) for k, hits in pd_hits.items()}
    route_from_used = Counter()  # rows whose * route split used the product-code route, by outcome
    for k in list(pd_hits):
        hits = pd_hits[k]
        if "*" not in hits[0][1]["row"]["Brnd_Name"]:
            continue
        kept, dropped, route = star_route_split(hits)
        for row, why in dropped:
            pd_reasons[row["ndc"]] = PART_D_UNMATCHED[why]
            pd_unmatched[why] += 1
            row.pop("_pd_by_code", None)
            if why != "multi_route_no_identity" and row["identity"] is None:
                route_from_used[why] += 1
        if kept:
            pd_hits[k] = kept
            units, total = all_units[k], sum(all_units[k].values())
            joined = [row for row, _, _, _ in kept if units[row["unit"]] / total >= MAJORITY_UNIT_SHARE]
            route_notes[k] = star_route_note(route, len(kept), joined, len(hits))
        else:
            del pd_hits[k]
    for k, hits in pd_hits.items():
        units = all_units[k]
        total = sum(units.values())
        for row, e, basis, path in hits:
            share = units[row["unit"]] / total
            mix = route_notes.get(k)
            if len(units) > 1:
                others = ", ".join(f"{n} per {u}" for u, n in sorted(units.items()) if u != row["unit"])
                unit_mix = f"{units[row['unit']]} of {total} NADAC NDCs joined to this name are priced per {row['unit']} ({others}): CMS's average mixes those units."
                mix = f"{mix} {unit_mix}" if mix else unit_mix
            entry = part_d_entry(e, basis, row["unit"], pd, mix) if share >= MAJORITY_UNIT_SHARE else None
            if entry:
                key = part_d_key(e)
                known = pd_names.setdefault(key, entry)
                if known != entry:
                    sys.exit(f"Part D {key}: joined NDCs need different entries (e.g. NDC {row['ndc']}); refusing to pick one.")
                row["part_d"] = {"key": key, "basis": basis}
                if row.pop("_route_from", None) == ROUTE_FROM_PRODUCT:
                    # This join depends on the route of the FDA product record: say so on the row.
                    # product_ndc is FDA's own PRODUCTNDC ("50268-662"), so a reader can find the record;
                    # inner_of lists the FDA packages of that product whose description prints this NDC
                    # as an inner unit ([] when none does).
                    row["part_d"].update(route_from=ROUTE_FROM_PRODUCT, route=row["_code_route"],
                                         product_ndc=row["_code_product_ndc"],
                                         inner_of=sorted(fda_info["inner_of"].get(row["ndc"], ())))
                    route_from_used["joined"] += 1
                row["_pd_path"] = path
            else:
                row.pop("_pd_by_code", None)
                if row.pop("_route_from", None) == ROUTE_FROM_PRODUCT:
                    route_from_used["mixed_units" if share < MAJORITY_UNIT_SHARE else "no_value"] += 1
                code = "mixed_units" if share < MAJORITY_UNIT_SHARE else "no_value"
                pd_reasons[row["ndc"]] = PART_D_UNMATCHED[code]
                pd_unmatched[code] += 1
    # Two different Part D rows must never share a key (CMS's Overall rows are one per brand +
    # generic name; this would catch a file where they are not).
    key_owner: dict[str, int] = {}
    for hits in pd_hits.values():
        e = hits[0][1]
        if key_owner.setdefault(part_d_key(e), id(e)) != id(e):
            sys.exit(f"Two Part D Overall rows share the key {part_d_key(e)!r}.")

    out_rows = sorted(rows.values(), key=lambda x: (x["name"], x["ndc"]))
    paths = Counter(r.pop("_pd_path") for r in out_rows if "_pd_path" in r)
    by_code_matched = sum(1 for r in out_rows if r.pop("_pd_by_code", False))
    # Fixed key order on every row, matching the contract.
    order = ["ndc", "name", "unit", "otc", "rate_class", "explanation_codes", "carried_forward", "identity",
             "nadac", "generic_nadac", "part_d", "part_b"]
    out_rows = [{k: r[k] for k in order if k in r} for r in out_rows]

    def records_of(r):
        yield r["nadac"]
        if r.get("generic_nadac"):
            yield r["generic_nadac"]
        if r["part_b"]:
            for k in ("bill_units_per_package", "package_size", "package_qty"):
                yield r["part_b"][k]

    def table_records():
        for n in pd_names.values():
            yield n["avg_per_unit"]
            if n.get("claims"):
                yield n["claims"]
        for c in pb_codes.values():
            yield c["payment_limit"]
            yield c["coinsurance_pct"]

    # Every record in the file, once: row records plus the shared table records.
    by_state = Counter(rec["state"] for r in out_rows for rec in records_of(r))
    by_state.update(rec["state"] for rec in table_records())
    row_state = Counter(r["nadac"]["state"] for r in out_rows)
    n = len(out_rows)
    classes = sorted({r["rate_class"] for r in out_rows})
    pd_rows = [r for r in out_rows if r["part_d"]]
    pb_rows = [r for r in out_rows if r["part_b"]]
    counts = {
        "rows": n,
        "rows_by_state": dict(sorted(row_state.items())),
        "records_by_state": dict(sorted(by_state.items())),
        "distinct_names": len({r["name"] for r in out_rows}),
        "identity_matched": sum(1 for r in out_rows if r["identity"]),
        "identity_ambiguous": sum(1 for r in out_rows if r["ndc"] in fda_info["ambiguous"]),
        # Rows whose FDA identity carries pharm_classes, and the distinct [EPC] entries among them
        # (the class pages). Ambiguous: FDA lists the package under product records whose
        # PHARM_CLASSES differ, so none is written.
        "identity_with_pharm_classes": sum(1 for r in out_rows if r["identity"] and "pharm_classes" in r["identity"]),
        "identity_pharm_classes_ambiguous": sum(1 for r in out_rows if r["ndc"] in fda_info["pharm_ambiguous"]),
        "epc_classes": len({c for r in out_rows if r["identity"] for c in r["identity"].get("pharm_classes", ()) if c.endswith(" [EPC]")}),
        "part_d_matched": len(pd_rows),
        "part_d_by_basis": dict(sorted(Counter(r["part_d"]["basis"] for r in pd_rows).items())),
        "part_d_by_join": dict(sorted(paths.items())),
        "part_d_by_rate_class": {c: {"rows": sum(1 for r in out_rows if r["rate_class"] == c),
                                     "matched": sum(1 for r in pd_rows if r["rate_class"] == c)} for c in classes},
        "part_d_otc": {"rows": sum(1 for r in out_rows if r["otc"]), "matched": sum(1 for r in pd_rows if r["otc"])},
        "part_d_outliers": sum(1 for r in pd_rows if pd_names[r["part_d"]["key"]]["outlier"] is True),
        "part_d_outlier_flag_blank": sum(1 for r in pd_rows if pd_names[r["part_d"]["key"]]["outlier"] is None),
        "part_d_multiple_routes": sum(1 for r in pd_rows if "*" in pd_names[r["part_d"]["key"]]["brand_name"]),
        # Rows with no exact FDA package match that were matched using their product code's FDA record.
        "part_d_fda_by_product_code": {"rows": by_code_rows, "matched": by_code_matched},
        # Rows with no exact FDA package match that joined a * name by name and whose route split
        # used the route of that product-code record: how many, how many kept the join because of
        # it (part_d.route_from = "fda_product"), and what happened to the others.
        "part_d_route_from_product_code": {"rows": sum(route_from_used.values()), "joined": route_from_used["joined"],
                                           "not_joined": dict(sorted((k, v) for k, v in route_from_used.items() if k != "joined"))},
        "part_d_unmatched": dict(sorted(pd_unmatched.items(), key=lambda kv: (-kv[1], kv[0]))),
        "part_b_matched": len(pb_rows),
        "part_b_unit_reconciled": sum(1 for r in pb_rows if r["part_b"]["package_unit"]),
        "part_b_unit_reconciled_by": dict(sorted(Counter(pb.reconciled_by[r["ndc"]] for r in pb_rows if r["part_b"]["package_unit"]).items())),
        "part_b_unmatched": dict(sorted(pb_unmatched.items(), key=lambda kv: (-kv[1], kv[0]))),
        "part_d_names": len(pd_names),
        "part_b_codes": len(pb_codes),
        "part_b_single_labeler_codes": sum(1 for c in pb_codes.values() if len(c["labelers"]) == 1),
        "carried_forward": sum(r["carried_forward"] for r in out_rows),
        "with_generic_nadac": sum("generic_nadac" in r for r in out_rows),
        "rejected": len(rejected),
        "duplicate_ndcs": duplicates,
    }

    sources = {
        "nadac": source_entry("nadac", nadac_src, weeks_in_file=weeks),
        "fda_ndc": source_entry("fda_ndc", S["fda_ndc"], products=fda_info["products"], packages=fda_info["packages"]),
        "partd": source_entry("partd", S["partd"], data_year=pd.year,
                              data_dictionary_url=S["partd"].get("data_dictionary_url"),
                              methodology_url=S["partd"].get("methodology_url")),
        "asp_limits": source_entry("asp_limits", S["asp_limits"], member=S["asp_limits"].get("member")),
        "asp_crosswalk": source_entry("asp_crosswalk", S["asp_crosswalk"], member=S["asp_crosswalk"].get("member")),
    }
    referenced_d = {r["part_d"]["key"] for r in pd_rows}
    referenced_b = {r["part_b"]["hcpcs"] for r in pb_rows}
    if referenced_d != set(pd_names) or referenced_b != set(pb_codes):
        sys.exit("A table entry is not referenced by any row, or a row points at a missing entry.")
    write_json({"schema": SCHEMA, "sources": sources, "counts": counts},
               {"part_d_names": pd_names, "part_b_codes": pb_codes}, out_rows)
    samples = write_samples(out_rows, pd_reasons, pb_rows, fda_raw, pd_names, pb_codes)

    age = (dt.date.fromisoformat(nadac_src["retrieved_date"]) - dt.date.fromisoformat(as_of)).days
    eff = sorted(r["nadac"]["effective_date"] for r in out_rows)
    pct = lambda a, b: f"{100 * a / max(b, 1):.1f}%"
    c = counts
    print(f"""
data/drugs.json  ({OUT.stat().st_size / 1e6:,.1f} MB, schema {SCHEMA})
  sources         """ + "\n                  ".join(f"{k:<14} {S[k]['file']}  sha256 {S[k]['sha256'][:12]}... (verified)" for k in SOURCE_IDS) + f"""
  as of           {as_of}  (newest of {weeks} weekly NADAC files; retrieved {nadac_src['retrieved_date']}, {age} days later)
  rows            {n:,}  (one per NDC; {c['distinct_names']:,} distinct drug descriptions)
  filed           {row_state.get(FILED, 0):,} of {n:,} rows ({pct(row_state.get(FILED, 0), n)})
  price records   {sum(by_state.values()):,}  {dict(sorted(by_state.items()))}
  generic NADAC   {c['with_generic_nadac']:,} brand rows also carry their generic's NADAC
  carried fwd     {c['carried_forward']:,} rows not re-surveyed this cycle (explanation code 2 or 4)
  effective dates {eff[0]} .. {eff[-1]}
  rejected        {c['rejected']}   duplicates {c['duplicate_ndcs']}
  identity        {c['identity_matched']:,} of {n:,} rows ({pct(c['identity_matched'], n)}) by exact NDC in the FDA NDC Directory; {c['identity_ambiguous']} ambiguous
  classes         {c['identity_with_pharm_classes']:,} identity rows carry FDA pharm_classes; {c['epc_classes']:,} distinct [EPC] classes; {c['identity_pharm_classes_ambiguous']} ambiguous
  Part D          {c['part_d_matched']:,} of {n:,} rows ({pct(c['part_d_matched'], n)}), data year {pd.year}; by basis {c['part_d_by_basis']}; by join {c['part_d_by_join']}
                  """ + "; ".join(f"{k} {v['matched']:,}/{v['rows']:,} ({pct(v['matched'], v['rows'])})" for k, v in c["part_d_by_rate_class"].items())
          + f"""; OTC {c['part_d_otc']['matched']}/{c['part_d_otc']['rows']}
                  outliers {c['part_d_outliers']:,}, outlier flag blank {c['part_d_outlier_flag_blank']}, multiple-route (*) names {c['part_d_multiple_routes']:,}
                  no exact FDA package: {c['part_d_fda_by_product_code']['rows']:,} rows matched with their product code's FDA record, {c['part_d_fda_by_product_code']['matched']:,} of them joined
                  * route from that record: {c['part_d_route_from_product_code']['rows']:,} rows, {c['part_d_route_from_product_code']['joined']:,} joined; not joined {c['part_d_route_from_product_code']['not_joined']}
  Part B          {c['part_b_matched']:,} rows joined through the crosswalk ({pct(c['part_b_matched'], n)}); package unit reconciled to the NADAC unit on {c['part_b_unit_reconciled']:,} {c['part_b_unit_reconciled_by']}
  tables          part_d_names {c['part_d_names']:,}; part_b_codes {c['part_b_codes']:,} ({c['part_b_single_labeler_codes']:,} with a single labeler on the crosswalk)
""".rstrip())
    for why, k in c["part_d_unmatched"].items():
        print(f"    Part D unmatched  {k:>6,}  {why}")
    for why, k in list(c["part_b_unmatched"].items())[:5]:
        print(f"    Part B unmatched  {k:>6,}  {why}")
    for ndc, why in rejected[:20]:
        print(f"  rejected {ndc}: {why}")
    for s in samples:
        print(f"  sample          {s}")
    if age > STALE_AFTER_DAYS:
        print(f"WARNING: newest NADAC week is {age} days older than the retrieval date. The source may be stale.")
    return 0


if __name__ == "__main__":
    sys.exit(build())
