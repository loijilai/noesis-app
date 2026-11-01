import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { dataPaths, loadConfig } from '../server/config.js';
import { eventKey, isEvent, mergeEvents } from '../phone/events.js';

const progressFile = path.join(dataPaths(loadConfig()).progressDir, 'phone.jsonl');
const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error('用法：npm run phone:import -- <db 匯出的 JSON 檔或資料夾>...');
  process.exit(1);
}

const incoming = collect(await Promise.all((await Promise.all(inputs.map(jsonFiles))).flat().map(async (f) => JSON.parse(await readFile(f, 'utf8')))));
const existing = new Set((await readFile(progressFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => eventKey(JSON.parse(line))));
const fresh = mergeEvents(incoming.valid).filter((e) => !existing.has(eventKey(e)));

await mkdir(path.dirname(progressFile), { recursive: true });
if (fresh.length) await appendFile(progressFile, fresh.map((e) => `${JSON.stringify(e)}\n`).join(''));
console.log(`noesis: 新增 ${fresh.length} 筆，略過已匯入 ${incoming.valid.length - fresh.length} 筆${incoming.invalid ? `、格式不對 ${incoming.invalid} 筆` : ''}`);

async function jsonFiles(input) {
  if (!(await stat(input)).isDirectory()) return [input];
  const entries = await readdir(input, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => path.join(e.parentPath, e.name));
}

// Accepts events, documents holding an `events` array, or db rows wrapping either under `data`.
function collect(value) {
  const valid = [];
  let invalid = 0;
  const visit = (item) => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (item?.data && typeof item.data === 'object') return visit(item.data);
    if (Array.isArray(item?.events)) return item.events.forEach(visit);
    if (item?.docs) return visit(item.docs);
    if (isEvent(item)) valid.push(pick(item));
    else invalid++;
  };
  visit(value);
  return { valid, invalid };
}

function pick({ time, id, type, rating }) {
  return type === 'review' && rating !== undefined ? { time, id, type, rating } : { time, id, type };
}
