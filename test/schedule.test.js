import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fsrs, createEmptyCard, Rating } from 'ts-fsrs';
import { startServer } from '../server/app.js';

const CARD = '---\ncreated: 2026-01-01T00:00:00Z\n---\n\n## Question\n\nQ\n\n## Answer\n\nA\n';
const withSchedule = (schedule) => CARD.replace('---\n\n', `schedule: ${schedule}\n---\n\n`);
const NONE = withSchedule('none');
const EVERY_30 = withSchedule('30d');
const jsonl = (...events) => events.map((e) => `${JSON.stringify(e)}\n`).join('');
const review = (time, id, rating = 'good') => ({ time, id, type: 'review', rating });
const reset = (time, id) => ({ time, id, type: 'reset' });
const seen = (time, id) => ({ time, id, type: 'review' });
const suspend = (time, id) => ({ time, id, type: 'suspend' });
const GRADES = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };

// What ts-fsrs itself says for a sequence of reviews, so tests never pin FSRS numbers.
function expectedCard(reviews) {
  const scheduler = fsrs({ enable_short_term: false });
  let card = null;
  for (const { time, rating } of reviews) {
    const at = new Date(time);
    card = scheduler.next(card ?? createEmptyCard(at), at, GRADES[rating]).card;
  }
  return card;
}

async function makeDir(prefix, files) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

async function withServer({ deck = {}, progress = {}, now = new Date('2026-02-01T12:00:00Z') }, fn) {
  const deckDir = await makeDir('noesis-deck-', deck);
  const progressDir = await makeDir('noesis-progress-', progress);
  const clock = { now };
  const server = await startServer({ deckDir, progressDir, device: 'home', now: () => clock.now });
  try {
    await fn({ ...server, deckDir, progressDir, clock });
  } finally {
    await server.close();
    await rm(deckDir, { recursive: true, force: true });
    await rm(progressDir, { recursive: true, force: true });
  }
}

async function getSchedule(url) {
  const res = await fetch(`${url}/api/schedule`);
  assert.equal(res.status, 200);
  return (await res.json()).cards;
}

async function scheduleOf(url, id) {
  const found = (await getSchedule(url)).find((c) => c.id === id);
  assert.ok(found, `expected a schedule for ${id}`);
  return found;
}

describe('card schedule API', () => {
  test('a card without events is new and has no due time', async () => {
    await withServer({ deck: { 'g/aaaaa.md': CARD } }, async ({ url }) => {
      const [{ preview, ...s }] = await getSchedule(url);
      assert.deepEqual(s, { id: 'aaaaa', status: 'new', due: null, dueInDays: null, retrievability: null, suspended: false, lastReview: null });
    });
  });

  test('a reviewed card is scheduled with the due time ts-fsrs computes', async () => {
    const reviews = [review('2026-01-10T12:00:00Z', 'aaaaa', 'good')];
    await withServer({ deck: { 'g/aaaaa.md': CARD }, progress: { 'home.jsonl': jsonl(...reviews) } }, async ({ url }) => {
      const s = await scheduleOf(url, 'aaaaa');
      assert.equal(s.status, 'scheduled');
      assert.equal(s.due, expectedCard(reviews).due.toISOString());
      assert.equal(typeof s.dueInDays, 'number');
      assert.ok(s.retrievability > 0 && s.retrievability < 1);
    });
  });

  test('events from every device are merged and replayed in time order', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': CARD },
      progress: {
        'home.jsonl': jsonl(review('2026-01-01T12:00:00Z', 'aaaaa', 'again'), review('2026-01-09T12:00:00Z', 'aaaaa', 'good')),
        'work.jsonl': jsonl(review('2026-01-03T12:00:00Z', 'aaaaa', 'easy')),
      },
    }, async ({ url }) => {
      const expected = expectedCard([
        review('2026-01-01T12:00:00Z', 'aaaaa', 'again'),
        review('2026-01-03T12:00:00Z', 'aaaaa', 'easy'),
        review('2026-01-09T12:00:00Z', 'aaaaa', 'good'),
      ]);
      assert.equal((await scheduleOf(url, 'aaaaa')).due, expected.due.toISOString());
    });
  });

  test('several reviews on the same day are all replayed in order', async () => {
    const reviews = [
      review('2026-01-10T09:00:00Z', 'aaaaa', 'again'),
      review('2026-01-10T09:05:00Z', 'aaaaa', 'hard'),
      review('2026-01-10T09:10:00Z', 'aaaaa', 'easy'),
    ];
    await withServer({ deck: { 'g/aaaaa.md': CARD }, progress: { 'home.jsonl': jsonl(...reviews) } }, async ({ url }) => {
      const due = (await scheduleOf(url, 'aaaaa')).due;
      assert.equal(due, expectedCard(reviews).due.toISOString());
      assert.notEqual(due, expectedCard(reviews.slice(-1)).due.toISOString());
    });
  });

  test('only reviews after the last reset count; a reset with no review after it means new', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': CARD, 'g/bbbbb.md': CARD },
      progress: {
        'home.jsonl': jsonl(
          review('2026-01-01T12:00:00Z', 'aaaaa', 'easy'),
          review('2026-01-05T12:00:00Z', 'aaaaa', 'easy'),
          reset('2026-01-06T12:00:00Z', 'aaaaa'),
          review('2026-01-07T12:00:00Z', 'aaaaa', 'hard'),
          review('2026-01-01T12:00:00Z', 'bbbbb', 'good'),
        ),
        'work.jsonl': jsonl(reset('2026-01-02T12:00:00Z', 'bbbbb')),
      },
    }, async ({ url }) => {
      const expected = expectedCard([review('2026-01-07T12:00:00Z', 'aaaaa', 'hard')]);
      assert.equal((await scheduleOf(url, 'aaaaa')).due, expected.due.toISOString());
      assert.equal((await scheduleOf(url, 'bbbbb')).status, 'new');
    });
  });

  test('reviews of deleted cards are ignored but stay on disk; cards with format errors are left out', async () => {
    const log = jsonl(review('2026-01-01T12:00:00Z', 'gone1'), review('2026-01-01T12:00:00Z', 'bad01'));
    await withServer({
      deck: { 'g/aaaaa.md': CARD, 'g/bad01.md': 'garbage', 'g/dupe1.md': CARD, 'h/dupe1.md': CARD },
      progress: { 'home.jsonl': log },
    }, async ({ url, progressDir }) => {
      assert.deepEqual((await getSchedule(url)).map((c) => c.id), ['aaaaa']);
      assert.equal(await readFile(path.join(progressDir, 'home.jsonl'), 'utf8'), log);
    });
  });

  test('cards follow reconciled group order then card order', async () => {
    await withServer({
      deck: { '_groups.json': JSON.stringify({ order: ['b'] }), 'a/aaaaa.md': CARD, 'b/bbbb2.md': CARD, 'b/bbbb1.md': CARD },
    }, async ({ url }) => {
      assert.deepEqual((await getSchedule(url)).map((c) => c.id), ['bbbb1', 'bbbb2', 'aaaaa']);
    });
  });

  test('retrievability falls as the injected clock moves on', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': CARD },
      progress: { 'home.jsonl': jsonl(review('2026-01-10T12:00:00Z', 'aaaaa')) },
      now: new Date('2026-01-11T12:00:00Z'),
    }, async ({ url, clock }) => {
      const early = (await scheduleOf(url, 'aaaaa')).retrievability;
      clock.now = new Date('2026-03-01T12:00:00Z');
      const late = (await scheduleOf(url, 'aaaaa')).retrievability;
      assert.ok(late < early, `${late} < ${early}`);
    });
  });

  test('a day starts at 4am local time', async () => {
    // Reviewed at 03:30 local, so it is due at 03:30 local some days later: still the previous day.
    const reviewedAt = new Date(2026, 0, 10, 3, 30);
    await withServer({
      deck: { 'g/aaaaa.md': CARD },
      progress: { 'home.jsonl': jsonl(review(reviewedAt.toISOString(), 'aaaaa')) },
      now: reviewedAt,
    }, async ({ url, clock }) => {
      const due = new Date((await scheduleOf(url, 'aaaaa')).due);
      assert.deepEqual([due.getHours(), due.getMinutes()], [3, 30]);
      const at = (dayOffset, h, m) => new Date(due.getFullYear(), due.getMonth(), due.getDate() + dayOffset, h, m);
      const dueInDays = async (now) => {
        clock.now = now;
        return (await scheduleOf(url, 'aaaaa')).dueInDays;
      };
      assert.equal(await dueInDays(at(-1, 3, 59)), 1);
      assert.equal(await dueInDays(at(-1, 4, 0)), 0);
      assert.equal(await dueInDays(at(0, 3, 59)), 0);
      assert.equal(await dueInDays(at(0, 4, 0)), -1);
      assert.equal(await dueInDays(at(3, 4, 0)), -4);
    });
  });

  test('a rating through the API is timed by the injected clock and reschedules the card', async () => {
    const now = new Date('2026-01-10T12:00:00Z');
    await withServer({ deck: { 'g/aaaaa.md': CARD }, now }, async ({ url, progressDir }) => {
      const res = await fetch(`${url}/api/progress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'aaaaa', type: 'review', rating: 'good' }),
      });
      assert.equal(res.status, 201);
      const [event] = (await readFile(path.join(progressDir, 'home.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(event.time, now.toISOString());
      const s = await scheduleOf(url, 'aaaaa');
      assert.equal(s.status, 'scheduled');
      assert.equal(s.due, expectedCard([review(now.toISOString(), 'aaaaa', 'good')]).due.toISOString());
    });
  });

  for (const [label, progress] of [
    ['a new card', {}],
    ['a reviewed card', { 'home.jsonl': jsonl(review('2026-01-10T12:00:00Z', 'aaaaa', 'hard'), review('2026-01-20T12:00:00Z', 'aaaaa', 'good')) }],
  ]) {
    test(`${label} previews the interval in days for every rating, in increasing order`, async () => {
      await withServer({ deck: { 'g/aaaaa.md': CARD }, progress }, async ({ url }) => {
        const { preview } = await scheduleOf(url, 'aaaaa');
        assert.deepEqual(Object.keys(preview).sort(), ['again', 'easy', 'good', 'hard']);
        for (const days of Object.values(preview)) assert.ok(Number.isInteger(days) && days >= 0, `${days}`);
        assert.ok(preview.again <= preview.hard && preview.hard <= preview.good && preview.good <= preview.easy, JSON.stringify(preview));
      });
    });
  }

  for (const rating of Object.keys(GRADES)) {
    test(`the ${rating} preview matches the due time after rating ${rating}`, async () => {
      const now = new Date('2026-02-01T12:00:00Z');
      await withServer({
        deck: { 'g/aaaaa.md': CARD, 'g/bbbbb.md': CARD },
        progress: { 'home.jsonl': jsonl(review('2026-01-10T12:00:00Z', 'aaaaa', 'good')) },
        now,
      }, async ({ url }) => {
        const before = new Map((await getSchedule(url)).map((c) => [c.id, c.preview[rating]]));
        for (const id of ['aaaaa', 'bbbbb']) {
          const res = await fetch(`${url}/api/progress`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, type: 'review', rating }),
          });
          assert.equal(res.status, 201);
          const due = new Date((await scheduleOf(url, id)).due);
          assert.equal(due.getTime(), now.getTime() + before.get(id) * 24 * 60 * 60 * 1000, id);
        }
      });
    });
  }

  test('reviews with an unknown rating are ignored', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': CARD },
      progress: { 'home.jsonl': jsonl(review('2026-01-10T12:00:00Z', 'aaaaa', 'constructor')) },
    }, async ({ url }) => {
      assert.equal((await scheduleOf(url, 'aaaaa')).status, 'new');
    });
  });

  test('without a progress folder every valid card is new', async () => {
    const deckDir = await makeDir('noesis-deck-', { 'g/aaaaa.md': CARD });
    const server = await startServer({ deckDir });
    try {
      assert.deepEqual((await getSchedule(server.url)).map((c) => c.status), ['new']);
    } finally {
      await server.close();
      await rm(deckDir, { recursive: true, force: true });
    }
  });

  test('only GET is allowed and reading writes nothing', async () => {
    await withServer({ deck: { 'g/aaaaa.md': CARD } }, async ({ url, progressDir }) => {
      assert.equal((await fetch(`${url}/api/schedule`, { method: 'POST' })).status, 405);
      await getSchedule(url);
      assert.deepEqual(await readdir(progressDir), []);
    });
  });
});

describe('last review', () => {
  test('is null for a card without reviews', async () => {
    await withServer({ deck: { 'g/aaaaa.md': CARD } }, async ({ url }) => {
      assert.equal((await scheduleOf(url, 'aaaaa')).lastReview, null);
    });
  });

  test('is the latest review across every device', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': CARD },
      progress: {
        'home.jsonl': jsonl(review('2026-01-01T12:00:00Z', 'aaaaa', 'good'), review('2026-01-09T12:00:00Z', 'aaaaa', 'easy')),
        'work.jsonl': jsonl(review('2026-01-20T12:00:00Z', 'aaaaa', 'hard'), review('2026-01-05T12:00:00Z', 'aaaaa', 'again')),
      },
    }, async ({ url }) => {
      const { lastReview } = await scheduleOf(url, 'aaaaa');
      assert.equal(lastReview.time, '2026-01-20T12:00:00Z');
      assert.equal(lastReview.rating, 'hard');
    });
  });

  test('daysAgo counts days that start at 4am local time', async () => {
    const reviewedAt = new Date(2026, 0, 10, 4, 0);
    await withServer({
      deck: { 'g/aaaaa.md': CARD },
      progress: { 'home.jsonl': jsonl(review(reviewedAt.toISOString(), 'aaaaa', 'good')) },
      now: reviewedAt,
    }, async ({ url, clock }) => {
      const daysAgo = async (now) => {
        clock.now = now;
        return (await scheduleOf(url, 'aaaaa')).lastReview.daysAgo;
      };
      assert.equal(await daysAgo(new Date(2026, 0, 10, 4, 0)), 0);
      assert.equal(await daysAgo(new Date(2026, 0, 11, 3, 59)), 0);
      assert.equal(await daysAgo(new Date(2026, 0, 11, 4, 0)), 1);
      assert.equal(await daysAgo(new Date(2026, 0, 14, 3, 59)), 3);
      assert.equal(await daysAgo(new Date(2026, 0, 14, 4, 0)), 4);
    });
  });

  test('a review just before 4am belongs to the previous day', async () => {
    const reviewedAt = new Date(2026, 0, 10, 3, 59);
    await withServer({
      deck: { 'g/aaaaa.md': CARD },
      progress: { 'home.jsonl': jsonl(review(reviewedAt.toISOString(), 'aaaaa', 'good')) },
      now: new Date(2026, 0, 10, 4, 0),
    }, async ({ url }) => {
      assert.equal((await scheduleOf(url, 'aaaaa')).lastReview.daysAgo, 1);
    });
  });

  test('is null after a reset until the next review, which is then the only one seen', async () => {
    const now = new Date('2026-01-10T12:00:00Z');
    await withServer({
      deck: { 'g/aaaaa.md': CARD },
      progress: {
        'home.jsonl': jsonl(review('2026-01-01T12:00:00Z', 'aaaaa', 'easy')),
        'work.jsonl': jsonl(reset('2026-01-02T12:00:00Z', 'aaaaa')),
      },
      now,
    }, async ({ url }) => {
      assert.equal((await scheduleOf(url, 'aaaaa')).lastReview, null);
      const res = await fetch(`${url}/api/progress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'aaaaa', type: 'review', rating: 'hard' }),
      });
      assert.equal(res.status, 201);
      assert.deepEqual((await scheduleOf(url, 'aaaaa')).lastReview, { time: now.toISOString(), rating: 'hard', daysAgo: 0 });
    });
  });

  test('is still reported for a suspended card', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': CARD },
      progress: { 'home.jsonl': jsonl(review('2026-01-28T12:00:00Z', 'aaaaa', 'good'), suspend('2026-01-29T12:00:00Z', 'aaaaa')) },
    }, async ({ url }) => {
      const s = await scheduleOf(url, 'aaaaa');
      assert.equal(s.suspended, true);
      assert.equal(s.lastReview.rating, 'good');
      assert.equal(s.lastReview.time, '2026-01-28T12:00:00Z');
    });
  });
});

describe('unscheduled cards', () => {
  test('are new until reviewed, then practiced, and never due', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': NONE, 'g/bbbbb.md': NONE },
      progress: { 'home.jsonl': jsonl(seen('2026-01-10T12:00:00Z', 'bbbbb')) },
    }, async ({ url }) => {
      assert.deepEqual(await scheduleOf(url, 'aaaaa'), {
        id: 'aaaaa', status: 'new', due: null, dueInDays: null, retrievability: null, preview: null, suspended: false, lastReview: null,
      });
      const s = await scheduleOf(url, 'bbbbb');
      assert.equal(s.status, 'practiced');
      assert.equal(s.due, null);
      assert.deepEqual(s.lastReview, { time: '2026-01-10T12:00:00Z', daysAgo: 22 });
    });
  });

  test('a graded review counts as practiced too', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': NONE },
      progress: { 'home.jsonl': jsonl(review('2026-01-10T12:00:00Z', 'aaaaa', 'again')) },
    }, async ({ url }) => {
      assert.equal((await scheduleOf(url, 'aaaaa')).status, 'practiced');
    });
  });

  test('a reset makes a practiced card new again', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': NONE },
      progress: { 'home.jsonl': jsonl(seen('2026-01-10T12:00:00Z', 'aaaaa'), reset('2026-01-11T12:00:00Z', 'aaaaa')) },
    }, async ({ url }) => {
      const s = await scheduleOf(url, 'aaaaa');
      assert.equal(s.status, 'new');
      assert.equal(s.lastReview, null);
    });
  });
});

describe('cards shown every N days', () => {
  test('are new until reviewed, then due N days after the last review, whatever its rating', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': EVERY_30, 'g/bbbbb.md': EVERY_30 },
      progress: { 'home.jsonl': jsonl(review('2026-01-01T12:00:00Z', 'bbbbb', 'easy'), seen('2026-01-10T12:00:00Z', 'bbbbb')) },
    }, async ({ url }) => {
      const fresh = await scheduleOf(url, 'aaaaa');
      assert.equal(fresh.status, 'new');
      assert.deepEqual(fresh.preview, { seen: 30 });
      const s = await scheduleOf(url, 'bbbbb');
      assert.equal(s.status, 'scheduled');
      assert.equal(s.due, '2026-02-09T12:00:00.000Z');
      assert.equal(s.dueInDays, 8);
      assert.equal(s.retrievability, null);
      assert.deepEqual(s.preview, { seen: 30 });
    });
  });

  test('a reset makes the card new again', async () => {
    await withServer({
      deck: { 'g/aaaaa.md': EVERY_30 },
      progress: { 'home.jsonl': jsonl(seen('2026-01-10T12:00:00Z', 'aaaaa'), reset('2026-01-11T12:00:00Z', 'aaaaa')) },
    }, async ({ url }) => {
      assert.equal((await scheduleOf(url, 'aaaaa')).status, 'new');
    });
  });
});

describe('changing a card\'s schedule', () => {
  test('keeps its progress: FSRS replays graded reviews and skips the ungraded ones', async () => {
    const graded = [review('2026-01-05T12:00:00Z', 'aaaaa', 'good')];
    const progress = { 'home.jsonl': jsonl(...graded, seen('2026-01-20T12:00:00Z', 'aaaaa')) };
    await withServer({ deck: { 'g/aaaaa.md': CARD }, progress }, async ({ url }) => {
      const s = await scheduleOf(url, 'aaaaa');
      assert.equal(s.due, expectedCard(graded).due.toISOString());
      assert.equal(s.lastReview.time, '2026-01-20T12:00:00Z');
    });
    await withServer({ deck: { 'g/aaaaa.md': EVERY_30 }, progress }, async ({ url }) => {
      assert.equal((await scheduleOf(url, 'aaaaa')).due, '2026-02-19T12:00:00.000Z');
    });
  });

  test('through the API rewrites only the frontmatter, and fsrs removes the line', async () => {
    await withServer({ deck: { 'g/aaaaa.md': CARD } }, async ({ url, deckDir }) => {
      const put = (schedule) => fetch(`${url}/api/cards/g/aaaaa/schedule`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schedule }),
      });
      const file = path.join(deckDir, 'g/aaaaa.md');
      assert.equal((await put('30d')).status, 200);
      assert.equal(await readFile(file, 'utf8'), EVERY_30);
      assert.equal((await put('none')).status, 200);
      assert.equal(await readFile(file, 'utf8'), NONE);
      assert.equal((await put('fsrs')).status, 200);
      assert.equal(await readFile(file, 'utf8'), CARD);
      assert.equal((await put('weekly')).status, 400);
      assert.equal(await readFile(file, 'utf8'), CARD);
    });
  });
});
