import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/deck.js', import.meta.url));
const card = (q) => `---\ncreated: 2026-01-01T00:00:00Z\n---\n\n## Question\n\n${q}\n\n## Answer\n\nA\n`;

async function withDeck(files, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'noesis-cli-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, 'decks', rel)), { recursive: true });
      await writeFile(path.join(dir, 'decks', rel), typeof content === 'string' ? content : JSON.stringify(content));
    }
    const env = { ...process.env, NOESIS_DECK: path.join(dir, 'decks'), NOESIS_PROGRESS: path.join(dir, 'progress'), NOESIS_DEVICE: 'cli-test' };
    const deck = (...args) => {
      const input = args.at(-1)?.stdin;
      const r = spawnSync(process.execPath, [CLI, ...(input === undefined ? args : args.slice(0, -1))], { env, input: input ?? '', encoding: 'utf8' });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const order = async (group) => JSON.parse(await readFile(path.join(dir, 'decks', group, '_group.json'), 'utf8')).order;
    await fn({ dir, deck, order });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('add places the new card and rejects a broken one without writing', async () => {
  await withDeck({ 'g/aaaaa.md': card('a'), 'g/bbbbb.md': card('b'), 'g/_group.json': { name: 'G', order: ['aaaaa', 'bbbbb'] } }, async ({ dir, deck, order }) => {
    const added = deck('add', 'g', '--after', 'aaaaa', { stdin: '## Question\n\nnew\n\n## Answer\n\nA\n' });
    assert.equal(added.code, 0, added.err);
    const id = added.out.trim().split('/')[1];
    assert.deepEqual(await order('g'), ['aaaaa', id, 'bbbbb']);

    const broken = deck('add', 'g', { stdin: '## Question\n\nno answer\n' });
    assert.equal(broken.code, 1);
    assert.match(broken.err, /必須有 Code 或 Answer/);
    assert.equal((await readdir(path.join(dir, 'decks/g'))).length, 4);
  });
});

test('show finds the file by id and check reports a broken one', async () => {
  await withDeck({ 'g/aaaaa.md': card('a'), 'g/bbbbb.md': '## Question\n\nno answer\n' }, async ({ deck }) => {
    assert.match(deck('show', 'aaaaa').out, /decks\/g\/aaaaa\.md$/m);
    assert.equal(deck('show', 'zzzzz').code, 1);
    const checked = deck('check', deck('show', 'aaaaa').out.trim(), deck('show', 'bbbbb').out.trim());
    assert.equal(checked.code, 1);
    assert.match(checked.out, /aaaaa\.md: ok/);
    assert.match(checked.out, /bbbbb\.md: 必須有 Code 或 Answer/);
  });
});

test('mv, place and rm keep group orders in step, and a bad id in a batch changes nothing', async () => {
  const files = {
    'g/aaaaa.md': card('a'), 'g/bbbbb.md': card('b'), 'g/ccccc.md': card('c'), 'g/_group.json': { name: 'G', order: ['aaaaa', 'bbbbb', 'ccccc'] },
    'h/ddddd.md': card('d'), 'h/_group.json': { name: 'H', order: ['ddddd'] },
  };
  await withDeck(files, async ({ dir, deck, order }) => {
    assert.equal(deck('mv', 'aaaaa', 'zzzzz', '--to', 'h').code, 1);
    assert.deepEqual(await order('g'), ['aaaaa', 'bbbbb', 'ccccc']);

    assert.equal(deck('mv', 'aaaaa', 'bbbbb', '--to', 'h').code, 0);
    assert.deepEqual(await order('g'), ['ccccc']);
    assert.deepEqual(await order('h'), ['ddddd', 'aaaaa', 'bbbbb']);

    assert.equal(deck('place', 'bbbbb', '--before', 'ddddd').code, 0);
    assert.deepEqual(await order('h'), ['bbbbb', 'ddddd', 'aaaaa']);
    assert.equal(deck('place', 'bbbbb', '--before', 'ccccc').code, 1);

    assert.equal(deck('rm', 'ddddd').code, 0);
    assert.deepEqual(await order('h'), ['bbbbb', 'aaaaa']);
    assert.deepEqual((await readdir(path.join(dir, 'decks/h'))).toSorted(), ['_group.json', 'aaaaa.md', 'bbbbb.md']);
  });
});

test('group commands and progress markers', async () => {
  await withDeck({ 'g/aaaaa.md': card('a'), 'h/bbbbb.md': card('b'), '_groups.json': { order: ['g', 'h'] } }, async ({ dir, deck }) => {
    const groups = async () => JSON.parse(await readFile(path.join(dir, 'decks/_groups.json'), 'utf8')).order;
    assert.equal(deck('group', 'add', 'n', '新的').code, 0);
    assert.equal(deck('group', 'place', 'n', '--after', 'g').code, 0);
    assert.deepEqual(await groups(), ['g', 'n', 'h']);
    assert.equal(deck('group', 'rename', 'n', '改名').code, 0);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'decks/n/_group.json'), 'utf8')).name, '改名');
    assert.equal(deck('group', 'rm', 'g').code, 1);
    assert.equal(deck('group', 'rm', 'n').code, 0);

    assert.equal(deck('suspend', 'aaaaa', 'bbbbb').code, 0);
    const lines = (await readFile(path.join(dir, 'progress/cli-test.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((e) => [e.id, e.type]), [['aaaaa', 'suspend'], ['bbbbb', 'suspend']]);
  });
});

test('schedule sets the frontmatter of every card given, and a bad value or id changes nothing', async () => {
  await withDeck({ 'g/aaaaa.md': card('a'), 'g/bbbbb.md': card('b') }, async ({ dir, deck }) => {
    const read = (id) => readFile(path.join(dir, 'decks/g', `${id}.md`), 'utf8');
    assert.equal(deck('schedule', 'weekly', 'aaaaa').code, 1);
    assert.equal(deck('schedule', '30d', 'aaaaa', 'zzzzz').code, 1);
    assert.equal(await read('aaaaa'), card('a'));
    assert.equal(deck('schedule', '30d', 'aaaaa', 'bbbbb').code, 0);
    assert.match(await read('aaaaa'), /^schedule: 30d$/m);
    assert.match(await read('bbbbb'), /^schedule: 30d$/m);
    assert.equal(deck('schedule', 'fsrs', 'aaaaa').code, 0);
    assert.equal(await read('aaaaa'), card('a'));
  });
});

test('rm refuses a card other cards link to unless --force, and check reports a link to a missing card', async () => {
  const files = { 'g/aaaaa.md': card('see [[bbbbb]]'), 'g/bbbbb.md': card('b'), 'g/ccccc.md': card('c'), 'g/_group.json': { name: 'G', order: ['aaaaa', 'bbbbb', 'ccccc'] } };
  await withDeck(files, async ({ deck, order }) => {
    const refused = deck('rm', 'ccccc', 'bbbbb');
    assert.equal(refused.code, 1);
    assert.match(refused.err, /bbbbb.*aaaaa/);
    assert.deepEqual(await order('g'), ['aaaaa', 'bbbbb', 'ccccc']);

    assert.equal(deck('rm', 'aaaaa', 'bbbbb').code, 0);
    assert.deepEqual(await order('g'), ['ccccc']);
  });
  await withDeck(files, async ({ deck, order }) => {
    assert.equal(deck('rm', 'bbbbb', '--force').code, 0);
    assert.deepEqual(await order('g'), ['aaaaa', 'ccccc']);
    const checked = deck('check', deck('show', 'aaaaa').out.trim());
    assert.equal(checked.code, 1);
    assert.match(checked.out, /aaaaa\.md: 連到不存在的卡片 bbbbb/);
  });
});
