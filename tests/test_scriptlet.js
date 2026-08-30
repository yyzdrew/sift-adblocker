// Tests for the YouTube scriptlet.
//
// The scriptlet patches JSON.parse, Response.prototype.json and a window
// property, so it is loaded inside a throwaway iframe rather than in this page
// — otherwise it would rewrite the test runner's own globals.

import { suite, test, ok, notOk, equal, note } from './runner.js';

const SCRIPT_URL = '/extension/content/scriptlets/yt-ads.js';

/** A cut-down shape of what YouTube's player response actually looks like. */
function playerResponse() {
  return {
    responseContext: { visitorData: 'abc' },
    playabilityStatus: { status: 'OK' },
    streamingData: {
      formats: [{ itag: 18, url: 'https://rr3.googlevideo.com/videoplayback?x=1' }],
    },
    videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'Real Video', lengthSeconds: '212' },
    playerConfig: {
      audioConfig: { loudnessDb: 1.2 },
      adPlacementConfig: { kevlarConfig: {} },
    },
    adPlacements: [{ adPlacementRenderer: { config: {} } }],
    playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
    adSlots: [{ adSlotRenderer: {} }],
    adBreakHeartbeatParams: 'xyz',
    contents: {
      items: [
        { videoRenderer: { videoId: 'real1' } },
        { adSlotRenderer: { adLayoutMetadata: {} } },
        { videoRenderer: { videoId: 'real2' } },
        { promotedSparklesWebRenderer: {} },
      ],
    },
  };
}

async function makeSandbox() {
  const source = await (await fetch(SCRIPT_URL)).text();

  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.srcdoc = '<!doctype html><html><head></head><body></body></html>';
  document.body.appendChild(iframe);

  await new Promise((resolve) => {
    if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') resolve();
    else iframe.addEventListener('load', resolve, { once: true });
  });

  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  const el = doc.createElement('script');
  el.textContent = source;
  doc.head.appendChild(el);

  return { win, doc, cleanup: () => iframe.remove() };
}

suite('youtube scriptlet', () => {
  test('strips ad instructions from a player response', async () => {
    const { win, cleanup } = await makeSandbox();
    try {
      const parsed = win.JSON.parse(JSON.stringify(playerResponse()));

      notOk('adPlacements' in parsed, 'adPlacements removed');
      notOk('playerAds' in parsed, 'playerAds removed');
      notOk('adSlots' in parsed, 'adSlots removed');
      notOk('adBreakHeartbeatParams' in parsed, 'adBreakHeartbeatParams removed');
      notOk('adPlacementConfig' in parsed.playerConfig, 'mid-roll config removed');

      note(`pruned ${win.__siftYouTube.prunedFields} ad fields`);
    } finally {
      cleanup();
    }
  });

  // The failure that matters most: pruning too much breaks playback entirely,
  // which is far worse than showing an ad.
  test('leaves the actual video data untouched', async () => {
    const { win, cleanup } = await makeSandbox();
    try {
      const parsed = win.JSON.parse(JSON.stringify(playerResponse()));

      equal(parsed.videoDetails.videoId, 'dQw4w9WgXcQ', 'video id intact');
      equal(parsed.videoDetails.title, 'Real Video', 'title intact');
      equal(parsed.playabilityStatus.status, 'OK', 'playability intact');
      equal(parsed.streamingData.formats.length, 1, 'stream formats intact');
      ok(parsed.playerConfig.audioConfig, 'unrelated playerConfig keys intact');
      equal(parsed.responseContext.visitorData, 'abc', 'response context intact');
    } finally {
      cleanup();
    }
  });

  test('drops ad cards from feed arrays but keeps real videos', async () => {
    const { win, cleanup } = await makeSandbox();
    try {
      const parsed = win.JSON.parse(JSON.stringify(playerResponse()));
      const items = parsed.contents.items;

      equal(items.length, 2, 'two ad cards removed');
      equal(items[0].videoRenderer.videoId, 'real1');
      equal(items[1].videoRenderer.videoId, 'real2');
    } finally {
      cleanup();
    }
  });

  test('ordinary JSON is passed through unchanged', async () => {
    const { win, cleanup } = await makeSandbox();
    try {
      equal(win.JSON.parse('{"a":1}').a, 1);
      equal(win.JSON.parse('[1,2,3]').length, 3);
      equal(win.JSON.parse('"hello"'), 'hello');
      equal(win.JSON.parse('null'), null);
      // The reviver argument must still work; YouTube's own code may use it.
      equal(win.JSON.parse('{"n":2}', (k, v) => (k === 'n' ? v * 5 : v)).n, 10);
    } finally {
      cleanup();
    }
  });

  test('prunes responses read via Response.json()', async () => {
    const { win, cleanup } = await makeSandbox();
    try {
      const res = new win.Response(JSON.stringify(playerResponse()));
      const parsed = await res.json();
      notOk('adPlacements' in parsed, 'pruned through the fetch path too');
      equal(parsed.videoDetails.videoId, 'dQw4w9WgXcQ', 'video data survived');
    } finally {
      cleanup();
    }
  });

  test('guards the ytInitialPlayerResponse global', async () => {
    const { win, cleanup } = await makeSandbox();
    try {
      win.ytInitialPlayerResponse = playerResponse();
      const stored = win.ytInitialPlayerResponse;
      notOk('adPlacements' in stored, 'pruned on assignment');
      equal(stored.videoDetails.title, 'Real Video', 'video data survived');
    } finally {
      cleanup();
    }
  });

  test('respects the disabled flag set by the content script', async () => {
    const { win, doc, cleanup } = await makeSandbox();
    try {
      doc.documentElement.setAttribute('data-sift-disabled', '');
      const parsed = win.JSON.parse(JSON.stringify(playerResponse()));
      ok('adPlacements' in parsed, 'nothing pruned while whitelisted');
      ok(win.__siftYouTube.disabled, 'reports itself as disabled');
    } finally {
      cleanup();
    }
  });

  test('a malformed payload cannot break the page', async () => {
    const { win, cleanup } = await makeSandbox();
    try {
      // Deeply nested and self-referential shapes must not throw or hang.
      const deep = { a: {} };
      let node = deep.a;
      for (let i = 0; i < 40; i++) { node.next = {}; node = node.next; }
      ok(win.JSON.parse(JSON.stringify(deep)), 'deep nesting survives the depth cap');

      // Invalid JSON must still throw the way JSON.parse normally does.
      let threw = false;
      try { win.JSON.parse('{not json'); } catch { threw = true; }
      ok(threw, 'invalid JSON still throws');
    } finally {
      cleanup();
    }
  });
});
