// Cosmetic filtering and element collapsing.
//
// Runs at document_start in every frame. Three layers, in order of when they
// can act:
//
//   1. Curated generic selectors (AB_GENERIC_CSS, from generics.js) injected
//      synchronously right now — before the parser has produced any content, so
//      there is no flash of visible ads.
//   2. Hostname-scoped EasyList selectors, fetched from the background. A few
//      dozen for this site rather than the ~13,600 generic rules EasyList
//      carries, which is the difference between a cheap stylesheet and one the
//      style engine has to grind through on every element.
//   3. Element collapsing. Blocking a request at the network layer still leaves
//      the <img> or <iframe> in the layout, holding open an empty grey box.
//      The background tells us which URLs it blocked and we hide those exact
//      elements. This is the layer that removes the leftover holes.

(() => {
  'use strict';

  // Bail on documents with no element tree to style (some XML/plugin docs).
  if (!document.documentElement) return;

  const GENERIC_STYLE_ID = 'sift-generic-styles';
  const SPECIFIC_STYLE_ID = 'sift-specific-styles';

  // URLs the background told us it blocked, so the observer and the error
  // handler below only collapse elements we are actually responsible for.
  const blockedURLs = new Set();

  // --- stylesheet injection -------------------------------------------------

  function injectStyle(id, css) {
    if (!css || document.getElementById(id)) return null;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    // documentElement is guaranteed at document_start; head often is not.
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  // Layer 1, immediately. If the site turns out to carry $generichide we remove
  // it again a few milliseconds later — brief over-hiding is a far better
  // failure than a visible flash of ads on every page load.
  injectStyle(GENERIC_STYLE_ID, typeof AB_GENERIC_CSS === 'string' ? AB_GENERIC_CSS : '');

  function removeGenerics() {
    const el = document.getElementById(GENERIC_STYLE_ID);
    if (el) el.remove();
  }

  // --- layer 2: hostname-scoped selectors -----------------------------------

  browser.runtime
    .sendMessage({ type: 'sift:cosmetic', hostname: location.hostname })
    .then((res) => {
      if (!res || res.error) return;

      if (!res.active || !res.allowGenerics) removeGenerics();
      if (!res.active) return;

      if (res.selectors && res.selectors.length) {
        injectStyle(
          SPECIFIC_STYLE_ID,
          `${res.selectors.join(',\n')} {\n  display: none !important;\n}\n`,
        );
      }
    })
    .catch(() => {
      // Background unreachable (still starting, or the page outlived it).
      // The generic sheet is already in place; that is the safe state.
    });

  // --- layer 3: element collapsing ------------------------------------------

  const COLLAPSE_SELECTOR = 'img, iframe, video, audio, object, embed, source, track';

  function hide(el) {
    if (!el || el.dataset.siftCollapsed === '1') return;
    el.dataset.siftCollapsed = '1';
    el.style.setProperty('display', 'none', 'important');
  }

  /** Every URL-bearing attribute an element might have loaded from. */
  function urlsOf(el) {
    const out = [];
    for (const attr of ['src', 'data', 'poster', 'srcset']) {
      const raw = el.getAttribute && el.getAttribute(attr);
      if (!raw) continue;
      try {
        // Resolve against the document so it can be compared with the absolute
        // URL the background reported.
        out.push(new URL(raw, document.baseURI).href);
      } catch {
        /* malformed attribute; ignore */
      }
    }
    return out;
  }

  function collapseMatching(root) {
    if (blockedURLs.size === 0) return;
    const scope = root && root.querySelectorAll ? root : document;
    let nodes;
    try {
      nodes = scope.querySelectorAll(COLLAPSE_SELECTOR);
    } catch {
      return;
    }
    for (const el of nodes) {
      for (const u of urlsOf(el)) {
        if (blockedURLs.has(u)) {
          // <source> has no box of its own; collapse the media element.
          hide(el.tagName === 'SOURCE' || el.tagName === 'TRACK' ? el.parentElement : el);
          break;
        }
      }
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'sift:collapse' || !Array.isArray(msg.urls)) return;
    for (const u of msg.urls) blockedURLs.add(u);
    collapseMatching(document);
  });

  // Ads are frequently injected after the initial parse, and the element can
  // appear after we were told its request was blocked. Watch for both orders.
  const observer = new MutationObserver((records) => {
    if (blockedURLs.size === 0) return;
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType !== 1) continue;
        collapseMatching(node);
        if (node.matches && node.matches(COLLAPSE_SELECTOR)) {
          for (const u of urlsOf(node)) {
            if (blockedURLs.has(u)) { hide(node); break; }
          }
        }
      }
    }
  });

  try {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* detached document */
  }

  // Backstop for the race where the element errors out before our message
  // arrives. Deliberately scoped to URLs we blocked: hiding every image that
  // fails to load would collapse ordinary broken images all over the web.
  window.addEventListener(
    'error',
    (ev) => {
      const el = ev.target;
      if (!el || el.nodeType !== 1) return;
      if (!el.matches || !el.matches(COLLAPSE_SELECTOR)) return;
      for (const u of urlsOf(el)) {
        if (blockedURLs.has(u)) { hide(el); return; }
      }
    },
    true, // capture: resource errors do not bubble
  );
})();
