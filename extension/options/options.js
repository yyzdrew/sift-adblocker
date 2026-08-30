'use strict';

const el = (id) => document.getElementById(id);

let settings = null;
let lists = [];

// --- helpers ----------------------------------------------------------------

function send(msg) {
  return browser.runtime.sendMessage(msg);
}

function setStatus(node, kind, text, items) {
  node.hidden = false;
  node.className = `status ${kind}`;
  node.textContent = text;
  if (items && items.length) {
    const ul = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    }
    node.appendChild(ul);
  }
}

function num(n) {
  return (n || 0).toLocaleString();
}

function relativeTime(iso) {
  if (!iso) return 'unknown';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

/** Normalise user input like "https://www.example.com/path" to a hostname. */
function toHostname(raw) {
  let value = raw.trim().toLowerCase();
  if (value === '') return '';
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      return '';
    }
  } else {
    value = value.split('/')[0].split('?')[0];
  }
  if (value.includes('@') || value.includes(' ')) return '';
  // A bare hostname needs at least one dot, unless it is something like
  // "localhost" that legitimately has none.
  if (!/^[a-z0-9.-]+$/.test(value)) return '';
  if (value.startsWith('.') || value.endsWith('.')) return '';
  return value;
}

// --- rendering --------------------------------------------------------------

function renderEngine(engine, startup) {
  const source = startup && startup.fromCache
    ? 'loaded from cache'
    : 'compiled from the bundled snapshot';
  el('engine-summary').textContent =
    `${num(engine.blockRules)} block rules and ${num(engine.allowRules)} exceptions ` +
    `across ${num(engine.cosmeticDomains)} sites with cosmetic rules — ` +
    `${source} in ${startup ? startup.ms : 0}ms.`;
}

function renderLists() {
  const root = el('lists');
  root.textContent = '';

  if (!lists.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No filter lists loaded.';
    root.appendChild(p);
    return;
  }

  for (const list of lists) {
    const item = document.createElement('div');
    item.className = 'list-item';

    const title = document.createElement('div');
    title.className = 'list-title';
    title.append(document.createTextNode(list.title || list.id));

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = list.origin === 'network' ? 'refreshed' : 'bundled';
    title.appendChild(badge);

    const meta = document.createElement('div');
    meta.className = 'list-meta';
    const bits = [];
    if (list.version) bits.push(`version ${list.version}`);
    bits.push(relativeTime(list.fetchedAt));
    if (list.license) bits.push(list.license);
    meta.textContent = bits.join(' · ');

    const nums = document.createElement('div');
    nums.className = 'list-nums';
    nums.textContent =
      `${num(list.networkRules)} network · ${num(list.cosmeticRules)} cosmetic · ` +
      `${num(list.exceptions)} exceptions · ${num(list.skipped)} skipped`;

    item.append(title, meta, nums);

    // The skipped count is only honest if you can see what it covers.
    const reasons = Object.entries(list.skippedReasons || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    if (reasons.length) {
      const det = document.createElement('details');
      const sum = document.createElement('summary');
      sum.className = 'list-nums';
      sum.textContent = 'why rules were skipped';
      det.appendChild(sum);
      const ul = document.createElement('ul');
      ul.className = 'list-nums';
      for (const [reason, count] of reasons) {
        const li = document.createElement('li');
        li.textContent = `${num(count)} — ${reason}`;
        ul.appendChild(li);
      }
      det.appendChild(ul);
      item.appendChild(det);
    }

    if (list.sha256) {
      const h = document.createElement('div');
      h.className = 'hash';
      h.textContent = `sha256 ${list.sha256.slice(0, 24)}…`;
      item.appendChild(h);
    }

    root.appendChild(item);
  }
}

function renderWhitelist() {
  const root = el('whitelist');
  root.textContent = '';

  const sites = [...(settings.disabledSites || [])].sort();
  if (sites.length === 0) {
    const p = document.createElement('li');
    p.className = 'empty';
    p.style.borderTop = '0';
    p.textContent = 'No sites whitelisted.';
    root.appendChild(p);
    return;
  }

  for (const site of sites) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = site;

    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      const next = sites.filter((s) => s !== site);
      await saveSettings({ disabledSites: next });
      setStatus(el('whitelist-status'), 'ok', `Removed ${site}.`);
    });

    li.append(name, remove);
    root.appendChild(li);
  }
}

function renderStats(engine) {
  const root = el('stats');
  root.textContent = '';

  const tiers = engine.tiers || {};
  const cheap =
    (tiers.HOST_ONLY || 0) + (tiers.HOST_PREFIX || 0) +
    (tiers.PLAIN || 0) + (tiers.LEFT || 0) + (tiers.RIGHT || 0);
  const total = cheap + (tiers.REGEX || 0);

  const cells = [
    [num(settings.totalBlocked), 'requests blocked'],
    [num(engine.blockRules + engine.allowRules), 'rules loaded'],
    [num(engine.userRules), 'custom rules active'],
    [total ? `${((cheap / total) * 100).toFixed(1)}%` : '—', 'rules avoiding regex'],
    [num((engine.buckets || {}).blockUntokenized), 'always-scanned rules'],
    [num(engine.genericSkipped), 'generic hides not shipped'],
  ];

  for (const [value, label] of cells) {
    const box = document.createElement('div');
    const v = document.createElement('div');
    v.className = 'stat-value';
    v.textContent = value;
    const l = document.createElement('div');
    l.className = 'stat-label';
    l.textContent = label;
    box.append(v, l);
    root.appendChild(box);
  }
}

// --- actions ----------------------------------------------------------------

async function saveSettings(patch) {
  const res = await send({ type: 'sift:save-settings', patch });
  if (res && res.settings) {
    settings = res.settings;
    renderWhitelist();
    if (res.engine) renderStats(res.engine);
  }
}

async function load() {
  const res = await send({ type: 'sift:get-options' });
  if (!res || res.error) {
    setStatus(el('refresh-status'), 'err', res ? res.error : 'Background not responding.');
    return;
  }
  settings = res.settings;
  lists = res.lists || [];

  el('global-toggle').checked = settings.enabled;
  el('global-hint').textContent = settings.enabled
    ? 'Filtering is on. Use the whitelist below for exceptions.'
    : 'Filtering is off everywhere. Nothing is being blocked.';
  el('custom-rules').value = settings.customRules || '';

  renderEngine(res.engine, res.startup);
  renderLists();
  renderWhitelist();
  renderStats(res.engine);
}

el('global-toggle').addEventListener('change', async () => {
  await send({ type: 'sift:toggle-global' });
  await load();
});

el('refresh-btn').addEventListener('click', async () => {
  const btn = el('refresh-btn');
  const status = el('refresh-status');
  btn.disabled = true;
  setStatus(status, 'busy', 'Fetching the latest lists…');

  try {
    const res = await send({ type: 'sift:refresh-lists' });
    if (!res || res.error) {
      setStatus(status, 'err', `Refresh failed: ${res ? res.error : 'no response'}`);
    } else {
      lists = res.lists || lists;
      renderLists();
      renderStats(res.engine);
      if (res.errors && res.errors.length) {
        setStatus(status, 'warn', 'Refreshed, but some lists failed:', res.errors);
      } else {
        setStatus(status, 'ok', 'Lists refreshed.');
      }
    }
  } catch (err) {
    setStatus(status, 'err', `Refresh failed: ${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
});

el('save-rules').addEventListener('click', async () => {
  const text = el('custom-rules').value;
  const feedback = el('rules-feedback');

  // Validate with the same parser the engine uses, so what is reported here is
  // exactly what will happen at request time.
  const check = await send({ type: 'sift:validate-rules', text });
  await saveSettings({ customRules: text });

  const parts = [];
  if (check.network) parts.push(`${check.network} network rule${check.network === 1 ? '' : 's'}`);
  if (check.cosmetic) parts.push(`${check.cosmetic} hiding rule${check.cosmetic === 1 ? '' : 's'}`);
  const summary = parts.length ? `Saved ${parts.join(' and ')}.` : 'Saved. No active rules.';

  if (check.problems && check.problems.length) {
    setStatus(
      feedback, 'warn', `${summary} ${check.problems.length} line(s) could not be used:`,
      check.problems.map((p) => `line ${p.line}: ${p.reason} — ${p.text}`),
    );
  } else {
    setStatus(feedback, 'ok', summary);
  }
});

el('whitelist-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = el('whitelist-input');
  const status = el('whitelist-status');
  const host = toHostname(input.value);

  if (!host) {
    setStatus(status, 'err', `"${input.value.trim()}" is not a valid hostname.`);
    return;
  }
  if ((settings.disabledSites || []).includes(host)) {
    setStatus(status, 'warn', `${host} is already whitelisted.`);
    return;
  }

  await saveSettings({ disabledSites: [...(settings.disabledSites || []), host] });
  input.value = '';
  setStatus(status, 'ok', `Added ${host}. Reload affected pages to apply.`);
});

el('reset-total').addEventListener('click', async () => {
  await send({ type: 'sift:reset-total' });
  await load();
});

load().catch((err) => {
  setStatus(el('refresh-status'), 'err', String(err.message || err));
});
