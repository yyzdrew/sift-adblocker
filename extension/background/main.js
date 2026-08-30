// Background event page.
//
// FIREFOX-SPECIFIC, and the single most important thing in this file:
//
// Manifest V3 in Firefox uses an *event page*, not a service worker. Event
// pages are suspended when idle and restarted on the next event, which means a
// blocking webRequest listener can fire on a cold page whose filter index has
// not been loaded yet. Handled naively, requests sail through unblocked for a
// few hundred milliseconds after every wake-up — an ad blocker that silently
// leaks, with nothing in the console to show for it.
//
// Two things prevent that:
//
//   1. The listener is registered synchronously during module evaluation. An
//      event page only gets woken for events it registered in its first turn.
//   2. Firefox lets a blocking listener return a *Promise* (since Firefox 52).
//      Chrome cannot do this. So on a cold start the request is HELD on the
//      readiness promise rather than allowed through.
//
// This is why index rehydration speed is a correctness concern and not just a
// nicety: every millisecond spent loading is a millisecond of stalled requests.

import { hostnameOf } from '../lib/url.js';
import { getSettings, setSettings } from './storage.js';
import { loadMainEngine, refreshLists, buildUserEngine } from './lists.js';
import { parseFilter } from '../lib/parser.js';
import * as stats from './stats.js';

// --- module state -----------------------------------------------------------

let mainEngine = null;
let userEngine = null;
let settings = null;
let listMeta = [];
let disabledSet = new Set();
let startupInfo = { fromCache: false, ms: 0 };

/** tabId -> top-level document hostname. */
const tabHosts = new Map();

// Kick off initialisation immediately, but do NOT await it here: the listener
// registrations below must happen in this same synchronous turn.
const ready = init();

// --- request blocking -------------------------------------------------------

browser.webRequest.onBeforeRequest.addListener(
  onBeforeRequest,
  { urls: ['<all_urls>'] },
  ['blocking'],
);

function onBeforeRequest(details) {
  // Warm path: fully synchronous, allocates nothing.
  if (mainEngine !== null) return decide(details);
  // Cold path: hold the request until the index is up rather than leak it.
  return ready.then(() => decide(details)).catch(() => undefined);
}

function decide(details) {
  const { url, type, tabId } = details;

  // A top-level navigation resets the tab's counters and tells us the document
  // hostname that every subresource on the page will be judged against.
  if (type === 'main_frame') {
    const host = hostnameOf(url);
    tabHosts.set(tabId, host);
    stats.resetTab(tabId, host);
    stats.setBadgeDisabled(tabId, !isActiveFor(host));
    // Top-level navigations are deliberately never blocked. EasyList's
    // $document rules exist mostly for interstitials and pop-unders; applying
    // them here would turn a filter list into a site blocker and hand the user
    // a blank page with no explanation. See README "Deliberate omissions".
    return undefined;
  }

  if (!settings.enabled) return undefined;

  const docHost = tabHosts.get(tabId)
    || hostnameOf(details.documentUrl || details.originUrl || '');

  if (!isActiveFor(docHost)) return undefined;

  // The user's own rules win over the shipped lists, in both directions.
  if (userEngine !== null) {
    if (userEngine.exceptionFor(url, type, docHost)) return undefined;
    const mine = userEngine.match(url, type, docHost);
    if (mine.blocked) return block(details, mine.filter);
  }

  const hit = mainEngine.match(url, type, docHost);
  if (hit.blocked) return block(details, hit.filter);

  return undefined;
}

function block(details, filter) {
  stats.recordBlock(details.tabId, details.url, filter, details.type);
  queueCollapse(details);
  return { cancel: true };
}

function isActiveFor(hostname) {
  if (!settings.enabled) return false;
  if (!hostname) return true;
  if (disabledSet.has(hostname)) return false;
  // A whitelisted parent domain covers its subdomains.
  let i = hostname.indexOf('.');
  while (i !== -1) {
    if (disabledSet.has(hostname.slice(i + 1))) return false;
    i = hostname.indexOf('.', i + 1);
  }
  return true;
}

// --- element collapsing -----------------------------------------------------

// Blocking the request leaves the element behind: an <img> with a broken source
// or an <iframe> that never loads, both still occupying layout space. Telling
// the content script exactly which URL failed lets it collapse that specific
// element, which is what actually removes the empty grey boxes.
const COLLAPSIBLE = new Set(['image', 'imageset', 'sub_frame', 'media', 'object']);
const collapseQueue = new Map(); // `${tabId}:${frameId}` -> string[]
let collapseTimer = null;

function queueCollapse(details) {
  if (!COLLAPSIBLE.has(details.type) || details.tabId < 0) return;
  const key = `${details.tabId}:${details.frameId}`;
  const list = collapseQueue.get(key);
  if (list) list.push(details.url);
  else collapseQueue.set(key, [details.url]);

  if (collapseTimer === null) collapseTimer = setTimeout(flushCollapse, 50);
}

function flushCollapse() {
  collapseTimer = null;
  for (const [key, urls] of collapseQueue) {
    const sep = key.indexOf(':');
    const tabId = Number(key.slice(0, sep));
    const frameId = Number(key.slice(sep + 1));
    browser.tabs
      .sendMessage(tabId, { type: 'sift:collapse', urls }, { frameId })
      .catch(() => {
        // No content script in that frame yet, or the tab is gone. The
        // MutationObserver in the content script is the backstop.
      });
  }
  collapseQueue.clear();
}

// --- tab bookkeeping --------------------------------------------------------

browser.tabs.onRemoved.addListener((tabId) => {
  tabHosts.delete(tabId);
  stats.forgetTab(tabId);
});

// --- messaging --------------------------------------------------------------

browser.runtime.onMessage.addListener((msg, sender) => {
  // Returning a promise is how a Firefox message listener replies asynchronously.
  return ready.then(() => handleMessage(msg, sender)).catch((err) => ({
    error: String(err && err.message ? err.message : err),
  }));
});

async function handleMessage(msg, sender) {
  switch (msg && msg.type) {
    case 'sift:cosmetic': {
      // Selectors are looked up by the *frame's* hostname, but whether we
      // filter at all is decided by the top-level document: whitelisting a site
      // has to cover the third-party frames embedded in it, and a subframe
      // cannot read its parent's hostname cross-origin.
      const host = msg.hostname || '';
      const topHost = (sender.tab && tabHosts.get(sender.tab.id)) || host;
      if (!isActiveFor(topHost)) return { selectors: [], allowGenerics: false, active: false };
      const base = mainEngine.cosmeticFor(host);
      const extra = userEngine ? userEngine.cosmeticFor(host) : { selectors: [] };
      return {
        selectors: [...new Set([...base.selectors, ...extra.selectors])],
        allowGenerics: base.allowGenerics,
        active: true,
      };
    }

    case 'sift:popup': {
      const tabId = msg.tabId;
      const host = tabHosts.get(tabId) || msg.hostname || '';
      const state = stats.getTabState(tabId);
      return {
        hostname: host,
        active: isActiveFor(host),
        globallyEnabled: settings.enabled,
        pageCount: state ? state.count : 0,
        totalCount: stats.getTotal(),
        entries: state ? state.entries.slice(-12).reverse() : [],
      };
    }

    case 'sift:toggle-site': {
      const host = msg.hostname;
      if (!host) return { ok: false };
      const next = new Set(disabledSet);
      if (next.has(host)) next.delete(host);
      else next.add(host);
      await applySettings({ disabledSites: [...next] });
      return { ok: true, active: isActiveFor(host) };
    }

    case 'sift:toggle-global': {
      await applySettings({ enabled: !settings.enabled });
      return { ok: true, enabled: settings.enabled };
    }

    case 'sift:get-options': {
      await stats.flushTotal();
      return {
        settings,
        lists: listMeta,
        engine: summariseEngine(),
        startup: startupInfo,
      };
    }

    case 'sift:save-settings': {
      await applySettings(msg.patch || {});
      return { ok: true, settings, engine: summariseEngine() };
    }

    case 'sift:validate-rules':
      return validateRules(msg.text || '');

    case 'sift:refresh-lists': {
      const result = await refreshLists();
      mainEngine = result.engine;
      listMeta = result.meta;
      return { ok: true, lists: listMeta, errors: result.errors, engine: summariseEngine() };
    }

    case 'sift:reset-total':
      await stats.resetTotal();
      return { ok: true };

    default:
      return { error: `unknown message: ${msg && msg.type}` };
  }
}

function summariseEngine() {
  const s = mainEngine ? mainEngine.stats : null;
  const u = userEngine ? userEngine.stats : null;
  return {
    blockRules: s ? s.blockRules : 0,
    allowRules: s ? s.allowRules : 0,
    cosmeticDomains: s ? s.cosmeticDomains : 0,
    genericSkipped: s ? s.cosmeticGenericSkipped : 0,
    tiers: s ? s.tiers : {},
    buckets: s ? s.buckets : {},
    userRules: u ? u.blockRules + u.allowRules : 0,
  };
}

/**
 * Check custom rules with the same parser the engine uses, so the feedback
 * shown in the options page is exactly what will happen at request time.
 */
function validateRules(text) {
  const problems = [];
  let network = 0;
  let cosmetic = 0;

  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let rule;
    try {
      rule = parseFilter(line);
    } catch (err) {
      problems.push({ line: i + 1, text: trimmed, reason: String(err.message) });
      return;
    }
    if (rule === null) return; // comment
    if (rule.kind === 'unsupported') {
      problems.push({ line: i + 1, text: trimmed, reason: rule.reason });
    } else if (rule.kind === 'network') network++;
    else cosmetic++;
  });

  return { problems, network, cosmetic };
}

// --- settings ---------------------------------------------------------------

async function applySettings(patch) {
  const next = { ...settings, ...patch };
  const rulesChanged = next.customRules !== settings.customRules;

  await setSettings(patch);
  settings = next;
  disabledSet = new Set(settings.disabledSites);

  if (rulesChanged) {
    userEngine = buildUserEngine(settings.customRules).engine;
  }
}

// --- startup ----------------------------------------------------------------

async function init() {
  const t0 = Date.now();
  try {
    settings = await getSettings();
    disabledSet = new Set(settings.disabledSites);
    stats.initTotal(settings.totalBlocked);
    userEngine = buildUserEngine(settings.customRules).engine;

    const { engine, meta, fromCache } = await loadMainEngine();
    mainEngine = engine;
    listMeta = meta;
    startupInfo = { fromCache, ms: Date.now() - t0 };

    await stats.initBadge();
    await primeTabHosts();

    console.log(
      `[sift] ready in ${startupInfo.ms}ms (${fromCache ? 'cached index' : 'compiled from bundled lists'}), ` +
      `${engine.stats.blockRules.toLocaleString()} block rules, ` +
      `${engine.stats.allowRules.toLocaleString()} exceptions`,
    );
  } catch (err) {
    console.error('[sift] startup failed:', err);
    // Leave mainEngine null. decide() is never reached with a null engine
    // because onBeforeRequest only calls it after `ready` resolves, and a
    // rejected `ready` falls through to "allow". Failing open is the right
    // call: a broken blocker must not break the web.
    throw err;
  }
}

/** After a cold start we do not know what is loaded in each tab. Ask. */
async function primeTabHosts() {
  try {
    const all = await browser.tabs.query({});
    for (const tab of all) {
      if (tab.url) tabHosts.set(tab.id, hostnameOf(tab.url));
    }
  } catch (err) {
    // Without the URL we fall back to documentUrl/originUrl per request.
    console.warn('[sift] could not prime tab hostnames:', err);
  }
}
