// The phone's copy of the data repo. Every change is kept on the phone first and goes to GitHub later, all of it in one commit.
// Kept apart from the page so it can be tested against a fake GitHub.
import { buildDeck } from '../server/deck-files.js';
import { parseCard, withSchedule } from '../server/card-text.js';
import { parseEvents } from '../server/progress-lines.js';
import { newCardId, newCardText, placeNew } from '../server/new-card.js';
import { eventKey, mergeEvents } from './events.js';

const DECK = 'decks/';
const PHONE_LOG = 'progress/phone.jsonl';
const PROGRESS = /^progress\/([^/]+)\.jsonl$/;
const CARD_FILE = /^decks\/([^/]+)\/([a-z0-9]{5})\.md$/;
const RETRIES = 3;

export class StoreError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isWanted = (file) => file === `${DECK}_groups.json`
  || (/^decks\/[^/]+\/[^/]+$/.test(file) && (file.endsWith('.md') || file.endsWith('/_group.json')))
  || PROGRESS.test(file);

// A branch that cannot move forward is refused with 422.
const isRace = (err) => err?.status === 409 || err?.status === 422;

const randomIndex = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;

// `pending` holds ratings and `changes` holds card changes not yet on GitHub, both { get(), set(list) } kept somewhere that survives a reload.
// A change is the phone's wish for one card: { id, group, base, raw, place?, rev, time, conflict? }, with `raw` null for a deleted card.
// `base` is the sha the card had on GitHub when the phone first changed it, null when it had no file. The change goes out only while
// GitHub still has that; otherwise it waits as a conflict for the user to settle.
export function createStore({ gh, branch, pending, changes, cached = (sha, load) => load(), random = randomIndex, now = () => new Date() }) {
  const decoder = new TextDecoder();
  const text = (sha) => cached(sha, async () => decoder.decode(await gh.blob(sha)));
  let state = { commit: null, tree: null, files: new Map(), texts: new Map() };
  let flushing = null;
  let lastRev = 0;
  let view = null;

  async function refresh(onProgress) {
    const commit = await gh.head(branch);
    const { sha, files } = await gh.tree(commit);
    const wanted = [...files].filter(([file]) => isWanted(file));
    const texts = new Map();
    let done = 0;
    await pool(wanted, 12, async ([file, blob]) => {
      texts.set(file, await text(blob));
      onProgress?.(++done, wanted.length);
    });
    state = { commit, tree: sha, files, texts };
    return commit;
  }

  // GitHub's files with every change on top, conflicts included, so nothing the user did drops out of view.
  function deck() {
    const list = changes.get();
    const key = `${state.commit}\n${JSON.stringify(list)}`;
    if (view?.key !== key) {
      const { texts, owner } = apply(state, list, { force: true });
      const files = new Map();
      for (const [file, content] of texts) {
        if (!file.startsWith(DECK)) continue;
        const change = owner.get(file);
        files.set(file.slice(DECK.length), { text: content, version: change ? `phone-${change.rev}` : state.files.get(file) });
      }
      view = { key, deck: buildDeck(files) };
    }
    return view.deck;
  }

  function events() {
    const logged = [];
    for (const [file, content] of state.texts) {
      const device = file.match(PROGRESS)?.[1];
      if (device) logged.push(...parseEvents(content, device));
    }
    return mergeEvents(logged, pending.get().map((e) => ({ ...e, device: 'phone' })));
  }

  function record(event) {
    pending.set([...pending.get(), event]);
  }

  function nextRev() {
    lastRev = Math.max(lastRev + 1, Date.now(), ...changes.get().map((c) => c.rev + 1));
    return lastRev;
  }

  function put(change) {
    changes.set([...changes.get().filter((c) => c.id !== change.id), change]);
  }

  function findCard(group, id) {
    const card = deck().cards.find((c) => c.id === id && c.group === group);
    if (!card) throw new StoreError(404, `找不到卡片 ${group}/${id}`);
    return card;
  }

  function remoteBase(id) {
    const file = cardPath(state.files, id);
    return file ? state.files.get(file) : null;
  }

  function saveCard(group, id, raw, version) {
    const card = findCard(group, id);
    if (typeof raw !== 'string') throw new StoreError(400, '缺少 raw');
    if (version !== card.version) throw new StoreError(409, '卡片已被其他分頁修改，請重新載入後再編輯');
    requireValid(raw);
    const before = changes.get().find((c) => c.id === id);
    const rev = nextRev();
    put({ ...before, id, group, base: before ? before.base : remoteBase(id), raw, rev, time: now().toISOString() });
    return { id, group, version: `phone-${rev}` };
  }

  function setSchedule(group, id, schedule) {
    const card = findCard(group, id);
    return saveCard(group, id, withSchedule(card.raw, schedule), card.version);
  }

  function createCard(group, raw, side = {}) {
    const content = newCardText(raw, now());
    const current = deck();
    const shown = current.groups.find((g) => g.slug === group)?.order;
    if (!shown) throw new StoreError(404, `找不到群組 ${group}`);
    placeNew(shown, side, group);
    const taken = new Set(current.cards.map((c) => c.id));
    for (const file of state.files.keys()) taken.add(file.match(CARD_FILE)?.[2]);
    const id = newCardId(taken, random);
    const rev = nextRev();
    put({ id, group, base: null, raw: content, place: side, rev, time: now().toISOString() });
    return { id, group, version: `phone-${rev}` };
  }

  function deleteCard(group, id) {
    findCard(group, id);
    const before = changes.get().find((c) => c.id === id);
    // GitHub has no file for it, so deleting is just dropping the phone's wish.
    if (before?.base === null) {
      changes.set(changes.get().filter((c) => c.id !== id));
      return;
    }
    put({ ...before, id, group, base: before ? before.base : remoteBase(id), raw: null, rev: nextRev(), time: now().toISOString() });
  }

  // One call at a time; what changes while it runs waits for the next one.
  function flush() {
    flushing ??= send().finally(() => { flushing = null; });
    return flushing;
  }

  async function send() {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      if (!pending.get().length && !changes.get().some((c) => !c.conflict)) return;
      await refresh();
      const queued = pending.get();
      const sent = changes.get().filter((c) => !c.conflict);
      const { writes, applied, conflicts, settled } = apply(state, sent, { force: false });
      const revOf = new Map(sent.map((c) => [c.id, c.rev]));
      const untouched = (c) => revOf.get(c.id) === c.rev;
      const conflicted = new Set(conflicts.map((c) => c.id));
      const gone = new Set(settled.map((c) => c.id));
      changes.set(changes.get()
        .filter((c) => !(gone.has(c.id) && untouched(c)))
        .map((c) => (conflicted.has(c.id) && untouched(c) ? { ...c, conflict: true } : c)));

      const current = state.texts.get(PHONE_LOG) ?? '';
      // A write that reached GitHub but whose answer was lost must not be appended twice.
      const logged = new Set(parseEvents(current, 'phone').map(eventKey));
      const fresh = queued.filter((e) => !logged.has(eventKey(e)));
      if (fresh.length) {
        const head = current && !current.endsWith('\n') ? `${current}\n` : current;
        writes.push({ path: PHONE_LOG, text: head + fresh.map((e) => `${JSON.stringify(e)}\n`).join('') });
      }

      if (writes.length) {
        try {
          await gh.commit({ branch, parent: state.commit, baseTree: state.tree, changes: writes, message: 'sync: phone' });
        } catch (err) {
          if (isRace(err)) continue;
          throw err;
        }
        await refresh();
      }

      const written = new Set(queued.map(eventKey));
      pending.set(pending.get().filter((e) => !written.has(eventKey(e))));
      const done = new Set(applied.map((c) => c.id));
      // A card changed again while this was sending stays, now based on what was just written.
      changes.set(changes.get().flatMap((c) => {
        if (!done.has(c.id)) return [c];
        return untouched(c) ? [] : [{ ...c, base: remoteBase(c.id) }];
      }));
      return;
    }
    throw new StoreError(409, 'GitHub 上一直有新的改動，等一下會再試');
  }

  function conflicts() {
    const names = new Map(deck().groups.map((g) => [g.slug, g.name]));
    return changes.get().filter((c) => c.conflict).map((c) => {
      const file = cardPath(state.texts, c.id);
      const group = file ? file.match(CARD_FILE)[1] : c.group;
      return {
        id: c.id,
        group,
        groupName: names.get(group) ?? group,
        local: c.raw,
        remote: file ? state.texts.get(file) : null,
        missingGroup: !file && !groupExists(state.texts, group),
      };
    });
  }

  // Taking the phone's side rebases the change on what GitHub has now, so the next flush writes it over GitHub's.
  function resolve(id, use, raw) {
    const change = changes.get().find((c) => c.id === id && c.conflict);
    if (!change) throw new StoreError(404, `卡片 ${id} 沒有衝突`);
    if (use === 'remote') {
      changes.set(changes.get().filter((c) => c.id !== id));
      return;
    }
    if (use !== 'local') throw new StoreError(400, 'use 必須是 local 或 remote');
    const file = cardPath(state.texts, id);
    const group = file ? file.match(CARD_FILE)[1] : change.group;
    if (!file && !groupExists(state.texts, group)) throw new StoreError(409, `群組 ${group} 已不存在，手機無法建立群組`);
    const content = change.raw === null ? null : raw ?? change.raw;
    if (content !== null) requireValid(content);
    const { conflict, ...rest } = change;
    put({ ...rest, group, raw: content, base: remoteBase(id), rev: nextRev(), time: now().toISOString() });
  }

  return {
    refresh,
    deck,
    events,
    record,
    flush,
    saveCard,
    setSchedule,
    createCard,
    deleteCard,
    conflicts,
    resolve,
    commit: () => state.commit,
    blobSha: (file) => state.files.get(file),
    hasPending: () => pending.get().length > 0 || changes.get().some((c) => !c.conflict),
    status: () => ({
      pending: pending.get().length + changes.get().filter((c) => !c.conflict).length,
      conflicts: changes.get().filter((c) => c.conflict).length,
    }),
  };
}

function requireValid(raw) {
  const { errors } = parseCard(raw);
  if (errors.length) throw new StoreError(400, `卡片格式錯誤：${errors.join('；')}`);
}

// Plays the changes onto GitHub's files. Unless forced, a change goes in only while GitHub still has the card it was based on;
// one GitHub already agrees with is settled, and the rest are conflicts. Cards are found by id, so a move on the desktop is followed.
function apply(base, list, { force }) {
  const texts = new Map(base.texts);
  const touched = new Set();
  const owner = new Map();
  const applied = [];
  const conflicts = [];
  const settled = [];
  const write = (file, content) => {
    if (content === null) texts.delete(file);
    else texts.set(file, content);
    touched.add(file);
  };

  for (const change of list) {
    const file = cardPath(texts, change.id);
    if (!force && (file ? base.files.get(file) : null) !== change.base) {
      if (change.raw === null ? !file : texts.get(file) === change.raw) settled.push(change);
      else conflicts.push(change);
      continue;
    }
    if (file) {
      write(file, change.raw);
      if (change.raw === null) setOrder(texts, write, file.match(CARD_FILE)[1], (order) => order.filter((id) => id !== change.id));
      else owner.set(file, change);
      applied.push(change);
      continue;
    }
    if (change.raw === null) {
      settled.push(change);
      continue;
    }
    if (!force && !groupExists(texts, change.group)) {
      conflicts.push(change);
      continue;
    }
    const shown = shownOrder(texts, change.group);
    let place;
    try {
      place = placeNew(shown, change.place ?? {}, change.group);
    } catch {
      place = placeNew(shown, {}, change.group);
    }
    const target = `${DECK}${change.group}/${change.id}.md`;
    write(target, change.raw);
    owner.set(target, change);
    setOrder(texts, write, change.group, () => place(change.id), true);
    applied.push(change);
  }

  const writes = [...touched]
    .filter((file) => (texts.get(file) ?? null) !== (base.texts.get(file) ?? null))
    .map((file) => ({ path: file, text: texts.get(file) ?? null }));
  return { texts, owner, writes, applied, conflicts, settled };
}

function cardPath(files, id) {
  for (const file of files.keys()) {
    if (file.endsWith(`/${id}.md`) && CARD_FILE.test(file)) return file;
  }
  return undefined;
}

function groupExists(files, group) {
  const dir = `${DECK}${group}/`;
  for (const file of files.keys()) if (file.startsWith(dir)) return true;
  return false;
}

function shownOrder(texts, group) {
  const dir = `${DECK}${group}/`;
  const files = new Map();
  for (const [file, content] of texts) if (file.startsWith(dir)) files.set(file.slice(DECK.length), { text: content });
  return buildDeck(files).groups.find((g) => g.slug === group)?.order ?? [];
}

// A `_group.json` that cannot be read is left alone: the card still lands, and the group falls back to creation order.
function setOrder(texts, write, group, reorder, create = false) {
  const file = `${DECK}${group}/_group.json`;
  let meta = {};
  if (texts.has(file)) {
    try {
      meta = JSON.parse(texts.get(file));
    } catch {
      return;
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return;
  }
  if (!create && !Array.isArray(meta.order)) return;
  write(file, `${JSON.stringify({ ...meta, order: reorder(meta.order ?? []) }, null, 2)}\n`);
}

async function pool(items, size, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}
