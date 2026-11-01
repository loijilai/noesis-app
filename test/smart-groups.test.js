import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/app.js';

const card = (created = '2026-01-01T00:00:00Z') => `---\ncreated: ${created}\n---\n\n## Question\n\nQ\n\n## Answer\n\nA\n`;
const jsonl = (...events) => events.map((e) => `${JSON.stringify(e)}\n`).join('');
const review = (time, id, rating = 'good') => ({ time, id, type: 'review', rating });
const reset = (time, id) => ({ time, id, type: 'reset' });
const suspend = (time, id) => ({ time, id, type: 'suspend' });
const unsuspend = (time, id) => ({ time, id, type: 'unsuspend' });
const seen = (time, id) => ({ time, id, type: 'review' });
const scheduled = (schedule) => card().replace('---\n\n', `schedule: ${schedule}\n---\n\n`);

async function makeDir(prefix, files) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

async function withServer({ deck = {}, progress = {}, now }, fn) {
  const deckDir = await makeDir('noesis-deck-', deck);
  const progressDir = await makeDir('noesis-progress-', progress);
  const clock = { now };
  const server = await startServer({ deckDir, progressDir, device: 'home', ...(now && { now: () => clock.now }) });
  try {
    await fn({ ...server, clock });
  } finally {
    await server.close();
    await rm(deckDir, { recursive: true, force: true });
    await rm(progressDir, { recursive: true, force: true });
  }
}

async function getSmartGroups(url) {
  const res = await fetch(`${url}/api/smart-groups`);
  assert.equal(res.status, 200);
  return (await res.json()).groups;
}

async function unpracticed(url) {
  const found = (await getSmartGroups(url)).find((g) => g.key === 'unpracticed');
  assert.ok(found, 'expected an unpracticed smart group');
  return found.ids;
}

async function dueToday(url) {
  const found = (await getSmartGroups(url)).find((g) => g.key === 'due-today');
  assert.ok(found, 'expected a due-today smart group');
  return found.ids;
}

async function scheduleOf(url, id) {
  const res = await fetch(`${url}/api/schedule`);
  return (await res.json()).cards.find((c) => c.id === id);
}

describe('smart groups API', () => {
  test('lists each smart group with key, display name and ids; due today comes before unpracticed', async () => {
    await withServer({ deck: { 'g/aaaaa.md': card() } }, async ({ url }) => {
      assert.deepEqual(await getSmartGroups(url), [
        { key: 'due-today', name: '今天到期', ids: [] },
        { key: 'unpracticed', name: '還沒練過', ids: ['aaaaa'] },
      ]);
    });
  });

  test('cards without any events are listed; reviewed cards are not', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': card(), 'g/bbbbb.md': card() },
      progress: { 'home.jsonl': jsonl(review('2026-01-01T00:00:00Z', 'bbbbb')) },
    }, async ({ url }) => {
      assert.deepEqual(await unpracticed(url), ['aaaaa']);
    });
  });

  test('a card with no review after its last reset is listed again', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': card(), 'g/bbbbb.md': card() },
      progress: {
        'home.jsonl': jsonl(
          review('2026-01-01T00:00:00Z', 'aaaaa'),
          reset('2026-01-02T00:00:00Z', 'aaaaa'),
          review('2026-01-01T00:00:00Z', 'bbbbb'),
          reset('2026-01-02T00:00:00Z', 'bbbbb'),
          review('2026-01-03T00:00:00Z', 'bbbbb'),
        ),
      },
    }, async ({ url }) => {
      assert.deepEqual(await unpracticed(url), ['aaaaa']);
    });
  });

  test('a card with only a reset is listed', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': card() },
      progress: { 'home.jsonl': jsonl(reset('2026-01-02T00:00:00Z', 'aaaaa')) },
    }, async ({ url }) => {
      assert.deepEqual(await unpracticed(url), ['aaaaa']);
    });
  });

  test('cards with format errors or duplicate ids are excluded', async () => {
    await withServer({
      deck: {
        'g/aaaaa.md': card(),
        'g/bad01.md': 'garbage',
        'g/BAD.md': card(),
        'g/dupe1.md': card(),
        'h/dupe1.md': card(),
      },
    }, async ({ url }) => {
      assert.deepEqual(await unpracticed(url), ['aaaaa']);
    });
  });

  test('events from every device are merged by time', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': card(), 'g/bbbbb.md': card(), 'g/ccccc.md': card() },
      progress: {
        'home.jsonl': jsonl(
          review('2026-01-01T00:00:00Z', 'aaaaa'),
          reset('2026-01-05T00:00:00Z', 'bbbbb'),
        ),
        'work.jsonl': jsonl(
          reset('2026-01-02T00:00:00Z', 'aaaaa'),
          review('2026-01-06T00:00:00Z', 'bbbbb'),
          review('2026-01-01T00:00:00Z', 'ccccc'),
        ),
      },
    }, async ({ url }) => {
      assert.deepEqual(await unpracticed(url), ['aaaaa']);
    });
  });

  test('events for missing cards and malformed lines do not matter', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': card() },
      progress: { 'home.jsonl': `garbage\n${jsonl(review('2026-01-01T00:00:00Z', 'gone1'))}` },
    }, async ({ url }) => {
      assert.deepEqual(await unpracticed(url), ['aaaaa']);
    });
  });

  test('ordered by reconciled group order, then reconciled card order within a group', async () => {
    await withServer({
      deck: {
        '_groups.json': { order: ['zeta', 'ghost'] },
        'alpha/aaaa2.md': card('2026-01-02T00:00:00Z'),
        'alpha/aaaa1.md': card('2026-01-01T00:00:00Z'),
        'beta/bbbbb.md': card(),
        'zeta/_group.json': { name: 'Z', order: ['zzzz2', 'ghost'] },
        'zeta/zzzz1.md': card(),
        'zeta/zzzz2.md': card(),
        'zeta/zzzz3.md': card(),
      },
      progress: { 'home.jsonl': jsonl(review('2026-01-01T00:00:00Z', 'zzzz3')) },
    }, async ({ url }) => {
      assert.deepEqual(await unpracticed(url), ['zzzz2', 'zzzz1', 'aaaa1', 'aaaa2', 'bbbbb']);
    });
  });

  test('rating a card removes it from unpracticed', async () => {
    await withServer({ deck: { 'g/aaaaa.md': card(), 'g/bbbbb.md': card() } }, async ({ url }) => {
      const res = await fetch(`${url}/api/progress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'aaaaa', type: 'review', rating: 'again' }),
      });
      assert.equal(res.status, 201);
      assert.deepEqual(await unpracticed(url), ['bbbbb']);
    });
  });

  test('without a progress folder every valid card is unpracticed', async () => {
    const deckDir = await makeDir('noesis-deck-', { 'g/aaaaa.md': card() });
    const server = await startServer({ deckDir });
    try {
      assert.deepEqual(await unpracticed(server.url), ['aaaaa']);
    } finally {
      await server.close();
      await rm(deckDir, { recursive: true, force: true });
    }
  });

  test('only GET is allowed', async () => {
    await withServer({ deck: { 'g/aaaaa.md': card() } }, async ({ url }) => {
      assert.equal((await fetch(`${url}/api/smart-groups`, { method: 'POST' })).status, 405);
    });
  });
});

describe('due today smart group', () => {
  // Local times, so the 4am day boundary does not depend on the machine's time zone.
  const local = (day, h, m = 0) => new Date(2026, 0, day, h, m);

  async function dueOf(id, reviewedAt) {
    const progress = { 'home.jsonl': jsonl(review(reviewedAt.toISOString(), id)) };
    let due;
    await withServer({ deck: { [`g/${id}.md`]: card() }, progress, now: reviewedAt }, async ({ url }) => {
      due = new Date((await scheduleOf(url, id)).due);
    });
    return due;
  }

  test('overdue cards and cards due before the next local 4am are listed; later ones are not', async () => {
    const noonReview = local(10, 12);
    const lateReview = local(10, 3, 30);
    const noonDue = await dueOf('noon1', noonReview);
    const lateDue = await dueOf('late1', lateReview);
    assert.deepEqual([noonDue.getHours(), lateDue.getHours(), lateDue.getMinutes()], [12, 3, 30]);
    const progress = { 'home.jsonl': jsonl(review(noonReview.toISOString(), 'noon1'), review(lateReview.toISOString(), 'late1')) };
    const deck = { 'g/noon1.md': card(), 'g/late1.md': card() };
    const at = (base, dayOffset, h) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, h);
    const cases = [
      [at(noonDue, -1, 20), 'noon1', false],
      [at(noonDue, 0, 4), 'noon1', true],
      [at(noonDue, 0, 13), 'noon1', true],
      [at(noonDue, 5, 12), 'noon1', true],
      [at(lateDue, -2, 23), 'late1', false],
      [at(lateDue, -1, 4), 'late1', true],
      [at(lateDue, -1, 23), 'late1', true],
    ];
    for (const [now, id, listed] of cases) {
      await withServer({ deck, progress, now }, async ({ url }) => {
        assert.equal((await dueToday(url)).includes(id), listed, `${id} at ${now}`);
      });
    }
  });

  test('new, reset and malformed cards are excluded', async () => {
    await withServer({
      deck: {
        'g/aaaaa.md': card(),
        'g/bbbbb.md': card(),
        'g/ccccc.md': card(),
        'g/bad01.md': 'garbage',
        'g/dupe1.md': card(),
        'h/dupe1.md': card(),
      },
      progress: {
        'home.jsonl': jsonl(
          review('2026-01-01T00:00:00Z', 'aaaaa'),
          review('2026-01-01T00:00:00Z', 'ccccc'),
          reset('2026-01-02T00:00:00Z', 'ccccc'),
          review('2026-01-01T00:00:00Z', 'bad01'),
          review('2026-01-01T00:00:00Z', 'dupe1'),
        ),
      },
      now: new Date('2026-03-01T12:00:00Z'),
    }, async ({ url }) => {
      assert.deepEqual(await dueToday(url), ['aaaaa']);
    });
  });

  test('ordered by retrievability from low to high, then by id', async () => {
    await withServer({
      deck: {
        'g/ccccc.md': card('2026-01-01T00:00:00Z'),
        'g/bbbbb.md': card('2026-01-02T00:00:00Z'),
        'g/aaaaa.md': card('2026-01-03T00:00:00Z'),
        'g/zzzzz.md': card('2026-01-04T00:00:00Z'),
      },
      progress: {
        'home.jsonl': jsonl(
          review('2026-01-01T00:00:00Z', 'aaaaa', 'easy'),
          review('2026-01-01T00:00:00Z', 'bbbbb', 'easy'),
          review('2026-01-01T00:00:00Z', 'ccccc', 'easy'),
          review('2026-01-01T00:00:00Z', 'zzzzz', 'again'),
        ),
      },
      now: new Date('2026-06-01T12:00:00Z'),
    }, async ({ url }) => {
      const r = async (id) => (await scheduleOf(url, id)).retrievability;
      assert.ok(await r('zzzzz') < await r('aaaaa'));
      assert.equal(await r('aaaaa'), await r('ccccc'));
      assert.deepEqual(await dueToday(url), ['zzzzz', 'aaaaa', 'bbbbb', 'ccccc']);
    });
  });

  test('rating a due card removes it from due today', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': card(), 'g/bbbbb.md': card() },
      progress: { 'home.jsonl': jsonl(review('2026-01-01T00:00:00Z', 'aaaaa'), review('2026-01-01T00:00:00Z', 'bbbbb')) },
      now: new Date('2026-03-01T12:00:00Z'),
    }, async ({ url }) => {
      assert.deepEqual(await dueToday(url), ['aaaaa', 'bbbbb']);
      const res = await fetch(`${url}/api/progress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'aaaaa', type: 'review', rating: 'good' }),
      });
      assert.equal(res.status, 201);
      assert.deepEqual(await dueToday(url), ['bbbbb']);
    });
  });
});

describe('reset and suspend', () => {
  const NOW = new Date('2026-03-01T12:00:00Z');
  const reviewed = { 'home.jsonl': jsonl(review('2026-01-01T00:00:00Z', 'aaaaa')) };

  async function post(url, body) {
    const res = await fetch(`${url}/api/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 201);
  }

  test('reset brings a due card back to unpracticed and out of due today', async () => {
    await withServer({ deck: { 'g/aaaaa.md': card() }, progress: reviewed, now: NOW }, async ({ url }) => {
      assert.deepEqual(await dueToday(url), ['aaaaa']);
      await post(url, { id: 'aaaaa', type: 'reset' });
      assert.deepEqual(await dueToday(url), []);
      assert.deepEqual(await unpracticed(url), ['aaaaa']);
      assert.equal((await scheduleOf(url, 'aaaaa')).status, 'new');
    });
  });

  test('suspend removes a card from both smart groups and flags its schedule', async () => {
    await withServer({ deck: { 'g/aaaaa.md': card(), 'g/bbbbb.md': card() }, progress: reviewed, now: NOW }, async ({ url }) => {
      const before = await scheduleOf(url, 'aaaaa');
      assert.equal(before.suspended, false);
      await post(url, { id: 'aaaaa', type: 'suspend' });
      await post(url, { id: 'bbbbb', type: 'suspend' });
      assert.deepEqual(await dueToday(url), []);
      assert.deepEqual(await unpracticed(url), []);
      assert.deepEqual(await scheduleOf(url, 'aaaaa'), { ...before, suspended: true });
      assert.equal((await scheduleOf(url, 'bbbbb')).suspended, true);
    });
  });

  test('unsuspend brings a card back and its schedule carries on from earlier reviews', async () => {
    await withServer({ deck: { 'g/aaaaa.md': card(), 'g/bbbbb.md': card() }, progress: reviewed, now: NOW }, async ({ url, clock }) => {
      const before = await scheduleOf(url, 'aaaaa');
      await post(url, { id: 'aaaaa', type: 'suspend' });
      await post(url, { id: 'bbbbb', type: 'suspend' });
      clock.now = new Date('2026-03-05T12:00:00Z');
      await post(url, { id: 'aaaaa', type: 'unsuspend' });
      await post(url, { id: 'bbbbb', type: 'unsuspend' });
      assert.deepEqual(await dueToday(url), ['aaaaa']);
      assert.deepEqual(await unpracticed(url), ['bbbbb']);
      const after = await scheduleOf(url, 'aaaaa');
      assert.equal(after.suspended, false);
      assert.equal(after.status, 'scheduled');
      assert.equal(after.due, before.due);
    });
  });

  test('the last suspend or unsuspend decides, whatever the device', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': card(), 'g/bbbbb.md': card() },
      progress: {
        'home.jsonl': jsonl(suspend('2026-01-01T00:00:00Z', 'aaaaa'), unsuspend('2026-01-03T00:00:00Z', 'bbbbb')),
        'work.jsonl': jsonl(unsuspend('2026-01-02T00:00:00Z', 'aaaaa'), suspend('2026-01-02T00:00:00Z', 'bbbbb')),
      },
    }, async ({ url }) => {
      assert.deepEqual(await unpracticed(url), ['aaaaa', 'bbbbb']);
    });
    await withServer({
      deck: { 'g/aaaaa.md': card(), 'g/bbbbb.md': card() },
      progress: {
        'home.jsonl': jsonl(unsuspend('2026-01-01T00:00:00Z', 'aaaaa'), suspend('2026-01-03T00:00:00Z', 'bbbbb')),
        'work.jsonl': jsonl(suspend('2026-01-02T00:00:00Z', 'aaaaa'), unsuspend('2026-01-02T00:00:00Z', 'bbbbb')),
      },
    }, async ({ url }) => {
      assert.deepEqual(await unpracticed(url), []);
    });
  });

  test('reset does not change the suspended state, and suspend does not reset', async () => {
    await withServer({ deck: { 'g/aaaaa.md': card() }, progress: reviewed, now: NOW }, async ({ url }) => {
      await post(url, { id: 'aaaaa', type: 'suspend' });
      await post(url, { id: 'aaaaa', type: 'reset' });
      const s = await scheduleOf(url, 'aaaaa');
      assert.equal(s.suspended, true);
      assert.equal(s.status, 'new');
      assert.deepEqual(await unpracticed(url), []);
      await post(url, { id: 'aaaaa', type: 'unsuspend' });
      assert.deepEqual(await unpracticed(url), ['aaaaa']);
      assert.deepEqual(await dueToday(url), []);
    });
  });

  test('invalid suspend events are rejected and change nothing', async () => {
    await withServer({ deck: { 'g/aaaaa.md': card() }, progress: reviewed, now: NOW }, async ({ url }) => {
      for (const body of [{ id: 'aaaaa', type: 'suspended' }, { id: 'AAAAA', type: 'suspend' }, { type: 'unsuspend' }]) {
        const res = await fetch(`${url}/api/progress`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 400);
      }
      assert.deepEqual(await dueToday(url), ['aaaaa']);
      assert.equal((await scheduleOf(url, 'aaaaa')).suspended, false);
    });
  });
});

describe('cards not on FSRS in smart groups', () => {
  test('an unreviewed unscheduled card is unpracticed; a reviewed one is in neither group, however long ago', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': scheduled('none'), 'g/bbbbb.md': scheduled('none') },
      progress: { 'home.jsonl': jsonl(seen('2025-01-01T00:00:00Z', 'bbbbb')) },
    }, async ({ url }) => {
      assert.deepEqual(await unpracticed(url), ['aaaaa']);
      assert.deepEqual(await dueToday(url), []);
    });
  });

  test('a card shown every N days is due today once N days have passed', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': scheduled('7d'), 'g/bbbbb.md': scheduled('90d'), 'g/ccccc.md': scheduled('7d') },
      progress: { 'home.jsonl': jsonl(seen('2026-01-01T12:00:00Z', 'aaaaa'), seen('2026-01-01T12:00:00Z', 'bbbbb')) },
      now: new Date('2026-01-20T12:00:00Z'),
    }, async ({ url }) => {
      assert.deepEqual(await dueToday(url), ['aaaaa']);
      assert.deepEqual(await unpracticed(url), ['ccccc']);
    });
  });

  test('a suspended unscheduled card is in neither group', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': scheduled('none') },
      progress: { 'home.jsonl': jsonl(suspend('2026-01-01T00:00:00Z', 'aaaaa')) },
    }, async ({ url }) => {
      assert.deepEqual(await unpracticed(url), []);
    });
  });
});
