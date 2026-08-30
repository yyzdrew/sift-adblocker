// Request matching against a compiled index.
//
// Lives in lib/ rather than background/ so the tests can drive it with no
// browser present. The background wraps it; it does not extend it.

import { hostnameOf, hostnameEndIndex, hostnameSuffixes, hostnameMatches, isThirdParty } from './url.js';
import { tokenizeURL } from './tokenizer.js';
import { matchPattern, RegexCache } from './matcher.js';
import { resourceTypeBit, T } from './parser.js';
import { FLAG } from './compiler.js';

export class FilterEngine {
  constructor(index) {
    this.index = index;
    this.regexCache = new RegexCache();
  }

  get stats() { return this.index.stats; }

  /**
   * Decide a request.
   *
   * @param {string} url          request URL
   * @param {string} resourceType Firefox webRequest ResourceType
   * @param {string} docHostname  hostname of the top-level document
   * @returns {{blocked: boolean, filter: string|null, exception: string|null}}
   */
  match(url, resourceType, docHostname) {
    const hostname = hostnameOf(url);
    if (hostname === '') return NO_MATCH;

    const ctx = {
      url,
      urlLower: url.toLowerCase(),
      hostname,
      hostEnd: hostnameEndIndex(url),
      regexCache: this.regexCache,
    };

    const typeBit = resourceTypeBit(resourceType);
    const thirdParty = isThirdParty(hostname, docHostname);

    const hit = this.#search(this.index.block, ctx, typeBit, thirdParty, docHostname);
    if (hit.index === -1) return NO_MATCH;

    const filter = this.index.block.pattern[hit.index];

    // $important block rules deliberately outrank exception rules.
    if (hit.important) {
      return { blocked: true, filter, exception: null };
    }

    const allow = this.#search(this.index.allow, ctx, typeBit, thirdParty, docHostname);
    if (allow.index !== -1) {
      return { blocked: false, filter, exception: this.index.allow.pattern[allow.index] };
    }

    return { blocked: true, filter, exception: null };
  }

  /**
   * Does an exception (@@) rule cover this request?
   *
   * `match()` only consults the allow index after a block rule has already
   * matched, so it cannot answer "did the user explicitly allow this?". The
   * background needs that to let a custom @@ rule override the shipped lists.
   *
   * @returns {string|null} the matching pattern, or null
   */
  exceptionFor(url, resourceType, docHostname) {
    const hostname = hostnameOf(url);
    if (hostname === '') return null;

    const ctx = {
      url,
      urlLower: url.toLowerCase(),
      hostname,
      hostEnd: hostnameEndIndex(url),
      regexCache: this.regexCache,
    };

    const hit = this.#search(
      this.index.allow, ctx,
      resourceTypeBit(resourceType),
      isThirdParty(hostname, docHostname),
      docHostname,
    );
    return hit.index === -1 ? null : this.index.allow.pattern[hit.index];
  }

  /**
   * Scan the candidate buckets for a hit.
   *
   * Candidate sets are small (a few dozen at most), so every candidate is
   * examined rather than stopping at the first hit. That costs almost nothing
   * on the common no-match path and lets an $important rule outrank an
   * ordinary one that happened to be checked first.
   */
  #search(sub, ctx, typeBit, thirdParty, docHostname) {
    let found = -1;

    // 1. Hostname buckets: probe only this request's own suffixes.
    const suffixes = hostnameSuffixes(ctx.hostname);
    for (let s = 0; s < suffixes.length; s++) {
      const bucket = sub.hostMap.get(suffixes[s]);
      if (bucket === undefined) continue;
      for (let k = 0; k < bucket.length; k++) {
        const i = bucket[k];
        if (!this.#applies(sub, i, ctx, typeBit, thirdParty, docHostname)) continue;
        if (sub.flags[i] & FLAG.IMPORTANT) return { index: i, important: true };
        if (found === -1) found = i;
      }
    }

    // 2. Token buckets.
    const tokens = tokenizeURL(ctx.urlLower);
    for (let t = 0; t < tokens.length; t++) {
      const bucket = sub.tokenMap.get(tokens[t]);
      if (bucket === undefined) continue;
      for (let k = 0; k < bucket.length; k++) {
        const i = bucket[k];
        if (!this.#applies(sub, i, ctx, typeBit, thirdParty, docHostname)) continue;
        if (sub.flags[i] & FLAG.IMPORTANT) return { index: i, important: true };
        if (found === -1) found = i;
      }
    }

    // 3. Patterns with no trustworthy token. Kept small by design.
    const un = sub.untokenized;
    for (let k = 0; k < un.length; k++) {
      const i = un[k];
      if (!this.#applies(sub, i, ctx, typeBit, thirdParty, docHostname)) continue;
      if (sub.flags[i] & FLAG.IMPORTANT) return { index: i, important: true };
      if (found === -1) found = i;
    }

    return { index: found, important: false };
  }

  #applies(sub, i, ctx, typeBit, thirdParty, docHostname) {
    // Cheap integer tests before any string work.
    if ((sub.types[i] & typeBit) === 0) return false;
    if ((sub.notTypes[i] & typeBit) !== 0) return false;

    const flags = sub.flags[i];
    if ((flags & FLAG.THIRD_PARTY) && !thirdParty) return false;
    if ((flags & FLAG.FIRST_PARTY) && thirdParty) return false;

    if (flags & FLAG.HAS_DOMAINS) {
      if (!domainApplies(sub.domains.get(i), docHostname)) return false;
    }

    return matchPattern(
      sub.tier[i], sub.host[i], sub.rest[i], sub.pattern[i],
      ctx, (flags & FLAG.MATCH_CASE) !== 0,
    );
  }

  /**
   * Selectors to hide on a given page, and whether generic hiding applies.
   * @returns {{selectors: string[], allowGenerics: boolean}}
   */
  cosmeticFor(hostname) {
    const { cosmetic, genericHideHosts, elemHideHosts } = this.index;
    if (!hostname) return { selectors: [], allowGenerics: false };

    const suffixes = hostnameSuffixes(hostname);

    // $elemhide switches off element hiding for the site entirely.
    for (const s of suffixes) {
      if (elemHideHosts.has(s)) return { selectors: [], allowGenerics: false };
    }

    const hide = new Set();
    for (const s of suffixes) {
      const sels = cosmetic.byDomain.get(s);
      if (sels !== undefined) for (const sel of sels) hide.add(sel);
    }
    for (const s of suffixes) {
      const sels = cosmetic.exceptions.get(s);
      if (sels !== undefined) for (const sel of sels) hide.delete(sel);
    }

    let allowGenerics = true;
    for (const s of suffixes) {
      if (genericHideHosts.has(s)) { allowGenerics = false; break; }
    }

    return { selectors: [...hide], allowGenerics };
  }
}

const NO_MATCH = Object.freeze({ blocked: false, filter: null, exception: null });

/**
 * `$domain=` scoping. An entry matches the document hostname or any parent of
 * it, so `domain=example.com` also covers `sub.example.com`.
 */
export function domainApplies(domains, docHostname) {
  if (!domains) return true;
  if (!docHostname) {
    // No document context (e.g. a top-level navigation): only unscoped rules
    // and pure-exclusion rules can apply.
    return domains.include.length === 0;
  }

  for (const d of domains.exclude) {
    if (hostnameMatches(docHostname, d)) return false;
  }
  if (domains.include.length === 0) return true;
  for (const d of domains.include) {
    if (hostnameMatches(docHostname, d)) return true;
  }
  return false;
}

export { T };
