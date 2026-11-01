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

async function withServer(files, fn) {
  const deckDir = await makeDir('noesis-deck-', files);
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

function putOrder(url, slug, body) {
  return fetch(`${url}/api/groups/${encodeURIComponent(slug)}/order`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function readMeta(deckDir, slug) {
  return JSON.parse(await readFile(path.join(deckDir, slug, '_group.json'), 'utf8'));
}

const codeCard = (created) => `---\ncreated: ${created}\n---\n\n## Question\n\nQ\n\n## Code\n\n\`\`\`cpp\nint x;\n\`\`\`\n`;
const threeCards = {
  'g/aaaaa.md': codeCard('2026-01-01T00:00:00Z'),
  'g/bbbbb.md': codeCard('2026-01-02T00:00:00Z'),
  'g/ccccc.md': codeCard('2026-01-03T00:00:00Z'),
};

describe('write card order', () => {
  test('writes the order verbatim and the deck follows it', async () => {
    await withServer(threeCards, async ({ url, deckDir }) => {
      const res = await putOrder(url, 'g', { order: ['ccccc', 'aaaaa', 'bbbbb'] });
      assert.equal(res.status, 204);
      assert.deepEqual(await readMeta(deckDir, 'g'), { order: ['ccccc', 'aaaaa', 'bbbbb'] });
      assert.deepEqual((await getDeck(url)).groups[0].order, ['ccccc', 'aaaaa', 'bbbbb']);
    });
  });

  test('keeps name and other fields of _group.json', async () => {
    const meta = { name: '演算法', order: ['aaaaa', 'bbbbb', 'ccccc'], note: 'keep me' };
    await withServer({ ...threeCards, 'g/_group.json': meta }, async ({ url, deckDir }) => {
      const res = await putOrder(url, 'g', { order: ['bbbbb', 'ccccc', 'aaaaa'] });
      assert.equal(res.status, 204);
      assert.deepEqual(await readMeta(deckDir, 'g'), { ...meta, order: ['bbbbb', 'ccccc', 'aaaaa'] });
      const group = (await getDeck(url)).groups[0];
      assert.equal(group.name, '演算法');
      assert.deepEqual(group.order, ['bbbbb', 'ccccc', 'aaaaa']);
    });
  });

  test('an incomplete order or one with deleted ids loses no cards', async () => {
    await withServer(threeCards, async ({ url, deckDir }) => {
      const order = ['zzzzz', 'ccccc', 'yyyyy'];
      assert.equal((await putOrder(url, 'g', { order })).status, 204);
      assert.deepEqual((await readMeta(deckDir, 'g')).order, order);
      const deck = await getDeck(url);
      assert.deepEqual(deck.groups[0].order, ['ccccc', 'aaaaa', 'bbbbb']);
      assert.equal(deck.cards.length, 3);
    });
  });

  test('an empty order is written as is', async () => {
    await withServer({ ...threeCards, 'g/_group.json': { name: 'G', order: ['ccccc'] } }, async ({ url, deckDir }) => {
      assert.equal((await putOrder(url, 'g', { order: [] })).status, 204);
      assert.deepEqual(await readMeta(deckDir, 'g'), { name: 'G', order: [] });
      assert.deepEqual((await getDeck(url)).groups[0].order, ['aaaaa', 'bbbbb', 'ccccc']);
    });
  });

  test('unknown group is rejected and nothing is created', async () => {
    await withServer(threeCards, async ({ url, deckDir }) => {
      assert.equal((await putOrder(url, 'nope', { order: ['aaaaa'] })).status, 404);
      assert.deepEqual(await readdir(deckDir), ['g']);
    });
  });

  test('unparseable _group.json is not overwritten', async () => {
    await withServer({ ...threeCards, 'g/_group.json': '{ broken' }, async ({ url, deckDir }) => {
      assert.equal((await putOrder(url, 'g', { order: ['aaaaa'] })).status, 409);
      assert.equal(await readFile(path.join(deckDir, 'g/_group.json'), 'utf8'), '{ broken');
    });
  });

  test('invalid slugs, ids and bodies are rejected and nothing is written', async () => {
    const outside = await makeDir('noesis-outside-', { 'aaaaa.md': codeCard('2026-01-01T00:00:00Z') });
    try {
      await withServer({ ...threeCards, 'assets/x.png': 'x' }, async ({ url, deckDir }) => {
        const badSlugs = ['..', '.hidden', 'assets', 'A B', path.relative(deckDir, outside)];
        for (const slug of badSlugs) {
          const res = await putOrder(url, slug, { order: ['aaaaa'] });
          assert.ok(res.status >= 400 && res.status < 500, `${slug}: ${res.status}`);
        }
        const badBodies = [
          '{ not json',
          {},
          { order: 'aaaaa' },
          { order: [1] },
          { order: ['../g/aaaaa'] },
          { order: ['AAAAA'] },
          { order: ['_group'] },
        ];
        for (const body of badBodies) {
          assert.equal((await putOrder(url, 'g', body)).status, 400, JSON.stringify(body));
        }
        assert.deepEqual((await readdir(path.join(deckDir, 'g'))).toSorted(), ['aaaaa.md', 'bbbbb.md', 'ccccc.md']);
        assert.deepEqual(await readdir(path.join(deckDir, 'assets')), ['x.png']);
        assert.deepEqual(await readdir(outside), ['aaaaa.md']);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
