import { readFileSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'noesis.config.json';

// Everything resolves from the working directory: in this repo that is the code with a config pointing at the data,
// and in the data repo, where this package is installed, it is the data itself.
export function loadConfig(cwd = process.cwd()) {
  const file = path.join(cwd, CONFIG_FILE);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} 不是合法的 JSON`);
  }
}

export function dataPaths(config, { cwd = process.cwd(), env = process.env } = {}) {
  const dataDir = path.resolve(cwd, env.NOESIS_DATA ?? config.dataDir ?? '.');
  return {
    dataDir,
    deckDir: path.resolve(cwd, env.NOESIS_DECK ?? path.join(dataDir, 'decks')),
    progressDir: path.resolve(dataDir, env.NOESIS_PROGRESS ?? config.progressDir ?? 'progress'),
  };
}
