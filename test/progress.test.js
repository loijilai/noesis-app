import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/app.js';

const CARD = '---\ncreated: 2026-01-01T00:00:00Z\n---\n\n## Question\n\nQ\n\n## Answer\n\nA\n';

async function makeDir(prefix, files) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

async function withServer({ deck = {}, progress = {}, device = 'home' }, fn) {
  const deckDir = await makeDir('noesis-deck-', deck);
  const progressDir = await makeDir('noesis-progress-', progress);
  const server = await startServer({ deckDir, progressDir, device });
  try {
    await fn({ ...server, deckDir, progressDir });
  } finally {
    await server.close();
    await rm(deckDir, { recursive: true, force: true });
    await rm(progressDir, { recursive: true, force: true });
  }
}

function post(url, body) {
  return fetch(`${url}/api/progress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function getEvents(url) {
  const res = await fetch(`${url}/api/progress`);
  assert.equal(res.status, 200);
  return (await res.json()).events;
}

function lines(text) {
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const jsonl = (...events) => events.map((e) => `${JSON.stringify(e)}\n`).join('');

async function snapshot(root) {
  const out = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(root, full)] = { content: await readFile(full, 'utf8'), mtimeMs: (await stat(full)).mtimeMs };
  }
  return out;
}

describe('appending review events', () => {
  test('appends one line to the local device file with time, id, type and rating only', async () => {
    await withServer({ deck: { 'g/aaaaa.md': CARD } }, async ({ url, progressDir }) => {
      const res = await post(url, { id: 'aaaaa', type: 'review', rating: 'good', input: 'my typed answer' });
      assert.equal(res.status, 201);
      const [event] = lines(await readFile(path.join(progressDir, 'home.jsonl'), 'utf8'));
      assert.deepEqual(Object.keys(event).sort(), ['id', 'rating', 'time', 'type']);
      assert.equal(event.id, 'aaaaa');
      assert.equal(event.type, 'review');
      assert.equal(event.rating, 'good');
      assert.match(event.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    });
  });

  test('only appends to the local device file and never touches other devices', async () => {
    const existing = jsonl({ time: '2026-01-01T00:00:00Z', id: 'aaaaa', type: 'review', rating: 'hard' });
    const other = jsonl({ time: '2026-01-02T00:00:00Z', id: 'aaaaa', type: 'review', rating: 'easy' });
    await withServer({
      deck: { 'g/aaaaa.md': CARD },
      progress: { 'home.jsonl': existing, 'work.jsonl': other },
    }, async ({ url, progressDir }) => {
      const before = await snapshot(progressDir);
      for (const rating of ['again', 'hard', 'good', 'easy']) {
        assert.equal((await post(url, { id: 'aaaaa', type: 'review', rating })).status, 201);
      }
      const after = await snapshot(progressDir);
      assert.deepEqual(after['work.jsonl'], before['work.jsonl']);
      assert.ok(after['home.jsonl'].content.startsWith(existing));
      assert.deepEqual(lines(after['home.jsonl'].content).map((e) => e.rating), ['hard', 'again', 'hard', 'good', 'easy']);
      assert.deepEqual(Object.keys(after).sort(), ['home.jsonl', 'work.jsonl']);
    });
  });

  test('creates the progress folder when it does not exist yet', async () => {
    await withServer({ deck: { 'g/aaaaa.md': CARD } }, async ({ url, progressDir }) => {
      await rm(progressDir, { recursive: true });
      assert.equal((await post(url, { id: 'aaaaa', type: 'review', rating: 'again' })).status, 201);
      assert.equal(lines(await readFile(path.join(progressDir, 'home.jsonl'), 'utf8')).length, 1);
    });
  });

  test('accepts the reserved reset event without a rating', async () => {
    await withServer({ deck: { 'g/aaaaa.md': CARD } }, async ({ url, progressDir }) => {
      assert.equal((await post(url, { id: 'aaaaa', type: 'reset', rating: 'good' })).status, 201);
      const [event] = lines(await readFile(path.join(progressDir, 'home.jsonl'), 'utf8'));
      assert.deepEqual(Object.keys(event).sort(), ['id', 'time', 'type']);
      assert.equal(event.type, 'reset');
    });
  });

  test('accepts a review without a rating as seeing the card', async () => {
    await withServer({ deck: { 'g/aaaaa.md': CARD } }, async ({ url, progressDir }) => {
      const res = await post(url, { id: 'aaaaa', type: 'review' });
      assert.equal(res.status, 201);
      const [event] = lines(await readFile(path.join(progressDir, 'home.jsonl'), 'utf8'));
      assert.deepEqual(Object.keys(event).sort(), ['id', 'time', 'type']);
      assert.equal(event.type, 'review');
    });
  });

  for (const type of ['suspend', 'unsuspend']) {
    test(`accepts a ${type} event with the same fields as reset`, async () => {
      await withServer({ deck: { 'g/aaaaa.md': CARD } }, async ({ url, progressDir }) => {
        const res = await post(url, { id: 'aaaaa', type, rating: 'good' });
        assert.equal(res.status, 201);
        const [event] = lines(await readFile(path.join(progressDir, 'home.jsonl'), 'utf8'));
        assert.deepEqual(Object.keys(event).sort(), ['id', 'time', 'type']);
        assert.equal(event.type, type);
        assert.deepEqual(await res.json(), event);
      });
    });
  }

  test('never writes progress into card files', async () => {
    await withServer({ deck: { 'g/aaaaa.md': CARD } }, async ({ url, deckDir }) => {
      const before = await snapshot(deckDir);
      await post(url, { id: 'aaaaa', type: 'review', rating: 'good' });
      await post(url, { id: 'aaaaa', type: 'reset' });
      await post(url, { id: 'aaaaa', type: 'suspend' });
      await post(url, { id: 'aaaaa', type: 'unsuspend' });
      assert.deepEqual(await snapshot(deckDir), before);
    });
  });

  test('rejects invalid events without writing', async () => {
    await withServer({ deck: { 'g/aaaaa.md': CARD } }, async ({ url, progressDir }) => {
      assert.equal((await post(url, { id: 'aaaaa', type: 'review', rating: 'meh' })).status, 400);
      assert.equal((await post(url, { id: 'aaaaa', type: 'practice' })).status, 400);
      assert.equal((await post(url, { id: 'aaaaa', type: 'delete' })).status, 400);
      assert.equal((await post(url, { id: 'aaaaa', type: 'Suspend' })).status, 400);
      assert.equal((await post(url, { id: '../x', type: 'suspend' })).status, 400);
      assert.equal((await post(url, { type: 'unsuspend' })).status, 400);
      assert.equal((await post(url, { id: 'zzzzz', type: 'suspend' })).status, 404);
      assert.equal((await post(url, { id: 'zzzzz', type: 'unsuspend' })).status, 404);
      assert.equal((await post(url, { id: '../x', type: 'review', rating: 'good' })).status, 400);
      assert.equal((await post(url, '{ not json')).status, 400);
      assert.equal((await post(url, { id: 'zzzzz', type: 'review', rating: 'good' })).status, 404);
      assert.deepEqual(await readdir(progressDir), []);
    });
  });

  test('explains the missing device name instead of writing', async () => {
    await withServer({ deck: { 'g/aaaaa.md': CARD }, device: null }, async ({ url, progressDir }) => {
      const res = await post(url, { id: 'aaaaa', type: 'review', rating: 'good' });
      assert.equal(res.status, 503);
      assert.match((await res.json()).error, /noesis\.config\.json/);
      assert.deepEqual(await readdir(progressDir), []);
    });
  });

  test('rejects an unsafe device name', async () => {
    await withServer({ deck: { 'g/aaaaa.md': CARD }, device: '../evil' }, async ({ url, progressDir }) => {
      assert.equal((await post(url, { id: 'aaaaa', type: 'review', rating: 'good' })).status, 503);
      assert.deepEqual(await readdir(progressDir), []);
      assert.deepEqual(await readdir(path.dirname(progressDir)).then((d) => d.filter((n) => n.startsWith('evil'))), []);
    });
  });
});

describe('reading progress', () => {
  test('merges events from every device file in time order', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': CARD, 'h/bbbbb.md': CARD },
      progress: {
        'home.jsonl': jsonl(
          { time: '2026-01-01T00:00:00Z', id: 'aaaaa', type: 'review', rating: 'again' },
          { time: '2026-01-03T00:00:00Z', id: 'bbbbb', type: 'review', rating: 'good' },
        ),
        'work.jsonl': jsonl(
          { time: '2026-01-02T00:00:00Z', id: 'aaaaa', type: 'review', rating: 'easy' },
          { time: '2026-01-04T00:00:00Z', id: 'aaaaa', type: 'reset' },
        ),
        'notes.txt': 'not a log',
      },
    }, async ({ url }) => {
      assert.deepEqual(await getEvents(url), [
        { time: '2026-01-01T00:00:00Z', id: 'aaaaa', type: 'review', rating: 'again', device: 'home' },
        { time: '2026-01-02T00:00:00Z', id: 'aaaaa', type: 'review', rating: 'easy', device: 'work' },
        { time: '2026-01-03T00:00:00Z', id: 'bbbbb', type: 'review', rating: 'good', device: 'home' },
        { time: '2026-01-04T00:00:00Z', id: 'aaaaa', type: 'reset', device: 'work' },
      ]);
    });
  });

  test('ignores events for missing cards but keeps them on disk', async () => {
    const log = jsonl(
      { time: '2026-01-01T00:00:00Z', id: 'gone1', type: 'review', rating: 'good' },
      { time: '2026-01-02T00:00:00Z', id: 'aaaaa', type: 'review', rating: 'hard' },
    );
    await withServer({ deck: { 'g/aaaaa.md': CARD }, progress: { 'work.jsonl': log } }, async ({ url, progressDir }) => {
      const before = await snapshot(progressDir);
      assert.deepEqual((await getEvents(url)).map((e) => e.id), ['aaaaa']);
      assert.deepEqual(await snapshot(progressDir), before);
    });
  });

  test('skips malformed lines', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': CARD },
      progress: { 'work.jsonl': `garbage\n${jsonl({ time: '2026-01-02T00:00:00Z', id: 'aaaaa', type: 'review', rating: 'hard' })}` },
    }, async ({ url }) => {
      assert.equal((await getEvents(url)).length, 1);
    });
  });

  test('missing progress folder means no events', async () => {
    await withServer({ deck: { 'g/aaaaa.md': CARD } }, async ({ url, progressDir }) => {
      await rm(progressDir, { recursive: true });
      assert.deepEqual(await getEvents(url), []);
    });
  });
});

describe('practice activity', () => {
  test('counts reviews with or without a rating per day, a day running from 4am, deleted cards included', async () => {
    const at = (day, hour) => new Date(2026, 0, day, hour).toISOString();
    await withServer({
      deck: { 'g/aaaaa.md': CARD },
      progress: {
        'home.jsonl': jsonl(
          { time: at(5, 10), id: 'aaaaa', type: 'review', rating: 'good' },
          { time: at(6, 3), id: 'gone1', type: 'review', rating: 'again' },
          { time: at(6, 4), id: 'aaaaa', type: 'review' },
          { time: at(6, 4), id: 'aaaaa', type: 'practice' },
          { time: at(6, 5), id: 'aaaaa', type: 'reset' },
          { time: at(6, 6), id: 'aaaaa', type: 'suspend' },
          { time: at(6, 7), id: 'aaaaa', type: 'review', rating: 'meh' },
        ),
        'work.jsonl': jsonl({ time: at(6, 9), id: 'aaaaa', type: 'review', rating: 'easy' }),
      },
    }, async ({ url }) => {
      const res = await fetch(`${url}/api/activity`);
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).days, { '2026-01-05': 2, '2026-01-06': 2 });
    });
  });
});
