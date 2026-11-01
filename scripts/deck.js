#!/usr/bin/env node
// The agent's way to change the deck's structure: each command calls the same server function as the matching action on the page.
// Card text is edited in the file itself, so there is no command for it.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseCard } from '../server/card-text.js';
import { CardError, createCard, deleteCard, setCardSchedule } from '../server/cards.js';
import { loadDeck } from '../server/deck.js';
import { placeCard } from '../server/group-meta.js';
import { createGroup, deleteGroup, placeGroup, renameGroup } from '../server/groups.js';
import { moveCard } from '../server/move-card.js';
import { dataPaths, loadConfig } from '../server/config.js';
import { ProgressError, appendEvent, toEvent } from '../server/progress.js';

const HELP = `用法：npm run deck -- <指令> [參數]

這裡的指令改的是結構：哪些卡片和 group、放在哪裡、什麼順序。順序檔由指令負責，不要手動改。
卡片內容直接改 show 印出的那個檔案（不要動 frontmatter），改完跑 check。

卡片都用 5 碼 id 指定，不用寫 group。新卡的內容從 stdin 傳入，只寫 ## 段落，不寫 frontmatter。
格式不對的卡片不會寫入；失敗時印出原因、exit code 不是 0，什麼都沒改。

卡片
  show <id>                              印出卡片檔案的路徑
  check <file>...                        檢查格式，不寫入
  add <group> [--before <id> | --after <id>] < card.md
                                         新增卡片，印出 <group>/<id>；沒指定位置就排在最後
  rm <id>...                             刪除卡片
  mv <id>... --to <group>                移到另一個 group 的最後面
  place <id> (--before <id> | --after <id>)
                                         在同一個 group 裡調整位置
  schedule <fsrs|none|<N>d> <id>...      設定排程：fsrs 記憶（預設）、none 不排程、30d 每 30 天出現一次

Group（用資料夾名稱 slug 指定）
  group add <slug> <name>                新增 group，排在最後
  group rename <slug> <name>             改顯示名稱，slug 不變
  group rm <slug>                        刪除空的 group
  group place <slug> (--before <slug> | --after <slug>)

練習狀態（評分只能由使用者在 app 裡做）
  reset <id>...                          清掉排程和練過紀錄
  suspend <id>...                        封存
  unsuspend <id>...                      取消封存

範例
  npm run deck -- add os --after ab12c <<'EOF'
  ## Question
  ...
  ## Answer
  ...
  EOF
  npm run deck -- mv ab12c x9k2m --to networking
`;

class UsageError extends Error {}

const config = loadConfig();
const { deckDir, progressDir } = dataPaths(config);

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: { before: { type: 'string' }, after: { type: 'string' }, to: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
} catch (err) {
  usage(err.message);
}
const { positionals, values } = args;
const side = { before: values.before, after: values.after };

try {
  await run(positionals[0], positionals.slice(1));
} catch (err) {
  if (!(err instanceof CardError || err instanceof ProgressError || err instanceof UsageError)) throw err;
  console.error(err.message);
  process.exit(err instanceof UsageError ? 2 : 1);
}

async function run(command, rest) {
  if (!command || command === 'help' || values.help) return console.log(HELP);
  if (command === 'group') return runGroup(rest[0], rest.slice(1));
  if (command === 'show') {
    const card = await find(one(rest));
    return console.log(path.relative(process.cwd(), path.join(deckDir, card.group, `${card.id}.md`)));
  }
  if (command === 'check') return check(atLeastOne(rest));
  if (command === 'add') {
    const group = one(rest);
    const { id } = await createCard(deckDir, group, await stdin(), side);
    return console.log(`${group}/${id}`);
  }
  if (command === 'rm') {
    for (const card of await findAll(atLeastOne(rest))) {
      await deleteCard(deckDir, card.group, card.id);
      console.log(`已刪除 ${card.group}/${card.id}`);
    }
    return;
  }
  if (command === 'mv') {
    if (values.to === undefined) throw new UsageError('mv 要加 --to <group>');
    for (const card of await findAll(atLeastOne(rest))) {
      await moveCard(deckDir, card.group, card.id, values.to);
      console.log(`${card.group}/${card.id} → ${values.to}/${card.id}`);
    }
    return;
  }
  if (command === 'place') {
    const card = await find(one(rest));
    await placeCard(deckDir, card.group, card.id, side);
    return console.log(`已調整 ${card.group}/${card.id} 的位置`);
  }
  if (command === 'schedule') {
    const [schedule, ...ids] = rest;
    for (const card of await findAll(atLeastOne(ids))) {
      await setCardSchedule(deckDir, card.group, card.id, schedule);
      console.log(`${card.group}/${card.id}：${schedule}`);
    }
    return;
  }
  if (['reset', 'suspend', 'unsuspend'].includes(command)) {
    const where = await progressTarget();
    for (const card of await findAll(atLeastOne(rest))) {
      await appendEvent(where, toEvent({ id: card.id, type: command }));
      console.log(`${command} ${card.group}/${card.id}`);
    }
    return;
  }
  throw new UsageError(`沒有這個指令：${command}`);
}

async function runGroup(command, rest) {
  if (command === 'add' || command === 'rename') {
    if (rest.length !== 2) throw new UsageError(`用法：group ${command} <slug> <name>`);
    const { slug, name } = await (command === 'add' ? createGroup : renameGroup)(deckDir, rest[0], rest[1]);
    return console.log(`${slug}：${name}`);
  }
  if (command === 'rm') {
    const slug = one(rest);
    await deleteGroup(deckDir, slug);
    return console.log(`已刪除 group ${slug}`);
  }
  if (command === 'place') {
    const slug = one(rest);
    await placeGroup(deckDir, slug, side);
    return console.log(`已調整 group ${slug} 的位置`);
  }
  throw new UsageError(`沒有這個指令：group ${command ?? ''}`);
}

// Checks every file before failing, so one run lists all the problems. A draft without frontmatter gets one, as add does.
async function check(files) {
  let failed = false;
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const { errors } = parseCard(text.startsWith('---') ? text : `---\ncreated: ${new Date().toISOString()}\n---\n\n${text}`);
    if (errors.length) failed = true;
    console.log(`${file}: ${errors.length ? errors.join('；') : 'ok'}`);
  }
  if (failed) process.exit(1);
}

async function find(id) {
  const found = (await loadDeck(deckDir)).cards.filter((c) => c.id === id);
  if (!found.length) throw new CardError(404, `找不到卡片 ${id}`);
  if (found.length > 1) throw new CardError(409, `id ${id} 重複（${found.map((c) => c.group).join('、')}），請先在 app 裡處理`);
  return found[0];
}

// All ids are looked up before anything is written, so a typo in the list changes nothing.
async function findAll(ids) {
  const cards = [];
  for (const id of ids) cards.push(await find(id));
  return cards;
}

function progressTarget() {
  return { progressDir, device: process.env.NOESIS_DEVICE || config.device };
}

async function stdin() {
  if (process.stdin.isTTY) throw new UsageError('卡片內容要從 stdin 傳入');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

function one(list) {
  if (list.length !== 1) throw new UsageError('這個指令只接受一個參數，用 help 看用法');
  return list[0];
}

function atLeastOne(list) {
  if (!list.length) throw new UsageError('至少要給一個參數，用 help 看用法');
  return list;
}

function usage(message) {
  console.error(`${message}\n用 npm run deck -- help 看用法`);
  process.exit(2);
}
