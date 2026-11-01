import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCard } from './card-text.js';

const ID_FILE = /^[a-z0-9]{5}\.md$/;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
export const RESERVED_DIRS = new Set(['assets']);
export const GROUP_ORDER_FILE = '_groups.json';

export function isGroupSlug(value) {
  return typeof value === 'string' && SLUG.test(value) && !RESERVED_DIRS.has(value);
}

export function cardVersion(raw) {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export async function loadDeck(root) {
  const groups = [];
  const cards = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || RESERVED_DIRS.has(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const groupCards = await loadGroupCards(dir, entry.name);
    const { name, preferredOrder, errors } = await loadGroupMeta(dir, entry.name);
    groups.push({ slug: entry.name, name, order: reconcileOrder(preferredOrder, groupCards), errors });
    cards.push(...groupCards);
  }
  markDuplicateIds(cards);
  const { preferredOrder, errors } = await loadGroupOrder(root);
  return { groups: reconcileGroups(preferredOrder, groups), cards, errors };
}

async function loadGroupOrder(root) {
  let text;
  try {
    text = await readFile(path.join(root, GROUP_ORDER_FILE), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { preferredOrder: [], errors: [] };
    throw err;
  }
  let meta;
  try {
    meta = JSON.parse(text);
  } catch {
    return { preferredOrder: [], errors: [`${GROUP_ORDER_FILE} 無法解析`] };
  }
  const order = Array.isArray(meta?.order) ? meta.order.filter((slug) => typeof slug === 'string') : [];
  return { preferredOrder: order, errors: [] };
}

function reconcileGroups(preferred, groups) {
  const bySlug = new Map(groups.map((g) => [g.slug, g]));
  const listed = [...new Set(preferred)].filter((slug) => bySlug.has(slug));
  const listedSet = new Set(listed);
  const rest = groups.filter((g) => !listedSet.has(g.slug)).sort((a, b) => a.slug.localeCompare(b.slug));
  return [...listed.map((slug) => bySlug.get(slug)), ...rest];
}

async function loadGroupMeta(dir, slug) {
  const group = { name: slug, preferredOrder: [], errors: [] };
  let text;
  try {
    text = await readFile(path.join(dir, '_group.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return group;
    throw err;
  }
  let meta;
  try {
    meta = JSON.parse(text);
  } catch {
    group.errors.push('_group.json 無法解析');
    return group;
  }
  if (typeof meta?.name === 'string' && meta.name.trim()) group.name = meta.name;
  if (Array.isArray(meta?.order)) group.preferredOrder = meta.order.filter((id) => typeof id === 'string');
  return group;
}

async function loadGroupCards(dir, slug) {
  const cards = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue;
    const raw = await readFile(path.join(dir, entry.name), 'utf8');
    const card = { ...parseCard(raw), version: cardVersion(raw) };
    if (!ID_FILE.test(entry.name)) card.errors.unshift('檔名不合法：id 必須是 5 碼小寫英數');
    cards.push({ id: entry.name.slice(0, -3), group: slug, ...card });
  }
  return cards;
}

function reconcileOrder(preferred, cards) {
  const present = new Set(cards.map((c) => c.id));
  const listed = [...new Set(preferred)].filter((id) => present.has(id));
  const listedSet = new Set(listed);
  const rest = cards
    .filter((c) => !listedSet.has(c.id))
    .sort((a, b) => createdTime(a) - createdTime(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => c.id);
  return [...listed, ...rest];
}

function createdTime(card) {
  const t = Date.parse(card.created);
  return Number.isNaN(t) ? Infinity : t;
}

function markDuplicateIds(cards) {
  const byId = Map.groupBy(cards, (c) => c.id);
  for (const [id, same] of byId) {
    if (same.length < 2) continue;
    const where = same.map((c) => c.group).join('、');
    for (const c of same) c.errors.push(`id ${id} 重複（${where}）`);
  }
}
