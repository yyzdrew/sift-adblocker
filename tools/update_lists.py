#!/usr/bin/env python3
"""Refresh the vendored filter-list snapshots.

Downloads each list defined in CATALOG into extension/filters/, records a
sha256 and the list's own "! Version:" header in filters/lists.json, then
reports what changed.

This tool only *fetches*. Parsing lives in extension/lib/parser.js so there is
exactly one parser implementation rather than two that drift apart.

Usage:
    py tools/update_lists.py            # fetch every list
    py tools/update_lists.py easylist   # fetch just one
    py tools/update_lists.py --check    # report staleness, write nothing
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILTERS_DIR = ROOT / "extension" / "filters"
MANIFEST = FILTERS_DIR / "lists.json"

USER_AGENT = "AdBlockerListUpdater/1.0"
TIMEOUT = 60

# The lists we ship. Adding one here and re-running is all it takes; the
# extension reads this same manifest to know what to load and what to refresh.
CATALOG = [
    {
        "id": "easylist",
        "title": "EasyList",
        "description": "The primary advertising filter list.",
        "url": "https://easylist.to/easylist/easylist.txt",
        "file": "easylist.txt",
        "homepage": "https://easylist.to/",
        "license": "GPL-3.0-or-later OR CC-BY-SA-3.0",
    },
    {
        "id": "easyprivacy",
        "title": "EasyPrivacy",
        "description": "Tracking and telemetry filters.",
        "url": "https://easylist.to/easylist/easyprivacy.txt",
        "file": "easyprivacy.txt",
        "homepage": "https://easylist.to/",
        "license": "GPL-3.0-or-later OR CC-BY-SA-3.0",
    },
]

VERSION_RE = re.compile(r"^!\s*Version:\s*(.+?)\s*$", re.IGNORECASE)
TITLE_RE = re.compile(r"^!\s*Title:\s*(.+?)\s*$", re.IGNORECASE)
EXPIRES_RE = re.compile(r"^!\s*Expires:\s*(.+?)\s*$", re.IGNORECASE)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def size_str(n: int) -> str:
    if n < 1024:
        return "%d B" % n
    if n < 1024 * 1024:
        return "%.1f KB" % (n / 1024)
    return "%.2f MB" % (n / (1024 * 1024))


def read_manifest() -> dict:
    if not MANIFEST.exists():
        return {"schema": 1, "generatedAt": None, "lists": []}
    try:
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print("  ! lists.json unreadable (%s); starting fresh" % exc, file=sys.stderr)
        return {"schema": 1, "generatedAt": None, "lists": []}


def header_field(text: str, pattern: re.Pattern) -> str | None:
    """Filter-list metadata lives in the first handful of lines."""
    for line in text.split("\n", 40)[:40]:
        m = pattern.match(line)
        if m:
            return m.group(1)
    return None


def count_rules(text: str) -> tuple[int, int]:
    """Return (non-blank lines, comment lines). A tally, not a parse."""
    total = 0
    comments = 0
    for line in text.split("\n"):
        s = line.strip()
        if not s:
            continue
        total += 1
        if s.startswith("!") or (s.startswith("[") and s.endswith("]")):
            comments += 1
    return total, comments


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        raw = resp.read()
    # Filter lists are UTF-8; be forgiving about stray bytes rather than dying.
    return raw.decode("utf-8", errors="replace")


def update_one(entry: dict, previous: dict | None, check_only: bool) -> dict:
    print("  %s <- %s" % (entry["title"], entry["url"]))
    try:
        text = fetch(entry["url"])
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
        print("    FAILED: %s" % exc, file=sys.stderr)
        if previous:
            print("    keeping the existing snapshot")
            return previous
        raise SystemExit(
            "no existing snapshot for %s and the fetch failed" % entry["id"]
        )

    # Normalise to LF so the checksum is stable across platforms.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    data = text.encode("utf-8")
    digest = hashlib.sha256(data).hexdigest()
    total, comments = count_rules(text)
    rules = total - comments

    old_digest = (previous or {}).get("sha256")
    if old_digest == digest:
        print("    unchanged (%s, %s rules)" % (size_str(len(data)), format(rules, ",")))
    elif old_digest:
        delta = rules - (previous or {}).get("rules", 0)
        print(
            "    updated   (%s, %s rules, %s%s)"
            % (
                size_str(len(data)),
                format(rules, ","),
                "+" if delta >= 0 else "",
                format(delta, ","),
            )
        )
    else:
        print("    new       (%s, %s rules)" % (size_str(len(data)), format(rules, ",")))

    if not check_only:
        (FILTERS_DIR / entry["file"]).write_text(text, encoding="utf-8", newline="\n")

    return {
        "id": entry["id"],
        "title": header_field(text, TITLE_RE) or entry["title"],
        "description": entry["description"],
        "url": entry["url"],
        "file": entry["file"],
        "homepage": entry["homepage"],
        "license": entry["license"],
        "version": header_field(text, VERSION_RE),
        "expires": header_field(text, EXPIRES_RE),
        "bytes": len(data),
        "lines": total,
        "rules": rules,
        "sha256": digest,
        "fetchedAt": now_iso(),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Refresh vendored filter-list snapshots.")
    ap.add_argument("ids", nargs="*", help="list ids to update (default: all)")
    ap.add_argument(
        "--check",
        action="store_true",
        help="report what would change without writing anything",
    )
    args = ap.parse_args()

    known = {e["id"] for e in CATALOG}
    wanted = set(args.ids) if args.ids else known
    unknown = wanted - known
    if unknown:
        print("unknown list id(s): %s" % ", ".join(sorted(unknown)), file=sys.stderr)
        print("known ids: %s" % ", ".join(sorted(known)), file=sys.stderr)
        return 2

    FILTERS_DIR.mkdir(parents=True, exist_ok=True)
    by_id = {e["id"]: e for e in read_manifest().get("lists", [])}

    print(
        "%s filter lists in %s" % ("Checking" if args.check else "Updating", FILTERS_DIR)
    )
    results = []
    for entry in CATALOG:
        if entry["id"] in wanted:
            results.append(update_one(entry, by_id.get(entry["id"]), args.check))
        elif entry["id"] in by_id:
            results.append(by_id[entry["id"]])

    if args.check:
        print("\n--check: nothing written.")
        return 0

    manifest = {"schema": 1, "generatedAt": now_iso(), "lists": results}
    MANIFEST.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    total_rules = sum(r.get("rules", 0) for r in results)
    total_bytes = sum(r.get("bytes", 0) for r in results)
    print(
        "\nWrote lists.json - %d lists, %s rules, %s"
        % (len(results), format(total_rules, ","), size_str(total_bytes))
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
