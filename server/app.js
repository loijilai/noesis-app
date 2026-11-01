import http from 'node:http';
import { existsSync, mkdirSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeck } from './deck.js';
import { ProgressError, appendEvent, readEvents, toEvent } from './progress.js';
import { dailyPractice } from './activity.js';
import { CardError, createCard, updateCard, deleteCard, setCardSchedule } from './cards.js';
import { moveCard } from './move-card.js';
import { writeCardOrder } from './group-meta.js';
import { writeGroupOrder, createGroup, renameGroup, deleteGroup } from './groups.js';
import { smartGroups } from './smart-groups.js';
import { cardSchedules } from './schedule.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const DEBOUNCE_MS = 100;

export function startServer({ deckDir, progressDir, device, now = () => new Date(), port = 0, host = '127.0.0.1' }) {
  // Created up front so the first rating on a fresh setup is watched too.
  if (progressDir) mkdirSync(progressDir, { recursive: true });
  const changes = watchDirs([deckDir, progressDir]);
  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, { deckDir, progressDir, device, now, changes });
    } catch (err) {
      if (err instanceof ProgressError || err instanceof CardError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      sendJson(res, 500, { error: String(err.message ?? err) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      resolve({
        url: `http://${host}:${actual}`,
        close: () => {
          changes.close();
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

// macOS reports one save as several events; coalesce them into one notification.
function watchDirs(dirs) {
  const clients = new Set();
  let timer = null;
  const notify = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const res of clients) res.write('data: changed\n\n');
    }, DEBOUNCE_MS);
  };
  const watchers = dirs.filter((dir) => dir && existsSync(dir)).map((dir) => watch(dir, { recursive: true }, notify));
  for (const watcher of watchers) watcher.on('error', (err) => console.error(err));
  return {
    subscribe(req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },
    close() {
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

async function route(req, res, { deckDir, progressDir, device, now, changes }) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/progress' && req.method === 'POST') {
    const event = toEvent(await readJson(req), now());
    if (!(await cardIds(deckDir)).has(event.id)) return sendJson(res, 404, { error: `找不到卡片 ${event.id}` });
    await appendEvent({ progressDir, device }, event);
    return sendJson(res, 201, event);
  }
  if (pathname === '/api/cards' || pathname.startsWith('/api/cards/')) return routeCards(req, res, pathname, deckDir);
  if (pathname === '/api/group-order') {
    if (req.method !== 'PUT') return sendJson(res, 405, { error: 'method not allowed' });
    return sendJson(res, 200, await writeGroupOrder(deckDir, (await readJson(req)).order));
  }
  if (pathname === '/api/groups' && req.method === 'POST') {
    const { slug, name } = await readJson(req);
    return sendJson(res, 201, await createGroup(deckDir, slug, name));
  }
  const group = pathname.match(/^\/api\/groups\/([^/]+)$/);
  if (group && req.method === 'PUT') {
    return sendJson(res, 200, await renameGroup(deckDir, decodeSegment(group[1]), (await readJson(req)).name));
  }
  if (group && req.method === 'DELETE') {
    await deleteGroup(deckDir, decodeSegment(group[1]));
    res.writeHead(204);
    return res.end();
  }
  const cardOrder = pathname.match(/^\/api\/groups\/([^/]+)\/order$/);
  if (cardOrder && req.method === 'PUT') {
    await writeCardOrder(deckDir, decodeSegment(cardOrder[1]), (await readJson(req)).order);
    res.writeHead(204);
    return res.end();
  }
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  if (pathname === '/api/deck') return sendJson(res, 200, await loadDeck(deckDir));
  if (pathname === '/api/events') return changes.subscribe(req, res);
  if (pathname === '/api/smart-groups') {
    const { deck, events } = await loadDeckAndEvents(deckDir, progressDir);
    return sendJson(res, 200, { groups: smartGroups(deck, events, now()) });
  }
  if (pathname === '/api/schedule') {
    const { deck, events } = await loadDeckAndEvents(deckDir, progressDir);
    return sendJson(res, 200, { cards: cardSchedules(deck, events, now()) });
  }
  if (pathname === '/api/activity') {
    return sendJson(res, 200, { days: progressDir ? dailyPractice(await readEvents(progressDir)) : {} });
  }
  if (pathname === '/api/progress') {
    return sendJson(res, 200, { events: progressDir ? await readEvents(progressDir, await cardIds(deckDir)) : [] });
  }
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
  if (pathname.startsWith('/assets/')) return serveFile(res, path.join(deckDir, 'assets') + path.sep, pathname.slice('/assets/'.length));
  return serveFile(res, PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
}

async function routeCards(req, res, pathname, deckDir) {
  let parts;
  try {
    parts = pathname.split('/').slice(3).map(decodeURIComponent);
  } catch {
    throw new CardError(400, '路徑不合法');
  }
  if (req.method === 'POST' && parts.length === 0) {
    const { group, raw, before, after } = await readJson(req);
    return sendJson(res, 201, await createCard(deckDir, group, raw, { before, after }));
  }
  if (parts.length === 3 && parts[2] === 'move') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    return sendJson(res, 200, await moveCard(deckDir, parts[0], parts[1], (await readJson(req)).to));
  }
  if (parts.length === 3 && parts[2] === 'schedule') {
    if (req.method !== 'PUT') return sendJson(res, 405, { error: 'method not allowed' });
    return sendJson(res, 200, await setCardSchedule(deckDir, parts[0], parts[1], (await readJson(req)).schedule));
  }
  if (parts.length !== 2) return sendJson(res, 404, { error: 'not found' });
  const [group, id] = parts;
  if (req.method === 'PUT') {
    const { raw, version } = await readJson(req);
    return sendJson(res, 200, await updateCard(deckDir, group, id, raw, version));
  }
  if (req.method === 'DELETE') {
    await deleteCard(deckDir, group, id);
    res.writeHead(204);
    return res.end();
  }
  return sendJson(res, 405, { error: 'method not allowed' });
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new CardError(400, '路徑不合法');
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data && typeof data === 'object') return data;
  } catch {}
  throw new CardError(400, 'request body 必須是 JSON 物件');
}

async function serveFile(res, dir, encodedRel) {
  const file = path.join(dir, decodeURIComponent(encodedRel));
  if (!file.startsWith(dir)) return sendJson(res, 404, { error: 'not found' });
  let body;
  try {
    body = await readFile(file);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(body);
}

async function loadDeckAndEvents(deckDir, progressDir) {
  const deck = await loadDeck(deckDir);
  const events = progressDir ? await readEvents(progressDir, new Set(deck.cards.map((c) => c.id))) : [];
  return { deck, events };
}

async function cardIds(deckDir) {
  return new Set((await loadDeck(deckDir)).cards.map((c) => c.id));
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
