// Per-tab block counts and the badge.
//
// The thing to get right here is write volume. An ad-heavy page can fire 80+
// blocks in a couple of seconds; naively that means 80 badge repaints and 80
// storage writes. Both are batched instead:
//
//   badge    coalesced on a short timer, one write per tab per tick
//   total    flushed to storage.local on a slower timer, and on suspend

import { setSettings } from './storage.js';

const BADGE_FLUSH_MS = 200;
const TOTAL_FLUSH_MS = 5000;
const MAX_ENTRIES_PER_TAB = 60; // what the popup shows; not a running log

const BADGE_BACKGROUND = '#3f6fd8';

/** tabId -> { count, entries: [{url, filter, type}], hostname } */
const tabs = new Map();

let total = 0;
let totalDirty = false;
const dirtyBadges = new Set();
let badgeTimer = null;
let totalTimer = null;

export function initTotal(value) {
  total = value || 0;
}

export function getTotal() {
  return total;
}

export function getTabState(tabId) {
  return tabs.get(tabId) || null;
}

export function setTabHostname(tabId, hostname) {
  const state = tabs.get(tabId);
  if (state) state.hostname = hostname;
}

/** Called when a tab starts a new top-level navigation. */
export function resetTab(tabId, hostname) {
  tabs.set(tabId, { count: 0, entries: [], hostname });
  scheduleBadge(tabId);
}

export function forgetTab(tabId) {
  tabs.delete(tabId);
  dirtyBadges.delete(tabId);
}

export function recordBlock(tabId, url, filter, type) {
  total++;
  totalDirty = true;
  scheduleTotalFlush();

  if (tabId < 0) return; // requests with no tab (e.g. from the background itself)

  let state = tabs.get(tabId);
  if (!state) {
    state = { count: 0, entries: [], hostname: '' };
    tabs.set(tabId, state);
  }
  state.count++;
  if (state.entries.length < MAX_ENTRIES_PER_TAB) {
    state.entries.push({ url, filter, type });
  }
  scheduleBadge(tabId);
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function scheduleBadge(tabId) {
  dirtyBadges.add(tabId);
  if (badgeTimer !== null) return;
  badgeTimer = setTimeout(flushBadges, BADGE_FLUSH_MS);
}

async function flushBadges() {
  badgeTimer = null;
  const pending = [...dirtyBadges];
  dirtyBadges.clear();

  for (const tabId of pending) {
    const state = tabs.get(tabId);
    const count = state ? state.count : 0;
    try {
      await browser.action.setBadgeText({
        tabId,
        text: count > 0 ? formatCount(count) : '',
      });
    } catch {
      // The tab closed between the block and the flush. Nothing to do.
      tabs.delete(tabId);
    }
  }
}

function formatCount(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** Badge colour is set once; text is what changes per tab. */
export async function initBadge() {
  try {
    await browser.action.setBadgeBackgroundColor({ color: BADGE_BACKGROUND });
    if (browser.action.setBadgeTextColor) {
      await browser.action.setBadgeTextColor({ color: '#ffffff' });
    }
  } catch (err) {
    console.warn('[sift] could not style badge:', err);
  }
}

/** Grey the badge out while blocking is off for a site. */
export async function setBadgeDisabled(tabId, disabled) {
  try {
    await browser.action.setBadgeBackgroundColor({
      tabId,
      color: disabled ? '#8b8f98' : BADGE_BACKGROUND,
    });
  } catch {
    /* tab gone */
  }
}

// ---------------------------------------------------------------------------
// Total
// ---------------------------------------------------------------------------

function scheduleTotalFlush() {
  if (totalTimer !== null) return;
  totalTimer = setTimeout(flushTotal, TOTAL_FLUSH_MS);
}

export async function flushTotal() {
  totalTimer = null;
  if (!totalDirty) return;
  totalDirty = false;
  try {
    await setSettings({ totalBlocked: total });
  } catch (err) {
    console.warn('[sift] could not persist total:', err);
    totalDirty = true;
  }
}

export async function resetTotal() {
  total = 0;
  totalDirty = false;
  await setSettings({ totalBlocked: 0 });
}
