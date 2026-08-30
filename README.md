# Sift Ad Blocker

A working ad and tracker blocker for Firefox. Manifest V3, blocking `webRequest`,
real EasyList/EasyPrivacy parsing, no build step, no dependencies.

It ships with 136,000 filter rules compiled into an index that a request checks
in about **17 microseconds**, touching roughly **0.05% of the rule set** per
lookup.

---

## Install it

### Permanently (recommended)

Release Firefox refuses to permanently install an unsigned extension. Signing it
on the **unlisted** channel fixes that — unlisted means it is signed for your own
use, not published to the store and not reviewed:

```sh
py tools/sign.py
```

You need AMO API credentials once, from
<https://addons.mozilla.org/developers/addon/api/key/>, saved as
`.amo-credentials.json` in the project root (gitignored):

```json
{"issuer": "user:12345:67", "secret": "..."}
```

The script packages `extension/` into an `.xpi`, uploads it, waits for Mozilla to
sign it, and writes the result to `dist/`. Install that file via
**about:addons → gear icon → Install Add-on From File…**. It survives restarts.

To ship an update, bump `version` in `extension/manifest.json` and run it again.

### Temporarily, for development

No signing, but it unloads when you quit Firefox:

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select **`extension/manifest.json`** (the file, not the folder)

To reload after editing, click **Reload** on its card. **Inspect** opens the
background console, where every block is logged with the rule that matched.

> The manifest sets `browser_specific_settings.gecko.id`. Without it Firefox
> hands a temporary add-on a **fresh ID on every reload**, which wipes
> `storage.local` — you would lose your whitelist and counters each time.

Requires **Firefox 128+** (see [Firefox notes](#firefox-notes) for why).

---

## What it does

| | |
|---|---|
| **Network blocking** | EasyList + EasyPrivacy, parsed properly: anchors, separators, wildcards, regex rules, `$third-party`, resource types, `$domain=`, `$match-case`, `$important`, and `@@` exceptions |
| **Per-site toggle** | In the popup. Writes to the same whitelist the options page edits |
| **Counts** | Per-page and all-time, with the badge showing the current tab's count |
| **Custom rules** | Full EasyList syntax, validated by the same parser the engine uses |
| **Whitelist** | Hostnames, with parent domains covering their subdomains |
| **List management** | Versions, checksums, rule counts and a Refresh button |
| **Cosmetic filtering** | Hostname-scoped EasyList selectors + 350 curated generics |
| **Element collapsing** | Blocked images and iframes are hidden, not left as empty boxes |
| **YouTube ad removal** | A MAIN-world scriptlet strips ad instructions from the player response |

---

## How it works

### The index

Parsing 3.5 MB of filter text on every request is obviously out. So is scanning
107,275 rules. Three structures narrow the search:

```
hostMap      ||example.com^ rules, keyed by hostname.  100,004 buckets
             A request probes only its own hostname suffixes:
             ads.doubleclick.net -> "net", "doubleclick.net",
             "ads.doubleclick.net". Three lookups, no pattern matching.

tokenMap     everything else, keyed by the RAREST token in the       3,429 buckets
             pattern. Rarest matters: filed under "com" a rule gets
             probed on nearly every request; under "doubleclick",
             almost never. Largest bucket is "gif" at 49 rules.

untokenized  patterns with no token that can be trusted.                 35 rules
             Scanned on every request, so it must stay tiny.
```

Measured on a typical URL: **53 of 107,275 rules examined**.

### Why "trusted" token matters

A pattern's token is only usable as an index key if every URL the pattern
matches will contain it as a whole token. `/ads*` looks like it could be filed
under `ads`, but it matches `/ads123`, which tokenizes as `ads123` — the bucket
would never be probed and the rule would silently stop working. `tokenizer.js`
rejects any token whose neighbours in the pattern are not hard boundaries, and
`tests/test_tokenizer.js` pins this down with an explicit invariant test.

This is the failure mode that makes a broken ad blocker look like a working one.

### Matching tiers

Every pattern is classified once, at compile time, into the cheapest test that
can express it:

| Tier | Example | Test | Count |
|---|---|---|---|
| `HOST_ONLY` | `\|\|example.com^` | hostname compare | 96,310 |
| `HOST_PREFIX` | `\|\|example.com/ads/` | hostname + anchored prefix | 6,721 |
| `PLAIN` | `/banner.gif` | `includes` | 3,915 |
| `RIGHT` | `/track.js\|` | `endsWith` | 27 |
| `REGEX` | `\|\|a.io^*/ads` | cached `RegExp` | 1,686 |

**98.4% of rules never touch a regex.** The 1,686 that do are compiled lazily on
first use — a browsing session typically builds about 63 of them.

### Storage

The compiled index is stored in IndexedDB as the live object graph. Structured
clone handles `Map`, `Set` and typed arrays natively, so there is no
serialisation format to write or keep in step with the compiler.

- compile from text: **~210 ms**
- rehydrate from IndexedDB: **~145 ms**

Modest, but it is on the critical path of every event-page wake-up, and the
round trip is covered by a test so a non-cloneable value can never silently
disable the cache.

### Cosmetic filtering

Three layers:

1. **350 curated generic selectors**, injected synchronously at `document_start`
   so there is no flash of visible ads.
2. **Hostname-scoped EasyList selectors** — a few dozen for the current site,
   fetched from the background.
3. **Element collapsing** — the background reports each blocked URL to the tab
   and the content script hides that exact `<img>`/`<iframe>`. This is the layer
   that removes the leftover empty boxes; hiding by selector alone does not.

EasyList ships **13,634 generic hiding rules**. Shipping all of them as one
stylesheet is the standard way to build a slow ad blocker — the style engine
evaluates it against every element on every page. `tools/build_generics.py`
instead extracts simple `#id`/`.class` selectors whose identifier contains a
delimited ad token, so `ad-slot` qualifies and `gradient`, `download`, `badge`
and `thread` do not, then ranks them by how canonical the name is.

### Video ads: YouTube and Twitch

These are the two hardest cases in ad blocking, and they fail for *different*
reasons. Neither is a filter-list problem.

**YouTube** serves ad video from `googlevideo.com/videoplayback` — the same
endpoint as the real video. Ad and content segments are indistinguishable by URL,
so blocking it either does nothing or kills playback. What works instead is
removing the ad *instructions* before the player acts on them:
`extension/content/scriptlets/yt-ads.js` runs in the page's own JS realm and
strips `adPlacements`, `playerAds`, `adSlots` and `playerConfig.adPlacementConfig`
out of the player response as it is parsed. Same "json-prune" technique uBlock
Origin uses.

It hooks three paths, because the response arrives by three routes:

| Path | Why |
|---|---|
| `JSON.parse` | most player responses |
| `Response.prototype.json` | `/youtubei/v1/player` is fetched, never touching `JSON.parse` |
| `window.ytInitialPlayerResponse` | assigned by an inline script on the watch page |

> **This will break.** It depends on the shape of YouTube's player response,
> which they change without notice. When ads come back, the field names in
> `AD_KEYS` are the first thing to check. `window.__siftYouTube` in the page
> console reports how many fields were pruned.

**Twitch is not solved, and is not solvable this way.** Twitch stitches ads into
the HLS video stream **server-side** — the ad frames arrive inside the same `.ts`
segments as the stream, from the same CDN host. There is no ad request to block
and no ad metadata to prune. The extensions that do beat Twitch proxy the
playlist request through a third-party server in a region that serves no ads,
which means routing your viewing through someone else's infrastructure. That is a
trust decision, not a technical one, so this project does not do it.

---

## Firefox notes

### Manifest V2 vs V3 for this use case

The important thing: **Firefox kept blocking `webRequest` in MV3.** Chrome
removed it, which is why uBlock Origin was delisted there and why this project
is viable on Firefox and would not be on Chrome.

| | MV2 | MV3 (Firefox) |
|---|---|---|
| Blocking `webRequest` | yes | **still yes** — `"webRequest"` + `"webRequestBlocking"` + host permissions + `["blocking"]` |
| Background | persistent page | **event page** — suspended when idle |
| `background.service_worker` | n/a | **not supported in Firefox.** Use `"scripts": [...]` |
| `browser_action` | `browser_action` | `action` |
| Host permissions | granted at install | listed in `host_permissions`; shown and granted at install from **Firefox 127**, revocable per-site by the user at any time |

No special manifest key is needed for blocking beyond the permission itself.

### The event-page trap

This is the part that is easy to get wrong and produces no error when you do.

MV3 background code is an **event page**: Firefox suspends it when idle and
restarts it on the next event. So a blocking `webRequest` listener can fire on a
cold page whose filter index has not loaded yet. The naive implementation lets
requests through for a few hundred milliseconds after every wake-up — an ad
blocker that silently leaks.

Two things prevent it, in `background/main.js`:

1. The listener is registered **synchronously during module evaluation**. An
   event page is only woken for events it registered in its first turn.
2. Firefox lets a blocking listener **return a Promise** (since Firefox 52 —
   Chrome cannot do this). On a cold start the request is *held* on the
   readiness promise instead of being allowed through:

```js
function onBeforeRequest(details) {
  if (mainEngine !== null) return decide(details);        // warm: synchronous
  return ready.then(() => decide(details));               // cold: hold it
}
```

`tests/test_extension.js` fires a known ad request before startup can plausibly
have finished and asserts it is still blocked.

### Why `strict_min_version: 128.0`

Two independent floors:

- **121** — MV3 shipped in Firefox 109, but before 121 the background page did
  not start reliably in all MV3 configurations.
- **128** — `"world": "MAIN"` for manifest content scripts, which the YouTube
  scriptlet needs. Crucially, a MAIN-world content script is **not subject to the
  page's CSP**, unlike injecting a `<script>` element. YouTube's CSP is strict,
  so that exemption is what makes the scriptlet work at all.

---

## Layout

```
Ad Blocker/
├─ extension/
│  ├─ manifest.json
│  ├─ background/
│  │  ├─ main.js         listener registration, cold-start gate, messaging
│  │  ├─ lists.js        load / refresh / cache orchestration
│  │  ├─ stats.js        per-tab counts, badge (writes are batched)
│  │  └─ storage.js      IndexedDB + settings
│  ├─ lib/               ← no browser APIs; the tests import these directly
│  │  ├─ parser.js       EasyList syntax  ->  rule objects
│  │  ├─ tokenizer.js    the index invariant lives here
│  │  ├─ compiler.js     rules  ->  queryable index
│  │  ├─ matcher.js      pattern  ->  cheapest applicable test
│  │  ├─ engine.js       request  ->  decision
│  │  └─ url.js          hostname / registrable-domain helpers
│  ├─ content/
│  │  ├─ cosmetic.js     selector injection + element collapsing
│  │  ├─ generics.js     curated generic selectors (generated)
│  │  └─ scriptlets/
│  │     └─ yt-ads.js    YouTube ad pruning, MAIN world
│  ├─ popup/  options/   UI
│  ├─ filters/           vendored EasyList + EasyPrivacy snapshots
│  └─ icons/
├─ tools/                Python: list updater, generics, icons, test runner
└─ tests/                zero-dependency browser test suite
```

`lib/` deliberately contains no `browser.*` calls. That is what lets the tests
exercise the exact modules the extension runs, rather than a copy.

---

## Tools

All Python 3, standard library only (icons need Pillow).

```sh
py tools/update_lists.py            # re-vendor EasyList + EasyPrivacy
py tools/update_lists.py --check    # report staleness, write nothing
py tools/build_generics.py          # regenerate the curated generic selectors
py tools/build_icons.py             # regenerate the icon set
py tools/run_tests.py               # run the test suite headlessly
py tools/sign.py                    # package + sign via AMO (permanent install)
py tools/sign.py --package-only     # just build the .xpi, no network
```

`update_lists.py` only *fetches*. Parsing stays in `lib/parser.js` so there is
one parser implementation rather than two that drift apart.

### Tests

```sh
py tools/run_tests.py                     # headless, exits non-zero on failure
py tools/run_tests.py --keep-open         # serve, then open the URL yourself
```

130 tests. They run in a real browser because that is where the code runs;
results are POSTed back to the runner rather than scraped, since Chrome's
`--virtual-time-budget` freezes `performance.now()` and would report every
benchmark as 0 ms.

Coverage worth calling out:

- the tokenizer invariant (silent under-blocking)
- **false positives** — ordinary CDN, font and first-party requests that must
  *not* be blocked, which matters more than missed ads
- top-level navigations are never cancelled
- the cold-start gate
- the IndexedDB round trip
- a deterministic "rules probed" metric, so the index cannot quietly degenerate
  into a linear scan

---

## Deliberate omissions

Things that are missing on purpose, not by oversight:

- **`$popup` rules are skipped.** EasyList has ~2,900. They target the pop-up
  window, not the request; applying them as ordinary block rules would block the
  destination site outright. Rules combining `$popup` with a real type keep the
  real type.
- **Top-level navigations are never blocked.** `$document` rules exist, but
  cancelling a `main_frame` load turns a filter list into a site blocker and
  hands the user a blank page with no explanation.
- **Unknown filter options skip the rule** rather than being guessed at. Skipping
  under-blocks, which is visible; misinterpreting over-blocks and breaks pages.
  The options page shows the counts and reasons.
- **Not all of EasyList's generic hiding rules ship.** See
  [Cosmetic filtering](#cosmetic-filtering).

### Known approximation

Third-party detection needs the Public Suffix List to be exactly right. The real
PSL is ~200 KB with its own update cadence; `lib/url.js` uses a compact stand-in
covering the multi-part suffixes that actually occur in browsing. When it is
wrong, a `$third-party` rule is applied or skipped incorrectly for that site — it
does not cause wholesale over-blocking. Swapping in the real PSL is a contained
change to one function.

---

## What is still missing vs uBlock Origin

Being straight about it: this genuinely blocks ads, but uBO is a decade of work.

**Substantial gaps**

- **Scriptlet injection is YouTube-only.** There is a working MAIN-world
  scriptlet for YouTube, but no general `#$#` snippet engine and no library of
  them. Anti-adblock walls on other sites will still win.
- **No procedural cosmetic filters** (`:has-text`, `:xpath`, `:upward`). Modern
  EasyList leans on these for ads plain CSS cannot target. 282 such rules in
  EasyList are currently skipped.
- **No `$redirect` resources.** uBO swaps in neutered stubs for analytics scripts
  so pages expecting them keep working. Without it, some sites break *because*
  we blocked cleanly — there is no stub to hand them.
- **No `$csp`, `$removeparam`, `$replace`, or header filtering.**
- **No popup blocking**, per the omission above.
- **Twitch video ads**, for the structural reason above.

**Moderate gaps**

- Two lists, no per-list toggles. uBO ships EasyList, EasyPrivacy, uBO filters,
  Peter Lowe's, plus regional and annoyance lists.
- No generic cosmetic filtering at full scale — that needs selector hashing and
  DOM surveying to do without wrecking page performance.
- **No request logger.** uBO's logger is *the* tool for writing and debugging
  filters; the popup's recent-blocks list is a pale substitute.
- No scheduled auto-update; refreshing is manual.
- Approximate registrable-domain logic (above).
- Firefox only, by construction.

**What it does do well:** correct network blocking across the EasyList option
set, a fast and measurable index, hostname-scoped cosmetic filtering, real
element collapsing, accurate per-tab counting, and a filter parser you can
actually extend — because it is one readable module with tests around it.

---

## Publishing to AMO

If you ever want this on addons.mozilla.org:

- **Remote code is prohibited; remote *data* is fine.** Downloading filter lists
  is allowed — they are data. Never `eval` list content. This design treats them
  strictly as data.
- **No source-code submission needed.** There is no build step, no minification
  and no bundler, so reviewers read exactly what runs. This is a real advantage
  of the zero-dependency approach.
- **Expect scrutiny of `<all_urls>` + `webRequestBlocking`.** Straightforward to
  justify for a blocker, but be ready to.
- **Privacy policy.** This extension transmits nothing; the only outbound
  request is to `easylist.to` when you press Refresh. Say so plainly in the
  listing — anything that can see every URL you visit gets asked.
- **License compliance.** See below.
- **No Surprises policy** — changes to page content must be clearly attributable
  to the extension.

---

## License and attribution

This extension is licensed **GPL-3.0-or-later** (see `LICENSE`). That choice is
driven by the bundled filter lists, and matches what uBlock Origin uses.

`extension/filters/easylist.txt` and `easyprivacy.txt` are **not** original work
here. They are redistributed from the EasyList project, which dual-licenses them
under the **GNU General Public License v3 (or later)** and **Creative Commons
Attribution-ShareAlike 3.0 Unported (or later)**:

> Copyright © The EasyList authors
> <https://easylist.to/> · <https://easylist.to/pages/licence.html>

If you redistribute this extension, those obligations travel with it.
