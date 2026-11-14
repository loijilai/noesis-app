import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/app.js';

async function makeDeck(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'noesis-deck-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

async function withServer(files, fn) {
  const deckDir = await makeDeck(files);
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

function card(deck, id, group) {
  const found = deck.cards.filter((c) => c.id === id && (!group || c.group === group));
  assert.equal(found.length, 1, `expected exactly one card ${id}`);
  return found[0];
}

function md({ created = '2026-01-01T00:00:00Z', body }) {
  return `---\ncreated: ${created}\n---\n\n${body}`;
}

const codeCard = (created) => md({ created, body: '## Question\n\nQ\n\n## Code\n\n```cpp\nint x;\n```\n' });

describe('card parsing', () => {
  test('parses id, group, created, sections, raw and version', async () => {
    const raw = md({
      created: '2026-03-04T05:06:07Z',
      body: [
        '## Question', '', '寫出 swap', '',
        '## Code', '', '```cpp', 'void swap(int& a, int& b);', '```', '',
        '## Code', '', '```cpp', 'std::swap(a, b);', '```', '',
        '## Notes', '', '### 陷阱', '', '小心 alias', '',
        '## Mnemonic', '', '自訂段落', '',
      ].join('\n'),
    });
    await withServer({ 'cpp/abc12.md': raw }, async ({ url }) => {
      const c = card(await getDeck(url), 'abc12');
      assert.equal(c.group, 'cpp');
      assert.equal(c.created, '2026-03-04T05:06:07Z');
      assert.equal(c.raw, raw);
      assert.equal(typeof c.version, 'string');
      assert.ok(c.version.length > 0);
      assert.deepEqual(c.errors, []);
      assert.equal(c.kind, 'code');
      assert.deepEqual(c.sections, [
        { name: 'Question', body: '寫出 swap' },
        { name: 'Code', body: '```cpp\nvoid swap(int& a, int& b);\n```' },
        { name: 'Code', body: '```cpp\nstd::swap(a, b);\n```' },
        { name: 'Notes', body: '### 陷阱\n\n小心 alias' },
        { name: 'Mnemonic', body: '自訂段落' },
      ]);
    });
  });

  test('Answer card is kind answer', async () => {
    const raw = md({ body: '## Question\n\nQ\n\n## Answer\n\nA\n' });
    await withServer({ 'concepts/ans01.md': raw }, async ({ url }) => {
      const c = card(await getDeck(url), 'ans01');
      assert.equal(c.kind, 'answer');
      assert.deepEqual(c.errors, []);
    });
  });

  test('schedule comes from the frontmatter and defaults to fsrs; an Answer may be empty', async () => {
    const none = md({ body: '## Question\n\nHonor thy error as a hidden intention.\n\n## Answer\n' }).replace('---\n\n', 'schedule: none\n---\n\n');
    const every = codeCard().replace('---\n\n', 'schedule: 30d\n---\n\n');
    await withServer({ 'g/prm01.md': none, 'g/prm02.md': every, 'g/ans01.md': codeCard() }, async ({ url }) => {
      const deck = await getDeck(url);
      assert.deepEqual(card(deck, 'prm01').errors, []);
      assert.equal(card(deck, 'prm01').schedule, 'none');
      assert.deepEqual(card(deck, 'prm01').sections, [{ name: 'Question', body: 'Honor thy error as a hidden intention.' }, { name: 'Answer', body: '' }]);
      assert.equal(card(deck, 'prm02').schedule, '30d');
      assert.equal(card(deck, 'prm02').kind, 'code');
      assert.equal(card(deck, 'ans01').schedule, 'fsrs');
    });
  });

  test('## inside a fenced code block is not a section heading', async () => {
    const raw = md({ body: '## Question\n\nQ\n\n## Code\n\n```python\n## not a heading\nx = 1\n```\n' });
    await withServer({ 'py/fence.md': raw }, async ({ url }) => {
      const c = card(await getDeck(url), 'fence');
      assert.deepEqual(c.sections.map((s) => s.name), ['Question', 'Code']);
      assert.match(c.sections[1].body, /## not a heading/);
    });
  });

  test('version changes when content changes', async () => {
    await withServer({ 'g/aaaaa.md': codeCard(), 'g/bbbbb.md': codeCard('2026-02-02T00:00:00Z') }, async ({ url }) => {
      const deck = await getDeck(url);
      assert.notEqual(card(deck, 'aaaaa').version, card(deck, 'bbbbb').version);
    });
  });

  test('CRLF line endings parse the same', async () => {
    const raw = codeCard().replace(/\n/g, '\r\n');
    await withServer({ 'g/crlf1.md': raw }, async ({ url }) => {
      const c = card(await getDeck(url), 'crlf1');
      assert.deepEqual(c.errors, []);
      assert.equal(c.raw, raw);
    });
  });
});

describe('load checks', () => {
  const cases = {
    'unparseable frontmatter': ['---\nnot yaml at all\n---\n\n## Question\n\nQ\n\n## Answer\n\nA\n', /frontmatter/],
    'missing frontmatter': ['## Question\n\nQ\n\n## Answer\n\nA\n', /frontmatter/],
    'missing created': ['---\nfoo: bar\n---\n\n## Question\n\nQ\n\n## Answer\n\nA\n', /created/],
    'invalid created': [md({ created: 'yesterday', body: '## Question\n\nQ\n\n## Answer\n\nA\n' }), /created/],
    'missing Question': [md({ body: '## Answer\n\nA\n' }), /必須有 Question/],
    'a Prompt instead of a Question': [md({ body: '## Prompt\n\nP\n\n## Answer\n\nA\n' }), /必須有 Question/],
    'unknown schedule': ['---\ncreated: 2026-01-01T00:00:00Z\nschedule: weekly\n---\n\n## Question\n\nQ\n\n## Answer\n\nA\n', /schedule 不合法/],
    'zero days': ['---\ncreated: 2026-01-01T00:00:00Z\nschedule: 0d\n---\n\n## Question\n\nQ\n\n## Answer\n\nA\n', /schedule 不合法/],
    'duplicate Question': [md({ body: '## Question\n\nQ\n\n## Question\n\nQ2\n\n## Answer\n\nA\n' }), /Question/],
    'both Code and Answer': [md({ body: '## Question\n\nQ\n\n## Code\n\n```c\nx\n```\n\n## Answer\n\nA\n' }), /Code.*Answer/],
    'neither Code nor Answer': [md({ body: '## Question\n\nQ\n\n## Notes\n\nN\n' }), /Code.*Answer/],
  };
  for (const [name, [raw, pattern]] of Object.entries(cases)) {
    test(`${name} is flagged without blocking other cards`, async () => {
      await withServer({ 'g/bad01.md': raw, 'g/good1.md': codeCard() }, async ({ url }) => {
        const deck = await getDeck(url);
        const bad = card(deck, 'bad01');
        assert.ok(bad.errors.some((e) => pattern.test(e)), `errors: ${JSON.stringify(bad.errors)}`);
        assert.equal(bad.raw, raw);
        assert.deepEqual(card(deck, 'good1').errors, []);
        assert.deepEqual(deck.groups[0].order.toSorted(), ['bad01', 'good1']);
      });
    });
  }

  test('invalid file names are flagged', async () => {
    await withServer({
      'g/TooLong123.md': codeCard(),
      'g/ABCDE.md': codeCard(),
      'g/ab-cd.md': codeCard(),
      'g/ok123.md': codeCard(),
    }, async ({ url }) => {
      const deck = await getDeck(url);
      for (const id of ['TooLong123', 'ABCDE', 'ab-cd']) {
        assert.ok(card(deck, id).errors.some((e) => /檔名/.test(e)), id);
      }
      assert.deepEqual(card(deck, 'ok123').errors, []);
    });
  });

  test('every card sharing a duplicate id is flagged', async () => {
    await withServer({
      'a/dup00.md': codeCard(),
      'b/dup00.md': codeCard(),
      'c/dup00.md': codeCard(),
      'c/uniq0.md': codeCard(),
    }, async ({ url }) => {
      const deck = await getDeck(url);
      const dups = deck.cards.filter((c) => c.id === 'dup00');
      assert.equal(dups.length, 3);
      for (const d of dups) assert.ok(d.errors.some((e) => /重複/.test(e)), d.group);
      assert.deepEqual(card(deck, 'uniq0').errors, []);
    });
  });

  test('non-markdown files, hidden files and the assets folder are ignored', async () => {
    await withServer({
      'g/ok123.md': codeCard(),
      'g/.DS_Store': 'x',
      'g/readme.txt': 'x',
      'assets/pic.md': 'x',
      '.hidden/x1234.md': codeCard(),
    }, async ({ url }) => {
      const deck = await getDeck(url);
      assert.deepEqual(deck.groups.map((g) => g.slug), ['g']);
      assert.deepEqual(deck.cards.map((c) => c.id), ['ok123']);
    });
  });
});

describe('order reconciliation', () => {
  test('order ids come first, then unlisted cards by created then id; missing ids are skipped', async () => {
    await withServer({
      'g/_group.json': { name: '群組', order: ['ccccc', 'ghost', 'aaaaa'] },
      'g/aaaaa.md': codeCard('2026-01-05T00:00:00Z'),
      'g/ccccc.md': codeCard('2026-01-01T00:00:00Z'),
      'g/zzzzz.md': codeCard('2026-01-02T00:00:00Z'),
      'g/yyyyy.md': codeCard('2026-01-03T00:00:00Z'),
      'g/xxxxx.md': codeCard('2026-01-03T00:00:00Z'),
    }, async ({ url }) => {
      const [g] = (await getDeck(url)).groups;
      assert.equal(g.name, '群組');
      assert.deepEqual(g.order, ['ccccc', 'aaaaa', 'zzzzz', 'xxxxx', 'yyyyy']);
    });
  });

  test('without _group.json the folder name is the display name', async () => {
    await withServer({
      'plain/bbbbb.md': codeCard('2026-01-02T00:00:00Z'),
      'plain/aaaaa.md': codeCard('2026-01-02T00:00:00Z'),
    }, async ({ url }) => {
      const [g] = (await getDeck(url)).groups;
      assert.equal(g.slug, 'plain');
      assert.equal(g.name, 'plain');
      assert.deepEqual(g.order, ['aaaaa', 'bbbbb']);
    });
  });

  test('_group.json without name falls back to the folder name', async () => {
    await withServer({
      'g/_group.json': { order: ['bbbbb'] },
      'g/aaaaa.md': codeCard(),
      'g/bbbbb.md': codeCard(),
    }, async ({ url }) => {
      const [g] = (await getDeck(url)).groups;
      assert.equal(g.name, 'g');
      assert.deepEqual(g.order, ['bbbbb', 'aaaaa']);
    });
  });

  test('membership comes from the folder, not from order', async () => {
    await withServer({
      'a/_group.json': { order: ['bbbbb', 'aaaaa'] },
      'a/aaaaa.md': codeCard(),
      'b/bbbbb.md': codeCard(),
    }, async ({ url }) => {
      const deck = await getDeck(url);
      assert.deepEqual(deck.groups.find((g) => g.slug === 'a').order, ['aaaaa']);
      assert.deepEqual(deck.groups.find((g) => g.slug === 'b').order, ['bbbbb']);
    });
  });

  test('unparseable _group.json is flagged and falls back', async () => {
    await withServer({
      'g/_group.json': '{ not json',
      'g/aaaaa.md': codeCard(),
    }, async ({ url }) => {
      const [g] = (await getDeck(url)).groups;
      assert.equal(g.name, 'g');
      assert.deepEqual(g.order, ['aaaaa']);
      assert.ok(g.errors.length > 0);
    });
  });
});

async function snapshot(root) {
  const out = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const s = await stat(full);
    out[path.relative(root, full)] = entry.isFile()
      ? { content: await readFile(full, 'utf8'), mtimeMs: s.mtimeMs }
      : { dir: true, mtimeMs: s.mtimeMs };
  }
  return out;
}

describe('reading never writes', () => {
  let server;
  let deckDir;
  let progressDir;
  before(async () => {
    deckDir = await makeDeck({
      'g/_group.json': { name: 'G', order: ['ghost', 'bbbbb'] },
      'g/aaaaa.md': codeCard(),
      'g/bbbbb.md': codeCard(),
      'g/bad01.md': 'garbage',
      'h/aaaaa.md': codeCard(),
      '_groups.json': { order: ['ghost', 'h'] },
    });
    progressDir = await makeDeck({
      'home.jsonl': `${JSON.stringify({ time: '2026-01-01T00:00:00Z', id: 'bbbbb', type: 'review', rating: 'good' })}\n`,
      'work.jsonl': `${JSON.stringify({ time: '2026-01-02T00:00:00Z', id: 'bbbbb', type: 'reset' })}\n`,
    });
    server = await startServer({ deckDir, progressDir, device: 'home' });
  });
  after(async () => {
    await server.close();
    await rm(deckDir, { recursive: true, force: true });
    await rm(progressDir, { recursive: true, force: true });
  });

  test('deck and progress folders are unchanged after a series of reads', async () => {
    const deckBefore = await snapshot(deckDir);
    const progressBefore = await snapshot(progressDir);
    for (let i = 0; i < 5; i++) {
      await getDeck(server.url);
      assert.equal((await fetch(`${server.url}/api/smart-groups`).then((r) => r.json())).groups.length, 2);
      await fetch(`${server.url}/api/progress`).then((r) => r.json());
      assert.equal((await fetch(`${server.url}/api/schedule`).then((r) => r.json())).cards.length, 1);
    }
    await fetch(`${server.url}/`).then((r) => r.text());
    assert.deepEqual(await snapshot(deckDir), deckBefore);
    assert.deepEqual(await snapshot(progressDir), progressBefore);
  });
});

describe('static frontend', () => {
  test('serves the home page and refuses path traversal', async () => {
    await withServer({}, async ({ url }) => {
      const home = await fetch(`${url}/`);
      assert.equal(home.status, 200);
      assert.match(home.headers.get('content-type'), /text\/html/);
      const traversal = await fetch(`${url}/..%2Fpackage.json`);
      assert.equal(traversal.status, 404);
    });
  });

  test('empty deck returns no groups', async () => {
    await withServer({}, async ({ url }) => {
      assert.deepEqual(await getDeck(url), { groups: [], cards: [], errors: [] });
    });
  });
});

describe('deck assets', () => {
  test('serves files from the shared assets folder and refuses path traversal', async () => {
    await withServer({ 'assets/note.png': 'PNGDATA', 'g/aaaaa.md': codeCard() }, async ({ url }) => {
      const img = await fetch(`${url}/assets/note.png`);
      assert.equal(img.status, 200);
      assert.equal(img.headers.get('content-type'), 'image/png');
      assert.equal(await img.text(), 'PNGDATA');
      assert.equal((await fetch(`${url}/assets/missing.png`)).status, 404);
      assert.equal((await fetch(`${url}/assets/..%2Fg%2Faaaaa.md`)).status, 404);
    });
  });
});

async function openEvents(url) {
  const controller = new AbortController();
  const res = await fetch(`${url}/api/events`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const stream = { count: 0, onMessage: () => {} };
  (async () => {
    let buffer = '';
    try {
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        const messages = buffer.split('\n\n');
        buffer = messages.pop();
        for (const m of messages) {
          if (/^data:/m.test(m)) {
            stream.count++;
            stream.onMessage();
          }
        }
      }
    } catch {}
  })();
  return {
    count: () => stream.count,
    next: (ms = 3000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no change notification')), ms);
      stream.onMessage = () => {
        clearTimeout(timer);
        resolve();
      };
    }),
    close: () => controller.abort(),
  };
}

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

describe('change notifications', () => {
  const mutations = {
    'adding a card file': (dir) => writeFile(path.join(dir, 'g/new01.md'), codeCard()),
    'modifying a card file': (dir) => writeFile(path.join(dir, 'g/aaaaa.md'), codeCard('2026-05-05T00:00:00Z')),
    'deleting a card file': (dir) => rm(path.join(dir, 'g/aaaaa.md')),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    test(`${name} notifies the event stream`, async () => {
      await withServer({ 'g/aaaaa.md': codeCard() }, async ({ url, deckDir }) => {
        const events = await openEvents(url);
        try {
          await settle();
          const changed = events.next();
          await mutate(deckDir);
          await changed;
        } finally {
          events.close();
        }
      });
    });
  }

  test('a change in the progress folder notifies the event stream', async () => {
    const deckDir = await makeDeck({ 'g/aaaaa.md': codeCard() });
    const progressDir = await makeDeck({});
    const server = await startServer({ deckDir, progressDir, device: 'home' });
    const events = await openEvents(server.url);
    try {
      await settle();
      const changed = events.next();
      await writeFile(path.join(progressDir, 'work.jsonl'), `${JSON.stringify({ time: '2026-01-01T00:00:00Z', id: 'aaaaa', type: 'review', rating: 'good' })}\n`);
      await changed;
    } finally {
      events.close();
      await server.close();
      await rm(deckDir, { recursive: true, force: true });
      await rm(progressDir, { recursive: true, force: true });
    }
  });

  test('a progress folder missing at startup is created and watched', async () => {
    const deckDir = await makeDeck({ 'g/aaaaa.md': codeCard() });
    const root = await makeDeck({});
    const progressDir = path.join(root, 'nested', 'progress');
    const server = await startServer({ deckDir, progressDir, device: 'home' });
    const events = await openEvents(server.url);
    try {
      assert.equal((await fetch(`${server.url}/api/schedule`)).status, 200);
      await settle();
      const changed = events.next();
      const res = await fetch(`${server.url}/api/progress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'aaaaa', type: 'review', rating: 'good' }),
      });
      assert.equal(res.status, 201);
      await changed;
    } finally {
      events.close();
      await server.close();
      await rm(deckDir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a burst of writes is debounced into one notification', async () => {
    // A wide window so a slow CI runner's gaps between writes still fall inside it.
    const deckDir = await makeDeck({ 'g/aaaaa.md': codeCard() });
    const server = await startServer({ deckDir, debounceMs: 500 });
    const events = await openEvents(server.url);
    try {
      await settle();
      const before = events.count();
      const changed = events.next();
      for (let i = 1; i <= 5; i++) {
        await writeFile(path.join(deckDir, 'g/aaaaa.md'), codeCard(`2026-05-0${i}T00:00:00Z`));
      }
      await changed;
      await settle(1000);
      assert.equal(events.count() - before, 1);
    } finally {
      events.close();
      await server.close();
      await rm(deckDir, { recursive: true, force: true });
    }
  });
});
