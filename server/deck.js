import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { GROUP_ORDER_FILE, RESERVED_DIRS, buildDeck } from './deck-files.js';

export { GROUP_ORDER_FILE, RESERVED_DIRS, isGroupSlug } from './deck-files.js';

export function cardVersion(raw) {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export async function loadDeck(root) {
  const files = new Map();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || RESERVED_DIRS.has(entry.name)) continue;
    const dir = path.join(root, entry.name);
    // A group with no files still exists on disk; the placeholder makes buildDeck see it.
    files.set(`${entry.name}/.`, { text: '' });
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (!file.isFile() || file.name.startsWith('.')) continue;
      if (!file.name.endsWith('.md') && file.name !== '_group.json') continue;
      const text = await readFile(path.join(dir, file.name), 'utf8');
      files.set(`${entry.name}/${file.name}`, { text, version: cardVersion(text) });
    }
  }
  const order = await readOptional(path.join(root, GROUP_ORDER_FILE));
  if (order !== undefined) files.set(GROUP_ORDER_FILE, { text: order });
  return buildDeck(files);
}

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}
