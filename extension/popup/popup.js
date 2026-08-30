'use strict';

const el = (id) => document.getElementById(id);

let hostname = '';
let tabId = null;

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function render(state) {
  hostname = state.hostname || '';

  el('hostname').textContent = hostname || 'This page';
  el('page-count').textContent = state.pageCount.toLocaleString();
  el('total-count').textContent = state.totalCount.toLocaleString();

  const on = state.active;
  el('site-toggle').checked = on;
  el('status-dot').classList.toggle('off', !on);

  el('site-state').textContent = !state.globallyEnabled
    ? 'Blocking is off everywhere'
    : on
      ? 'Blocking on this site'
      : 'Paused on this site';

  const entries = state.entries || [];
  const list = el('recent-list');
  list.textContent = '';

  if (entries.length === 0) {
    el('recent-section').hidden = true;
    const note = el('empty-note');
    note.hidden = false;
    note.textContent = on
      ? 'Nothing blocked on this page yet.'
      : 'Turn blocking on to filter this site.';
    return;
  }

  el('empty-note').hidden = true;
  el('recent-section').hidden = false;

  for (const entry of entries) {
    const li = document.createElement('li');

    const host = document.createElement('div');
    host.className = 'rec-host';
    host.textContent = hostOf(entry.url) || entry.url;

    const meta = document.createElement('div');
    meta.className = 'rec-meta';
    meta.textContent = `${entry.type} · ${entry.filter}`;

    // Full detail on hover; the row itself stays one line.
    li.title = `${entry.url}\n\nmatched: ${entry.filter}`;
    li.append(host, meta);
    list.appendChild(li);
  }
}

function showError(message) {
  el('hostname').textContent = 'Unavailable';
  el('site-state').textContent = message;
  el('recent-section').hidden = true;
  el('empty-note').hidden = false;
  el('empty-note').textContent = '';
}

async function load() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return showError('No active tab.');

  tabId = tab.id;
  const fallbackHost = hostOf(tab.url || '');

  const state = await browser.runtime.sendMessage({
    type: 'sift:popup',
    tabId,
    hostname: fallbackHost,
  });

  if (!state || state.error) {
    return showError(state ? state.error : 'Background not responding.');
  }
  render(state);
}

el('site-toggle').addEventListener('change', async () => {
  if (!hostname) return;
  await browser.runtime.sendMessage({ type: 'sift:toggle-site', hostname });
  await load();
  // The page has to be reloaded for the change to take effect on requests that
  // have already been made, so say so rather than letting the count look wrong.
  el('site-state').textContent += ' — reload the page';
});

el('options-link').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

load().catch((err) => showError(String(err.message || err)));
