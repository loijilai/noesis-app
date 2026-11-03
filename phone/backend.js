// Stands in for server/app.js on the phone: answers the page's /api calls from the data repo on GitHub.
import { cardSchedules } from '../server/schedule.js';
import { smartGroups } from '../server/smart-groups.js';
import { dailyPractice } from '../server/activity.js';
import { isSchedule } from '../server/card-text.js';
import { toEvent } from './events.js';
import { gitHub } from './github.js';
import { cached, openCache } from './cache.js';
import { createStore } from './store.js';

const SETTINGS_KEY = 'noesis-github';
const PENDING_KEY = 'noesis-pending';
const CHANGES_KEY = 'noesis-changes';
// Everything goes out together once the user pauses, so a round of practice and its edits is one commit.
const FLUSH_AFTER_MS = 90e3;
const RECHECK_AFTER_MS = 30e3;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

const stored = (key) => ({
  get() {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '[]');
    } catch {
      return [];
    }
  },
  set(list) {
    localStorage.setItem(key, JSON.stringify(list));
  },
});

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    return s?.token && s.repo && s.branch ? s : null;
  } catch {
    return null;
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function forgetSettings() {
  localStorage.removeItem(SETTINGS_KEY);
}

let store;
let gh;
let flushTimer;
let syncing = false;
let syncError = null;
let lastCheck = 0;
const listeners = new Set();

export async function start(settings, onProgress) {
  gh = gitHub(settings);
  await openCache();
  store = createStore({ gh, branch: settings.branch, pending: stored(PENDING_KEY), changes: stored(CHANGES_KEY), cached });
  await store.refresh(onProgress);
  lastCheck = Date.now();
  install();
  flush();
}

async function flush() {
  clearTimeout(flushTimer);
  if (!store.hasPending()) return;
  const before = [store.commit(), store.status().conflicts];
  syncing = true;
  announce();
  try {
    await store.flush();
    syncError = null;
  } catch (err) {
    syncError = err.message ?? String(err);
    console.error('noesis: 還沒寫進 GitHub', err);
  }
  syncing = false;
  announce();
  if (store.commit() !== before[0] || store.status().conflicts !== before[1]) changed();
}

function flushLater() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FLUSH_AFTER_MS);
}

function syncStatus() {
  return { ...store.status(), syncing, error: syncError };
}

function announce() {
  dispatchEvent(new CustomEvent('noesis-sync', { detail: syncStatus() }));
}

function changed() {
  for (const listener of listeners) listener(new MessageEvent('message'));
}

async function recheck(after = RECHECK_AFTER_MS) {
  if (Date.now() - lastCheck < after) return;
  lastCheck = Date.now();
  const before = store.commit();
  try {
    await store.refresh();
  } catch (err) {
    return console.error(err);
  }
  if (store.commit() !== before) changed();
}

function cardChanged() {
  flushLater();
  announce();
}

function json(status, data) {
  return new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

async function handle(path, method, body) {
  const now = new Date();
  if (method === 'GET') {
    const deck = store.deck();
    const ids = new Set(deck.cards.map((c) => c.id));
    const known = store.events().filter((e) => ids.has(e.id));
    // The page hides what only the desktop can do; adding and deleting cards are the structural changes the phone makes.
    if (path === '/api/deck') {
      const conflicts = store.conflicts().map((c) => c.id);
      return json(200, { ...deck, cards: deck.cards.map(withAssetLinks), readOnly: true, canAdd: true, canDelete: true, canSync: true, conflicts });
    }
    if (path === '/api/sync') return json(200, syncStatus());
    if (path === '/api/conflicts') return json(200, { conflicts: store.conflicts() });
    if (path === '/api/schedule') return json(200, { cards: cardSchedules(deck, known, now) });
    if (path === '/api/smart-groups') return json(200, { groups: smartGroups(deck, known, now) });
    if (path === '/api/progress') return json(200, { events: known });
    if (path === '/api/activity') return json(200, { days: dailyPractice(store.events()) });
    return json(404, { error: 'not found' });
  }
  if (path === '/api/progress' && method === 'POST') {
    const event = toEvent(JSON.parse(body ?? '{}'), now);
    if (!event) return json(400, { error: 'id、type 或 rating 不合法' });
    if (!store.deck().cards.some((c) => c.id === event.id)) return json(404, { error: `找不到卡片 ${event.id}` });
    store.record(event);
    flushLater();
    announce();
    return json(201, event);
  }
  if (path === '/api/sync' && method === 'POST') {
    await flush();
    await recheck(0);
    return json(200, syncStatus());
  }
  const conflict = path.match(/^\/api\/conflicts\/([^/]+)$/);
  if (conflict && method === 'POST') {
    const { use, raw } = JSON.parse(body ?? '{}');
    store.resolve(decodeURIComponent(conflict[1]), use, raw);
    cardChanged();
    return json(204);
  }
  if (path === '/api/cards' && method === 'POST') {
    const { group, raw, before, after } = JSON.parse(body ?? '{}');
    const created = store.createCard(group, raw, { before, after });
    cardChanged();
    return json(201, created);
  }
  const card = path.match(/^\/api\/cards\/([^/]+)\/([^/]+)(\/schedule)?$/);
  if (!card) return json(403, { error: '手機版不能搬移卡片或改群組，請在電腦上做' });
  const [group, id] = [decodeURIComponent(card[1]), decodeURIComponent(card[2])];
  if (card[3] && method === 'PUT') {
    const { schedule } = JSON.parse(body ?? '{}');
    if (!isSchedule(schedule)) return json(400, { error: `schedule 不合法：${schedule}` });
    const saved = store.setSchedule(group, id, schedule);
    cardChanged();
    return json(200, saved);
  }
  if (card[3]) return json(405, { error: 'method not allowed' });
  if (method === 'PUT') {
    const { raw, version } = JSON.parse(body ?? '{}');
    const saved = store.saveCard(group, id, raw, version);
    cardChanged();
    return json(200, saved);
  }
  if (method === 'DELETE') {
    store.deleteCard(group, id);
    cardChanged();
    return json(204);
  }
  return json(405, { error: 'method not allowed' });
}

async function answer(path, method, body) {
  try {
    return await handle(path, method, body);
  } catch (err) {
    if (err.status === 401) {
      forgetSettings();
      return json(401, { error: 'GitHub token 失效了，請重新載入頁面再輸入一次' });
    }
    return json(err.status && err.status < 500 ? err.status : 502, { error: err.message ?? String(err) });
  }
}

// Card text keeps its asset paths, so an edit is written back as is; only what is shown points at the blobs.
function withAssetLinks(card) {
  const swap = (text) => text.replaceAll('](../assets/', '](noesis-asset:');
  return { ...card, sections: card.sections.map((s) => ({ ...s, body: swap(s.body) })) };
}

const imageUrls = new Map();

async function showAsset(img) {
  const name = decodeURIComponent(img.getAttribute('src').slice('noesis-asset:'.length));
  img.removeAttribute('src');
  const sha = store.blobSha(`decks/assets/${name}`);
  if (!sha) return;
  if (!imageUrls.has(sha)) {
    imageUrls.set(sha, cached(sha, () => gh.blob(sha)).then((bytes) => {
      const type = MIME[name.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
      return URL.createObjectURL(new Blob([bytes], { type }));
    }));
  }
  img.src = await imageUrls.get(sha);
}

function install() {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    return answer(url.pathname, (init.method ?? 'GET').toUpperCase(), init.body);
  };

  // There is no server to push changes, so the page looks again when it comes back to the foreground.
  window.EventSource = class {
    addEventListener(type, listener) {
      if (type === 'message') listeners.add(listener);
    }
    close() {}
  };

  document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? flush() : recheck()));
  addEventListener('pagehide', flush);
  addEventListener('hashchange', () => {
    if (!location.hash.includes('/practice')) flush();
  });

  new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        const imgs = node.matches('img[src^="noesis-asset:"]') ? [node] : node.querySelectorAll('img[src^="noesis-asset:"]');
        for (const img of imgs) showAsset(img).catch((err) => console.error(err));
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}
