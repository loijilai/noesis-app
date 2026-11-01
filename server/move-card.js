import { rename, stat } from 'node:fs/promises';
import { CardError, ID, groupDir, requireGroup, within } from './cards.js';
import { loadDeck } from './deck.js';
import { readMeta, updateGroupMeta } from './group-meta.js';

// Every check runs before anything is written, so a rejected move leaves the deck untouched.
export async function moveCard(root, from, id, to) {
  const fromDir = groupDir(root, from);
  if (typeof to !== 'string') throw new CardError(400, '缺少目標群組');
  const toDir = groupDir(root, to);
  if (typeof id !== 'string' || !ID.test(id)) throw new CardError(400, 'id 不合法');
  if (from === to) throw new CardError(400, '目標群組與原群組相同');
  await requireGroup(fromDir, from);
  await requireGroup(toDir, to);
  const source = within(fromDir, `${id}.md`);
  const target = within(toDir, `${id}.md`);
  if (!(await stat(source).catch(() => null))?.isFile()) throw new CardError(404, `找不到卡片 ${from}/${id}`);
  if (await stat(target).catch(() => null)) throw new CardError(409, `群組 ${to} 已經有 ${id}.md`);
  const fromMeta = await readMeta(within(fromDir, '_group.json'));
  const toMeta = await readMeta(within(toDir, '_group.json'));

  // Cards the target order does not list already show after the listed ones; keep them ahead of the newcomer.
  const listed = Array.isArray(toMeta.order) ? toMeta.order.filter((x) => x !== id) : [];
  const shown = (await loadDeck(root)).groups.find((g) => g.slug === to).order;
  const toOrder = [...listed, ...shown.filter((x) => !listed.includes(x)), id];

  await rename(source, target);
  await updateGroupMeta(root, to, (meta) => ({ ...meta, order: toOrder }));
  if (Array.isArray(fromMeta.order) && fromMeta.order.includes(id)) {
    await updateGroupMeta(root, from, (meta) => ({ ...meta, order: meta.order.filter((x) => x !== id) }));
  }
  return { id, group: to };
}
