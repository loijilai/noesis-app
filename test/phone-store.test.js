import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitHub } from '../phone/github.js';
import { createStore } from '../phone/store.js';
import { fakeGitHub } from './fake-github.js';

const card = (q) => `---\ncreated: 2026-01-01T00:00:00.000Z\n---\n\n## Question\n\n${q}\n\n## Answer\n\na\n`;
const FILES = {
  'decks/_groups.json': '{\n  "order": ["g"]\n}\n',
  'decks/g/_group.json': '{\n  "name": "G",\n  "order": [\n    "aaaaa",\n    "bbbbb"\n  ]\n}\n',
  'decks/g/aaaaa.md': card('one'),
  'decks/g/bbbbb.md': card('two'),
  'decks/assets/x.png': 'png',
  'progress/home.jsonl': '{"time":"2026-01-02T00:00:00.000Z","id":"aaaaa","type":"review","rating":"good"}\n',
  'README.md': 'not read',
};

async function setup(files = FILES) {
  const remote = fakeGitHub(files);
  let queue = [];
  const pending = { get: () => queue, set: (list) => { queue = list; } };
  const store = createStore({ gh: gitHub({ token: 't', repo: 'me/data', fetch: remote.fetch }), branch: 'master', pending });
  await store.refresh();
  return { remote, store, pending };
}

const review = (id, time) => ({ time, id, type: 'review', rating: 'good' });

test('the deck and every device\'s events are read from the repo', async () => {
  const { store } = await setup();
  const deck = store.deck();
  assert.deepEqual(deck.groups.map((g) => [g.slug, g.name, g.order]), [['g', 'G', ['aaaaa', 'bbbbb']]]);
  assert.equal(deck.cards.find((c) => c.id === 'aaaaa').version, store.blobSha('decks/g/aaaaa.md'));
  assert.deepEqual(store.events().map((e) => [e.id, e.device]), [['aaaaa', 'home']]);
});

test('ratings wait on the phone and go to progress/phone.jsonl in one commit', async () => {
  const { remote, store, pending } = await setup();
  store.record(review('aaaaa', '2026-02-01T00:00:00.000Z'));
  store.record(review('bbbbb', '2026-02-01T00:01:00.000Z'));
  assert.equal(store.events().length, 3);
  assert.equal(remote.read('progress/phone.jsonl'), undefined);

  await store.flush();
  assert.equal(remote.read('progress/phone.jsonl'),
    '{"time":"2026-02-01T00:00:00.000Z","id":"aaaaa","type":"review","rating":"good"}\n'
    + '{"time":"2026-02-01T00:01:00.000Z","id":"bbbbb","type":"review","rating":"good"}\n');
  assert.deepEqual(remote.log(), ['sync: phone', 'init']);
  assert.deepEqual(pending.get(), []);
  assert.equal(store.events().length, 3);

  await store.flush();
  assert.deepEqual(remote.log(), ['sync: phone', 'init']);
});

test('a rating already on GitHub is not appended twice, and a push in between is kept', async () => {
  const { remote, store } = await setup();
  const first = review('aaaaa', '2026-02-01T00:00:00.000Z');
  remote.push({ 'progress/phone.jsonl': `${JSON.stringify(first)}\n`, 'decks/g/bbbbb.md': card('changed on desktop') });
  store.record(first);
  store.record(review('bbbbb', '2026-02-01T00:01:00.000Z'));
  await store.flush();
  assert.equal(remote.read('progress/phone.jsonl').trim().split('\n').length, 2);
  assert.equal(remote.read('decks/g/bbbbb.md'), card('changed on desktop'));
  assert.match(store.deck().cards.find((c) => c.id === 'bbbbb').raw, /changed on desktop/);
});

test('a rating survives a failed write and goes out on the next flush', async () => {
  const { remote, store, pending } = await setup();
  store.record(review('aaaaa', '2026-02-01T00:00:00.000Z'));
  const real = remote.fetch;
  const gh = gitHub({ token: 't', repo: 'me/data', fetch: async (url, init) => (init?.method === 'PUT' ? new Response('{}', { status: 502 }) : real(url, init)) });
  const offline = createStore({ gh, branch: 'master', pending });
  await offline.refresh();
  await assert.rejects(offline.flush());
  assert.equal(pending.get().length, 1);
  await store.flush();
  assert.equal(remote.read('progress/phone.jsonl').trim().split('\n').length, 1);
});

test('an edit is written with the sha the phone saw', async () => {
  const { remote, store } = await setup();
  const before = store.deck().cards.find((c) => c.id === 'aaaaa');
  const saved = await store.saveCard('g', 'aaaaa', card('edited'), before.version);
  assert.equal(remote.read('decks/g/aaaaa.md'), card('edited'));
  assert.deepEqual(remote.log(), ['phone: edit g/aaaaa', 'init']);
  assert.equal(saved.version, store.blobSha('decks/g/aaaaa.md'));
  assert.notEqual(saved.version, before.version);
});

test('an edit of a card the desktop changed in the meantime is refused and changes nothing', async () => {
  const { remote, store } = await setup();
  const seen = store.deck().cards.find((c) => c.id === 'aaaaa').version;
  remote.push({ 'decks/g/aaaaa.md': card('desktop') });
  await assert.rejects(store.saveCard('g', 'aaaaa', card('phone'), seen), { status: 409, message: /電腦上改過/ });
  assert.equal(remote.read('decks/g/aaaaa.md'), card('desktop'));
});

test('a malformed edit is refused before it reaches GitHub', async () => {
  const { remote, store } = await setup();
  const seen = store.deck().cards.find((c) => c.id === 'aaaaa').version;
  await assert.rejects(store.saveCard('g', 'aaaaa', 'nonsense', seen), { status: 400 });
  assert.deepEqual(remote.log(), ['init']);
});

test('a schedule change is an edit of the card text', async () => {
  const { remote, store } = await setup();
  await store.setSchedule('g', 'bbbbb', '30d');
  assert.match(remote.read('decks/g/bbbbb.md'), /^schedule: 30d$/m);
});

test('a delete removes the card and its place in _group.json in one commit', async () => {
  const { remote, store } = await setup();
  await store.deleteCard('g', 'aaaaa');
  assert.equal(remote.read('decks/g/aaaaa.md'), undefined);
  assert.deepEqual(JSON.parse(remote.read('decks/g/_group.json')), { name: 'G', order: ['bbbbb'] });
  assert.deepEqual(remote.log(), ['phone: delete g/aaaaa', 'init']);
  assert.deepEqual(store.deck().cards.map((c) => c.id), ['bbbbb']);
});

test('a delete goes through when only other files changed since the phone loaded', async () => {
  const { remote, store } = await setup();
  remote.push({ 'progress/home.jsonl': '' });
  await store.deleteCard('g', 'aaaaa');
  assert.equal(remote.read('decks/g/aaaaa.md'), undefined);
  assert.equal(remote.read('progress/home.jsonl'), '');
});

test('a delete of a card the desktop changed in the meantime is refused and the card stays', async () => {
  const { remote, store } = await setup();
  remote.push({ 'decks/g/aaaaa.md': card('desktop') });
  await assert.rejects(store.deleteCard('g', 'aaaaa'), { status: 409 });
  assert.equal(remote.read('decks/g/aaaaa.md'), card('desktop'));
  assert.match(remote.read('decks/g/_group.json'), /aaaaa/);
});

test('a push landing between the phone\'s read and its commit is not overwritten', async () => {
  const { remote, store } = await setup();
  const real = remote.fetch;
  let raced = false;
  const gh = gitHub({ token: 't', repo: 'me/data', fetch: async (url, init) => {
    if (init?.method === 'PATCH' && !raced) {
      raced = true;
      remote.push({ 'progress/home.jsonl': 'desktop\n' });
    }
    return real(url, init);
  } });
  const racing = createStore({ gh, branch: 'master', pending: { get: () => [], set() {} } });
  await racing.refresh();
  await racing.deleteCard('g', 'aaaaa');
  assert.equal(remote.read('progress/home.jsonl'), 'desktop\n');
  assert.equal(remote.read('decks/g/aaaaa.md'), undefined);
  assert.deepEqual(remote.log(), ['phone: delete g/aaaaa', 'desktop', 'init']);
});

const order = (remote) => JSON.parse(remote.read('decks/g/_group.json')).order;
const DRAFT = '## Question\n\nnew\n\n## Answer\n\nyes\n';

test('a new card goes last by default, with its file and its place in one commit', async () => {
  const { remote, store } = await setup();
  const created = await store.createCard('g', DRAFT);
  assert.match(created.id, /^[a-z0-9]{5}$/);
  assert.deepEqual(order(remote), ['aaaaa', 'bbbbb', created.id]);
  assert.match(remote.read(`decks/g/${created.id}.md`), /^---\ncreated: \d{4}-\d\d-\d\dT[\d:.]+Z\n---\n\n## Question\n\nnew\n/);
  assert.deepEqual(remote.log(), [`phone: add g/${created.id}`, 'init']);
  assert.equal(created.version, store.blobSha(`decks/g/${created.id}.md`));
  assert.ok(store.deck().cards.some((c) => c.id === created.id));
});

test('a new card can go right before or after another', async () => {
  const { remote, store } = await setup();
  const before = await store.createCard('g', DRAFT, { before: 'bbbbb' });
  assert.deepEqual(order(remote), ['aaaaa', before.id, 'bbbbb']);
  const after = await store.createCard('g', DRAFT, { after: 'aaaaa' });
  assert.deepEqual(order(remote), ['aaaaa', after.id, before.id, 'bbbbb']);
});

test('a draft\'s own frontmatter is replaced by the creation time', async () => {
  const { remote, store } = await setup();
  const { id } = await store.createCard('g', `---\nschedule: none\ncreated: 1999-01-01T00:00:00Z\n---\n\n${DRAFT}`);
  const text = remote.read(`decks/g/${id}.md`);
  assert.doesNotMatch(text, /1999|schedule/);
});

test('a malformed draft, an unknown group or neighbour changes nothing', async () => {
  const { remote, store } = await setup();
  await assert.rejects(store.createCard('g', 'nonsense'), { status: 400 });
  await assert.rejects(store.createCard('nope', DRAFT), { status: 404 });
  await assert.rejects(store.createCard('g', DRAFT, { after: 'zzzzz' }), { status: 404 });
  assert.deepEqual(remote.log(), ['init']);
});

test('a new id never reuses one taken in another group', async () => {
  const picks = [2, 2, 2, 2, 2, 3, 3, 3, 3, 3];
  const remote = fakeGitHub({ ...FILES, 'decks/h/ccccc.md': card('elsewhere') });
  const store = createStore({ gh: gitHub({ token: 't', repo: 'me/data', fetch: remote.fetch }), branch: 'master', pending: { get: () => [], set() {} }, random: () => picks.shift() });
  await store.refresh();
  const { id } = await store.createCard('g', DRAFT);
  assert.equal(id, 'ddddd');
});

test('a reorder pushed from the desktop while the phone adds a card is kept', async () => {
  const { remote } = await setup();
  const real = remote.fetch;
  let raced = false;
  const gh = gitHub({ token: 't', repo: 'me/data', fetch: async (url, init) => {
    if (init?.method === 'PATCH' && !raced) {
      raced = true;
      remote.push({ 'decks/g/_group.json': '{\n  "name": "G",\n  "order": [\n    "bbbbb",\n    "aaaaa"\n  ]\n}\n' });
    }
    return real(url, init);
  } });
  const store = createStore({ gh, branch: 'master', pending: { get: () => [], set() {} } });
  await store.refresh();
  const { id } = await store.createCard('g', DRAFT);
  assert.deepEqual(order(remote), ['bbbbb', 'aaaaa', id]);
  assert.deepEqual(remote.log(), [`phone: add g/${id}`, 'desktop', 'init']);
});

test('a group with no _group.json gets one when a card is added', async () => {
  const files = { ...FILES };
  delete files['decks/g/_group.json'];
  const { remote, store } = await setup(files);
  const { id } = await store.createCard('g', DRAFT);
  assert.deepEqual(JSON.parse(remote.read('decks/g/_group.json')), { order: ['aaaaa', 'bbbbb', id] });
});
