// Loading, compiling and refreshing filter lists.
//
// Cold start order of preference:
//   1. the compiled index cached in IndexedDB  (~150ms to rehydrate)
//   2. recompile from the snapshot bundled in the extension (~250ms)
//
// The network is never on the startup path. Refreshing is something the user
// asks for on the options page, so a first run works offline and an unreachable
// easylist.to can never leave the browser unprotected.

import { compileLists, INDEX_FORMAT_VERSION } from '../lib/compiler.js';
import { FilterEngine } from '../lib/engine.js';
import { loadIndex, saveIndex } from './storage.js';

const CATALOG_URL = 'filters/lists.json';

/** Read the bundled catalogue: which lists exist, and the snapshot metadata. */
export async function readCatalog() {
  const url = browser.runtime.getURL(CATALOG_URL);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot read ${CATALOG_URL}: HTTP ${res.status}`);
  return res.json();
}

/** A fingerprint of the bundled snapshot, so a re-vendored list invalidates the cache. */
function bundledKey(catalog) {
  const parts = catalog.lists.map((l) => `${l.id}:${l.sha256 || l.version || ''}`);
  return `v${INDEX_FORMAT_VERSION}|${parts.join('|')}`;
}

async function readBundledSources(catalog) {
  const sources = [];
  for (const list of catalog.lists) {
    const url = browser.runtime.getURL(`filters/${list.file}`);
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[sift] bundled list ${list.file} missing (HTTP ${res.status})`);
      continue;
    }
    sources.push({ id: list.id, text: await res.text() });
  }
  return sources;
}

function metaFromCompile(catalog, index, origin, extra = {}) {
  const byId = new Map(index.stats.lists.map((l) => [l.id, l]));
  return catalog.lists.map((l) => {
    const s = byId.get(l.id) || {};
    return {
      id: l.id,
      title: l.title,
      description: l.description,
      url: l.url,
      homepage: l.homepage,
      license: l.license,
      version: (extra.versions && extra.versions[l.id]) || l.version,
      sha256: (extra.hashes && extra.hashes[l.id]) || l.sha256,
      fetchedAt: (extra.fetchedAt && extra.fetchedAt[l.id]) || l.fetchedAt,
      origin,
      networkRules: s.network || 0,
      cosmeticRules: s.cosmetic || 0,
      exceptions: s.exceptions || 0,
      skipped: s.skipped || 0,
      skippedReasons: s.skippedReasons || {},
    };
  });
}

/**
 * Build the main engine, preferring the cache.
 * @returns {{engine: FilterEngine, meta: object[], fromCache: boolean}}
 */
export async function loadMainEngine() {
  const catalog = await readCatalog();
  const key = bundledKey(catalog);

  const cached = await loadIndex();
  if (
    cached &&
    cached.formatVersion === INDEX_FORMAT_VERSION &&
    // A cache built from the bundled snapshot is stale once that snapshot
    // changes (someone re-ran tools/update_lists.py). One built from a network
    // refresh is newer than the bundle by definition, so it stands.
    (cached.origin === 'network' || cached.bundledKey === key)
  ) {
    return {
      engine: new FilterEngine(cached.index),
      meta: cached.meta,
      fromCache: true,
    };
  }

  const sources = await readBundledSources(catalog);
  const index = compileLists(sources);
  const meta = metaFromCompile(catalog, index, 'bundled');

  await saveIndex({
    formatVersion: INDEX_FORMAT_VERSION,
    origin: 'bundled',
    bundledKey: key,
    compiledAt: new Date().toISOString(),
    index,
    meta,
  });

  return { engine: new FilterEngine(index), meta, fromCache: false };
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const VERSION_RE = /^!\s*Version:\s*(.+?)\s*$/im;

/**
 * Re-fetch every list from its upstream URL and rebuild the index.
 *
 * The existing engine stays live until the new one is fully compiled, so a
 * failed or partial refresh never leaves the browser unprotected.
 *
 * @returns {{engine: FilterEngine, meta: object[], errors: string[]}}
 */
export async function refreshLists() {
  const catalog = await readCatalog();
  const sources = [];
  const errors = [];
  const versions = {};
  const hashes = {};
  const fetchedAt = {};

  for (const list of catalog.lists) {
    try {
      const res = await fetch(list.url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = (await res.text()).replace(/\r\n?/g, '\n');
      if (text.length < 1000) throw new Error('response too short to be a filter list');

      sources.push({ id: list.id, text });
      const m = VERSION_RE.exec(text.slice(0, 4000));
      versions[list.id] = m ? m[1] : null;
      hashes[list.id] = await sha256Hex(text);
      fetchedAt[list.id] = new Date().toISOString();
    } catch (err) {
      errors.push(`${list.title}: ${err.message}`);
    }
  }

  if (sources.length === 0) {
    throw new Error(`no lists could be fetched - ${errors.join('; ')}`);
  }

  const index = compileLists(sources);
  const meta = metaFromCompile(catalog, index, 'network', { versions, hashes, fetchedAt });

  await saveIndex({
    formatVersion: INDEX_FORMAT_VERSION,
    origin: 'network',
    bundledKey: bundledKey(catalog),
    compiledAt: new Date().toISOString(),
    index,
    meta,
  });

  return { engine: new FilterEngine(index), meta, errors };
}

/**
 * Compile the user's own rules into a small separate engine.
 *
 * Kept apart from the main index so that editing a custom rule costs a few
 * milliseconds instead of a full 250ms recompile of 136,000 list rules — and so
 * user intent can be given priority over the lists at match time.
 */
export function buildUserEngine(customRules) {
  const text = (customRules || '').trim();
  if (text === '') return { engine: null, stats: null };

  const index = compileLists([{ id: 'custom', text }]);
  return { engine: new FilterEngine(index), stats: index.stats.lists[0] };
}
