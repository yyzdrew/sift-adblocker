// Compile parsed rules into an index that is cheap to query per request.
//
// Requirement: never re-scan 136,000 rules on a request. Three structures do
// the narrowing:
//
//   hostMap   ||example.com^ style rules, keyed by hostname. A request probes
//             only the suffixes of its own hostname — 2-4 lookups, no pattern
//             matching at all. This is where most of EasyList lands.
//   tokenMap  everything else, keyed by the RAREST token in the pattern.
//             Rarest matters: a rule filed under "com" would be probed on
//             nearly every request; one filed under "doubleclick" almost never.
//   untokenized  patterns with no token we can trust (see tokenizer.js).
//             Always scanned, so this bucket must stay small.
//
// Rules are stored struct-of-arrays with typed arrays for the numeric fields.
// That is not premature cleverness: the compiled index is written to IndexedDB
// and structured-cloned back on every event-page wake-up, and typed arrays
// clone far faster than 136k plain objects. The cold path holds requests while
// this happens, so rehydration speed is a correctness concern.

import { parseList, T } from './parser.js';
import { patternTokens } from './tokenizer.js';
import { classify, TIER, TIER_NAMES } from './matcher.js';

export const INDEX_FORMAT_VERSION = 1;

export const FLAG = {
  IMPORTANT:   1 << 0,
  MATCH_CASE:  1 << 1,
  THIRD_PARTY: 1 << 2, // applies only to third-party requests
  FIRST_PARTY: 1 << 3, // applies only to first-party requests
  HAS_DOMAINS: 1 << 4,
};

function emptySubIndex() {
  return {
    n: 0,
    pattern: [],
    tier: null,
    host: [],
    rest: [],
    types: null,
    notTypes: null,
    flags: null,
    // Only ~1% of rules carry a domain= option, so a sparse Map beats two
    // parallel arrays of nulls.
    domains: new Map(),
    tokenMap: new Map(),
    hostMap: new Map(),
    untokenized: null,
  };
}

function buildSubIndex(rules) {
  const n = rules.length;
  const sub = emptySubIndex();
  sub.n = n;
  sub.tier = new Uint8Array(n);
  sub.types = new Uint32Array(n);
  sub.notTypes = new Uint32Array(n);
  sub.flags = new Uint8Array(n);

  // Pass 1 — classify, and count how many rules each candidate token serves.
  const tokenFreq = new Map();
  const candidates = new Array(n);

  for (let i = 0; i < n; i++) {
    const r = rules[i];
    const c = classify(r.pattern);

    sub.pattern.push(r.pattern);
    sub.host.push(c.host);
    sub.rest.push(c.rest);
    sub.tier[i] = c.tier;
    sub.types[i] = r.types;
    sub.notTypes[i] = r.notTypes;

    let f = 0;
    if (r.important) f |= FLAG.IMPORTANT;
    if (r.matchCase) f |= FLAG.MATCH_CASE;
    if (r.thirdParty === true) f |= FLAG.THIRD_PARTY;
    if (r.thirdParty === false) f |= FLAG.FIRST_PARTY;
    if (r.domains && (r.domains.include.length || r.domains.exclude.length)) {
      f |= FLAG.HAS_DOMAINS;
      sub.domains.set(i, r.domains);
    }
    sub.flags[i] = f;

    // Hostname-tier rules skip tokenisation entirely.
    if (c.tier === TIER.HOST_ONLY || c.tier === TIER.HOST_PREFIX) {
      candidates[i] = null;
      continue;
    }

    const toks = patternTokens(r.pattern);
    candidates[i] = toks;
    for (const t of toks) {
      tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
    }
  }

  // Pass 2 — file each rule under its rarest token.
  const tokenBuckets = new Map();
  const hostBuckets = new Map();
  const untokenized = [];

  for (let i = 0; i < n; i++) {
    if (candidates[i] === null) {
      push(hostBuckets, sub.host[i], i);
      continue;
    }
    const toks = candidates[i];
    if (toks.length === 0) {
      untokenized.push(i);
      continue;
    }
    let best = toks[0];
    let bestFreq = tokenFreq.get(best);
    for (let k = 1; k < toks.length; k++) {
      const f = tokenFreq.get(toks[k]);
      if (f < bestFreq) { best = toks[k]; bestFreq = f; }
    }
    push(tokenBuckets, best, i);
  }

  for (const [k, v] of tokenBuckets) sub.tokenMap.set(k, Int32Array.from(v));
  for (const [k, v] of hostBuckets) sub.hostMap.set(k, Int32Array.from(v));
  sub.untokenized = Int32Array.from(untokenized);

  return sub;
}

function push(map, key, value) {
  const cur = map.get(key);
  if (cur === undefined) map.set(key, [value]);
  else cur.push(value);
}

// ---------------------------------------------------------------------------
// Cosmetic rules
// ---------------------------------------------------------------------------

function buildCosmetic(rules) {
  const byDomain = new Map();     // domain -> selectors to hide
  const exceptions = new Map();   // domain -> selectors NOT to hide
  let genericCount = 0;

  for (const r of rules) {
    const target = r.isException ? exceptions : byDomain;
    const includes = r.domains.include;

    if (includes.length === 0) {
      // Generic rule. We deliberately do not ship EasyList's ~24k generic
      // selectors as one stylesheet — see content/generics.css for the curated
      // set and the README for why. Counted so the options page can say so.
      if (!r.isException) genericCount++;
      continue;
    }

    for (const d of includes) {
      push(target, d, r.selector);
    }
    // A rule like "a.com,~sub.a.com##.ad" hides on a.com except sub.a.com.
    for (const d of r.domains.exclude) {
      push(exceptions, d, r.selector);
    }
  }

  return {
    byDomain: dedupeMap(byDomain),
    exceptions: dedupeMap(exceptions),
    genericCount,
  };
}

function dedupeMap(map) {
  const out = new Map();
  for (const [k, v] of map) out.set(k, [...new Set(v)]);
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compile one or more filter lists into a queryable index.
 *
 * @param {Array<{id: string, text: string}>} sources
 * @returns {object} index
 */
export function compileLists(sources) {
  const started = Date.now();
  const netRules = [];
  const cosmeticRules = [];
  const perList = [];

  for (const src of sources) {
    const { network, cosmetic, stats } = parseList(src.text, src.id);
    netRules.push(...network);
    cosmeticRules.push(...cosmetic);
    perList.push({ id: src.id, ...stats });
  }

  // Exception rules that switch off cosmetic filtering for a whole site.
  const genericHideHosts = new Set();
  const elemHideHosts = new Set();

  const blockRules = [];
  const allowRules = [];

  for (const r of netRules) {
    if (r.cosmeticScope) {
      const c = classify(r.pattern);
      if (c.tier === TIER.HOST_ONLY) {
        if (r.cosmeticScope === 'elemhide') elemHideHosts.add(c.host);
        else genericHideHosts.add(c.host);
      }
      // A cosmetic-scope rule with no request types does no network blocking.
      if (r.types === 0) continue;
    }
    (r.isException ? allowRules : blockRules).push(r);
  }

  const block = buildSubIndex(blockRules);
  const allow = buildSubIndex(allowRules);
  const cosmetic = buildCosmetic(cosmeticRules);

  return {
    formatVersion: INDEX_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    block,
    allow,
    cosmetic,
    genericHideHosts,
    elemHideHosts,
    stats: {
      compileMs: Date.now() - started,
      lists: perList,
      blockRules: block.n,
      allowRules: allow.n,
      cosmeticDomains: cosmetic.byDomain.size,
      cosmeticGenericSkipped: cosmetic.genericCount,
      tiers: tierBreakdown(block, allow),
      buckets: {
        blockTokens: block.tokenMap.size,
        blockHosts: block.hostMap.size,
        blockUntokenized: block.untokenized.length,
        allowTokens: allow.tokenMap.size,
        allowHosts: allow.hostMap.size,
        allowUntokenized: allow.untokenized.length,
        largestTokenBucket: largestBucket(block.tokenMap),
      },
    },
  };
}

function tierBreakdown(block, allow) {
  const counts = new Array(TIER_NAMES.length).fill(0);
  for (const sub of [block, allow]) {
    for (let i = 0; i < sub.n; i++) counts[sub.tier[i]]++;
  }
  const out = {};
  TIER_NAMES.forEach((name, i) => { out[name] = counts[i]; });
  return out;
}

function largestBucket(map) {
  let max = 0;
  let key = '';
  for (const [k, v] of map) {
    if (v.length > max) { max = v.length; key = k; }
  }
  return { token: key, size: max };
}

export { T };
