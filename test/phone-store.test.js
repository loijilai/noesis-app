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

const memory = () => {
  let list = [];
  return { get: () => list, set: (next) => { list = next; } };
};

async function setup(files = FILES, fetch) {
  const remote = fakeGitHub(files);
  const pending = memory();
  const changes = memory();
  const store = createStore({ gh: gitHub({ token: 't', repo: 'me/data', fetch: fetch?.(remote) ?? remote.fetch }), branch: 'master', pending, changes });
  await store.refresh();
  return { remote, store, pending, changes };
}

// Lets the desktop push once, right when the phone is about to move the branch.
const pushBeforeCommit = (changes) => (remote) => {
  let done = false;
  return async (url, init) => {
    if (init?.method === 'PATCH' && !done) {
      done = true;
      remote.push(changes);
    }
    return remote.fetch(url, init);
  };
};

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
  const gh = gitHub({ token: 't', repo: 'me/data', fetch: async (url, init) => (init?.method === 'POST' ? new Response('{}', { status: 502 }) : real(url, init)) });
  const offline = createStore({ gh, branch: 'master', pending, changes: memory() });
  await offline.refresh();
  await assert.rejects(offline.flush());
  assert.equal(pending.get().length, 1);
  await store.flush();
  assert.equal(remote.read('progress/phone.jsonl').trim().split('\n').length, 1);
});

const cardOf = (store, id) => store.deck().cards.find((c) => c.id === id);
const order = (remote) => JSON.parse(remote.read('decks/g/_group.json')).order;
const DRAFT = '## Question\n\nnew\n\n## Answer\n\nyes\n';

test('an edit shows at once and reaches GitHub only on flush', async () => {
  const { remote, store } = await setup();
  const saved = store.saveCard('g', 'aaaaa', card('edited'), cardOf(store, 'aaaaa').version);
  assert.equal(remote.read('decks/g/aaaaa.md'), card('one'));
  assert.equal(cardOf(store, 'aaaaa').raw, card('edited'));
  assert.equal(cardOf(store, 'aaaaa').version, saved.version);
  assert.deepEqual(store.status(), { pending: 1, conflicts: 0 });

  await store.flush();
  assert.equal(remote.read('decks/g/aaaaa.md'), card('edited'));
  assert.deepEqual(remote.log(), ['sync: phone', 'init']);
  assert.equal(cardOf(store, 'aaaaa').version, store.blobSha('decks/g/aaaaa.md'));
  assert.deepEqual(store.status(), { pending: 0, conflicts: 0 });
});

test('edits, a new card, a delete and ratings go out in one commit', async () => {
  const { remote, store } = await setup();
  store.saveCard('g', 'aaaaa', card('edited'), cardOf(store, 'aaaaa').version);
  const { id } = store.createCard('g', DRAFT);
  store.deleteCard('g', 'bbbbb');
  store.record(review('aaaaa', '2026-02-01T00:00:00.000Z'));
  await store.flush();
  assert.deepEqual(remote.log(), ['sync: phone', 'init']);
  assert.equal(remote.read('decks/g/aaaaa.md'), card('edited'));
  assert.equal(remote.read('decks/g/bbbbb.md'), undefined);
  assert.match(remote.read(`decks/g/${id}.md`), /## Question\n\nnew/);
  assert.deepEqual(order(remote), ['aaaaa', id]);
  assert.equal(remote.read('progress/phone.jsonl').trim().split('\n').length, 1);
});

test('a card changed twice is sent once, and one added then deleted is never sent', async () => {
  const { remote, store, changes } = await setup();
  store.saveCard('g', 'aaaaa', card('first'), cardOf(store, 'aaaaa').version);
  store.saveCard('g', 'aaaaa', card('second'), cardOf(store, 'aaaaa').version);
  const { id } = store.createCard('g', DRAFT);
  store.deleteCard('g', id);
  assert.equal(changes.get().length, 1);
  await store.flush();
  assert.equal(remote.read('decks/g/aaaaa.md'), card('second'));
  assert.equal(remote.read(`decks/g/${id}.md`), undefined);
  assert.deepEqual(order(remote), ['aaaaa', 'bbbbb']);
});

test('an edit with a stale version or malformed text is refused and nothing is kept', async () => {
  const { store, changes } = await setup();
  assert.throws(() => store.saveCard('g', 'aaaaa', card('x'), 'old'), { status: 409 });
  assert.throws(() => store.saveCard('g', 'aaaaa', 'nonsense', cardOf(store, 'aaaaa').version), { status: 400 });
  assert.deepEqual(changes.get(), []);
});

test('a schedule change is an edit of the card text', async () => {
  const { remote, store } = await setup();
  store.setSchedule('g', 'bbbbb', '30d');
  await store.flush();
  assert.match(remote.read('decks/g/bbbbb.md'), /^schedule: 30d$/m);
});

test('a new card can go last, or right before or after another', async () => {
  const { remote, store } = await setup();
  const last = store.createCard('g', DRAFT);
  const before = store.createCard('g', DRAFT, { before: 'bbbbb' });
  const after = store.createCard('g', DRAFT, { after: 'aaaaa' });
  assert.deepEqual(store.deck().groups[0].order, ['aaaaa', after.id, before.id, 'bbbbb', last.id]);
  await store.flush();
  assert.deepEqual(order(remote), ['aaaaa', after.id, before.id, 'bbbbb', last.id]);
});

test('a draft\'s own frontmatter is replaced by the creation time', async () => {
  const { remote, store } = await setup();
  const { id } = store.createCard('g', `---\nschedule: none\ncreated: 1999-01-01T00:00:00Z\n---\n\n${DRAFT}`);
  await store.flush();
  assert.match(remote.read(`decks/g/${id}.md`), /^---\ncreated: \d{4}-\d\d-\d\dT[\d:.]+Z\n---\n\n## Question\n\nnew\n/);
  assert.doesNotMatch(remote.read(`decks/g/${id}.md`), /1999|schedule/);
});

test('a malformed draft, an unknown group or neighbour is refused', async () => {
  const { store, changes } = await setup();
  assert.throws(() => store.createCard('g', 'nonsense'), { status: 400 });
  assert.throws(() => store.createCard('nope', DRAFT), { status: 404 });
  assert.throws(() => store.createCard('g', DRAFT, { after: 'zzzzz' }), { status: 404 });
  assert.deepEqual(changes.get(), []);
});

test('a new id never reuses one taken in another group', async () => {
  const picks = [2, 2, 2, 2, 2, 3, 3, 3, 3, 3];
  const remote = fakeGitHub({ ...FILES, 'decks/h/ccccc.md': card('elsewhere') });
  const store = createStore({ gh: gitHub({ token: 't', repo: 'me/data', fetch: remote.fetch }), branch: 'master', pending: memory(), changes: memory(), random: () => picks.shift() });
  await store.refresh();
  assert.equal(store.createCard('g', DRAFT).id, 'ddddd');
});

test('a group with no _group.json gets one when a card is added', async () => {
  const files = { ...FILES };
  delete files['decks/g/_group.json'];
  const { remote, store } = await setup(files);
  const { id } = store.createCard('g', DRAFT);
  await store.flush();
  assert.deepEqual(JSON.parse(remote.read('decks/g/_group.json')), { order: ['aaaaa', 'bbbbb', id] });
});

test('a push landing between the phone\'s read and its commit is kept, and the phone tries again', async () => {
  const reorder = { 'decks/g/_group.json': '{\n  "name": "G",\n  "order": [\n    "bbbbb",\n    "aaaaa"\n  ]\n}\n' };
  const { remote, store } = await setup(FILES, pushBeforeCommit(reorder));
  const { id } = store.createCard('g', DRAFT);
  await store.flush();
  assert.deepEqual(order(remote), ['bbbbb', 'aaaaa', id]);
  assert.deepEqual(remote.log(), ['sync: phone', 'desktop', 'init']);
});

test('a new card whose neighbour the desktop deleted goes last', async () => {
  const { remote, store } = await setup();
  const { id } = store.createCard('g', DRAFT, { after: 'aaaaa' });
  remote.push({ 'decks/g/aaaaa.md': null, 'decks/g/_group.json': '{\n  "name": "G",\n  "order": [\n    "bbbbb"\n  ]\n}\n' });
  await store.flush();
  assert.deepEqual(order(remote), ['bbbbb', id]);
});

test('an edit follows a card the desktop moved to another group', async () => {
  const { remote, store } = await setup();
  store.saveCard('g', 'aaaaa', card('edited'), cardOf(store, 'aaaaa').version);
  remote.push({ 'decks/g/aaaaa.md': null, 'decks/h/aaaaa.md': card('one') });
  await store.flush();
  assert.equal(remote.read('decks/h/aaaaa.md'), card('edited'));
  assert.equal(remote.read('decks/g/aaaaa.md'), undefined);
});

test('a card the desktop changed the same way is no conflict', async () => {
  const { remote, store } = await setup();
  store.saveCard('g', 'aaaaa', card('same'), cardOf(store, 'aaaaa').version);
  remote.push({ 'decks/g/aaaaa.md': card('same') });
  await store.flush();
  assert.deepEqual(store.status(), { pending: 0, conflicts: 0 });
  assert.deepEqual(remote.log(), ['desktop', 'init']);
});

test('an edit of a card the desktop also changed waits as a conflict, and the rest still goes out', async () => {
  const { remote, store } = await setup();
  store.saveCard('g', 'aaaaa', card('phone'), cardOf(store, 'aaaaa').version);
  store.saveCard('g', 'bbbbb', card('fine'), cardOf(store, 'bbbbb').version);
  remote.push({ 'decks/g/aaaaa.md': card('desktop') });
  await store.flush();
  assert.equal(remote.read('decks/g/aaaaa.md'), card('desktop'));
  assert.equal(remote.read('decks/g/bbbbb.md'), card('fine'));
  assert.deepEqual(store.status(), { pending: 0, conflicts: 1 });
  assert.equal(store.hasPending(), false);
  assert.deepEqual(store.conflicts(), [{ id: 'aaaaa', group: 'g', groupName: 'G', local: card('phone'), remote: card('desktop'), missingGroup: false }]);
  assert.equal(cardOf(store, 'aaaaa').raw, card('phone'));
});

test('taking the phone\'s side, edited, writes it over the desktop\'s', async () => {
  const { remote, store } = await setup();
  store.saveCard('g', 'aaaaa', card('phone'), cardOf(store, 'aaaaa').version);
  remote.push({ 'decks/g/aaaaa.md': card('desktop') });
  await store.flush();
  store.resolve('aaaaa', 'local', card('merged'));
  assert.deepEqual(store.status(), { pending: 1, conflicts: 0 });
  await store.flush();
  assert.equal(remote.read('decks/g/aaaaa.md'), card('merged'));
  assert.deepEqual(store.status(), { pending: 0, conflicts: 0 });
});

test('taking the desktop\'s side drops the phone\'s change', async () => {
  const { remote, store } = await setup();
  store.saveCard('g', 'aaaaa', card('phone'), cardOf(store, 'aaaaa').version);
  remote.push({ 'decks/g/aaaaa.md': card('desktop') });
  await store.flush();
  store.resolve('aaaaa', 'remote');
  assert.equal(cardOf(store, 'aaaaa').raw, card('desktop'));
  assert.deepEqual(store.status(), { pending: 0, conflicts: 0 });
  assert.throws(() => store.resolve('aaaaa', 'remote'), { status: 404 });
});

test('a delete of a card the desktop changed is a conflict; taking the phone\'s side deletes it', async () => {
  const { remote, store } = await setup();
  store.deleteCard('g', 'aaaaa');
  remote.push({ 'decks/g/aaaaa.md': card('desktop') });
  await store.flush();
  assert.equal(store.conflicts()[0].local, null);
  assert.equal(remote.read('decks/g/aaaaa.md'), card('desktop'));
  store.resolve('aaaaa', 'local');
  await store.flush();
  assert.equal(remote.read('decks/g/aaaaa.md'), undefined);
  assert.deepEqual(order(remote), ['bbbbb']);
});

test('an edit of a card the desktop deleted is a conflict; taking the phone\'s side adds it back', async () => {
  const { remote, store } = await setup();
  store.saveCard('g', 'aaaaa', card('phone'), cardOf(store, 'aaaaa').version);
  remote.push({ 'decks/g/aaaaa.md': null, 'decks/g/_group.json': '{\n  "name": "G",\n  "order": [\n    "bbbbb"\n  ]\n}\n' });
  await store.flush();
  assert.equal(store.conflicts()[0].remote, null);
  store.resolve('aaaaa', 'local');
  await store.flush();
  assert.equal(remote.read('decks/g/aaaaa.md'), card('phone'));
  assert.deepEqual(order(remote), ['bbbbb', 'aaaaa']);
});

test('a card added to a group the desktop removed cannot take the phone\'s side', async () => {
  const { remote, store } = await setup();
  const { id } = store.createCard('g', DRAFT);
  remote.push({ 'decks/g/aaaaa.md': null, 'decks/g/bbbbb.md': null, 'decks/g/_group.json': null });
  await store.flush();
  assert.equal(store.conflicts()[0].missingGroup, true);
  assert.throws(() => store.resolve(id, 'local'), { status: 409 });
  store.resolve(id, 'remote');
  assert.deepEqual(store.status(), { pending: 0, conflicts: 0 });
});

test('a card edited again while it was being sent stays, based on what was sent', async () => {
  let store;
  const ctx = await setup(FILES, (remote) => {
    let done = false;
    return async (url, init) => {
      if (init?.method === 'PATCH' && !done) {
        done = true;
        store.saveCard('g', 'aaaaa', card('later'), cardOf(store, 'aaaaa').version);
      }
      return remote.fetch(url, init);
    };
  });
  store = ctx.store;
  store.saveCard('g', 'aaaaa', card('first'), cardOf(store, 'aaaaa').version);
  await store.flush();
  assert.equal(ctx.remote.read('decks/g/aaaaa.md'), card('first'));
  assert.deepEqual(store.status(), { pending: 1, conflicts: 0 });
  await store.flush();
  assert.equal(ctx.remote.read('decks/g/aaaaa.md'), card('later'));
  assert.deepEqual(store.status(), { pending: 0, conflicts: 0 });
});
