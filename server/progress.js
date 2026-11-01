import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE } from './config.js';
import { parseEvents } from './progress-lines.js';

const DEVICE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const CARD_ID = /^[a-z0-9]{5}$/;
const RATINGS = new Set(['again', 'hard', 'good', 'easy']);
const MARKERS = new Set(['reset', 'suspend', 'unsuspend']);

export class ProgressError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function checkDevice(device) {
  if (device == null || device === '') return `尚未設定裝置名稱：請在 ${CONFIG_FILE} 設定 "device"`;
  if (typeof device !== 'string' || !DEVICE.test(device)) return `裝置名稱不合法：${device}（只能用英數、-、_）`;
  return null;
}

export function toEvent(body, now = new Date()) {
  if (typeof body?.id !== 'string' || !CARD_ID.test(body.id)) throw new ProgressError(400, 'id 不合法');
  if (MARKERS.has(body.type)) return { time: now.toISOString(), id: body.id, type: body.type };
  if (body.type !== 'review') throw new ProgressError(400, 'type 必須是 review、reset、suspend 或 unsuspend');
  if (body.rating === undefined) return { time: now.toISOString(), id: body.id, type: 'review' };
  if (!RATINGS.has(body.rating)) throw new ProgressError(400, 'rating 必須是 again、hard、good 或 easy，或不填');
  return { time: now.toISOString(), id: body.id, type: 'review', rating: body.rating };
}

export async function appendEvent({ progressDir, device }, event) {
  const problem = checkDevice(device);
  if (problem || !progressDir) throw new ProgressError(503, problem ?? '尚未設定進度資料夾');
  await mkdir(progressDir, { recursive: true });
  await appendFile(path.join(progressDir, `${device}.jsonl`), `${JSON.stringify(event)}\n`);
}

// Events for cards that no longer exist are skipped, never deleted: the card may come back.
// Without `knownIds`, events of cards no longer in the deck are kept too.
export async function readEvents(progressDir, knownIds) {
  let entries;
  try {
    entries = await readdir(progressDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.startsWith('.')) continue;
    const device = entry.name.slice(0, -'.jsonl'.length);
    for (const event of parseEvents(await readFile(path.join(progressDir, entry.name), 'utf8'), device)) {
      if (!knownIds || knownIds.has(event.id)) events.push(event);
    }
  }
  return events.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}
