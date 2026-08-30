// Integration test against the real vendored EasyList + EasyPrivacy snapshots.
//
// This is the test that catches "the parser technically works but the index is
// wrong on real data" — the failure mode unit tests miss.

import { suite, test, ok, notOk, equal, note } from './runner.js';
import { compileLists } from '../extension/lib/compiler.js';
import { FilterEngine } from '../extension/lib/engine.js';
import { TIER_NAMES } from '../extension/lib/matcher.js';
import { tokenizeURL } from '../extension/lib/tokenizer.js';

const FILTER_BASE = '../extension/filters/';

async function loadRealLists() {
  const manifest = await (await fetch(FILTER_BASE + 'lists.json')).json();
  const sources = [];
  for (const l of manifest.lists) {
    const text = await (await fetch(FILTER_BASE + l.file)).text();
    sources.push({ id: l.id, text });
  }
  return sources;
}

let engine = null;
let compileMs = 0;

suite('real filter lists', () => {
  test('compiles EasyList + EasyPrivacy', async () => {
    const sources = await loadRealLists();
    ok(sources.length >= 2, 'both lists present');

    const t0 = performance.now();
    const index = compileLists(sources);
    compileMs = performance.now() - t0;
    engine = new FilterEngine(index);

    const s = index.stats;
    note(`compiled in ${compileMs.toFixed(0)}ms`);
    note(`block rules: ${s.blockRules.toLocaleString()}, allow rules: ${s.allowRules.toLocaleString()}`);
    note(`tiers: ${TIER_NAMES.map((n) => `${n}=${s.tiers[n].toLocaleString()}`).join('  ')}`);
    note(`host buckets: ${s.buckets.blockHosts.toLocaleString()}, token buckets: ${s.buckets.blockTokens.toLocaleString()}`);
    note(`untokenized (always scanned): ${s.buckets.blockUntokenized.toLocaleString()}`);
    note(`largest token bucket: "${s.buckets.largestTokenBucket.token}" = ${s.buckets.largestTokenBucket.size}`);
    note(`cosmetic domains: ${s.cosmeticDomains.toLocaleString()}, generic ## skipped: ${s.cosmeticGenericSkipped.toLocaleString()}`);
    for (const l of s.lists) {
      note(`${l.id}: ${l.network.toLocaleString()} network, ${l.cosmetic.toLocaleString()} cosmetic, ${l.skipped.toLocaleString()} skipped`);
    }

    ok(s.blockRules > 50000, `expected a large rule set, got ${s.blockRules}`);
    ok(s.allowRules > 500, `expected exception rules, got ${s.allowRules}`);
  });

  test('most rules land in a cheap tier', () => {
    const t = engine.index.stats.tiers;
    const total = Object.values(t).reduce((a, b) => a + b, 0);
    const cheap = t.HOST_ONLY + t.HOST_PREFIX + t.PLAIN + t.LEFT + t.RIGHT;
    const pct = (cheap / total) * 100;
    note(`${pct.toFixed(1)}% of rules avoid regex (${t.REGEX.toLocaleString()} regex rules)`);
    ok(pct > 75, `only ${pct.toFixed(1)}% in cheap tiers`);
  });

  test('the always-scanned bucket stays small', () => {
    const un = engine.index.block.untokenized.length;
    const pct = (un / engine.index.block.n) * 100;
    note(`${un.toLocaleString()} untokenized (${pct.toFixed(2)}% of block rules)`);
    // Every request pays for this bucket, so it must not grow into a linear scan.
    ok(pct < 5, `untokenized bucket is ${pct.toFixed(2)}% of all rules`);
  });

  test('blocks known ad and tracker requests', () => {
    const shouldBlock = [
      ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'script', 'news.example.com'],
      ['https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'script', 'news.example.com'],
      ['https://www.google-analytics.com/analytics.js', 'script', 'news.example.com'],
      ['https://connect.facebook.net/en_US/fbevents.js', 'script', 'news.example.com'],
      ['https://static.ads-twitter.com/uwt.js', 'script', 'news.example.com'],
      ['https://cdn.taboola.com/libtrc/unip/tfa.js', 'script', 'news.example.com'],
      ['https://sb.scorecardresearch.com/beacon.js', 'script', 'news.example.com'],
    ];

    const missed = [];
    for (const [url, type, doc] of shouldBlock) {
      const r = engine.match(url, type, doc);
      if (!r.blocked) missed.push(url);
      else note(`blocked ${new URL(url).hostname}  <-  ${r.filter}`);
    }
    equal(missed.length, 0, `not blocked:\n        ${missed.join('\n        ')}`);
  });

  // False positives are worse than misses: a broken page is more visible and
  // more damaging than a shown ad.
  test('does NOT block ordinary first-party and CDN requests', () => {
    const shouldAllow = [
      ['https://en.wikipedia.org/wiki/Main_Page', 'main_frame', 'en.wikipedia.org'],
      ['https://en.wikipedia.org/w/load.php?modules=startup', 'script', 'en.wikipedia.org'],
      ['https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js', 'script', 'example.com'],
      ['https://fonts.googleapis.com/css2?family=Inter', 'stylesheet', 'example.com'],
      ['https://fonts.gstatic.com/s/inter/v1/font.woff2', 'font', 'example.com'],
      ['https://github.com/anthropics/anthropic-sdk-python', 'main_frame', 'github.com'],
      ['https://news.ycombinator.com/news.css', 'stylesheet', 'news.ycombinator.com'],
      ['https://example.com/index.html', 'main_frame', 'example.com'],
      ['https://example.com/app.js', 'script', 'example.com'],
      ['https://example.com/logo.png', 'image', 'example.com'],
      ['https://api.github.com/repos/x/y', 'xmlhttprequest', 'github.com'],
      ['https://unpkg.com/react@18/umd/react.production.min.js', 'script', 'example.com'],
    ];

    const wrong = [];
    for (const [url, type, doc] of shouldAllow) {
      const r = engine.match(url, type, doc);
      if (r.blocked) wrong.push(`${url}  <-  ${r.filter}`);
    }
    equal(wrong.length, 0, `false positives:\n        ${wrong.join('\n        ')}`);
  });

  test('a top-level navigation is not blocked by ordinary rules', () => {
    // Rules without $document must never take down a main_frame load. Getting
    // this wrong turns the blocker into an accidental site blocker.
    const r = engine.match('https://www.theguardian.com/uk', 'main_frame', 'www.theguardian.com');
    notOk(r.blocked, `main_frame blocked by ${r.filter}`);
  });

  test('cosmetic selectors resolve per hostname', () => {
    const withRules = engine.cosmeticFor('www.forbes.com');
    note(`forbes.com -> ${withRules.selectors.length} selectors`);
    const none = engine.cosmeticFor('a-domain-that-does-not-exist-12345.test');
    equal(none.selectors.length, 0, 'unknown host gets nothing');
  });

  test('matching is fast enough for the request path', () => {
    const urls = [
      'https://example.com/index.html',
      'https://example.com/static/app.4f2c.js',
      'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
      'https://www.google-analytics.com/collect?v=1&tid=UA-1',
      'https://cdn.example.com/assets/img/hero-1920.jpg',
      'https://fonts.gstatic.com/s/inter/v12/font.woff2',
      'https://api.example.com/v2/users/me?include=profile',
      'https://securepubads.g.doubleclick.net/gampad/ads?iu=/1234',
    ];
    const types = ['main_frame', 'script', 'script', 'image', 'image', 'font', 'xmlhttprequest', 'script'];

    // Warm up so the lazily-built regexes are compiled before timing.
    for (let i = 0; i < urls.length; i++) engine.match(urls[i], types[i], 'example.com');

    const ITERATIONS = 4000;
    const t0 = performance.now();
    for (let n = 0; n < ITERATIONS; n++) {
      const i = n % urls.length;
      engine.match(urls[i], types[i], 'example.com');
    }
    const total = performance.now() - t0;
    const perMatch = (total / ITERATIONS) * 1000; // microseconds

    note(`${perMatch.toFixed(1)}us per match (${ITERATIONS} matches in ${total.toFixed(0)}ms)`);
    note(`regexes actually compiled: ${engine.regexCache.size}`);

    // A page makes a few hundred requests; anything under ~100us is invisible.
    ok(perMatch < 100, `${perMatch.toFixed(1)}us per match is too slow`);
  });

  test('the token index genuinely beats a linear scan', () => {
    // Guards against the index silently degenerating into "check everything".
    const sub = engine.index.block;
    const url = 'https://example.com/static/app.4f2c.js';

    let probed = 0;
    for (const t of tokenizeURL(url)) {
      const b = sub.tokenMap.get(t);
      if (b) probed += b.length;
    }
    probed += sub.untokenized.length;

    const ratio = probed / sub.n;
    note(`probed ${probed.toLocaleString()} of ${sub.n.toLocaleString()} rules (${(ratio * 100).toFixed(2)}%)`);
    ok(ratio < 0.05, `probing ${(ratio * 100).toFixed(1)}% of the rule set`);
  });
});
