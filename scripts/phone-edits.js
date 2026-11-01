import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { dataPaths, loadConfig } from '../server/config.js';
import { CardError, updateCard } from '../server/cards.js';
import { cardVersion, loadDeck } from '../server/deck.js';

const { deckDir } = dataPaths(loadConfig());
const args = process.argv.slice(2);
const take = new Set(args.flatMap((a, i) => (args[i - 1] === '--take' ? [a] : [])));
const inputs = args.filter((a, i) => a !== '--take' && args[i - 1] !== '--take');
if (!inputs.length) {
  console.error('用法：npm run phone:edits -- <db 匯出的 JSON 檔或資料夾>... [--take <id>]...');
  process.exit(1);
}

const edits = latest(collect(await Promise.all((await Promise.all(inputs.map(jsonFiles))).flat().map(async (f) => JSON.parse(await readFile(f, 'utf8'))))));
const cards = new Map((await loadDeck(deckDir)).cards.map((c) => [c.id, c]));
const written = [];
const applied = [];
const conflicts = [];
const invalid = [];
for (const edit of edits) {
  const card = cards.get(edit.id);
  if (!card) {
    conflicts.push(`${edit.id}（電腦上已經沒有這張卡）`);
    continue;
  }
  if (card.version === cardVersion(edit.raw)) {
    applied.push(edit.id);
    continue;
  }
  // The phone edited the snapshot, so the base is the version the edit expects the file to still have.
  try {
    await updateCard(deckDir, card.group, card.id, edit.raw, take.has(edit.id) ? card.version : edit.base);
    written.push(`${card.group}/${card.id}`);
  } catch (err) {
    if (!(err instanceof CardError)) throw err;
    if (err.status === 409) conflicts.push(`${card.group}/${card.id}`);
    else invalid.push(`${card.group}/${card.id}（${err.message}）`);
  }
}

console.log(`noesis: 寫入 ${written.length} 張${written.length ? `（${written.join('、')}）` : ''}，已經寫入過 ${applied.length} 張`);
if (conflicts.length) console.log(`衝突：${conflicts.join('、')}`);
if (invalid.length) console.log(`沒有寫入：${invalid.join('、')}`);
const done = [...written.map((w) => w.split('/')[1]), ...applied];
if (done.length) console.log(`可以從 db 刪除的 edits：${done.join(', ')}`);

async function jsonFiles(input) {
  if (!(await stat(input)).isDirectory()) return [input];
  const entries = await readdir(input, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => path.join(e.parentPath, e.name));
}

// Accepts edits, or db rows wrapping them under `data`.
function collect(value) {
  if (Array.isArray(value)) return value.flatMap(collect);
  if (value?.data && typeof value.data === 'object') return collect(value.data);
  if (value?.docs) return collect(value.docs);
  const ok = typeof value?.id === 'string' && typeof value.raw === 'string' && typeof value.base === 'string' && typeof value.time === 'string';
  return ok ? [value] : [];
}

function latest(list) {
  const byId = new Map();
  for (const e of list) if (!byId.has(e.id) || byId.get(e.id).time < e.time) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
