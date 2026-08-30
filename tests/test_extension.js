// End-to-end smoke test of the actual extension code.
//
// The unit tests cover lib/ in isolation. This one loads background/main.js
// exactly as Firefox would — same module graph, same top-level listener
// registration, same startup path — against a shimmed `browser` API, then
// drives real requests through the captured webRequest listener.
//
// It catches the class of bug unit tests cannot: a syntax error in a file
// nothing imports, a message handler that throws, a manifest pointing at a file
// that does not exist, or the cold-start gate letting requests through.

import { suite, test, ok, notOk, equal, note } from './runner.js';

const EXT = '/extension/';

// --- browser API shim -------------------------------------------------------

const shim = {
  requestListener: null,
  messageListener: null,
  removedListener: null,
  badgeText: new Map(),
  storage: {},
  sentToTabs: [],
};

function installShim() {
  const local = {
    async get(keys) {
      const out = {};
      for (const k of [].concat(keys)) {
        if (k in shim.storage) out[k] = shim.storage[k];
      }
      return out;
    },
    async set(patch) {
      Object.assign(shim.storage, patch);
    },
  };

  globalThis.browser = {
    runtime: {
      getURL: (path) => EXT + path,
      openOptionsPage: () => {},
      onMessage: { addListener: (fn) => { shim.messageListener = fn; } },
      sendMessage: async (msg) => (shim.messageListener ? shim.messageListener(msg, {}) : null),
    },
    storage: { local },
    webRequest: {
      onBeforeRequest: {
        addListener: (fn, filter, extra) => {
          shim.requestListener = fn;
          shim.filter = filter;
          shim.extraInfoSpec = extra;
        },
      },
    },
    action: {
      setBadgeText: async ({ tabId, text }) => { shim.badgeText.set(tabId, text); },
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
    },
    tabs: {
      onRemoved: { addListener: (fn) => { shim.removedListener = fn; } },
      query: async () => [],
      sendMessage: async (tabId, msg, opts) => { shim.sentToTabs.push({ tabId, msg, opts }); },
    },
  };
}

// --- helpers ----------------------------------------------------------------

let requestId = 0;
function request(url, type, tabId = 1, extra = {}) {
  return {
    requestId: String(++requestId),
    url,
    type,
    tabId,
    frameId: type === 'main_frame' ? 0 : 0,
    parentFrameId: -1,
    method: 'GET',
    ...extra,
  };
}

function isBlocked(result) {
  return !!(result && result.cancel === true);
}

/** Drive a request through the listener, awaiting the cold-start promise. */
async function run(details) {
  return await shim.requestListener(details);
}

async function navigate(tabId, url) {
  await run(request(url, 'main_frame', tabId));
}

// --- tests ------------------------------------------------------------------

let manifest = null;

suite('extension: manifest', () => {
  test('manifest.json is valid and Firefox-shaped', async () => {
    const res = await fetch(EXT + 'manifest.json');
    ok(res.ok, `manifest.json fetch failed: HTTP ${res.status}`);
    manifest = await res.json();

    equal(manifest.manifest_version, 3, 'MV3');

    // Firefox MV3 has no service_worker. Declaring one here would mean the
    // background never runs.
    ok(manifest.background.scripts, 'background.scripts present');
    notOk(manifest.background.service_worker, 'no service_worker (unsupported in Firefox)');
    equal(manifest.background.type, 'module', 'ES modules');

    // Blocking webRequest is the entire premise of the project.
    ok(manifest.permissions.includes('webRequest'), 'webRequest');
    ok(manifest.permissions.includes('webRequestBlocking'), 'webRequestBlocking');
    ok(manifest.host_permissions.includes('<all_urls>'), 'host permissions');

    // Without a stable add-on id, a temporary install gets a fresh one on every
    // reload and storage.local is wiped each time.
    ok(manifest.browser_specific_settings.gecko.id, 'gecko.id set');
    note(`min Firefox ${manifest.browser_specific_settings.gecko.strict_min_version}`);
  });

  test('every file the manifest references exists', async () => {
    const paths = [
      ...manifest.background.scripts,
      manifest.action.default_popup,
      manifest.options_ui.page,
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon),
    ];
    for (const cs of manifest.content_scripts) {
      paths.push(...(cs.js || []), ...(cs.css || []));
    }

    const missing = [];
    for (const p of [...new Set(paths)]) {
      const res = await fetch(EXT + p, { method: 'GET' });
      if (!res.ok) missing.push(`${p} (HTTP ${res.status})`);
    }
    equal(missing.length, 0, `missing files: ${missing.join(', ')}`);
    note(`checked ${new Set(paths).size} referenced files`);
  });

  test('content scripts run at document_start in all frames', () => {
    const cs = manifest.content_scripts[0];
    equal(cs.run_at, 'document_start', 'must beat the parser to avoid an ad flash');
    equal(cs.all_frames, true, 'ads live in iframes');
  });
});

suite('extension: background startup', () => {
  test('background/main.js loads and registers a blocking listener', async () => {
    installShim();
    await import('/extension/background/main.js');

    ok(shim.requestListener, 'onBeforeRequest listener registered at module scope');
    ok(shim.messageListener, 'onMessage listener registered');
    ok(shim.extraInfoSpec.includes('blocking'), 'listener asked for ["blocking"]');
    ok(shim.filter.urls.includes('<all_urls>'), 'filter covers all URLs');
  });

  // The cold-start gate is the subtle one: on a freshly woken event page the
  // index is not loaded, and a naive implementation lets requests straight
  // through. Firefox allows a blocking listener to return a Promise, so the
  // request is held instead. This fires the very first request before startup
  // could plausibly have finished.
  test('COLD START: the first request is held, not leaked', async () => {
    const result = await run(
      request('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'script', 1,
        { documentUrl: 'https://news.example.com/' }),
    );
    ok(isBlocked(result), 'a known ad request issued before startup finished was still blocked');
  });

  test('startup reports a loaded index', async () => {
    const opts = await shim.messageListener({ type: 'sift:get-options' }, {});
    ok(opts.engine.blockRules > 50000, `only ${opts.engine.blockRules} rules`);
    note(`${opts.engine.blockRules.toLocaleString()} block rules, ` +
         `${opts.engine.allowRules.toLocaleString()} exceptions`);
    note(`startup ${opts.startup.ms}ms (${opts.startup.fromCache ? 'from cache' : 'compiled'})`);
    note(`lists: ${opts.lists.map((l) => `${l.title} ${l.origin}`).join(', ')}`);
  });
});

suite('extension: request decisions', () => {
  test('blocks trackers on a normal page', async () => {
    await navigate(2, 'https://news.example.com/article');
    const blocked = await run(request('https://www.google-analytics.com/analytics.js', 'script', 2));
    ok(isBlocked(blocked), 'analytics blocked');
  });

  test('never blocks the top-level navigation itself', async () => {
    const r = await run(request('https://doubleclick.net/', 'main_frame', 3));
    notOk(isBlocked(r), 'main_frame must not be cancelled');
  });

  test('leaves ordinary subresources alone', async () => {
    await navigate(4, 'https://en.wikipedia.org/wiki/Main_Page');
    const r = await run(request('https://en.wikipedia.org/w/load.php?modules=startup', 'script', 4));
    notOk(isBlocked(r), 'first-party script allowed');
  });

  test('counts blocks per tab and sets the badge', async () => {
    await navigate(5, 'https://news.example.com/');
    for (const u of [
      'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
      'https://www.google-analytics.com/analytics.js',
      'https://connect.facebook.net/en_US/fbevents.js',
    ]) {
      await run(request(u, 'script', 5));
    }

    const state = await shim.messageListener({ type: 'sift:popup', tabId: 5 }, {});
    equal(state.pageCount, 3, 'three blocks counted on this tab');
    ok(state.totalCount >= 3, 'total accumulated');
    equal(state.hostname, 'news.example.com', 'tab hostname tracked');

    // Badge writes are coalesced on a timer, so wait for the flush.
    await new Promise((r) => setTimeout(r, 350));
    equal(shim.badgeText.get(5), '3', 'badge shows the count');
  });

  test('a new navigation resets that tab to zero', async () => {
    await navigate(5, 'https://other.example.org/');
    const state = await shim.messageListener({ type: 'sift:popup', tabId: 5 }, {});
    equal(state.pageCount, 0, 'counter reset on navigation');
  });

  test('blocked images are queued for collapsing', async () => {
    shim.sentToTabs.length = 0;
    await navigate(6, 'https://news.example.com/');
    await run(request('https://securepubads.g.doubleclick.net/pagead/banner.gif', 'image', 6));
    await new Promise((r) => setTimeout(r, 120));

    const collapse = shim.sentToTabs.find((m) => m.msg.type === 'sift:collapse');
    ok(collapse, 'a collapse message was sent to the tab');
    ok(collapse.msg.urls.some((u) => u.includes('banner.gif')), 'carries the blocked URL');
  });
});

suite('extension: whitelist and custom rules', () => {
  test('whitelisting a site stops blocking on it', async () => {
    await navigate(7, 'https://news.example.com/');
    ok(
      isBlocked(await run(request('https://www.google-analytics.com/analytics.js', 'script', 7))),
      'blocked before whitelisting',
    );

    await shim.messageListener(
      { type: 'sift:toggle-site', hostname: 'news.example.com' }, {},
    );

    notOk(
      isBlocked(await run(request('https://www.google-analytics.com/analytics.js', 'script', 7))),
      'allowed after whitelisting',
    );

    // And back off again, so later tests are unaffected.
    await shim.messageListener({ type: 'sift:toggle-site', hostname: 'news.example.com' }, {});
    ok(
      isBlocked(await run(request('https://www.google-analytics.com/analytics.js', 'script', 7))),
      'blocked again after un-whitelisting',
    );
  });

  test('a whitelisted parent domain covers its subdomains', async () => {
    await shim.messageListener({ type: 'sift:toggle-site', hostname: 'example.com' }, {});
    await navigate(8, 'https://deep.sub.example.com/');
    notOk(
      isBlocked(await run(request('https://www.google-analytics.com/analytics.js', 'script', 8))),
      'subdomain covered by the parent entry',
    );
    await shim.messageListener({ type: 'sift:toggle-site', hostname: 'example.com' }, {});
  });

  test('custom rules block, and custom exceptions override the lists', async () => {
    await shim.messageListener({
      type: 'sift:save-settings',
      patch: {
        customRules: [
          '||perfectly-normal-cdn.test^',
          '@@||www.google-analytics.com/analytics.js',
        ].join('\n'),
      },
    }, {});

    await navigate(9, 'https://news.example.com/');
    ok(
      isBlocked(await run(request('https://perfectly-normal-cdn.test/x.js', 'script', 9))),
      'custom block rule applied',
    );
    notOk(
      isBlocked(await run(request('https://www.google-analytics.com/analytics.js', 'script', 9))),
      'custom @@ rule overrides EasyPrivacy',
    );

    await shim.messageListener({ type: 'sift:save-settings', patch: { customRules: '' } }, {});
  });

  test('rule validation reports problems by line', async () => {
    const res = await shim.messageListener({
      type: 'sift:validate-rules',
      text: [
        '! a comment',
        '||good.example^',
        'example.com##.ad-thing',
        '||bad.example^$redirect=noop.js',
      ].join('\n'),
    }, {});

    equal(res.network, 1, 'one network rule');
    equal(res.cosmetic, 1, 'one cosmetic rule');
    equal(res.problems.length, 1, 'one problem');
    equal(res.problems[0].line, 4, 'reported against the right line');
    note(`problem reported: ${res.problems[0].reason}`);
  });

  test('the global switch turns everything off', async () => {
    await shim.messageListener({ type: 'sift:toggle-global' }, {});
    await navigate(10, 'https://news.example.com/');
    notOk(
      isBlocked(await run(request('https://www.google-analytics.com/analytics.js', 'script', 10))),
      'nothing blocked while disabled',
    );
    await shim.messageListener({ type: 'sift:toggle-global' }, {});
  });
});

suite('extension: cosmetic messaging', () => {
  test('a content script gets selectors for its hostname', async () => {
    await navigate(11, 'https://www.forbes.com/');
    const res = await shim.messageListener(
      { type: 'sift:cosmetic', hostname: 'www.forbes.com' },
      { tab: { id: 11 } },
    );
    ok(res.active, 'filtering active');
    ok(Array.isArray(res.selectors), 'selectors returned');
    note(`${res.selectors.length} selectors for forbes.com, generics ${res.allowGenerics ? 'on' : 'off'}`);
  });

  test('a whitelisted top document suppresses filtering in its frames', async () => {
    await shim.messageListener({ type: 'sift:toggle-site', hostname: 'www.forbes.com' }, {});
    const res = await shim.messageListener(
      // A third-party frame inside a whitelisted page.
      { type: 'sift:cosmetic', hostname: 'ads.iframe.test' },
      { tab: { id: 11 } },
    );
    notOk(res.active, 'frame inherits the top document decision');
    await shim.messageListener({ type: 'sift:toggle-site', hostname: 'www.forbes.com' }, {});
  });
});

suite('extension: index cache', () => {
  // The cold path holds requests while the index loads, so "rehydrate from
  // IndexedDB" must actually be faster than "recompile from text". If a
  // non-cloneable value ever creeps into the index, saveIndex fails silently
  // and every wake-up pays the full compile cost instead — this is the test
  // that would catch it.
  test('the compiled index survives a structured-clone round trip', async () => {
    const { loadIndex } = await import('/extension/background/storage.js');
    const { FilterEngine } = await import('/extension/lib/engine.js');

    const t0 = performance.now();
    const record = await loadIndex();
    const ms = performance.now() - t0;

    ok(record, 'background cached an index during startup');
    equal(record.formatVersion, 1, 'format version stored');
    ok(record.index.block.n > 50000, 'block rules survived');
    ok(record.index.block.tokenMap instanceof Map, 'Map survived the clone');
    ok(record.index.block.tier instanceof Uint8Array, 'TypedArray survived the clone');
    ok(record.index.genericHideHosts instanceof Set, 'Set survived the clone');

    note(`rehydrated ${record.index.block.n.toLocaleString()} rules in ${ms.toFixed(0)}ms`);
    note(`origin: ${record.origin}, compiled at ${record.compiledAt}`);

    // And it still works, not just looks right.
    const engine = new FilterEngine(record.index);
    ok(
      engine.match('https://www.google-analytics.com/analytics.js', 'script', 'news.test').blocked,
      'a rehydrated index still blocks',
    );
    notOk(
      engine.match('https://en.wikipedia.org/wiki/Main_Page', 'main_frame', 'en.wikipedia.org').blocked,
      'and still does not over-block',
    );
  });
});

suite('extension: UI scripts', () => {
  // popup.js / options.js / cosmetic.js are classic scripts loaded by Firefox,
  // not imported by anything here, so nothing else would catch a syntax error
  // in them until the page was opened by hand.
  const scripts = ['popup/popup.js', 'options/options.js', 'content/cosmetic.js', 'content/generics.js'];

  for (const path of scripts) {
    test(`${path} parses`, async () => {
      const res = await fetch(EXT + path);
      ok(res.ok, `HTTP ${res.status}`);
      const source = await res.text();
      try {
        // Compiles without executing: catches syntax errors only.
        new Function(source);
      } catch (err) {
        ok(false, `syntax error: ${err.message}`);
      }
    });
  }

  test('every element id the UI scripts look up exists in their HTML', async () => {
    const pages = [
      ['popup/popup.html', 'popup/popup.js'],
      ['options/options.html', 'options/options.js'],
    ];

    const missing = [];
    for (const [htmlPath, jsPath] of pages) {
      const html = await (await fetch(EXT + htmlPath)).text();
      const js = await (await fetch(EXT + jsPath)).text();
      const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
      for (const m of js.matchAll(/\bel\('([^']+)'\)/g)) {
        if (!ids.has(m[1])) missing.push(`${jsPath}: #${m[1]} not in ${htmlPath}`);
      }
    }
    equal(missing.length, 0, missing.join('\n        '));
  });
});
