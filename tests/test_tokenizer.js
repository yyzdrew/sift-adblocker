import { suite, test, ok, equal, deepEqual, note } from './runner.js';
import { tokenizeURL, patternTokens } from '../extension/lib/tokenizer.js';
import { classify, TIER, patternToRegexSource } from '../extension/lib/matcher.js';

suite('tokenizer', () => {
  test('tokenizeURL splits on non-alphanumeric runs of >= 3', () => {
    deepEqual(
      tokenizeURL('https://ads.example.com/banner.gif?id=42'),
      ['https', 'ads', 'example', 'com', 'banner', 'gif'],
    );
  });

  test('tokenizeURL drops runs shorter than 3', () => {
    deepEqual(tokenizeURL('http://a.bc.def/'), ['http', 'def']);
  });

  test('patternTokens accepts tokens bounded on both sides', () => {
    deepEqual(patternTokens('||example.com^'), ['example', 'com']);
  });

  test('patternTokens rejects a token cut short by a wildcard', () => {
    // "/ads*" can match "/ads123", which tokenizes as "ads123". Indexing this
    // rule under "ads" would mean it is never probed for that URL.
    deepEqual(patternTokens('/ads*'), []);
  });

  test('patternTokens rejects an unanchored edge token', () => {
    // "banner" unanchored can match inside "xbanner", tokenized as "xbanner".
    deepEqual(patternTokens('banner'), []);
  });

  test('an anchor alone does not make BOTH edges safe', () => {
    // '|banner' pins the token to the start of the URL but says nothing about
    // its right edge, so a URL may contain "bannerxyz" -> token "bannerxyz".
    // Rejecting here is correct; accepting would silently lose the rule.
    deepEqual(patternTokens('|banner'), []);
    deepEqual(patternTokens('banner|'), []);
  });

  test('patternTokens accepts a token anchored at both ends', () => {
    deepEqual(patternTokens('|banner|'), ['banner']);
  });

  test('patternTokens treats ^ as a hard boundary', () => {
    // 'io' is below the 3-character minimum; 'pixel' has an unanchored right
    // edge. Only 'track' survives.
    deepEqual(patternTokens('||track.io^pixel'), ['track']);
    deepEqual(
      patternTokens('||analytics.example^collect|'),
      ['analytics', 'example', 'collect'],
    );
  });

  test('patternTokens keeps interior tokens around a wildcard', () => {
    // "middle" is bounded by '/' on both sides, so it is safe even though the
    // pattern contains a wildcard elsewhere.
    deepEqual(patternTokens('|http://*/middle/*'), ['http', 'middle']);
  });

  // This is the invariant the whole index depends on: if the compiler files a
  // rule under token X, then every URL that rule matches must produce X.
  // A violation here means silent under-blocking with no error anywhere.
  test('INVARIANT: every pattern token appears in the tokens of a matching URL', () => {
    const cases = [
      ['||doubleclick.net^', 'https://ad.doubleclick.net/pixel.gif'],
      ['||example.com/ads/', 'https://example.com/ads/banner.png'],
      ['|http://tracker.io/', 'http://tracker.io/collect'],
      ['/pagead/', 'https://google.com/pagead/conversion.js'],
      ['||cdn.test.co.uk^script', 'https://cdn.test.co.uk/script/a.js'],
      ['/analytics.js|', 'https://x.io/analytics.js'],
      ['||a.io^*/track', 'https://a.io/x/track'],
    ];

    for (const [pattern, url] of cases) {
      const urlTokens = new Set(tokenizeURL(url.toLowerCase()));
      for (const t of patternTokens(pattern)) {
        ok(
          urlTokens.has(t),
          `pattern ${JSON.stringify(pattern)} token ${JSON.stringify(t)} ` +
          `missing from URL tokens of ${JSON.stringify(url)}`,
        );
      }
    }
    note(`checked ${cases.length} pattern/URL pairs`);
  });
});

suite('matcher classification', () => {
  const cases = [
    ['||example.com^', TIER.HOST_ONLY, 'example.com', ''],
    ['||example.com', TIER.HOST_ONLY, 'example.com', ''],
    ['||example.com/ads/x.js', TIER.HOST_PREFIX, 'example.com', '/ads/x.js'],
    ['/banner.gif', TIER.PLAIN, '', '/banner.gif'],
    ['|http://ads.', TIER.LEFT, '', 'http://ads.'],
    ['/track.js|', TIER.RIGHT, '', '/track.js'],
    ['||example.com^*/ads', TIER.REGEX, '', ''],
    ['/ad*banner/', TIER.REGEX, '', ''],
    ['||example.com^ads', TIER.REGEX, '', ''],
    ['/^regex\\d+$/', TIER.REGEX, '', ''],
  ];

  for (const [pattern, tier, host, rest] of cases) {
    test(`classify ${JSON.stringify(pattern)}`, () => {
      const c = classify(pattern);
      equal(c.tier, tier, 'tier');
      equal(c.host, host, 'host');
      equal(c.rest, rest, 'rest');
    });
  }

  test('regex source anchors || to the authority section', () => {
    const re = new RegExp(patternToRegexSource('||example.com^'), 'i');
    ok(re.test('https://example.com/'), 'bare host');
    ok(re.test('https://sub.example.com/x'), 'subdomain');
    ok(!re.test('https://notexample.com/'), 'must not match a longer label');
    ok(!re.test('https://evil.com/?u=example.com'), 'must not match in the query');
  });

  test('regex source expands ^ to a separator class', () => {
    const re = new RegExp(patternToRegexSource('/ads^'), 'i');
    ok(re.test('https://x.io/ads/1.gif'), 'slash is a separator');
    ok(re.test('https://x.io/ads?a=1'), 'question mark is a separator');
    ok(!re.test('https://x.io/adsxyz'), 'a letter is not a separator');
  });

  test('regex source treats * as a wildcard and escapes metacharacters', () => {
    // Note: '/a.b*c/' would be an explicit regex rule (slash-delimited). This
    // is the ABP-pattern form, so '.' is literal and '*' is the wildcard.
    const re = new RegExp(patternToRegexSource('/a.b*c'), 'i');
    ok(re.test('https://x.io/a.b-ZZZ-c'), 'wildcard spans');
    ok(!re.test('https://x.io/aXb-c'), 'dot is literal');
  });
});
