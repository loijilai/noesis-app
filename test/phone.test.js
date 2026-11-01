import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeEvents, toEvent } from '../phone/events.js';
import { editedCard, newEdit, withImages } from '../phone/cards.js';
import { cardVersion, loadDeck } from '../server/deck.js';

const IMPORT = fileURLToPath(new URL('../scripts/phone-import.js', import.meta.url));
const EDITS = fileURLToPath(new URL('../scripts/phone-edits.js', import.meta.url));
const review = (time, id, rating) => ({ time, id, type: 'review', rating });

test('mergeEvents drops events seen twice and orders by time', () => {
  const a = review('2026-10-17T02:00:00.000Z', 'abcde', 'good');
  const b = review('2026-10-17T01:00:00.000Z', 'abcde', 'good');
  assert.deepEqual(mergeEvents([a, b], [{ ...a }]), [b, a]);
});

test('toEvent accepts reviews and markers and rejects the rest', () => {
  const now = new Date('2026-10-17T00:00:00.000Z');
  assert.deepEqual(toEvent({ id: 'abcde', type: 'review', rating: 'easy' }, now), review(now.toISOString(), 'abcde', 'easy'));
  assert.deepEqual(toEvent({ id: 'abcde', type: 'suspend' }, now), { time: now.toISOString(), id: 'abcde', type: 'suspend' });
  assert.deepEqual(toEvent({ id: 'abcde', type: 'review' }, now), { time: now.toISOString(), id: 'abcde', type: 'review' });
  assert.equal(toEvent({ id: 'abcde', type: 'practice' }, now), null);
  assert.equal(toEvent({ id: 'abcde', type: 'review', rating: 'meh' }, now), null);
  assert.equal(toEvent({ id: 'TOO-LONG', type: 'reset' }, now), null);
});

test('phone:import appends only events not already in progress/phone.jsonl', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'noesis-phone-'));
  try {
    const first = review('2026-10-17T01:00:00.000Z', 'abcde', 'good');
    const second = review('2026-10-17T02:00:00.000Z', 'fghij', 'again');
    const rows = (...events) => JSON.stringify([{ id: 'doc1', data: { events } }]);
    const run = async (body) => {
      await writeFile(path.join(dir, 'rows.json'), body);
      return execFileSync(process.execPath, [IMPORT, 'rows.json'], { cwd: dir, encoding: 'utf8' });
    };

    assert.match(await run(rows(first)), /新增 1 筆/);
    assert.match(await run(rows(second, first, { id: 'abcde', type: 'review' })), /新增 1 筆，略過已匯入 1 筆、格式不對 1 筆/);
    await mkdir(path.join(dir, 'export/events'), { recursive: true });
    await writeFile(path.join(dir, 'export/events/d1.json'), JSON.stringify({ events: [second] }));
    assert.match(execFileSync(process.execPath, [IMPORT, 'export'], { cwd: dir, encoding: 'utf8' }), /新增 0 筆，略過已匯入 1 筆/);
    const lines = (await readFile(path.join(dir, 'progress/phone.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines, [first, second]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const cardText = (question) => `---\ncreated: 2026-01-01T00:00:00Z\n---\n\n## Question\n\n${question}\n\n## Answer\n\nA\n`;

async function withDeck(cards, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'noesis-phone-'));
  try {
    for (const [id, question] of Object.entries(cards)) {
      await mkdir(path.join(dir, 'decks/g'), { recursive: true });
      await writeFile(path.join(dir, 'decks/g', `${id}.md`), cardText(question));
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('an edit shows only while the snapshot still holds the text it was made from', async () => {
  await withDeck({ abcde: 'old' }, async (dir) => {
    const [card] = (await loadDeck(path.join(dir, 'decks'))).cards;
    const edit = newEdit(card, cardText('new'), new Date('2026-10-23T00:00:00.000Z'));
    assert.equal(edit.base, card.version);
    const shown = editedCard(card, edit);
    assert.equal(shown.sections[0].body, 'new');
    assert.equal(shown.version, edit.time);
    assert.equal(editedCard({ ...card, version: 'rebuilt' }, edit).sections[0].body, 'old');
  });
});

test('withImages swaps asset paths in what is shown but leaves raw alone', () => {
  const card = { raw: '![](../assets/a.png)', sections: [{ name: 'Question', body: '![](../assets/a.png)' }] };
  const shown = withImages(card, { '../assets/a.png': 'data:image/png;base64,AAAA' });
  assert.equal(shown.sections[0].body, '![](data:image/png;base64,AAAA)');
  assert.equal(shown.raw, card.raw);
});

test('phone:edits writes clean edits back, skips applied ones and leaves conflicts alone', async () => {
  await withDeck({ aaaaa: 'a', bbbbb: 'b', ccccc: 'c', ddddd: 'd' }, async (dir) => {
    const { cards } = await loadDeck(path.join(dir, 'decks'));
    const version = (id) => cards.find((c) => c.id === id).version;
    const edit = (id, raw, base) => ({ id, raw, base, time: '2026-10-23T00:00:00.000Z' });
    await mkdir(path.join(dir, 'export/edits'), { recursive: true });
    await writeFile(path.join(dir, 'export/edits/aaaaa.json'), JSON.stringify(edit('aaaaa', cardText('a2'), version('aaaaa'))));
    await writeFile(path.join(dir, 'export/edits/bbbbb.json'), JSON.stringify({ id: 'bbbbb', data: edit('bbbbb', cardText('b'), 'older') }));
    await writeFile(path.join(dir, 'export/edits/ccccc.json'), JSON.stringify(edit('ccccc', cardText('c2'), 'older')));
    await writeFile(path.join(dir, 'export/edits/ddddd.json'), JSON.stringify(edit('ddddd', '## Question\n\nno answer\n', version('ddddd'))));
    await writeFile(path.join(dir, 'export/edits/zzzzz.json'), JSON.stringify(edit('zzzzz', cardText('z'), 'older')));
    const run = (...extra) => execFileSync(process.execPath, [EDITS, 'export', ...extra], { cwd: dir, encoding: 'utf8' });

    const out = run();
    assert.match(out, /寫入 1 張（g\/aaaaa），已經寫入過 1 張/);
    assert.match(out, /衝突：g\/ccccc、zzzzz（電腦上已經沒有這張卡）/);
    assert.match(out, /沒有寫入：g\/ddddd（卡片格式錯誤/);
    assert.match(out, /可以從 db 刪除的 edits：aaaaa, bbbbb/);
    assert.equal(await readFile(path.join(dir, 'decks/g/aaaaa.md'), 'utf8'), cardText('a2'));
    assert.equal(await readFile(path.join(dir, 'decks/g/ccccc.md'), 'utf8'), cardText('c'));

    assert.match(run('--take', 'ccccc'), /寫入 1 張（g\/ccccc），已經寫入過 2 張/);
    assert.equal(cardVersion(await readFile(path.join(dir, 'decks/g/ccccc.md'), 'utf8')), cardVersion(cardText('c2')));
  });
});
