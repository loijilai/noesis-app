import { readFile } from 'node:fs/promises';
import { CardError, ID, groupDir, reposition, requireGroup, within } from './cards.js';
import { loadDeck } from './deck.js';
import { writeJsonAtomic } from './json-file.js';

// Fields the updater does not touch are written back unchanged.
export async function updateGroupMeta(root, group, update) {
  const dir = groupDir(root, group);
  await requireGroup(dir, group);
  const file = within(dir, '_group.json');
  const meta = await readMeta(file);
  await writeJsonAtomic(file, update(meta));
}

export async function writeCardOrder(root, group, order) {
  if (!Array.isArray(order) || !order.every((id) => typeof id === 'string' && ID.test(id))) {
    throw new CardError(400, 'order 必須是 id 陣列');
  }
  await updateGroupMeta(root, group, (meta) => ({ ...meta, order }));
}

// The whole shown order is written, as a drag on the page does.
export async function placeCard(root, group, id, side) {
  const shown = (await loadDeck(root)).groups.find((g) => g.slug === group)?.order;
  if (!shown?.includes(id)) throw new CardError(404, `找不到卡片 ${group}/${id}`);
  await writeCardOrder(root, group, reposition(shown, id, side, (n) => `群組 ${group} 裡找不到卡片 ${n}`));
}

export async function readMeta(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  let meta;
  try {
    meta = JSON.parse(text);
  } catch {}
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new CardError(409, '_group.json 無法解析，請先修正');
  }
  return meta;
}
