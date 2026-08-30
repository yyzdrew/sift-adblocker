import { suite, test, ok, notOk, equal, deepEqual } from './runner.js';
import { compileLists } from '../extension/lib/compiler.js';
import { FilterEngine, domainApplies } from '../extension/lib/engine.js';
import {
  hostnameOf, hostnameEndIndex, registrableDomain, isThirdParty, hostnameMatches,
} from '../extension/lib/url.js';

suite('url helpers', () => {
  test('hostnameOf extracts the host', () => {
    equal(hostnameOf('https://ads.example.com/x?a=b'), 'ads.example.com');
    equal(hostnameOf('http://example.com'), 'example.com');
    equal(hostnameOf('https://example.com:8443/x'), 'example.com', 'port stripped');
    equal(hostnameOf('https://user:pw@example.com/x'), 'example.com', 'userinfo stripped');
    equal(hostnameOf('https://EXAMPLE.com/'), 'example.com', 'lowercased');
    equal(hostnameOf('data:text/html,hi'), '', 'no host');
    equal(hostnameOf('about:blank'), '', 'no host');
  });

  test('hostnameOf handles IPv6 literals', () => {
    equal(hostnameOf('http://[2001:db8::1]:80/x'), '[2001:db8::1]');
  });

  test('an @ in the path is not mistaken for userinfo', () => {
    equal(hostnameOf('https://example.com/mail@host/x'), 'example.com');
  });

  test('hostnameEndIndex points just past the host', () => {
    const url = 'https://example.com/ads/1.gif';
    equal(url.slice(hostnameEndIndex(url)), '/ads/1.gif');
  });

  test('registrableDomain handles common multi-part suffixes', () => {
    equal(registrableDomain('www.example.com'), 'example.com');
    equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
    equal(registrableDomain('example.com'), 'example.com');
    equal(registrableDomain('localhost'), 'localhost');
    equal(registrableDomain('192.168.1.1'), '192.168.1.1', 'IPv4 is its own domain');
    equal(registrableDomain('user.github.io'), 'user.github.io', 'explicit suffix');
  });

  test('isThirdParty compares registrable domains', () => {
    notOk(isThirdParty('cdn.example.com', 'www.example.com'), 'same site');
    ok(isThirdParty('ads.doubleclick.net', 'www.example.com'), 'different site');
    notOk(isThirdParty('example.co.uk', 'www.example.co.uk'), 'multi-part suffix');
  });

  test('hostnameMatches requires a label boundary', () => {
    ok(hostnameMatches('ads.example.com', 'example.com'));
    ok(hostnameMatches('example.com', 'example.com'));
    notOk(hostnameMatches('notexample.com', 'example.com'), 'must not match a suffix mid-label');
  });
});

suite('domain= scoping', () => {
  test('include list restricts to those sites and their subdomains', () => {
    const d = { include: ['a.com'], exclude: [] };
    ok(domainApplies(d, 'a.com'));
    ok(domainApplies(d, 'www.a.com'));
    notOk(domainApplies(d, 'b.com'));
  });

  test('exclude list wins over include', () => {
    const d = { include: ['a.com'], exclude: ['sub.a.com'] };
    ok(domainApplies(d, 'a.com'));
    notOk(domainApplies(d, 'sub.a.com'));
  });

  test('an all-negated list applies everywhere except the exclusions', () => {
    const d = { include: [], exclude: ['a.com'] };
    ok(domainApplies(d, 'b.com'));
    notOk(domainApplies(d, 'a.com'));
  });
});

// ---------------------------------------------------------------------------

const LIST = [
  '! test list',
  '||ads.example.com^',
  '||tracker.io^$third-party',
  '||cdn.example.com/analytics.js$script',
  '||first.io^$~third-party',
  '/pagead/*',
  '@@||ads.example.com/allowed.js^',
  '||scoped.io^$domain=news.com',
  '||imgonly.io^$image',
  '||caseful.io/AbC$match-case',
  '||override.io^$important',
  '@@||override.io^',
  'news.com##.sidebar-ad',
  'news.com,sports.com###banner',
  'news.com#@#.sidebar-ad',
  '###generic-ad',
  '@@||nogenerics.com^$generichide',
].join('\n');

function makeEngine() {
  return new FilterEngine(compileLists([{ id: 'test', text: LIST }]));
}

suite('engine: network matching', () => {
  const e = makeEngine();
  const on = (url, type = 'script', doc = 'site.com') => e.match(url, type, doc);

  test('blocks a hostname rule and its subdomains', () => {
    ok(on('https://ads.example.com/a.js').blocked);
    ok(on('https://deep.ads.example.com/a.js').blocked, 'subdomain');
  });

  test('does not block a neighbouring hostname', () => {
    notOk(on('https://notads.example.com/a.js').blocked);
    notOk(on('https://example.com/a.js').blocked, 'parent domain is not covered');
  });

  test('reports which filter matched', () => {
    equal(on('https://ads.example.com/a.js').filter, '||ads.example.com^');
  });

  test('$third-party only applies cross-site', () => {
    ok(on('https://tracker.io/t.js', 'script', 'site.com').blocked, 'third party');
    notOk(on('https://tracker.io/t.js', 'script', 'tracker.io').blocked, 'first party');
  });

  test('$~third-party only applies same-site', () => {
    ok(on('https://first.io/a.js', 'script', 'first.io').blocked);
    notOk(on('https://first.io/a.js', 'script', 'other.com').blocked);
  });

  test('type options are enforced', () => {
    ok(on('https://imgonly.io/a.png', 'image').blocked);
    notOk(on('https://imgonly.io/a.js', 'script').blocked);
  });

  test('a host-prefix rule anchors after the hostname', () => {
    ok(on('https://cdn.example.com/analytics.js', 'script').blocked);
    notOk(on('https://cdn.example.com/other.js', 'script').blocked);
    notOk(
      on('https://evil.com/?x=cdn.example.com/analytics.js', 'script').blocked,
      'must not match the pattern inside a query string',
    );
  });

  test('wildcard patterns match', () => {
    ok(on('https://google.com/pagead/conversion.js').blocked);
  });

  test('$domain= scopes a rule to a document', () => {
    ok(on('https://scoped.io/a.js', 'script', 'news.com').blocked);
    notOk(on('https://scoped.io/a.js', 'script', 'other.com').blocked);
  });

  test('$match-case is honoured', () => {
    ok(on('https://caseful.io/AbC').blocked, 'exact case');
    notOk(on('https://caseful.io/abc').blocked, 'wrong case');
  });

  test('unrelated requests are left alone', () => {
    notOk(on('https://en.wikipedia.org/wiki/Main_Page', 'main_frame').blocked);
    notOk(on('https://site.com/app.js').blocked);
  });
});

suite('engine: exceptions', () => {
  const e = makeEngine();

  test('an @@ rule unblocks a matching request', () => {
    const r = e.match('https://ads.example.com/allowed.js', 'script', 'site.com');
    notOk(r.blocked, 'not blocked');
    // Patterns are stored with the '@@' marker stripped; membership of the
    // allow index is what makes it an exception.
    equal(r.exception, '||ads.example.com/allowed.js^', 'exception reported');
    equal(r.filter, '||ads.example.com^', 'the overridden rule is still reported');
  });

  test('$important outranks an exception', () => {
    const r = e.match('https://override.io/a.js', 'script', 'site.com');
    ok(r.blocked, '$important wins over @@');
    equal(r.exception, null);
  });
});

suite('engine: cosmetic filtering', () => {
  const e = makeEngine();

  test('returns selectors scoped to the hostname', () => {
    const r = e.cosmeticFor('news.com');
    ok(r.selectors.includes('#banner'), 'multi-domain rule applies');
    notOk(r.selectors.includes('.sidebar-ad'), '#@# exception removes it');
  });

  test('applies to subdomains', () => {
    ok(e.cosmeticFor('www.news.com').selectors.includes('#banner'));
  });

  test('does not leak selectors to unrelated sites', () => {
    deepEqual(e.cosmeticFor('unrelated.com').selectors, []);
  });

  test('$generichide switches off the generic set for a site', () => {
    ok(e.cosmeticFor('news.com').allowGenerics, 'generics on by default');
    notOk(e.cosmeticFor('nogenerics.com').allowGenerics, 'generics disabled');
  });

  test('generic ## rules are counted but not shipped as selectors', () => {
    equal(e.index.stats.cosmeticGenericSkipped, 1);
  });
});

suite('engine: index shape', () => {
  test('hostname rules land in the host map, not the token map', () => {
    const e = makeEngine();
    ok(e.index.block.hostMap.has('ads.example.com'), 'host bucket exists');
    equal(e.index.stats.tiers.HOST_ONLY > 0, true);
  });

  test('the untokenized bucket stays small', () => {
    const e = makeEngine();
    ok(
      e.index.block.untokenized.length <= 2,
      `untokenized=${e.index.block.untokenized.length}`,
    );
  });
});
