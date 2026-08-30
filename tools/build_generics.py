#!/usr/bin/env python3
"""Derive the curated generic cosmetic stylesheet from EasyList.

EasyList ships ~13,600 generic (undomained) `##` hiding rules. Injecting all of
them into every page is the classic way to build a slow ad blocker: one enormous
selector list that the style engine must evaluate against every element on every
page. See README "Cosmetic filtering" for the reasoning.

Instead this extracts a small, conservative subset:

  * simple selectors only (a single #id or .class, no combinators, no
    attribute selectors, no pseudo-classes) - cheap for the style engine
  * the identifier must contain a delimited ad-related token, so "ad-slot"
    qualifies but "gradient", "download", "badge" and "thread" do not
  * a deny-list catches the remaining false friends

The result is written to extension/content/generics.css. Re-run it after
update_lists.py to refresh.

Usage:
    py tools/build_generics.py
    py tools/build_generics.py --limit 400 --show-rejected
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EASYLIST = ROOT / "extension" / "filters" / "easylist.txt"
OUT = ROOT / "extension" / "content" / "generics.css"
OUT_JS = ROOT / "extension" / "content" / "generics.js"

# A single #id or .class, nothing else.
SIMPLE_SELECTOR = re.compile(r"^([#.])([A-Za-z][-_A-Za-z0-9]*)$")

# Ad-related tokens, required to sit on a word boundary within the identifier.
# Delimiters are start/end, '-', '_', or a case change (adSlot).
AD_TOKENS = [
    "ad", "ads", "advert", "adverts", "advertising", "advertisement",
    "adbox", "adblock", "adbanner", "adslot", "adunit", "adzone", "adwrap",
    "adframe", "adspace", "adcontainer", "adsense", "adserver", "adtech",
    "sponsored", "sponsorship", "sponsor",
    "doubleclick", "taboola", "outbrain", "adnxs", "adroll",
    "googlead", "googleads", "banneradv", "leaderboard", "skyscraper",
    "interstitial", "popunder", "prebid",
]

# Identifiers that contain an ad token by accident, or are too load-bearing to
# hide. Anything matching these is dropped even if the token test passes.
DENY_SUBSTRINGS = [
    "load", "download", "upload", "head", "header", "shadow", "padding",
    "gradient", "badge", "thread", "radio", "read", "spread", "bread",
    "adapt", "adam", "admin", "adjust", "advance", "advice", "address",
    "adopt", "additional", "adadapted", "leader-line", "add",
]

MIN_IDENT_LENGTH = 5

# Structural words that commonly pair with an ad token in a container name.
# An identifier built only from ad tokens plus these is a canonical, widely-used
# name ("ad-container", "sponsored-block") and is worth shipping globally.
STRUCTURAL_WORDS = {
    "container", "wrapper", "wrap", "box", "slot", "unit", "block", "area",
    "bar", "banner", "top", "bottom", "left", "right", "side", "sidebar",
    "header", "footer", "main", "inner", "outer", "content", "holder",
    "space", "zone", "region", "panel", "widget", "module", "section",
    "label", "text", "middle", "center", "centre", "column", "col", "row",
    "frame", "placeholder", "slot", "spot", "tag", "item", "list", "grid",
    "small", "large", "big", "medium", "square", "rect", "rectangle",
    "horizontal", "vertical", "inline", "float", "fixed", "sticky",
    "div", "el", "id", "the", "site", "page", "post", "article", "story",
    "google", "dfp", "gpt",
}


def split_identifier(ident: str) -> list[str]:
    """Break an identifier into lowercase word parts on -, _ and case changes."""
    parts = re.split(r"[-_]+", ident)
    out = []
    for p in parts:
        if not p:
            continue
        # camelCase / PascalCase -> separate words
        out.extend(w.lower() for w in re.findall(r"[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+", p))
    return out


def is_safe(kind: str, ident: str) -> tuple[bool, str]:
    if len(ident) < MIN_IDENT_LENGTH:
        return False, "too short"

    low = ident.lower()
    for bad in DENY_SUBSTRINGS:
        if bad in low:
            return False, f"deny-list: {bad}"

    words = split_identifier(ident)
    if not words:
        return False, "no words"

    # A digit-only suffix is common ("ad-300", "ad2"); fold those in.
    normalised = [re.sub(r"\d+$", "", w) or w for w in words]
    for w in normalised:
        if w in AD_TOKENS:
            return True, ""
    return False, "no delimited ad token"


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the curated generic stylesheet.")
    ap.add_argument("--limit", type=int, default=350, help="max selectors to emit")
    ap.add_argument("--show-rejected", action="store_true")
    args = ap.parse_args()

    if not EASYLIST.exists():
        raise SystemExit(f"{EASYLIST} not found - run tools/update_lists.py first")

    text = EASYLIST.read_text(encoding="utf-8")

    accepted: list[str] = []
    seen: set[str] = set()
    rejected: dict[str, int] = {}
    total_generic = 0

    for line in text.split("\n"):
        s = line.strip()
        if not s or s.startswith("!"):
            continue
        # Generic hiding rules only: they start with '##' (no domain prefix).
        if not s.startswith("##"):
            continue
        total_generic += 1
        selector = s[2:].strip()

        m = SIMPLE_SELECTOR.match(selector)
        if not m:
            rejected["not a simple #id/.class"] = rejected.get("not a simple #id/.class", 0) + 1
            continue

        kind, ident = m.group(1), m.group(2)
        good, why = is_safe(kind, ident)
        if not good:
            rejected[why] = rejected.get(why, 0) + 1
            if args.show_rejected and why == "no delimited ad token":
                print(f"  reject {selector}")
            continue

        if selector.lower() in seen:
            continue
        seen.add(selector.lower())
        accepted.append(selector)

    # Rank by how canonical the name is, not alphabetically. A selector like
    # ".ad-container" appears across countless sites; one like
    # "#acm-ad-tag-lawrence_dfp_mobile_arkadium" is effectively site-specific
    # and adds cost without coverage.
    def score(selector: str) -> tuple:
        ident = selector[1:]
        words = split_identifier(ident)
        base = [re.sub(r"\d+$", "", w) or w for w in words]
        unknown = sum(1 for w in base if w not in AD_TOKENS and w not in STRUCTURAL_WORDS)
        digits = sum(1 for c in ident if c.isdigit())
        return (unknown, digits, len(ident), selector.lower())

    accepted.sort(key=score)
    if len(accepted) > args.limit:
        print(f"note: {len(accepted)} passed the filter, keeping the {args.limit} most generic")
        accepted = accepted[: args.limit]
    # Emit in a stable, readable order once the selection is made.
    accepted.sort(key=lambda s: (s[0], s[1:].lower()))

    stamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    body = ",\n".join(accepted)
    css = f"""/* Curated generic ad-container selectors.
 *
 * GENERATED by tools/build_generics.py from EasyList - do not edit by hand.
 * Generated: {stamp}
 * Source: {total_generic:,} generic ## rules in EasyList, filtered down to
 * {len(accepted)} simple, unambiguous selectors.
 *
 * Only simple #id / .class selectors with a delimited ad token survive the
 * filter, so the style engine stays cheap and false positives stay rare.
 * The remaining EasyList cosmetic rules are applied per-hostname at runtime
 * instead - see extension/lib/engine.js cosmeticFor().
 */

{body} {{
  display: none !important;
}}
"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(css, encoding="utf-8", newline="\n")

    # Also emit the same rule as a JS string. The content script injects it
    # synchronously at document_start (no flash of unstyled ads) and can remove
    # it again on a site carrying $generichide. Declaring it as manifest CSS
    # instead would be marginally simpler but could not be undone per-site.
    rule = body + " {\n  display: none !important;\n}\n"
    js = (
        "// GENERATED by tools/build_generics.py - do not edit by hand.\n"
        f"// Generated: {stamp}\n"
        f"// {len(accepted)} curated generic selectors. See generics.css for the\n"
        "// readable form and how they were derived.\n"
        "\n"
        f"const AB_GENERIC_CSS = {json.dumps(rule)};\n"
    )
    OUT_JS.write_text(js, encoding="utf-8", newline="\n")

    print(f"Wrote {OUT.relative_to(ROOT)} and {OUT_JS.relative_to(ROOT)}")
    print(f"  {total_generic:,} generic ## rules in EasyList")
    print(f"  {len(accepted)} selectors kept")
    print("  rejected:")
    for why, n in sorted(rejected.items(), key=lambda kv: -kv[1]):
        print(f"    {n:6,}  {why}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
