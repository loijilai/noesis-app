import { mkdir, readFile, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { GROUP_ORDER_FILE, isGroupSlug, loadDeck } from './deck.js';
import { CardError, groupDir, reposition, requireGroup, within } from './cards.js';
import { updateGroupMeta } from './group-meta.js';
import { writeJsonAtomic } from './json-file.js';

// Written as sent: reconciliation happens on read, so stale or missing slugs are harmless.
export async function writeGroupOrder(root, order) {
  if (!Array.isArray(order)) throw new CardError(400, 'order 必須是陣列');
  if (!order.every(isGroupSlug)) throw new CardError(400, '群組名稱不合法');
  await writeJsonAtomic(path.join(root, GROUP_ORDER_FILE), { order });
  return { order };
}

// The new group is written last into the group order; an unreadable order file is refused rather than overwritten.
export async function createGroup(root, slug, name) {
  const dir = groupDir(root, slug);
  name = displayName(name);
  await readGroupOrder(root);
  const deck = await loadDeck(root);
  try {
    await mkdir(dir);
  } catch (err) {
    if (err.code === 'EEXIST') throw new CardError(409, `群組 ${slug} 已存在`);
    throw err;
  }
  try {
    await writeJsonAtomic(within(dir, '_group.json'), { name, order: [] });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  await writeGroupOrder(root, [...deck.groups.map((g) => g.slug), slug]);
  return { slug, name };
}

export async function placeGroup(root, slug, side) {
  const shown = (await loadDeck(root)).groups.map((g) => g.slug);
  if (!shown.includes(slug)) throw new CardError(404, `找不到群組 ${slug}`);
  return writeGroupOrder(root, reposition(shown, slug, side, (n) => `找不到群組 ${n}`));
}

export async function renameGroup(root, slug, name) {
  groupDir(root, slug);
  name = displayName(name);
  await updateGroupMeta(root, slug, (meta) => ({ ...meta, name }));
  return { slug, name };
}

const DISPOSABLE = new Set(['_group.json', '.DS_Store']);

// Never recursive: only files known to be safe to drop are removed, so no card or unknown file is lost.
// The slug leaves the group order too, as a deleted card leaves its group's order.
export async function deleteGroup(root, slug) {
  const dir = groupDir(root, slug);
  await requireGroup(dir, slug);
  const order = await readGroupOrder(root);
  const entries = await readdir(dir);
  if (entries.some((name) => name.endsWith('.md'))) throw new CardError(409, '群組裡還有卡片，要先搬走或刪掉卡片');
  const others = entries.filter((name) => !DISPOSABLE.has(name));
  if (others.length) throw new CardError(409, `群組資料夾裡還有其他檔案：${others.join('、')}`);
  for (const name of entries) await unlink(within(dir, name));
  try {
    await rmdir(dir);
  } catch (err) {
    if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST') throw new CardError(409, '群組資料夾裡出現了新檔案，請重新整理');
    throw err;
  }
  if (order?.includes(slug)) await writeGroupOrder(root, order.filter((s) => s !== slug));
}

// Null when there is no order file yet; an unreadable one is refused so it is never overwritten.
async function readGroupOrder(root) {
  let text;
  try {
    text = await readFile(path.join(root, GROUP_ORDER_FILE), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let meta;
  try {
    meta = JSON.parse(text);
  } catch {}
  if (!Array.isArray(meta?.order)) throw new CardError(409, `${GROUP_ORDER_FILE} 無法解析，請先修正`);
  return meta.order;
}

function displayName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new CardError(400, '顯示名稱不能是空白');
  return name.trim();
}
