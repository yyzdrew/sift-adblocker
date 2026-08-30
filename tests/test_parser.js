import { suite, test, ok, equal, deepEqual } from './runner.js';
import { parseFilter, parseList, T, DEFAULT_TYPES } from '../extension/lib/parser.js';

suite('parser: comments and blanks', () => {
  test('skips blank lines, ! comments and [headers]', () => {
    equal(parseFilter(''), null);
    equal(parseFilter('   '), null);
    equal(parseFilter('! EasyList'), null);
    equal(parseFilter('[Adblock Plus 2.0]'), null);
    equal(parseFilter('# hosts-style comment'), null);
  });
});

suite('parser: network rules', () => {
  test('plain block rule gets the default type set', () => {
    const r = parseFilter('||ads.example.com^');
    equal(r.kind, 'network');
    equal(r.pattern, '||ads.example.com^');
    equal(r.isException, false);
    equal(r.types, DEFAULT_TYPES);
  });

  test('document and popup are excluded from the default types', () => {
    const r = parseFilter('/banner/');
    equal(r.types & T.document, 0, '$document must be explicit');
    equal(r.types & T.popup, 0, '$popup must be explicit');
  });

  test('@@ marks an exception', () => {
    const r = parseFilter('@@||cdn.example.com^$script');
    equal(r.isException, true);
    equal(r.types, T.script);
  });

  test('type options restrict the type set', () => {
    const r = parseFilter('||x.io^$script,image');
    equal(r.types, T.script | T.image);
  });

  test('negated type options subtract from the defaults', () => {
    const r = parseFilter('||x.io^$~script');
    equal(r.types & T.script, 0, 'script excluded');
    ok(r.types & T.image, 'image still included');
  });

  test('third-party and its negation', () => {
    equal(parseFilter('||x.io^$third-party').thirdParty, true);
    equal(parseFilter('||x.io^$~third-party').thirdParty, false);
    equal(parseFilter('||x.io^$first-party').thirdParty, false);
    equal(parseFilter('||x.io^').thirdParty, null);
  });

  test('match-case and important', () => {
    equal(parseFilter('||x.io^$match-case').matchCase, true);
    equal(parseFilter('||x.io^$important').important, true);
    equal(parseFilter('||x.io^').matchCase, false);
  });

  test('domain= splits on | and honours ~ exclusions', () => {
    const r = parseFilter('||x.io^$domain=a.com|~b.com|c.co.uk');
    deepEqual(r.domains.include, ['a.com', 'c.co.uk']);
    deepEqual(r.domains.exclude, ['b.com']);
  });

  test('an all-negated domain list keeps an empty include set', () => {
    // Real EasyPrivacy line shape: applies everywhere except these sites.
    const r = parseFilter('&http_referer=$script,domain=~biletomat.pl|~facebook.com');
    deepEqual(r.domains.include, []);
    deepEqual(r.domains.exclude, ['biletomat.pl', 'facebook.com']);
  });

  test('$all expands to every request type including document', () => {
    const r = parseFilter('||x.io^$all');
    ok(r.types & T.document, 'document included');
    ok(r.types & T.script, 'script included');
  });
});

suite('parser: popup handling', () => {
  // EasyList carries ~2,900 $popup rules. They target the pop-up window, not
  // the request, so treating them as ordinary block rules would block the
  // destination site outright. This is the single most damaging thing a naive
  // parser can get wrong.
  test('a popup-only rule is skipped, not applied', () => {
    const r = parseFilter('&popunder=$popup');
    equal(r.kind, 'unsupported');
    ok(r.reason.includes('popup'), 'reason names popup');
  });

  test('popup combined with a real type keeps only the real type', () => {
    const r = parseFilter('/earn.php?z=$popup,subdocument');
    equal(r.kind, 'network');
    equal(r.types, T.subdocument, 'popup bit stripped, subdocument kept');
  });
});

suite('parser: pattern/option splitting', () => {
  test('options are taken from the last $ when they parse as options', () => {
    const r = parseFilter('&adb=y&adb=y^$script,third-party');
    equal(r.pattern, '&adb=y&adb=y^');
    equal(r.thirdParty, true);
  });

  test('a leading / alone does not make a rule a regex', () => {
    // Real EasyPrivacy line. It starts with '/' but does not end with one, so
    // it is a path pattern. Mistaking it for a regex drops its $domain option
    // and turns a narrowly-scoped rule into a global one — over 4,000 rules in
    // the shipped lists have this shape.
    const r = parseFilter('/adobe-analytics-$domain=~business.adobe.com');
    equal(r.isRegex, false, 'not a regex rule');
    equal(r.pattern, '/adobe-analytics-');
    deepEqual(r.domains.exclude, ['business.adobe.com'], 'option survived');
  });

  test('a slash-delimited filter IS a regex, per ABP syntax', () => {
    const r = parseFilter('/pagead/$script');
    equal(r.isRegex, true, 'begins and ends with / -> regular expression');
    equal(r.pattern, '/pagead/');
    equal(r.types, T.script);
  });

  test('regex rules keep $ inside the expression', () => {
    const r = parseFilter('/banner\\d+$/$script');
    equal(r.kind, 'network');
    equal(r.isRegex, true);
    equal(r.pattern, '/banner\\d+$/');
    equal(r.types, T.script);
  });

  test('a regex rule with no options is parsed whole', () => {
    const r = parseFilter('/(https?:\\/\\/)\\w{30,}\\.me\\//');
    equal(r.kind, 'network');
    equal(r.isRegex, true);
  });

  test('an invalid regex is reported rather than thrown at request time', () => {
    const r = parseFilter('/ad[unclosed/');
    equal(r.kind, 'unsupported');
    ok(r.reason.includes('regular expression'), r.reason);
  });
});

suite('parser: unsupported options', () => {
  const unsupported = [
    '||x.io^$redirect=noop.js',
    '||x.io^$removeparam=utm_source',
    '||x.io^$csp=script-src none',
    '||x.io^$replace=/a/b/',
    '||x.io^$method=get',
  ];
  for (const line of unsupported) {
    test(`skips ${line}`, () => {
      equal(parseFilter(line).kind, 'unsupported');
    });
  }

  test('an unknown option beside a real one is reported', () => {
    const r = parseFilter('||x.io^$script,notarealoption');
    equal(r.kind, 'unsupported');
    ok(r.reason.includes('unknown option'), r.reason);
  });

  test('a $tail with no recognisable option is treated as pattern text', () => {
    // Nothing in "$b" looks like an option, so the '$' belongs to the URL.
    const r = parseFilter('||example.com/a$b');
    equal(r.kind, 'network');
    equal(r.pattern, '||example.com/a$b');
  });

  test('generichide is recognised, not discarded', () => {
    const r = parseFilter('@@||jetzt.de^$generichide');
    equal(r.kind, 'network');
    equal(r.cosmeticScope, 'generichide');
    equal(r.isException, true);
  });
});

suite('parser: cosmetic rules', () => {
  test('generic hiding rule', () => {
    const r = parseFilter('###AD_300');
    equal(r.kind, 'cosmetic');
    equal(r.selector, '#AD_300');
    equal(r.isException, false);
    deepEqual(r.domains.include, []);
  });

  test('domain-scoped hiding rule', () => {
    const r = parseFilter('advfn.com###APS_300_X_600');
    equal(r.selector, '#APS_300_X_600');
    deepEqual(r.domains.include, ['advfn.com']);
  });

  test('cosmetic domains split on comma, not pipe', () => {
    const r = parseFilter('a.com,b.com,~c.a.com##.ad');
    deepEqual(r.domains.include, ['a.com', 'b.com']);
    deepEqual(r.domains.exclude, ['c.a.com']);
  });

  test('#@# is an unhide exception', () => {
    const r = parseFilter('a.com#@#.ad');
    equal(r.kind, 'cosmetic');
    equal(r.isException, true);
  });

  test('procedural and scriptlet filters are reported unsupported', () => {
    equal(parseFilter('a.com#?#div:has-text(ad)').kind, 'unsupported');
    equal(parseFilter('a.com#$#hide-if-contains ad').kind, 'unsupported');
  });

  test('a # inside a network pattern is not a cosmetic separator', () => {
    const r = parseFilter('||example.com/page#section');
    equal(r.kind, 'network');
  });
});

suite('parser: whole-list parsing', () => {
  test('parseList tallies rules, exceptions and skips', () => {
    const text = [
      '[Adblock Plus 2.0]',
      '! Title: Test',
      '||ads.example.com^',
      '||track.example.com^$third-party',
      '@@||safe.example.com^',
      'example.com##.banner',
      '&popunder=$popup',
      '||x.io^$redirect=noop.js',
      '',
    ].join('\n');

    const { network, cosmetic, stats } = parseList(text, 'test');
    equal(network.length, 3, 'network rules');
    equal(cosmetic.length, 1, 'cosmetic rules');
    equal(stats.exceptions, 1, 'exceptions');
    equal(stats.skipped, 2, 'skipped (popup-only + redirect)');
    equal(network[0].source, 'test', 'source id recorded');
  });
});
