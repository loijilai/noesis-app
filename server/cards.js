import { readdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { cardVersion, isGroupSlug, loadDeck } from './deck.js';
import { isSchedule, withSchedule } from './card-text.js';
import { CardError, newCardId, newCardText, placeNew, requireValid } from './new-card.js';
import { readMeta, updateGroupMeta } from './group-meta.js';

export const ID = /^[a-z0-9]{5}$/;

export { CardError };

// Without `before` or `after` the card shows last in its group.
export async function createCard(root, group, raw, { before, after } = {}) {
  requireString(raw, 'raw');
  const dir = groupDir(root, group);
  await requireGroup(dir, group);
  const place = placeNew((await loadDeck(root)).groups.find((g) => g.slug === group).order, { before, after }, group);
  const taken = await existingIds(root);
  const content = newCardText(raw);
  for (;;) {
    const id = newCardId(taken, randomInt);
    taken.add(id);
    try {
      await writeFile(cardFile(root, group, id), content, { flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    await updateGroupMeta(root, group, (meta) => ({ ...meta, order: place(id) }));
    return { id, group, version: cardVersion(content) };
  }
}

// Not atomic: a write landing between the read and our write is still overwritten.
export async function updateCard(root, group, id, raw, version) {
  requireString(raw, 'raw');
  requireString(version, 'version');
  const file = cardFile(root, group, id);
  const current = await readExisting(file, group, id);
  if (cardVersion(current) !== version) throw new CardError(409, '卡片已被其他人修改，請重新載入後再編輯');
  requireValid(raw);
  await writeFile(file, raw);
  return { id, group, version: cardVersion(raw) };
}

export async function setCardSchedule(root, group, id, schedule) {
  if (!isSchedule(schedule)) throw new CardError(400, `schedule 不合法：${schedule}（只能是 fsrs、none，或像 30d 的天數）`);
  const file = cardFile(root, group, id);
  const raw = withSchedule(await readExisting(file, group, id), schedule);
  requireValid(raw);
  await writeFile(file, raw);
  return { id, group, version: cardVersion(raw) };
}

export async function deleteCard(root, group, id) {
  const file = cardFile(root, group, id);
  try {
    await unlink(file);
  } catch (err) {
    if (err.code === 'ENOENT') throw new CardError(404, `找不到卡片 ${group}/${id}`);
    throw err;
  }
  const meta = await readMeta(within(groupDir(root, group), '_group.json'));
  if (Array.isArray(meta.order) && meta.order.includes(id)) {
    await updateGroupMeta(root, group, (m) => ({ ...m, order: m.order.filter((x) => x !== id) }));
  }
}

export function groupDir(root, group) {
  if (!isGroupSlug(group)) {
    throw new CardError(400, '群組名稱不合法');
  }
  return within(root, group);
}

function cardFile(root, group, id) {
  const dir = groupDir(root, group);
  if (typeof id !== 'string' || !ID.test(id)) throw new CardError(400, 'id 不合法');
  return within(dir, `${id}.md`);
}

export function within(base, name) {
  const resolvedBase = path.resolve(base);
  const target = path.resolve(resolvedBase, name);
  if (path.dirname(target) !== resolvedBase) throw new CardError(400, '路徑不在題庫資料夾內');
  return target;
}

export async function requireGroup(dir, group) {
  const s = await stat(dir).catch(() => null);
  if (!s?.isDirectory()) throw new CardError(404, `找不到群組 ${group}`);
}

async function readExisting(file, group, id) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new CardError(404, `找不到卡片 ${group}/${id}`);
    throw err;
  }
}

async function existingIds(root) {
  const ids = new Set();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of await readdir(path.join(root, entry.name))) {
      if (name.endsWith('.md')) ids.add(name.slice(0, -3));
    }
  }
  return ids;
}

// Moves `item` right before or after `neighbour`, keeping everything else in place.
export function reposition(list, item, { before, after }, missing) {
  if ((before === undefined) === (after === undefined)) throw new CardError(400, '要指定 before 或 after 其中一個');
  const neighbour = before ?? after;
  if (neighbour === item) throw new CardError(400, '不能放在自己的前後');
  const rest = list.filter((x) => x !== item);
  const at = rest.indexOf(neighbour);
  if (at < 0) throw new CardError(404, missing(neighbour));
  return rest.toSpliced(before === undefined ? at + 1 : at, 0, item);
}

function requireString(value, name) {
  if (typeof value !== 'string') throw new CardError(400, `缺少 ${name}`);
}
