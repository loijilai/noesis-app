// Stands in for server/app.js inside the Artifact: the deck is a snapshot, progress and card edits go to the Artifact's db.
import { cardSchedules } from '../server/schedule.js';
import { smartGroups } from '../server/smart-groups.js';
import { dailyPractice } from '../server/activity.js';
import { mergeEvents, toEvent } from './events.js';
import { editedCard, newEdit, withImages } from './cards.js';
import { isSchedule, parseCard, withSchedule } from '../server/card-text.js';

const { deck: snapshot, events: snapshotEvents, images } = JSON.parse(document.getElementById('noesis-data').textContent);
const ids = new Set(snapshot.cards.map((c) => c.id));
const edits = new Map();
// Versions before the db kept ratings in localStorage; they are moved into the db on the first load that has one.
const LEGACY_KEY = 'noesis-phone-events';
// One document per page load: an unbounded log must not be one document per event, and two open pages never overwrite each other.
const docId = `${localDate(new Date())}_${Math.random().toString(36).slice(2, 10)}`;
const pageEvents = [];
let storedEvents = [];
let writing = Promise.resolve();

const store = openStore().catch((err) => {
  console.error(err);
  return null;
});

async function openStore() {
  const db = (await window.claude?.use('db')) ?? null;
  if (!db) return null;
  const snap = await db.collection('events').get();
  storedEvents = snap.docs.flatMap((d) => d.data()?.events ?? []);
  for (const doc of (await db.collection('edits').get()).docs) {
    const edit = doc.data();
    if (typeof edit?.id === 'string' && typeof edit.raw === 'string') edits.set(edit.id, edit);
  }
  const legacy = readLegacy();
  if (legacy.length) {
    pageEvents.push(...legacy);
    await save(db);
    localStorage.removeItem(LEGACY_KEY);
  }
  return db;
}

function readLegacy() {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function save(db) {
  writing = writing.catch(() => {}).then(() => db.collection('events').doc(docId).set({ events: [...pageEvents] }));
  return writing;
}

function deck() {
  return { ...snapshot, cards: snapshot.cards.map((c) => editedCard(c, edits.get(c.id))) };
}

function events() {
  return allEvents().filter((e) => ids.has(e.id));
}

function allEvents() {
  return mergeEvents(snapshotEvents, storedEvents, pageEvents);
}

function json(status, data) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

async function handle(path, method, body) {
  const db = await store;
  const now = new Date();
  if (method === 'GET') {
    // Tells the page to hide what only the desktop can do: which cards there are, and where, is fixed by the snapshot.
    if (path === '/api/deck') {
      const current = deck();
      return json(200, { ...current, cards: current.cards.map((c) => withImages(c, images)), readOnly: true });
    }
    if (path === '/api/schedule') return json(200, { cards: cardSchedules(deck(), events(), now) });
    if (path === '/api/smart-groups') return json(200, { groups: smartGroups(deck(), events(), now) });
    if (path === '/api/progress') return json(200, { events: events() });
    if (path === '/api/activity') return json(200, { days: dailyPractice(allEvents()) });
    return json(404, { error: 'not found' });
  }
  const cardPath = path.match(/^\/api\/cards\/([^/]+)\/([^/]+)$/);
  if (cardPath && method === 'PUT') return saveEdit(db, decodeURIComponent(cardPath[1]), decodeURIComponent(cardPath[2]), JSON.parse(body ?? '{}'), now);
  const schedulePath = path.match(/^\/api\/cards\/([^/]+)\/([^/]+)\/schedule$/);
  if (schedulePath && method === 'PUT') return saveSchedule(db, decodeURIComponent(schedulePath[1]), decodeURIComponent(schedulePath[2]), JSON.parse(body ?? '{}').schedule, now);
  if (path !== '/api/progress' || method !== 'POST') return json(403, { error: '手機版只能練習和修改卡片內容，新增、刪除、搬移請在電腦上做' });
  const event = toEvent(JSON.parse(body ?? '{}'), now);
  if (!event) return json(400, { error: 'id、type 或 rating 不合法' });
  if (!ids.has(event.id)) return json(404, { error: `找不到卡片 ${event.id}` });
  if (!db) return json(503, { error: '沒有存到：請登入 claude.ai，從 Artifact 連結打開這個頁面' });
  pageEvents.push(event);
  try {
    await save(db);
  } catch (err) {
    pageEvents.splice(pageEvents.indexOf(event), 1);
    return json(503, { error: `沒有存到：${err?.message ?? err}` });
  }
  return json(201, event);
}

async function saveEdit(db, group, id, { raw, version }, now) {
  const card = snapshot.cards.find((c) => c.id === id && c.group === group);
  if (!card) return json(404, { error: `找不到卡片 ${group}/${id}` });
  if (typeof raw !== 'string') return json(400, { error: '缺少 raw' });
  const { errors } = parseCard(raw);
  if (errors.length) return json(400, { error: `卡片格式錯誤：${errors.join('；')}` });
  if (version !== editedCard(card, edits.get(id)).version) return json(409, { error: '卡片已被其他分頁修改，請重新載入後再編輯' });
  if (!db) return json(503, { error: '沒有存到：請登入 claude.ai，從 Artifact 連結打開這個頁面' });
  const edit = newEdit(card, raw, now);
  try {
    await db.collection('edits').doc(id).set(edit);
  } catch (err) {
    return json(503, { error: `沒有存到：${err?.message ?? err}` });
  }
  edits.set(id, edit);
  return json(200, { id, group, version: edit.time });
}

// Saved as an edit of the card's text, so it reaches the desktop the way any other phone edit does.
function saveSchedule(db, group, id, schedule, now) {
  const card = deck().cards.find((c) => c.id === id && c.group === group);
  if (!card) return json(404, { error: `找不到卡片 ${group}/${id}` });
  if (!isSchedule(schedule)) return json(400, { error: `schedule 不合法：${schedule}` });
  return saveEdit(db, group, id, { raw: withSchedule(card.raw, schedule), version: card.version }, now);
}

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const realFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  return handle(url.pathname, (init.method ?? 'GET').toUpperCase(), init.body);
};

// Cards cannot change underneath the snapshot, so there is nothing to listen for.
window.EventSource = class {
  addEventListener() {}
  close() {}
};
