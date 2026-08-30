// Shared tokenizer for the token-bucket index.
//
// The compiler and the matcher MUST agree exactly on what a token is. If they
// disagree, rules quietly stop being checked and the blocker leaks with no
// error anywhere. tests/test_tokenizer.js exists specifically to pin this down.

const MIN_TOKEN_LENGTH = 3;

// Cap work on pathological URLs (data: URIs, giant query strings).
const MAX_URL_SCAN = 2048;

function isTokenChar(c) {
  return (
    (c >= 97 && c <= 122) || // a-z
    (c >= 48 && c <= 57) ||  // 0-9
    (c >= 65 && c <= 90)     // A-Z (callers lowercase first, but be safe)
  );
}

/**
 * Every alphanumeric run of >= 3 chars in a URL.
 *
 * Input should already be lowercased. Tokens are a prefilter only, so the
 * lookup is case-insensitive on both sides while the real match still honours
 * $match-case — over-selecting is safe, under-selecting is not.
 */
export function tokenizeURL(url) {
  const tokens = [];
  const len = url.length < MAX_URL_SCAN ? url.length : MAX_URL_SCAN;
  let start = -1;
  for (let i = 0; i < len; i++) {
    if (isTokenChar(url.charCodeAt(i))) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      if (i - start >= MIN_TOKEN_LENGTH) tokens.push(url.slice(start, i));
      start = -1;
    }
  }
  if (start !== -1 && len - start >= MIN_TOKEN_LENGTH) {
    tokens.push(url.slice(start, len));
  }
  return tokens;
}

/**
 * Tokens from a *pattern* that are safe to use as index keys.
 *
 * A token is only usable if the pattern guarantees it will appear as a whole
 * token in any matching URL. That means both its neighbours in the pattern must
 * be hard boundaries:
 *
 *   ||example.com^   -> "example", "com"   both bounded by | . ^   -> safe
 *   /ads*            -> "ads" is followed by '*', so a matching URL may contain
 *                       "/ads123", which tokenizes as "ads123". Looking up
 *                       "ads" would never find it. -> NOT safe
 *   ads              -> unanchored, so a URL may contain "xads". -> NOT safe
 *
 * '*' is explicitly NOT a boundary. '^' is, since it only ever matches a
 * non-alphanumeric separator. An unanchored pattern edge is not a boundary.
 *
 * Returns [] when no token is safe; the caller must then put the rule in the
 * always-scanned bucket rather than dropping it.
 */
export function patternTokens(pattern) {
  const tokens = [];
  const len = pattern.length;

  // Determine where the "real" pattern body starts and whether its edges are
  // anchored. Leading '||' or '|' and trailing '|' are hard boundaries.
  let bodyStart = 0;
  let leftBounded = false;
  if (pattern.startsWith('||')) { bodyStart = 2; leftBounded = true; }
  else if (pattern.startsWith('|')) { bodyStart = 1; leftBounded = true; }

  let bodyEnd = len;
  let rightBounded = false;
  if (len > bodyStart && pattern.endsWith('|')) { bodyEnd = len - 1; rightBounded = true; }

  let start = -1;
  for (let i = bodyStart; i <= bodyEnd; i++) {
    const inRun = i < bodyEnd && isTokenChar(pattern.charCodeAt(i));
    if (inRun) {
      if (start === -1) start = i;
      continue;
    }
    if (start === -1) continue;

    // Run ended at i. Check both boundaries.
    const leftOk = start === bodyStart
      ? leftBounded
      : pattern.charCodeAt(start - 1) !== 42 /* '*' */;
    const rightOk = i === bodyEnd
      ? rightBounded
      : pattern.charCodeAt(i) !== 42 /* '*' */;

    if (leftOk && rightOk && i - start >= MIN_TOKEN_LENGTH) {
      tokens.push(pattern.slice(start, i).toLowerCase());
    }
    start = -1;
  }

  return tokens;
}
