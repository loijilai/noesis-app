import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { dataPaths } from '../server/config.js';

const cwd = path.resolve('/work/noesis-app');

test('without dataDir the working directory is the data repo', () => {
  assert.deepEqual(dataPaths({}, { cwd, env: {} }), {
    dataDir: cwd,
    deckDir: path.join(cwd, 'decks'),
    progressDir: path.join(cwd, 'progress'),
  });
});

test('dataDir resolves from the working directory, and the deck and progress sit inside it', () => {
  const data = path.resolve('/work/noesis');
  assert.deepEqual(dataPaths({ dataDir: '../noesis' }, { cwd, env: {} }), {
    dataDir: data,
    deckDir: path.join(data, 'decks'),
    progressDir: path.join(data, 'progress'),
  });
});

test('environment variables override the config', () => {
  const env = { NOESIS_DATA: '/d', NOESIS_DECK: '/x/decks', NOESIS_PROGRESS: '/y/progress' };
  assert.deepEqual(dataPaths({ dataDir: '../noesis', progressDir: 'p' }, { cwd, env }), {
    dataDir: path.resolve('/d'),
    deckDir: path.resolve('/x/decks'),
    progressDir: path.resolve('/y/progress'),
  });
});
