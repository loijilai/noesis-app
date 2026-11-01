import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/app.js';

const ORDER_FILE = '_groups.json';

async function withServer(files, fn) {
  const deckDir = await mkdtemp(path.join(tmpdir(), 'noesis-deck-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(deckDir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const server = await startServer({ deckDir });
  try {
    await fn({ ...server, deckDir });
  } finally {
    await server.close();
    await rm(deckDir, { recursive: true, force: true });
  }
}

async function getDeck(url) {
  const res = await fetch(`${url}/api/deck`);
  assert.equal(res.status, 200);
  return res.json();
}

const slugs = async (url) => (await getDeck(url)).groups.map((g) => g.slug);

function putOrder(url, body) {
  return fetch(`${url}/api/group-order`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const codeCard = `---\ncreated: 2026-01-01T00:00:00Z\n---\n\n## Question\n\nQ\n\n## Code\n\n\`\`\`cpp\nint x;\n\`\`\`\n`;
const groups = (...names) => Object.fromEntries(names.map((n, i) => [`${n}/a${String(i).padStart(4, '0')}.md`, codeCard]));

describe('group order reconciliation', () => {
  test('listed slugs come first, then unlisted by slug; missing slugs are skipped', async () => {
    await withServer({
      ...groups('alpha', 'beta', 'gamma', 'delta'),
      [ORDER_FILE]: { order: ['gamma', 'ghost', 'alpha'] },
    }, async ({ url }) => {
      assert.deepEqual(await slugs(url), ['gamma', 'alpha', 'beta', 'delta']);
    });
  });

  test('without an order file groups are sorted by slug', async () => {
    await withServer(groups('c', 'a', 'b'), async ({ url }) => {
      const deck = await getDeck(url);
      assert.deepEqual(deck.groups.map((g) => g.slug), ['a', 'b', 'c']);
      assert.deepEqual(deck.errors, []);
    });
  });

  test('the order file is not a group', async () => {
    await withServer({ ...groups('a'), [ORDER_FILE]: { order: ['a'] } }, async ({ url }) => {
      assert.deepEqual(await slugs(url), ['a']);
    });
  });

  test('unparseable order file is reported and falls back to slug order', async () => {
    await withServer({ ...groups('b', 'a'), [ORDER_FILE]: '{ not json' }, async ({ url }) => {
      const deck = await getDeck(url);
      assert.deepEqual(deck.groups.map((g) => g.slug), ['a', 'b']);
      assert.equal(deck.cards.length, 2);
      assert.ok(deck.errors.some((e) => e.includes(ORDER_FILE)), JSON.stringify(deck.errors));
    });
  });

  test('order file without an order array falls back to slug order', async () => {
    await withServer({ ...groups('b', 'a'), [ORDER_FILE]: { order: 'b' } }, async ({ url }) => {
      assert.deepEqual(await slugs(url), ['a', 'b']);
    });
  });

  test('duplicate slugs in the order file count once', async () => {
    await withServer({ ...groups('a', 'b', 'c'), [ORDER_FILE]: { order: ['c', 'a', 'c'] } }, async ({ url }) => {
      assert.deepEqual(await slugs(url), ['c', 'a', 'b']);
    });
  });
});

describe('write group order', () => {
  test('writes the submitted order verbatim and reads reflect it', async () => {
    await withServer(groups('a', 'b', 'c'), async ({ url, deckDir }) => {
      const res = await putOrder(url, { order: ['c', 'a', 'b'] });
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(await readFile(path.join(deckDir, ORDER_FILE), 'utf8')), { order: ['c', 'a', 'b'] });
      assert.deepEqual(await slugs(url), ['c', 'a', 'b']);
    });
  });

  test('does not reconcile on write: unknown and missing slugs are kept as sent', async () => {
    await withServer(groups('a', 'b', 'c'), async ({ url, deckDir }) => {
      assert.equal((await putOrder(url, { order: ['ghost', 'b'] })).status, 200);
      assert.deepEqual(JSON.parse(await readFile(path.join(deckDir, ORDER_FILE), 'utf8')), { order: ['ghost', 'b'] });
    });
  });

  test('after an incomplete or stale order every group is still returned', async () => {
    await withServer(groups('a', 'b', 'c', 'd'), async ({ url }) => {
      await putOrder(url, { order: ['ghost', 'c', 'old-one'] });
      const deck = await getDeck(url);
      assert.deepEqual(deck.groups.map((g) => g.slug), ['c', 'a', 'b', 'd']);
      assert.equal(deck.cards.length, 4);
    });
  });

  test('overwrites an unparseable order file', async () => {
    await withServer({ ...groups('a', 'b'), [ORDER_FILE]: '{ broken' }, async ({ url }) => {
      assert.equal((await putOrder(url, { order: ['b', 'a'] })).status, 200);
      const deck = await getDeck(url);
      assert.deepEqual(deck.groups.map((g) => g.slug), ['b', 'a']);
      assert.deepEqual(deck.errors, []);
    });
  });

  const invalid = {
    'non-JSON body': '{ nope',
    'missing order': {},
    'order is not an array': { order: 'a' },
    'non-string slug': { order: ['a', 3] },
    'invalid slug': { order: ['a', 'Bad Slug'] },
    'path traversal': { order: ['../a'] },
    'reserved name': { order: ['assets'] },
  };
  for (const [name, body] of Object.entries(invalid)) {
    test(`rejects ${name} and writes nothing`, async () => {
      await withServer(groups('a', 'b'), async ({ url, deckDir }) => {
        const before = await readdir(deckDir);
        const res = await putOrder(url, body);
        assert.equal(res.status, 400);
        assert.ok((await res.json()).error);
        assert.deepEqual(await readdir(deckDir), before);
      });
    });
  }

  test('rejects methods other than PUT', async () => {
    await withServer(groups('a'), async ({ url }) => {
      assert.equal((await fetch(`${url}/api/group-order`, { method: 'POST', body: '{}' })).status, 405);
    });
  });

  test('leaves no temporary files behind', async () => {
    await withServer(groups('a', 'b'), async ({ url, deckDir }) => {
      await putOrder(url, { order: ['b', 'a'] });
      assert.deepEqual((await readdir(deckDir)).toSorted(), [ORDER_FILE, 'a', 'b']);
    });
  });
});
