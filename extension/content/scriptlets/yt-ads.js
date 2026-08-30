// YouTube ad removal — runs in the page's MAIN world.
//
// WHY THIS FILE EXISTS
//
// YouTube serves ad video from googlevideo.com/videoplayback — the exact same
// endpoint that serves the real video. Ad segments and content segments are
// indistinguishable by URL, so blocking at the network layer either does
// nothing or kills playback entirely. No filter list can fix that.
//
// What CAN be done is remove the ad *instructions* before the player acts on
// them. YouTube's player response carries `adPlacements`, `playerAds` and
// `adSlots` describing which ads to play and when. Delete those fields in
// flight and the player has nothing to schedule. This is the "json-prune"
// technique uBlock Origin uses for the same job.
//
// This needs the page's own JS realm — a normal content script runs isolated
// and cannot patch the page's JSON.parse. Firefox 128+ supports
// `"world": "MAIN"` in manifest content_scripts, and unlike injecting a
// <script> element, a MAIN-world content script is NOT subject to the page's
// CSP. YouTube's CSP is strict, so that exemption is what makes this viable.
//
// MAINTENANCE: this is inherently fragile. It depends on the shape of
// YouTube's player response, which they change without notice. When ads come
// back, the field names below are the first thing to check.

(() => {
  'use strict';

  // Fields carrying ad instructions in the player response.
  const AD_KEYS = [
    'adPlacements',
    'playerAds',
    'adSlots',
    'adBreakHeartbeatParams',
    'adParams',
    'adServerData',
  ];

  // Renderers that represent an ad card in a feed or sidebar.
  const AD_RENDERERS = [
    'adSlotRenderer',
    'promotedSparklesWebRenderer',
    'promotedSparklesTextSearchRenderer',
    'displayAdRenderer',
    'compactPromotedVideoRenderer',
    'searchPvpWatchCardRenderer',
    'statementBannerRenderer',
  ];

  // The isolated content script sets this attribute when the user has
  // whitelisted YouTube or turned blocking off. MAIN-world scripts get no
  // extension APIs, so a DOM attribute is the available channel. There is a
  // brief window at document_start before it is set; documented, not fatal.
  function disabled() {
    try {
      return document.documentElement.hasAttribute('data-sift-disabled');
    } catch {
      return false;
    }
  }

  let pruned = 0;

  function pruneObject(obj, depth = 0) {
    if (obj === null || typeof obj !== 'object' || depth > 12) return obj;

    if (Array.isArray(obj)) {
      // Drop entries that are themselves ad cards.
      for (let i = obj.length - 1; i >= 0; i--) {
        const item = obj[i];
        if (item && typeof item === 'object' &&
            AD_RENDERERS.some((k) => Object.prototype.hasOwnProperty.call(item, k))) {
          obj.splice(i, 1);
          pruned++;
          continue;
        }
        pruneObject(item, depth + 1);
      }
      return obj;
    }

    for (const key of AD_KEYS) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        delete obj[key];
        pruned++;
      }
    }

    // playerConfig.adPlacementConfig drives mid-roll scheduling.
    if (obj.playerConfig && typeof obj.playerConfig === 'object') {
      if ('adPlacementConfig' in obj.playerConfig) {
        delete obj.playerConfig.adPlacementConfig;
        pruned++;
      }
    }

    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value !== null && typeof value === 'object') pruneObject(value, depth + 1);
    }
    return obj;
  }

  function prune(value) {
    if (disabled()) return value;
    try {
      return pruneObject(value);
    } catch {
      // Never let a pruning bug break YouTube. Returning the original value
      // means ads play; throwing here would mean the page does not load.
      return value;
    }
  }

  // --- hook JSON.parse ------------------------------------------------------
  // The player response reaches the page through JSON.parse in several paths.
  const nativeParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    return prune(nativeParse.call(this, text, reviver));
  };

  // --- hook Response.prototype.json ----------------------------------------
  // /youtubei/v1/player is fetched and read as .json(), bypassing JSON.parse.
  if (typeof Response !== 'undefined' && Response.prototype && Response.prototype.json) {
    const nativeJson = Response.prototype.json;
    Response.prototype.json = function (...args) {
      return nativeJson.apply(this, args).then(prune);
    };
  }

  // --- guard the bootstrap global ------------------------------------------
  // ytInitialPlayerResponse is assigned directly by an inline script on the
  // watch page, so it never passes through either hook above.
  try {
    let stored;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get() { return stored; },
      set(value) { stored = prune(value); },
    });
  } catch {
    /* another extension may already own this property */
  }

  // A small, quiet signal for debugging when ads reappear.
  Object.defineProperty(window, '__siftYouTube', {
    configurable: true,
    get: () => ({ prunedFields: pruned, disabled: disabled() }),
  });
})();
