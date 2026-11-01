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

function send(url, method, pathname, body) {
  return fetch(`${url}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const codeCard = (q = 'Q') => `---\ncreated: 2026-01-01T00:00:00Z\n---\n\n## Question\n\n${q}\n\n## Code\n\n\`\`\`cpp\nint x;\n\`\`\`\n`;
const template = '## Question\n\n新題目\n\n## Answer\n\n\n\n## Notes\n\n';

describe('create card', () => {
  test('writes a new card with a fresh valid id and created into the group folder', async () => {
    await withServer({ 'g/aaaaa.md': codeCard(), 'h/bbbbb.md': codeCard() }, async ({ url, deckDir }) => {
      const before = Date.now();
      const res = await send(url, 'POST', '/api/cards', { group: 'g', raw: template });
      assert.equal(res.status, 201);
      const created = await res.json();
      assert.match(created.id, /^[a-z0-9]{5}$/);
      assert.ok(!['aaaaa', 'bbbbb'].includes(created.id));
      assert.equal(created.group, 'g');

      const files = await readdir(path.join(deckDir, 'g'));
      assert.ok(files.includes(`${created.id}.md`));
      assert.deepEqual(await readdir(path.join(deckDir, 'h')), ['bbbbb.md']);

      const c = (await getDeck(url)).cards.find((x) => x.id === created.id);
      assert.equal(c.group, 'g');
      assert.deepEqual(c.errors, []);
      assert.equal(c.kind, 'answer');
      assert.equal(c.sections[0].body, '新題目');
      const t = Date.parse(c.created);
      assert.ok(t >= before - 1000 && t <= Date.now() + 1000, c.created);
      assert.equal(c.version, created.version);
    });
  });

  test('ids are unique across many creations', async () => {
    await withServer({ 'g/aaaaa.md': codeCard() }, async ({ url }) => {
      const ids = new Set(['aaaaa']);
      for (let i = 0; i < 20; i++) {
        const res = await send(url, 'POST', '/api/cards', { group: 'g', raw: template });
        assert.equal(res.status, 201);
        ids.add((await res.json()).id);
      }
      assert.equal(ids.size, 21);
      const deck = await getDeck(url);
      assert.equal(deck.cards.length, 21);
      assert.ok(deck.cards.every((c) => c.errors.length === 0));
    });
  });

  test('unknown group is rejected', async () => {
    await withServer({ 'g/aaaaa.md': codeCard() }, async ({ url, deckDir }) => {
      const res = await send(url, 'POST', '/api/cards', { group: 'nope', raw: template });
      assert.equal(res.status, 404);
      assert.deepEqual(await readdir(deckDir), ['g']);
    });
  });

  test('without a neighbour the new card is written last into the group order', async () => {
    const files = { 'g/aaaaa.md': codeCard(), 'g/bbbbb.md': codeCard() };
    await withServer(files, async ({ url, deckDir }) => {
      const created = await (await send(url, 'POST', '/api/cards', { group: 'g', raw: template })).json();
      const meta = JSON.parse(await readFile(path.join(deckDir, 'g/_group.json'), 'utf8'));
      assert.deepEqual(meta.order, ['aaaaa', 'bbbbb', created.id]);
    });
  });

  test('before and after place the new card next to a neighbour', async () => {
    const files = { 'g/aaaaa.md': codeCard(), 'g/bbbbb.md': codeCard(), 'g/_group.json': { name: 'G', order: ['bbbbb', 'aaaaa'] } };
    await withServer(files, async ({ url }) => {
      const first = await (await send(url, 'POST', '/api/cards', { group: 'g', raw: template, before: 'bbbbb' })).json();
      const second = await (await send(url, 'POST', '/api/cards', { group: 'g', raw: template, after: 'bbbbb' })).json();
      const order = (await getDeck(url)).groups.find((g) => g.slug === 'g').order;
      assert.deepEqual(order, [first.id, 'bbbbb', second.id, 'aaaaa']);
    });
  });

  test('cards missing from the stored order keep their place ahead of the new one', async () => {
    const files = { 'g/aaaaa.md': codeCard(), 'g/bbbbb.md': codeCard(), 'g/ccccc.md': codeCard(), 'g/_group.json': { name: 'G', order: ['bbbbb'] } };
    await withServer(files, async ({ url }) => {
      const created = await (await send(url, 'POST', '/api/cards', { group: 'g', raw: template, after: 'aaaaa' })).json();
      const order = (await getDeck(url)).groups.find((g) => g.slug === 'g').order;
      assert.deepEqual(order, ['bbbbb', 'aaaaa', created.id, 'ccccc']);
    });
  });

  test('a neighbour outside the group or both before and after are rejected without writing', async () => {
    const files = { 'g/aaaaa.md': codeCard(), 'h/bbbbb.md': codeCard() };
    await withServer(files, async ({ url, deckDir }) => {
      assert.equal((await send(url, 'POST', '/api/cards', { group: 'g', raw: template, after: 'bbbbb' })).status, 404);
      assert.equal((await send(url, 'POST', '/api/cards', { group: 'g', raw: template, before: 'aaaaa', after: 'aaaaa' })).status, 400);
      assert.deepEqual(await readdir(path.join(deckDir, 'g')), ['aaaaa.md']);
    });
  });
});

describe('update card', () => {
  test('writes when the version matches', async () => {
    await withServer({ 'g/aaaaa.md': codeCard() }, async ({ url, deckDir }) => {
      const { version } = (await getDeck(url)).cards[0];
      const raw = codeCard('改過的題目');
      const res = await send(url, 'PUT', '/api/cards/g/aaaaa', { raw, version });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(await readFile(path.join(deckDir, 'g/aaaaa.md'), 'utf8'), raw);
      const c = (await getDeck(url)).cards[0];
      assert.equal(c.sections[0].body, '改過的題目');
      assert.equal(body.version, c.version);
      assert.notEqual(c.version, version);
    });
  });

  test('version mismatch returns conflict and leaves the file unchanged', async () => {
    await withServer({ 'g/aaaaa.md': codeCard() }, async ({ url, deckDir }) => {
      const { version } = (await getDeck(url)).cards[0];
      const file = path.join(deckDir, 'g/aaaaa.md');
      const external = codeCard('agent 剛改的');
      await writeFile(file, external);

      const res = await send(url, 'PUT', '/api/cards/g/aaaaa', { raw: codeCard('我的修改'), version });
      assert.equal(res.status, 409);
      assert.equal(await readFile(file, 'utf8'), external);
    });
  });

  test('updating a missing card returns not found and creates nothing', async () => {
    await withServer({ 'g/aaaaa.md': codeCard() }, async ({ url, deckDir }) => {
      const res = await send(url, 'PUT', '/api/cards/g/zzzzz', { raw: codeCard(), version: 'x' });
      assert.equal(res.status, 404);
      assert.deepEqual(await readdir(path.join(deckDir, 'g')), ['aaaaa.md']);
    });
  });
});

describe('card format', () => {
  test('a broken card is rejected on create and update and nothing is written', async () => {
    await withServer({ 'g/aaaaa.md': codeCard() }, async ({ url, deckDir }) => {
      const res = await send(url, 'POST', '/api/cards', { group: 'g', raw: '## Question\n\nQ\n' });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /必須有 Code 或 Answer/);
      assert.deepEqual(await readdir(path.join(deckDir, 'g')), ['aaaaa.md']);

      const { version } = (await getDeck(url)).cards[0];
      const broken = codeCard().replace('## Code', '## Answer\n\nA\n\n## Code');
      assert.equal((await send(url, 'PUT', '/api/cards/g/aaaaa', { raw: broken, version })).status, 400);
      assert.equal(await readFile(path.join(deckDir, 'g/aaaaa.md'), 'utf8'), codeCard());
    });
  });
});

describe('delete card', () => {
  test('removes only the card file; review logs stay', async () => {
    const progressDir = await makeDir('noesis-progress-', {
      'home.jsonl': '{"at":"2026-01-01T00:00:00Z","card":"aaaaa","type":"review","rating":"good"}\n',
    });
    try {
      await withServer({ 'g/aaaaa.md': codeCard(), 'g/bbbbb.md': codeCard() }, async ({ url, deckDir }) => {
        const res = await send(url, 'DELETE', '/api/cards/g/aaaaa');
        assert.equal(res.status, 204);
        assert.deepEqual(await readdir(path.join(deckDir, 'g')), ['bbbbb.md']);
        assert.deepEqual((await getDeck(url)).cards.map((c) => c.id), ['bbbbb']);
        assert.equal(
          await readFile(path.join(progressDir, 'home.jsonl'), 'utf8'),
          '{"at":"2026-01-01T00:00:00Z","card":"aaaaa","type":"review","rating":"good"}\n',
        );
      });
    } finally {
      await rm(progressDir, { recursive: true, force: true });
    }
  });

  test('deleting a missing card returns not found', async () => {
    await withServer({ 'g/aaaaa.md': codeCard() }, async ({ url }) => {
      assert.equal((await send(url, 'DELETE', '/api/cards/g/zzzzz')).status, 404);
    });
  });

  test('deleting a card drops its id from the group order', async () => {
    const files = {
      'g/aaaaa.md': codeCard(),
      'g/bbbbb.md': codeCard(),
      'g/_group.json': { name: 'G', order: ['aaaaa', 'bbbbb'] },
    };
    await withServer(files, async ({ url, deckDir }) => {
      assert.equal((await send(url, 'DELETE', '/api/cards/g/aaaaa')).status, 204);
      const meta = JSON.parse(await readFile(path.join(deckDir, 'g/_group.json'), 'utf8'));
      assert.deepEqual(meta, { name: 'G', order: ['bbbbb'] });
    });
  });

  test('deleting a card does not create a group meta file', async () => {
    await withServer({ 'g/aaaaa.md': codeCard(), 'g/bbbbb.md': codeCard() }, async ({ url, deckDir }) => {
      assert.equal((await send(url, 'DELETE', '/api/cards/g/aaaaa')).status, 204);
      assert.deepEqual(await readdir(path.join(deckDir, 'g')), ['bbbbb.md']);
    });
  });
});

describe('write path safety', () => {
  const badSlugs = ['..', '.hidden', 'assets', 'a/b', 'A B', '../g', ''];
  const badIds = ['..', '../g/aaaaa', 'AAAAA', 'aaaa', 'aaaaaa', 'aa.aa', '_group'];

  test('invalid group slugs are rejected on create', async () => {
    await withServer({ 'g/aaaaa.md': codeCard(), 'assets/x.png': 'x' }, async ({ url, deckDir }) => {
      for (const group of badSlugs) {
        const res = await send(url, 'POST', '/api/cards', { group, raw: template });
        assert.equal(res.status, 400, group);
      }
      assert.deepEqual((await readdir(deckDir)).toSorted(), ['assets', 'g']);
      assert.deepEqual(await readdir(path.join(deckDir, 'assets')), ['x.png']);
    });
  });

  test('invalid ids and slugs are rejected on update and delete', async () => {
    const outside = await makeDir('noesis-outside-', { 'aaaaa.md': codeCard() });
    try {
      await withServer({ 'g/aaaaa.md': codeCard() }, async ({ url, deckDir }) => {
        const cases = [
          ...badIds.map((id) => `/api/cards/g/${encodeURIComponent(id)}`),
          ...badSlugs.filter(Boolean).map((slug) => `/api/cards/${encodeURIComponent(slug)}/aaaaa`),
          `/api/cards/${encodeURIComponent(path.relative(deckDir, outside))}/aaaaa`,
        ];
        for (const p of cases) {
          const put = await send(url, 'PUT', p, { raw: 'x', version: 'x' });
          assert.ok(put.status >= 400 && put.status < 500, `PUT ${p}: ${put.status}`);
          const del = await send(url, 'DELETE', p);
          assert.ok(del.status >= 400 && del.status < 500, `DELETE ${p}: ${del.status}`);
        }
        assert.equal(await readFile(path.join(deckDir, 'g/aaaaa.md'), 'utf8'), codeCard());
        assert.equal(await readFile(path.join(outside, 'aaaaa.md'), 'utf8'), codeCard());
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('malformed request body is rejected', async () => {
    await withServer({ 'g/aaaaa.md': codeCard() }, async ({ url, deckDir }) => {
      const res = await fetch(`${url}/api/cards`, { method: 'POST', body: '{ not json' });
      assert.equal(res.status, 400);
      assert.equal((await send(url, 'POST', '/api/cards', { group: 'g' })).status, 400);
      assert.equal((await send(url, 'PUT', '/api/cards/g/aaaaa', { raw: 'x' })).status, 400);
      assert.deepEqual(await readdir(path.join(deckDir, 'g')), ['aaaaa.md']);
    });
  });
});
