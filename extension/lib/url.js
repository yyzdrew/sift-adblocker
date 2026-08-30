// URL and hostname helpers.
//
// No browser APIs in here — tests import this module directly.
//
// Deliberately avoids `new URL()` on the hot path. Parsing a URL object
// allocates and runs full spec-compliant parsing; we only need the hostname
// span, and this runs on every single request the browser makes.

// Registrable-domain detection needs the Public Suffix List to be exactly
// right. The real PSL is ~200KB and has its own update cadence. This is a
// compact stand-in covering the multi-part suffixes that actually show up in
// browsing: correct for the overwhelming majority of sites, wrong on exotic
// ones (e.g. some .jp municipal suffixes, dynamic-DNS providers on the PSL's
// private section).
//
// Consequence when wrong: third-party detection misfires for that site, so a
// `$third-party` rule may be applied or skipped incorrectly. It does not cause
// wholesale over-blocking. Swappable for the real PSL later — see README.
const MULTI_PART_SUFFIXES = new Set([
  // Generic second-level under a ccTLD.
  'co', 'com', 'net', 'org', 'edu', 'gov', 'ac', 'mil', 'gob', 'go', 'or',
  'ne', 'nom', 'info', 'biz', 'me', 'sch', 'ltd', 'plc', 'web', 'in', 'firm',
  'gen', 'ind', 'res', 'asn', 'id', 'priv', 'k12', 'lg', 'police', 'nhs',
]);

// Suffixes that are themselves multi-label and not covered by the rule above.
const EXPLICIT_SUFFIXES = new Set([
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'netlify.app',
  'vercel.app', 'herokuapp.com', 'azurewebsites.net', 'cloudfront.net',
  's3.amazonaws.com', 'appspot.com', 'firebaseapp.com', 'web.app',
  'blogspot.com', 'wordpress.com', 'tumblr.com', 'myshopify.com',
  'amazonaws.com', 'googleapis.com', 'googleusercontent.com',
]);

/**
 * Extract the hostname from a URL string without allocating a URL object.
 * Returns '' for URLs with no host (data:, about:, javascript:).
 */
export function hostnameOf(url) {
  // Find "://" — everything before it is the scheme.
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return '';

  let start = schemeEnd + 3;
  const len = url.length;

  // Skip over userinfo ("user:pass@host") if present, but only within the
  // authority section — an '@' after the first '/' belongs to the path.
  let authorityEnd = len;
  for (let i = start; i < len; i++) {
    const c = url.charCodeAt(i);
    // '/' 47, '?' 63, '#' 35
    if (c === 47 || c === 63 || c === 35) { authorityEnd = i; break; }
  }
  for (let i = start; i < authorityEnd; i++) {
    if (url.charCodeAt(i) === 64 /* @ */) { start = i + 1; break; }
  }

  // IPv6 literals are bracketed and may contain ':' legitimately.
  if (url.charCodeAt(start) === 91 /* [ */) {
    const close = url.indexOf(']', start);
    if (close === -1 || close > authorityEnd) return '';
    return url.slice(start, close + 1).toLowerCase();
  }

  let end = authorityEnd;
  for (let i = start; i < authorityEnd; i++) {
    if (url.charCodeAt(i) === 58 /* : */) { end = i; break; }
  }

  return url.slice(start, end).toLowerCase();
}

/**
 * Byte offset just past the hostname, used by the host-prefix matcher tier to
 * anchor the remainder of a pattern. Returns -1 if there is no host.
 */
export function hostnameEndIndex(url) {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return -1;
  const start = schemeEnd + 3;
  const len = url.length;
  for (let i = start; i < len; i++) {
    const c = url.charCodeAt(i);
    if (c === 47 || c === 63 || c === 35) return i;
  }
  return len;
}

/** Split a hostname into the suffixes used for right-to-left map lookups. */
export function hostnameSuffixes(hostname) {
  const out = [];
  if (!hostname) return out;
  out.push(hostname);
  let i = hostname.indexOf('.');
  while (i !== -1) {
    out.push(hostname.slice(i + 1));
    i = hostname.indexOf('.', i + 1);
  }
  return out;
}

/**
 * Registrable domain ("example.co.uk" from "www.example.co.uk").
 * See the MULTI_PART_SUFFIXES note above for accuracy limits.
 */
export function registrableDomain(hostname) {
  if (!hostname) return '';
  // IP literals and single-label hosts are their own registrable domain.
  if (hostname.charCodeAt(0) === 91 /* [ */) return hostname;
  if (isIPv4(hostname)) return hostname;

  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;

  const lastTwo = parts.slice(-2).join('.');
  if (EXPLICIT_SUFFIXES.has(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  const lastThree = parts.slice(-3).join('.');
  if (EXPLICIT_SUFFIXES.has(lastThree)) {
    return parts.slice(-4).join('.');
  }

  // "example.co.uk" — second-to-last label is a generic like "co" and the TLD
  // is a 2-letter ccTLD.
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (tld.length === 2 && MULTI_PART_SUFFIXES.has(sld)) {
    return parts.slice(-3).join('.');
  }

  return lastTwo;
}

function isIPv4(hostname) {
  let dots = 0;
  for (let i = 0; i < hostname.length; i++) {
    const c = hostname.charCodeAt(i);
    if (c === 46) { dots++; continue; }
    if (c < 48 || c > 57) return false;
  }
  return dots === 3;
}

/** True when `requestHost` is on a different registrable domain than `docHost`. */
export function isThirdParty(requestHost, docHost) {
  if (!docHost || !requestHost) return false;
  if (requestHost === docHost) return false;
  return registrableDomain(requestHost) !== registrableDomain(docHost);
}

/**
 * Does `hostname` match `candidate` as itself or a subdomain of it?
 * "ads.example.com" matches "example.com" but not "notexample.com".
 */
export function hostnameMatches(hostname, candidate) {
  if (hostname === candidate) return true;
  if (!hostname.endsWith(candidate)) return false;
  const boundary = hostname.length - candidate.length - 1;
  return boundary >= 0 && hostname.charCodeAt(boundary) === 46 /* . */;
}
