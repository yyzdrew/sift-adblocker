// EasyList / Adblock Plus filter syntax parser.
//
// Turns one line of filter text into a rule object, or reports why it could not.
// No browser APIs — the options page uses this to validate hand-written custom
// rules, the background uses it to compile lists, and the tests import it
// directly. One implementation, three callers.
//
// Reference: https://adblockplus.org/filter-cheatsheet

// ---------------------------------------------------------------------------
// Resource types
// ---------------------------------------------------------------------------

export const T = {
  other:          1 << 0,
  script:         1 << 1,
  image:          1 << 2,
  stylesheet:     1 << 3,
  object:         1 << 4,
  xmlhttprequest: 1 << 5,
  subdocument:    1 << 6,
  ping:           1 << 7,
  media:          1 << 8,
  font:           1 << 9,
  websocket:      1 << 10,
  document:       1 << 11,
  // Not a webRequest resource type. Tracked only so that a rule whose ONLY
  // type is `popup` is recognised as inapplicable and skipped. EasyList has
  // ~2,900 of these; treating them as ordinary rules would block the site
  // itself rather than its pop-ups.
  popup:          1 << 12,
};

/** Types a rule applies to when it names none. Excludes document and popup:
 *  both must be requested explicitly, per ABP semantics. */
export const DEFAULT_TYPES =
  T.other | T.script | T.image | T.stylesheet | T.object | T.xmlhttprequest |
  T.subdocument | T.ping | T.media | T.font | T.websocket;

/** Every type a real network request can carry (what `$all` expands to). */
export const ALL_REQUEST_TYPES = DEFAULT_TYPES | T.document;

const TYPE_ALIASES = {
  xhr: 'xmlhttprequest',
  css: 'stylesheet',
  frame: 'subdocument',
  doc: 'document',
  'object-subrequest': 'object',
  beacon: 'ping',
  background: 'image',
};

/** Firefox webRequest ResourceType -> our type bit. */
const RESOURCE_TYPE_MAP = {
  main_frame: T.document,
  sub_frame: T.subdocument,
  stylesheet: T.stylesheet,
  script: T.script,
  image: T.image,
  imageset: T.image,
  object: T.object,
  object_subrequest: T.object,
  xmlhttprequest: T.xmlhttprequest,
  xslt: T.other,
  ping: T.ping,
  beacon: T.ping,
  media: T.media,
  font: T.font,
  websocket: T.websocket,
  csp_report: T.other,
  speculative: T.other,
  web_manifest: T.other,
  xml_dtd: T.other,
  other: T.other,
};

export function resourceTypeBit(resourceType) {
  return RESOURCE_TYPE_MAP[resourceType] || T.other;
}

// ---------------------------------------------------------------------------
// Options we knowingly do not implement.
//
// These are skipped and counted rather than silently dropped, so the options
// page can show an honest "N rules skipped" number instead of pretending full
// coverage. Skipping fails safe: a missed block rule under-blocks, which is
// visible; misinterpreting one over-blocks and breaks pages, which is worse.
// ---------------------------------------------------------------------------
const UNSUPPORTED_OPTIONS = new Set([
  'redirect', 'redirect-rule', 'rewrite',   // needs stub resources (uBO's redirect engine)
  'csp', 'permissions',                     // header injection
  'removeparam', 'queryprune', 'uritransform', 'urltransform',
  'replace', 'header', 'method', 'cookie', 'stealth',
  'denyallow', 'to', 'ipaddress', 'from-scheme',
  'inline-script', 'inline-font', 'genericblock',
  'empty', 'mp4', 'badfilter', 'app', 'network',
  'webrtc', 'strict1p', 'strict3p',
]);

// Cosmetic-scope exception options: these mark an @@ rule as disabling element
// hiding rather than blocking, so they are meaningful to us.
const COSMETIC_EXCEPTION_OPTIONS = {
  elemhide: 'elemhide', ehide: 'elemhide',
  generichide: 'generichide', ghide: 'generichide',
  specifichide: 'specifichide', shide: 'specifichide',
};

const OPTION_LIST_RE = /^~?[a-z0-9_-]+(=.*)?$/i;

// Every option name we recognise, supported or not. Used to decide whether a
// '$' actually introduces an option list or is just a character in the URL.
const KNOWN_OPTION_NAMES = new Set([
  ...Object.keys(T),
  ...Object.keys(TYPE_ALIASES),
  ...Object.keys(COSMETIC_EXCEPTION_OPTIONS),
  ...UNSUPPORTED_OPTIONS,
  'domain', 'from', 'third-party', '3p', 'first-party', '1p',
  'match-case', 'important', 'all',
]);

// ---------------------------------------------------------------------------
// Cosmetic separators
// ---------------------------------------------------------------------------

const COSMETIC = {
  '##':  { kind: 'cosmetic', exception: false },
  '#@#': { kind: 'cosmetic', exception: true },
  '#?#': { kind: 'unsupported', reason: 'procedural cosmetic filter (#?#)' },
  '#$#': { kind: 'unsupported', reason: 'scriptlet / snippet filter (#$#)' },
  '#%#': { kind: 'unsupported', reason: 'javascript filter (#%#)' },
  '#@$#': { kind: 'unsupported', reason: 'scriptlet exception (#@$#)' },
  '#@?#': { kind: 'unsupported', reason: 'procedural exception (#@?#)' },
};

/**
 * Locate a cosmetic separator. A bare '#' may legitimately appear in a network
 * pattern as a fragment, so every '#' is examined rather than just the first.
 */
function findCosmeticSeparator(line) {
  let i = line.indexOf('#');
  while (i !== -1) {
    for (const sep of ['#@$#', '#@?#', '#@#', '#?#', '#$#', '#%#', '##']) {
      if (line.startsWith(sep, i)) {
        return { index: i, sep, ...COSMETIC[sep] };
      }
    }
    i = line.indexOf('#', i + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function unsupported(reason, line) {
  return { kind: 'unsupported', reason, line };
}

/**
 * Parse one filter line.
 *
 * Returns null for blanks/comments, or one of:
 *   { kind: 'network',     pattern, isException, isRegex, types, notTypes,
 *                          thirdParty, matchCase, important, domains, cosmeticScope }
 *   { kind: 'cosmetic',    selector, isException, domains }
 *   { kind: 'unsupported', reason, line }
 */
export function parseFilter(rawLine) {
  const line = rawLine.trim();
  if (line === '') return null;

  // Comments and list headers.
  const first = line.charCodeAt(0);
  if (first === 33 /* ! */) return null;
  if (first === 91 /* [ */ && line.endsWith(']')) return null;
  // "# " style comments used by some hosts-format lists.
  if (first === 35 && (line.length === 1 || line.charCodeAt(1) === 32)) return null;

  const cosmetic = findCosmeticSeparator(line);
  if (cosmetic) {
    if (cosmetic.kind === 'unsupported') {
      return unsupported(cosmetic.reason, line);
    }
    return parseCosmetic(line, cosmetic);
  }

  return parseNetwork(line);
}

function parseCosmetic(line, sep) {
  const selector = line.slice(sep.index + sep.sep.length).trim();
  if (selector === '') return unsupported('empty cosmetic selector', line);

  const domainPart = line.slice(0, sep.index).trim();
  const domains = { include: [], exclude: [] };

  if (domainPart !== '') {
    // Cosmetic rules separate domains with ',' (network `domain=` uses '|').
    for (const raw of domainPart.split(',')) {
      const d = raw.trim().toLowerCase();
      if (d === '') continue;
      if (d.charCodeAt(0) === 126 /* ~ */) domains.exclude.push(d.slice(1));
      else domains.include.push(d);
    }
  }

  return {
    kind: 'cosmetic',
    selector,
    isException: sep.exception,
    domains,
  };
}

function parseNetwork(line) {
  let body = line;
  let isException = false;

  if (body.startsWith('@@')) {
    isException = true;
    body = body.slice(2);
  }
  if (body === '') return unsupported('empty pattern', line);

  // Split pattern from options. A '$' can appear inside a pattern, so the tail
  // is only treated as options when it actually parses as an option list.
  let pattern = body;
  let optionText = '';

  // A regex rule is delimited by slashes: /expr/ or /expr/$options. Merely
  // *starting* with '/' is not enough — over 4,000 EasyList/EasyPrivacy rules
  // are ordinary path patterns like "/pagead/" or "/earn.php?z=$popup", and
  // treating those as regexes silently discards their $options.
  const lastSlash = body.lastIndexOf('/');
  const isRegexRule =
    body.length > 2 &&
    body.charCodeAt(0) === 47 /* / */ &&
    lastSlash > 0 &&
    (lastSlash === body.length - 1 || body.charCodeAt(lastSlash + 1) === 36 /* $ */);

  if (isRegexRule) {
    pattern = body.slice(0, lastSlash + 1);
    if (lastSlash !== body.length - 1) {
      optionText = body.slice(lastSlash + 2); // skip the '$'
    }
  } else {
    const dollar = body.lastIndexOf('$');
    if (dollar > 0) {
      const tail = body.slice(dollar + 1);
      if (tail !== '' && looksLikeOptionList(tail)) {
        pattern = body.slice(0, dollar);
        optionText = tail;
      }
    }
  }

  if (pattern === '') return unsupported('empty pattern', line);

  const rule = {
    kind: 'network',
    pattern,
    isException,
    isRegex: pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/'),
    types: 0,
    notTypes: 0,
    thirdParty: null,      // null = either, true = third-party only, false = first-party only
    matchCase: false,
    important: false,
    domains: null,         // { include: [], exclude: [] }
    cosmeticScope: null,   // 'elemhide' | 'generichide' | 'specifichide'
  };

  if (optionText !== '') {
    const err = applyOptions(rule, optionText, line);
    if (err) return err;
  }

  // A rule whose only declared type is `popup` cannot be expressed as a
  // webRequest block — dropping it is correct, applying it would block the
  // destination site outright.
  if (rule.types === T.popup) {
    return unsupported('popup-only rule (no equivalent request type)', line);
  }
  rule.types &= ~T.popup;
  rule.notTypes &= ~T.popup;

  if (rule.types === 0) {
    rule.types = rule.cosmeticScope ? 0 : DEFAULT_TYPES & ~rule.notTypes;
  }

  if (rule.types === 0 && !rule.cosmeticScope) {
    return unsupported('no applicable request types remain', line);
  }

  if (rule.isRegex) {
    // Validate now rather than throwing mid-request later.
    try {
      new RegExp(pattern.slice(1, -1));
    } catch {
      return unsupported('invalid regular expression', line);
    }
  }

  return rule;
}

/**
 * Decide whether the text after a '$' is an option list or just part of the URL.
 *
 * Requires every part to be option-shaped AND at least one to be a name we
 * recognise. "||example.com/a$b" is then correctly read as a pattern rather
 * than a rule with a bogus "$b" option, while "$script,somethingnew" is still
 * treated as options so the unknown name is reported instead of silently
 * changing the pattern.
 */
function looksLikeOptionList(tail) {
  let recognised = 0;
  for (const part of tail.split(',')) {
    if (!OPTION_LIST_RE.test(part)) return false;
    const eq = part.indexOf('=');
    const name = (eq === -1 ? part : part.slice(0, eq)).replace(/^~/, '').toLowerCase();
    if (KNOWN_OPTION_NAMES.has(name)) recognised++;
  }
  return recognised > 0;
}

function applyOptions(rule, optionText, line) {
  // `domain=a.com|b.com` may contain commas in newer syntax variants, but the
  // canonical separator inside domain= is '|', so a plain comma split is safe.
  for (const raw of optionText.split(',')) {
    let opt = raw.trim();
    if (opt === '') continue;

    let negated = false;
    if (opt.charCodeAt(0) === 126 /* ~ */) {
      negated = true;
      opt = opt.slice(1);
    }

    const eq = opt.indexOf('=');
    const name = (eq === -1 ? opt : opt.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? null : opt.slice(eq + 1);

    if (name === 'domain' || name === 'from') {
      if (!value) return unsupported('domain= with no value', line);
      rule.domains = parseDomainOption(value);
      continue;
    }

    if (name === 'third-party' || name === '3p') {
      rule.thirdParty = !negated;
      continue;
    }
    if (name === 'first-party' || name === '1p') {
      rule.thirdParty = negated;
      continue;
    }
    if (name === 'match-case') { rule.matchCase = !negated; continue; }
    if (name === 'important')  { rule.important = !negated; continue; }
    if (name === 'all')        { rule.types |= ALL_REQUEST_TYPES; continue; }

    if (COSMETIC_EXCEPTION_OPTIONS[name]) {
      rule.cosmeticScope = COSMETIC_EXCEPTION_OPTIONS[name];
      continue;
    }

    if (UNSUPPORTED_OPTIONS.has(name)) {
      return unsupported(`unsupported option: $${name}`, line);
    }

    const typeName = TYPE_ALIASES[name] || name;
    const bit = T[typeName];
    if (bit === undefined) {
      return unsupported(`unknown option: $${name}`, line);
    }
    if (negated) rule.notTypes |= bit;
    else rule.types |= bit;
  }

  if (rule.notTypes && rule.types === 0) {
    rule.types = DEFAULT_TYPES & ~rule.notTypes;
  }
  return null;
}

function parseDomainOption(value) {
  const include = [];
  const exclude = [];
  for (const raw of value.split('|')) {
    const d = raw.trim().toLowerCase();
    if (d === '') continue;
    if (d.charCodeAt(0) === 126 /* ~ */) exclude.push(d.slice(1));
    else include.push(d);
  }
  return { include, exclude };
}

// ---------------------------------------------------------------------------
// Whole-list parsing
// ---------------------------------------------------------------------------

/**
 * Parse a full filter list.
 *
 * @param {string} text  raw list contents
 * @param {string} sourceId  id recorded on each rule, for per-list stats
 * @returns {{network: object[], cosmetic: object[], stats: object}}
 */
export function parseList(text, sourceId = '') {
  const network = [];
  const cosmetic = [];
  const stats = {
    lines: 0,
    network: 0,
    cosmetic: 0,
    exceptions: 0,
    skipped: 0,
    skippedReasons: Object.create(null),
  };

  for (const line of text.split('\n')) {
    if (line === '' || line === '\r') continue;
    stats.lines++;

    let rule;
    try {
      rule = parseFilter(line);
    } catch (err) {
      stats.skipped++;
      bump(stats.skippedReasons, 'parser error');
      continue;
    }
    if (rule === null) continue;

    if (rule.kind === 'unsupported') {
      stats.skipped++;
      bump(stats.skippedReasons, rule.reason.replace(/:.*/, ''));
      continue;
    }

    rule.source = sourceId;
    if (rule.kind === 'network') {
      network.push(rule);
      stats.network++;
      if (rule.isException) stats.exceptions++;
    } else {
      cosmetic.push(rule);
      stats.cosmetic++;
    }
  }

  return { network, cosmetic, stats };
}

function bump(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}
