// The phone's copy of the data repo, read from and written to GitHub. Kept apart from the page so it can be tested against a fake GitHub.
import { buildDeck } from '../server/deck-files.js';
import { parseCard, withSchedule } from '../server/card-text.js';
import { parseEvents } from '../server/progress-lines.js';
import { newCardId, newCardText, placeNew } from '../server/new-card.js';
import { eventKey, mergeEvents } from './events.js';

const DECK = 'decks/';
const PHONE_LOG = 'progress/phone.jsonl';
const PROGRESS = /^progress\/([^/]+)\.jsonl$/;
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

// A stale sha is refused with 409 by the contents API and with 422 when a branch cannot move forward.
const isRace = (err) => err?.status === 409 || err?.status === 422;

// `pending` holds ratings not yet on GitHub: { get(), set(list) }, kept by the caller somewhere that survives a reload.
const randomIndex = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;

export function createStore({ gh, branch, pending, cached = (sha, load) => load(), random = randomIndex }) {
  const decoder = new TextDecoder();
  const text = (sha) => cached(sha, async () => decoder.decode(await gh.blob(sha)));
  let state = { commit: null, tree: null, files: new Map(), texts: new Map() };
  let flushing = null;

  async function latest() {
    const commit = await gh.head(branch);
    return { commit, ...(await gh.tree(commit)) };
  }

  async function refresh(onProgress) {
    const { commit, sha, files } = await latest();
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

  function deck() {
    const files = new Map();
    for (const [file, content] of state.texts) {
      if (file.startsWith(DECK)) files.set(file.slice(DECK.length), { text: content, version: state.files.get(file) });
    }
    return buildDeck(files);
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

  // One call at a time; ratings made while it runs wait for the next one.
  function flush() {
    flushing ??= appendPending().finally(() => { flushing = null; });
    return flushing;
  }

  async function appendPending() {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const queued = pending.get();
      if (!queued.length) return;
      const { commit, files } = await latest();
      const sha = files.get(PHONE_LOG);
      const current = sha ? await text(sha) : '';
      // A write that reached GitHub but whose answer was lost must not be appended twice.
      const logged = new Set(parseEvents(current, 'phone').map(eventKey));
      const fresh = queued.filter((e) => !logged.has(eventKey(e)));
      if (fresh.length) {
        const head = current && !current.endsWith('\n') ? `${current}\n` : current;
        try {
          await gh.putFile(PHONE_LOG, head + fresh.map((e) => `${JSON.stringify(e)}\n`).join(''), { sha, branch, message: 'sync: phone' });
        } catch (err) {
          if (isRace(err)) continue;
          throw err;
        }
      }
      const written = new Set(queued.map(eventKey));
      pending.set(pending.get().filter((e) => !written.has(eventKey(e))));
      if (commit !== state.commit || fresh.length) await refresh();
      return;
    }
    throw new StoreError(409, '評分一直寫不進 GitHub，等一下會再試');
  }

  function cardFile(group, id) {
    const file = `${DECK}${group}/${id}.md`;
    if (!state.files.has(file)) throw new StoreError(404, `找不到卡片 ${group}/${id}`);
    return file;
  }

  async function saveCard(group, id, raw, version) {
    const file = cardFile(group, id);
    if (typeof raw !== 'string') throw new StoreError(400, '缺少 raw');
    const sha = state.files.get(file);
    if (version !== sha) throw new StoreError(409, '卡片已被其他分頁修改，請重新載入後再編輯');
    const { errors } = parseCard(raw);
    if (errors.length) throw new StoreError(400, `卡片格式錯誤：${errors.join('；')}`);
    try {
      await gh.putFile(file, raw, { sha, branch, message: `phone: edit ${group}/${id}` });
    } catch (err) {
      if (isRace(err)) throw new StoreError(409, '電腦上改過這張卡，請重新載入');
      throw err;
    }
    await refresh();
    return { id, group, version: state.files.get(file) };
  }

  function setSchedule(group, id, schedule) {
    const file = cardFile(group, id);
    return saveCard(group, id, withSchedule(state.texts.get(file), schedule), state.files.get(file));
  }

  // The card and its place in the group order go in one commit. The order is worked out again from the latest push on every try,
  // so a reorder on the desktop in the meantime is kept rather than refused.
  async function createCard(group, raw, side = {}) {
    const content = newCardText(raw);
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      await refresh();
      const current = deck();
      const shown = current.groups.find((g) => g.slug === group)?.order;
      if (!shown) throw new StoreError(404, `找不到群組 ${group}`);
      const place = placeNew(shown, side, group);
      const id = newCardId(new Set(current.cards.map((c) => c.id)), random);
      const metaFile = `${DECK}${group}/_group.json`;
      const meta = state.files.has(metaFile) ? parseMeta(state.texts.get(metaFile)) : {};
      const changes = [
        { path: `${DECK}${group}/${id}.md`, text: content },
        { path: metaFile, text: `${JSON.stringify({ ...meta, order: place(id) }, null, 2)}\n` },
      ];
      try {
        await gh.commit({ branch, parent: state.commit, baseTree: state.tree, changes, message: `phone: add ${group}/${id}` });
      } catch (err) {
        if (isRace(err)) continue;
        throw err;
      }
      await refresh();
      return { id, group, version: state.files.get(`${DECK}${group}/${id}.md`) };
    }
    throw new StoreError(409, 'GitHub 上一直有新的改動，新增沒有完成，請再試一次');
  }

  // The card and its place in the group order go in one commit, so `_group.json` never lists a card that is gone.
  async function deleteCard(group, id) {
    const file = cardFile(group, id);
    const seen = state.files.get(file);
    const metaFile = `${DECK}${group}/_group.json`;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const { commit, sha: baseTree, files } = await latest();
      if (!files.has(file)) return refresh();
      if (files.get(file) !== seen) throw new StoreError(409, '電腦上改過這張卡，請重新載入');
      const changes = [{ path: file, text: null }];
      if (files.has(metaFile)) {
        const meta = parseMeta(await text(files.get(metaFile)));
        if (Array.isArray(meta.order) && meta.order.includes(id)) {
          changes.push({ path: metaFile, text: `${JSON.stringify({ ...meta, order: meta.order.filter((x) => x !== id) }, null, 2)}\n` });
        }
      }
      try {
        await gh.commit({ branch, parent: commit, baseTree, changes, message: `phone: delete ${group}/${id}` });
      } catch (err) {
        if (isRace(err)) continue;
        throw err;
      }
      return refresh();
    }
    throw new StoreError(409, 'GitHub 上一直有新的改動，刪除沒有完成，請重新載入再試');
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
    commit: () => state.commit,
    blobSha: (file) => state.files.get(file),
    hasPending: () => pending.get().length > 0,
  };
}

function parseMeta(text) {
  let meta;
  try {
    meta = JSON.parse(text);
  } catch {}
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new StoreError(409, '_group.json 無法解析，請先在電腦上修正');
  return meta;
}

async function pool(items, size, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}
