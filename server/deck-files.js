import { parseCard } from './card-text.js';

const ID_FILE = /^[a-z0-9]{5}\.md$/;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
export const RESERVED_DIRS = new Set(['assets']);
export const GROUP_ORDER_FILE = '_groups.json';

export function isGroupSlug(value) {
  return typeof value === 'string' && SLUG.test(value) && !RESERVED_DIRS.has(value);
}

// `files` maps paths relative to the deck root ("<group>/<id>.md", "<group>/_group.json", "_groups.json") to { text, version };
// version is only read for cards. Reading the files is left to the caller, so the desktop and the phone build the same deck.
export function buildDeck(files) {
  const byGroup = new Map();
  for (const [file, content] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const parts = file.split('/');
    if (parts.length !== 2 || parts[0].startsWith('.') || RESERVED_DIRS.has(parts[0])) continue;
    if (!byGroup.has(parts[0])) byGroup.set(parts[0], []);
    byGroup.get(parts[0]).push([parts[1], content]);
  }
  const groups = [];
  const cards = [];
  for (const [slug, entries] of byGroup) {
    const groupCards = entries
      .filter(([name]) => name.endsWith('.md') && !name.startsWith('.'))
      .map(([name, { text, version }]) => {
        const card = { ...parseCard(text), version };
        if (!ID_FILE.test(name)) card.errors.unshift('檔名不合法：id 必須是 5 碼小寫英數');
        return { id: name.slice(0, -3), group: slug, ...card };
      });
    const { name, preferredOrder, errors } = groupMeta(files.get(`${slug}/_group.json`)?.text, slug);
    groups.push({ slug, name, order: reconcileOrder(preferredOrder, groupCards), errors });
    cards.push(...groupCards);
  }
  markDuplicateIds(cards);
  const { preferredOrder, errors } = groupOrder(files.get(GROUP_ORDER_FILE)?.text);
  return { groups: reconcileGroups(preferredOrder, groups), cards, errors };
}

function groupOrder(text) {
  if (text === undefined) return { preferredOrder: [], errors: [] };
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

function groupMeta(text, slug) {
  const group = { name: slug, preferredOrder: [], errors: [] };
  if (text === undefined) return group;
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
