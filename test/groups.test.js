import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/app.js';

async function withServer(files, fn) {
  const deckDir = await mkdtemp(path.join(tmpdir(), 'noesis-deck-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(deckDir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    if (content !== null) await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const server = await startServer({ deckDir });
  try {
    await fn({ ...server, deckDir });
  } finally {
    await server.close();
    await rm(deckDir, { recursive: true, force: true });
  }
}

async function snapshot(dir) {
  const out = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const rel = path.relative(dir, path.join(entry.parentPath, entry.name));
    out[rel] = entry.isFile() ? await readFile(path.join(dir, rel), 'utf8') : '<dir>';
  }
  return out;
}

async function getDeck(url) {
  const res = await fetch(`${url}/api/deck`);
  assert.equal(res.status, 200);
  return res.json();
}

function send(method, url, body) {
  return fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const readMeta = async (deckDir, slug) => JSON.parse(await readFile(path.join(deckDir, slug, '_group.json'), 'utf8'));

const codeCard = `---\ncreated: 2026-01-01T00:00:00Z\n---\n\n## Question\n\nQ\n\n## Code\n\n\`\`\`cpp\nint x;\n\`\`\`\n`;

async function assertRejected(res, status) {
  assert.equal(res.status, status);
  assert.ok((await res.json()).error);
}

describe('create group', () => {
  test('creates the folder and _group.json, and the group appears last', async () => {
    await withServer({ 'b/aaaaa.md': codeCard, 'z/bbbbb.md': codeCard, '_groups.json': { order: ['z', 'b'] } }, async ({ url, deckDir }) => {
      const res = await send('POST', `${url}/api/groups`, { slug: 'a-new_1', name: '圖論' });
      assert.equal(res.status, 201);
      assert.deepEqual(await res.json(), { slug: 'a-new_1', name: '圖論' });
      assert.deepEqual(await readMeta(deckDir, 'a-new_1'), { name: '圖論', order: [] });
      assert.deepEqual(await readdir(path.join(deckDir, 'a-new_1')), ['_group.json']);
      assert.deepEqual(JSON.parse(await readFile(path.join(deckDir, '_groups.json'), 'utf8')), { order: ['z', 'b', 'a-new_1'] });
      const deck = await getDeck(url);
      assert.deepEqual(deck.groups.map((g) => g.slug), ['z', 'b', 'a-new_1']);
      assert.equal(deck.groups.at(-1).name, '圖論');
    });
  });

  test('writes the group order even when there was none, so the new group stays last', async () => {
    await withServer({ 'b/aaaaa.md': codeCard }, async ({ url, deckDir }) => {
      assert.equal((await send('POST', `${url}/api/groups`, { slug: 'a', name: 'A' })).status, 201);
      assert.deepEqual(JSON.parse(await readFile(path.join(deckDir, '_groups.json'), 'utf8')), { order: ['b', 'a'] });
      assert.deepEqual((await getDeck(url)).groups.map((g) => g.slug), ['b', 'a']);
    });
  });

  test('an unreadable group order file is refused and left alone', async () => {
    await withServer({ 'b/aaaaa.md': codeCard, '_groups.json': '{ nope' }, async ({ url, deckDir }) => {
      assert.equal((await send('POST', `${url}/api/groups`, { slug: 'a', name: 'A' })).status, 409);
      assert.equal(await readFile(path.join(deckDir, '_groups.json'), 'utf8'), '{ nope');
      assert.deepEqual((await readdir(deckDir)).toSorted(), ['_groups.json', 'b']);
    });
  });

  const invalid = {
    'non-JSON body': ['{ nope', 400],
    'missing slug': [{ name: 'X' }, 400],
    'non-string slug': [{ slug: 3, name: 'X' }, 400],
    'uppercase slug': [{ slug: 'Graph', name: 'X' }, 400],
    'slug starting with -': [{ slug: '-graph', name: 'X' }, 400],
    'slug with spaces': [{ slug: 'my graph', name: 'X' }, 400],
    'path traversal': [{ slug: '../evil', name: 'X' }, 400],
    'nested path': [{ slug: 'a/b', name: 'X' }, 400],
    'reserved name': [{ slug: 'assets', name: 'X' }, 400],
    'missing name': [{ slug: 'graph' }, 400],
    'blank name': [{ slug: 'graph', name: '   ' }, 400],
    'non-string name': [{ slug: 'graph', name: 5 }, 400],
    'duplicate slug': [{ slug: 'a', name: 'X' }, 409],
  };
  for (const [name, [body, status]] of Object.entries(invalid)) {
    test(`rejects ${name} and creates nothing`, async () => {
      await withServer({ 'a/aaaaa.md': codeCard, 'a/_group.json': { name: 'A', order: ['aaaaa'] } }, async ({ url, deckDir }) => {
        const before = await snapshot(deckDir);
        await assertRejected(await send('POST', `${url}/api/groups`, body), status);
        assert.deepEqual(await snapshot(deckDir), before);
      });
    });
  }

  test('rejects a slug taken by a top-level file', async () => {
    await withServer({ 'a/aaaaa.md': codeCard, 'notes': 'x' }, async ({ url, deckDir }) => {
      const before = await snapshot(deckDir);
      await assertRejected(await send('POST', `${url}/api/groups`, { slug: 'notes', name: 'N' }), 409);
      assert.deepEqual(await snapshot(deckDir), before);
    });
  });
});

describe('rename group', () => {
  test('replaces only name, keeping order and the folder', async () => {
    await withServer({ 'g/aaaaa.md': codeCard, 'g/_group.json': { name: 'Old', order: ['aaaaa'], extra: 1 } }, async ({ url, deckDir }) => {
      const res = await send('PUT', `${url}/api/groups/g`, { name: '新名稱' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { slug: 'g', name: '新名稱' });
      assert.deepEqual(await readMeta(deckDir, 'g'), { name: '新名稱', order: ['aaaaa'], extra: 1 });
      assert.deepEqual((await readdir(path.join(deckDir, 'g'))).toSorted(), ['_group.json', 'aaaaa.md']);
      const deck = await getDeck(url);
      assert.equal(deck.groups[0].slug, 'g');
      assert.equal(deck.groups[0].name, '新名稱');
    });
  });

  test('creates _group.json when missing', async () => {
    await withServer({ 'g/aaaaa.md': codeCard }, async ({ url, deckDir }) => {
      assert.equal((await send('PUT', `${url}/api/groups/g`, { name: 'G' })).status, 200);
      assert.deepEqual(await readMeta(deckDir, 'g'), { name: 'G' });
    });
  });

  const invalid = {
    'unknown group': ['ghost', { name: 'X' }, 404],
    'blank name': ['g', { name: ' ' }, 400],
    'missing name': ['g', {}, 400],
    'invalid slug': ['Bad%20Slug', { name: 'X' }, 400],
    'path traversal': ['..%2Fg', { name: 'X' }, 400],
    'reserved name': ['assets', { name: 'X' }, 400],
  };
  for (const [name, [slug, body, status]] of Object.entries(invalid)) {
    test(`rejects ${name} and writes nothing`, async () => {
      await withServer({ 'g/aaaaa.md': codeCard, 'g/_group.json': { name: 'G', order: [] }, 'assets/x.png': 'x' }, async ({ url, deckDir }) => {
        const before = await snapshot(deckDir);
        await assertRejected(await send('PUT', `${url}/api/groups/${slug}`, body), status);
        assert.deepEqual(await snapshot(deckDir), before);
      });
    });
  }
});

describe('delete group', () => {
  test('removes an empty group with its _group.json and folder', async () => {
    await withServer({ 'a/aaaaa.md': codeCard, 'e/_group.json': { name: 'E', order: [] } }, async ({ url, deckDir }) => {
      const res = await send('DELETE', `${url}/api/groups/e`);
      assert.equal(res.status, 204);
      assert.deepEqual(await readdir(deckDir), ['a']);
      assert.deepEqual((await getDeck(url)).groups.map((g) => g.slug), ['a']);
    });
  });

  test('drops the slug from the group order', async () => {
    await withServer({ 'a/aaaaa.md': codeCard, 'e/_group.json': { name: 'E', order: [] }, '_groups.json': { order: ['e', 'a'] } }, async ({ url, deckDir }) => {
      assert.equal((await send('DELETE', `${url}/api/groups/e`)).status, 204);
      assert.deepEqual(JSON.parse(await readFile(path.join(deckDir, '_groups.json'), 'utf8')), { order: ['a'] });
    });
  });

  test('removes an empty folder without _group.json', async () => {
    await withServer({ 'a/aaaaa.md': codeCard, 'e/_': null }, async ({ url, deckDir }) => {
      assert.equal((await send('DELETE', `${url}/api/groups/e`)).status, 204);
      assert.deepEqual(await readdir(deckDir), ['a']);
    });
  });

  test('rejects a group with cards as a conflict and deletes nothing', async () => {
    await withServer({ 'g/aaaaa.md': codeCard, 'g/_group.json': { name: 'G', order: ['aaaaa'] } }, async ({ url, deckDir }) => {
      const before = await snapshot(deckDir);
      await assertRejected(await send('DELETE', `${url}/api/groups/g`), 409);
      assert.deepEqual(await snapshot(deckDir), before);
    });
  });

  test('rejects a group with a malformed card', async () => {
    await withServer({ 'g/BAD.md': 'nope' }, async ({ url, deckDir }) => {
      const before = await snapshot(deckDir);
      await assertRejected(await send('DELETE', `${url}/api/groups/g`), 409);
      assert.deepEqual(await snapshot(deckDir), before);
    });
  });

  test('rejects a group holding other files', async () => {
    await withServer({ 'g/_group.json': { name: 'G' }, 'g/notes.txt': 'keep me' }, async ({ url, deckDir }) => {
      const before = await snapshot(deckDir);
      await assertRejected(await send('DELETE', `${url}/api/groups/g`), 409);
      assert.deepEqual(await snapshot(deckDir), before);
    });
  });

  const invalid = {
    'unknown group': ['ghost', 404],
    'invalid slug': ['Bad%20Slug', 400],
    'path traversal': ['..%2Fg', 400],
    'reserved name': ['assets', 400],
  };
  for (const [name, [slug, status]] of Object.entries(invalid)) {
    test(`rejects ${name} and deletes nothing`, async () => {
      await withServer({ 'g/_group.json': { name: 'G' }, 'assets/x.png': 'x' }, async ({ url, deckDir }) => {
        const before = await snapshot(deckDir);
        await assertRejected(await send('DELETE', `${url}/api/groups/${slug}`), status);
        assert.deepEqual(await snapshot(deckDir), before);
      });
    });
  }
});
