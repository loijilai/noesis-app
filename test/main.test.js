import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../server/main.js', import.meta.url));

function firstStdoutLine(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('\n')) resolve(out.split('\n')[0]);
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`exited with ${code} before printing`)));
  });
}

test('NOESIS_PROGRESS sets the progress folder', async () => {
  const deckDir = await mkdtemp(path.join(tmpdir(), 'noesis-deck-'));
  const progressDir = await mkdtemp(path.join(tmpdir(), 'noesis-progress-'));
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, NOESIS_DECK: deckDir, NOESIS_PROGRESS: progressDir, PORT: '0' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    const line = await firstStdoutLine(child);
    assert.ok(line.includes(`progress: ${path.resolve(progressDir)},`), line);
    const url = line.match(/http:\/\/\S+/)[0];
    assert.equal((await fetch(`${url}/api/deck`)).status, 200);
  } finally {
    child.kill();
    await rm(deckDir, { recursive: true, force: true });
    await rm(progressDir, { recursive: true, force: true });
  }
});
