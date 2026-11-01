import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/app.js';

async function makeDir(prefix, files) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

async function withServer(files, fn, progress = {}) {
  const deckDir = await makeDir('noesis-deck-', files);
  const progressDir = await makeDir('noesis-progress-', progress);
  const server = await startServer({ deckDir, progressDir, device: 'home' });
  try {
    await fn({ ...server, deckDir, progressDir });
  } finally {
    await server.close();
    await rm(deckDir, { recursive: true, force: true });
    await rm(progressDir, { recursive: true, force: true });
  }
}

async function getDeck(url) {
  const res = await fetch(`${url}/api/deck`);
  assert.equal(res.status, 200);
  return res.json();
}

function move(url, group, id, body) {
  return fetch(`${url}/api/cards/${encodeURIComponent(group)}/${encodeURIComponent(id)}/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function readMeta(deckDir, slug) {
  return JSON.parse(await readFile(path.join(deckDir, slug, '_group.json'), 'utf8'));
}

async function snapshot(root) {
  const out = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(root, full)] = await readFile(full, 'utf8');
  }
  return out;
}

const card = (created, q = 'Q') => `---\ncreated: ${created}\n---\n\n## Question\n\n${q}\r\n\n## Answer\n\nA  \n`;
const base = {
  'src/aaaaa.md': card('2026-01-01T00:00:00Z', '要搬的卡'),
  'src/bbbbb.md': card('2026-01-02T00:00:00Z'),
  'src/_group.json': { name: '來源', order: ['bbbbb', 'aaaaa'], note: 'keep' },
  'dst/ccccc.md': card('2026-01-03T00:00:00Z'),
  'dst/ddddd.md': card('2026-01-04T00:00:00Z'),
  'dst/_group.json': { name: '目標', order: ['ddddd', 'ccccc'], extra: 1 },
};

describe('move card to another group', () => {
  test('moves the file unchanged and updates both orders', async () => {
    await withServer(base, async ({ url, deckDir }) => {
      const res = await move(url, 'src', 'aaaaa', { to: 'dst' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { id: 'aaaaa', group: 'dst' });

      assert.equal(await readFile(path.join(deckDir, 'dst/aaaaa.md'), 'utf8'), base['src/aaaaa.md']);
      assert.deepEqual((await readdir(path.join(deckDir, 'src'))).toSorted(), ['_group.json', 'bbbbb.md']);
      assert.deepEqual(await readMeta(deckDir, 'src'), { name: '來源', order: ['bbbbb'], note: 'keep' });
      assert.deepEqual(await readMeta(deckDir, 'dst'), { name: '目標', order: ['ddddd', 'ccccc', 'aaaaa'], extra: 1 });

      const deck = await getDeck(url);
      const moved = deck.cards.find((c) => c.id === 'aaaaa');
      assert.equal(moved.group, 'dst');
      assert.equal(moved.created, '2026-01-01T00:00:00Z');
      assert.deepEqual(moved.errors, []);
      assert.deepEqual(deck.groups.find((g) => g.slug === 'dst').order, ['ddddd', 'ccccc', 'aaaaa']);
      assert.deepEqual(deck.groups.find((g) => g.slug === 'src').order, ['bbbbb']);
    });
  });

  test('lands last in a target without _group.json, and a source without one gets none', async () => {
    const files = {
      'src/aaaaa.md': card('2026-01-05T00:00:00Z'),
      'dst/ccccc.md': card('2026-01-03T00:00:00Z'),
      'dst/ddddd.md': card('2026-01-04T00:00:00Z'),
    };
    await withServer(files, async ({ url, deckDir }) => {
      assert.equal((await move(url, 'src', 'aaaaa', { to: 'dst' })).status, 200);
      assert.deepEqual(await readdir(path.join(deckDir, 'src')), []);
      assert.deepEqual(await readMeta(deckDir, 'dst'), { order: ['ccccc', 'ddddd', 'aaaaa'] });
      const deck = await getDeck(url);
      assert.deepEqual(deck.groups.find((g) => g.slug === 'dst').order, ['ccccc', 'ddddd', 'aaaaa']);
    });
  });

  test('lands after cards the target order does not list', async () => {
    const files = { ...base, 'dst/eeeee.md': card('2026-01-05T00:00:00Z') };
    await withServer(files, async ({ url, deckDir }) => {
      assert.equal((await move(url, 'src', 'aaaaa', { to: 'dst' })).status, 200);
      assert.deepEqual((await readMeta(deckDir, 'dst')).order, ['ddddd', 'ccccc', 'eeeee', 'aaaaa']);
    });
  });

  test('review progress stays valid before and after the move and logs are untouched', async () => {
    const log = `${JSON.stringify({ time: '2026-01-10T00:00:00Z', id: 'aaaaa', type: 'review', rating: 'good' })}\n`;
    await withServer(base, async ({ url, progressDir }) => {
      const events = async () => (await (await fetch(`${url}/api/progress`)).json()).events;
      assert.deepEqual((await events()).map((e) => e.id), ['aaaaa']);
      const before = await snapshot(progressDir);
      assert.equal((await move(url, 'src', 'aaaaa', { to: 'dst' })).status, 200);
      assert.deepEqual(await snapshot(progressDir), before);
      assert.deepEqual((await events()).map((e) => e.id), ['aaaaa']);
      const res = await fetch(`${url}/api/progress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'aaaaa', type: 'review', rating: 'easy' }),
      });
      assert.equal(res.status, 201);
      assert.deepEqual((await events()).map((e) => e.rating), ['good', 'easy']);
    }, { 'home.jsonl': log });
  });

  describe('rejections change nothing', () => {
    const cases = [
      ['target group does not exist', 'src', 'aaaaa', { to: 'nope' }, base, 404],
      ['target equals source', 'src', 'aaaaa', { to: 'src' }, base, 400],
      ['card does not exist', 'src', 'zzzzz', { to: 'dst' }, base, 404],
      ['card lives in another group', 'src', 'ccccc', { to: 'dst' }, base, 404],
      ['target already has a file with that name', 'src', 'aaaaa', { to: 'dst' }, { ...base, 'dst/aaaaa.md': 'other' }, 409],
      ['source _group.json is unparseable', 'src', 'aaaaa', { to: 'dst' }, { ...base, 'src/_group.json': '{ broken' }, 409],
      ['target _group.json is unparseable', 'src', 'aaaaa', { to: 'dst' }, { ...base, 'dst/_group.json': '{ broken' }, 409],
    ];
    for (const [name, group, id, body, files, status] of cases) {
      test(name, async () => {
        await withServer(files, async ({ url, deckDir }) => {
          const before = await snapshot(deckDir);
          const res = await move(url, group, id, body);
          assert.equal(res.status, status);
          assert.ok((await res.json()).error);
          assert.deepEqual(await snapshot(deckDir), before);
        });
      });
    }
  });

  test('invalid slugs, ids, bodies and paths are rejected and nothing is written', async () => {
    const outside = await makeDir('noesis-outside-', {});
    try {
      await withServer({ ...base, 'assets/x.png': 'x' }, async ({ url, deckDir }) => {
        const before = await snapshot(deckDir);
        const outsideRel = path.relative(deckDir, outside);
        const bad = [
          ['..', 'aaaaa', { to: 'dst' }],
          ['assets', 'aaaaa', { to: 'dst' }],
          ['A B', 'aaaaa', { to: 'dst' }],
          ['src', 'AAAAA', { to: 'dst' }],
          ['src', '../src/aaaaa', { to: 'dst' }],
          ['src', '_group', { to: 'dst' }],
          ['src', 'aaaaa', { to: '..' }],
          ['src', 'aaaaa', { to: '../dst' }],
          ['src', 'aaaaa', { to: outsideRel }],
          ['src', 'aaaaa', { to: 'assets' }],
          ['src', 'aaaaa', { to: '.hidden' }],
          ['src', 'aaaaa', {}],
          ['src', 'aaaaa', { to: 1 }],
          ['src', 'aaaaa', '{ not json'],
        ];
        for (const [group, id, body] of bad) {
          const res = await move(url, group, id, body);
          assert.ok(res.status >= 400 && res.status < 500, `${group}/${id} ${JSON.stringify(body)}: ${res.status}`);
        }
        assert.deepEqual(await snapshot(deckDir), before);
        assert.deepEqual(await readdir(outside), []);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('only POST is allowed', async () => {
    await withServer(base, async ({ url, deckDir }) => {
      const before = await snapshot(deckDir);
      const res = await fetch(`${url}/api/cards/src/aaaaa/move`, { method: 'PUT', body: '{"to":"dst"}' });
      assert.equal(res.status, 405);
      assert.deepEqual(await snapshot(deckDir), before);
    });
  });
});
