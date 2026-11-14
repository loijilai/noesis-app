import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAutoSync } from '../server/auto-sync.js';
import { startServer } from '../server/app.js';

const SYNC = fileURLToPath(new URL('../scripts/sync.js', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const card = (text) => `---\ncreated: 2026-01-01T00:00:00.000Z\n---\n\n## Question\n${text}\n\n## Answer\na\n`;
const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (await check()) return;
  throw new Error('timed out');
};

async function clone(remote, dir) {
  git(path.dirname(dir), 'clone', '--quiet', remote, dir);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  return dir;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'noesis-auto-'));
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=master', remote);
  const seed = await clone(remote, path.join(root, 'seed'));
  await mkdir(path.join(seed, 'decks', 'g'), { recursive: true });
  await writeFile(path.join(seed, 'decks', 'g', '_group.json'), '{ "name": "G" }\n');
  await writeFile(path.join(seed, 'decks', 'g', 'aaaaa.md'), card('base'));
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'init');
  git(seed, 'push', '--quiet', 'origin', 'master');
  const other = async (files) => {
    git(seed, 'pull', '--quiet');
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(seed, file), text);
    git(seed, 'add', '.');
    git(seed, 'commit', '--quiet', '-m', 'elsewhere');
    git(seed, 'push', '--quiet', 'origin', 'master');
  };
  const data = await clone(remote, path.join(root, 'data'));
  return { root, remote, data, other, onRemote: (file) => git(remote, 'show', `master:${file}`) };
}

test('pulls on start, and pushes what changed once things are quiet', async () => {
  const { root, data, other, onRemote } = await setup();
  let sync;
  try {
    await other({ 'decks/g/aaaaa.md': card('from phone') });
    const statuses = [];
    sync = await createAutoSync({ dataDir: data, device: 'mac', quietMs: 50, onStatus: (s) => statuses.push(s) });
    await until(() => !sync.status().syncing);
    assert.equal(await readFile(path.join(data, 'decks/g/aaaaa.md'), 'utf8'), card('from phone'));

    await writeFile(path.join(data, 'decks/g/bbbbb.md'), card('new'));
    sync.touched();
    await until(() => sync.status().pending === 1);
    await until(() => sync.status().pending === 0 && !sync.status().syncing);
    assert.equal(onRemote('decks/g/bbbbb.md'), card('new'));
    assert.equal(git(data, 'log', '-1', '--format=%s').trim(), 'sync: mac');
    assert.deepEqual(sync.status(), { pending: 0, conflicts: 0, syncing: false, error: null });
    assert.ok(statuses.some((s) => s.pending === 1));
  } finally {
    await sync?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a file changed on both sides waits as a conflict, with the repo left as it was', async () => {
  const { root, data, other, onRemote } = await setup();
  let sync;
  try {
    sync = await createAutoSync({ dataDir: data, device: 'mac', quietMs: 10e3 });
    await until(() => !sync.status().syncing);
    await writeFile(path.join(data, 'decks/g/aaaaa.md'), card('mac'));
    await writeFile(path.join(data, 'decks/g/ccccc.md'), card('only on mac'));
    await other({ 'decks/g/aaaaa.md': card('phone') });
    await sync.syncNow();

    assert.equal(sync.status().conflicts, 1);
    assert.deepEqual(sync.conflicts(new Map([['g', 'G']])), [
      { id: 'decks/g/aaaaa.md', group: 'g', groupName: 'G', local: card('mac'), remote: card('phone'), missingGroup: false },
    ]);
    assert.deepEqual(sync.conflictCardIds(), ['aaaaa']);
    assert.equal(existsSync(path.join(data, '.git', 'rebase-merge')), false);
    assert.equal(await readFile(path.join(data, 'decks/g/aaaaa.md'), 'utf8'), card('mac'));
    assert.equal(onRemote('decks/g/aaaaa.md'), card('phone'));

    await assert.rejects(sync.resolve('decks/g/aaaaa.md', 'local', 'not a card'), { status: 400 });
    await sync.resolve('decks/g/aaaaa.md', 'local', card('merged'));
    assert.equal(sync.status().conflicts, 0);
    assert.equal(onRemote('decks/g/aaaaa.md'), card('merged'));
    assert.equal(onRemote('decks/g/ccccc.md'), card('only on mac'));
    assert.equal(await readFile(path.join(data, 'decks/g/aaaaa.md'), 'utf8'), card('merged'));
  } finally {
    await sync?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('taking GitHub\'s side keeps what is there, a delete included', async () => {
  const { root, data, other, onRemote } = await setup();
  let sync;
  try {
    sync = await createAutoSync({ dataDir: data, device: 'mac', quietMs: 10e3 });
    await until(() => !sync.status().syncing);
    await writeFile(path.join(data, 'decks/g/aaaaa.md'), card('mac'));
    await other({ 'decks/g/aaaaa.md': card('phone') });
    await sync.syncNow();
    await sync.resolve('decks/g/aaaaa.md', 'remote');
    assert.equal(onRemote('decks/g/aaaaa.md'), card('phone'));
    assert.equal(await readFile(path.join(data, 'decks/g/aaaaa.md'), 'utf8'), card('phone'));
    assert.deepEqual(sync.status(), { pending: 0, conflicts: 0, syncing: false, error: null });
  } finally {
    await sync?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the server reports sync status and conflicts, and resolves them', async () => {
  const { root, data, other, onRemote } = await setup();
  let server;
  try {
    server = await startServer({ deckDir: path.join(data, 'decks'), progressDir: path.join(data, 'progress'), device: 'mac', autoSync: { dataDir: data, quietMs: 10e3 } });
    await until(() => !server.sync.status().syncing);
    const deck = await (await fetch(`${server.url}/api/deck`)).json();
    assert.equal(deck.canSync, true);
    assert.deepEqual(deck.conflicts, []);

    const saved = await fetch(`${server.url}/api/cards/g/aaaaa`, { method: 'PUT', body: JSON.stringify({ raw: card('mac'), version: deck.cards[0].version }) });
    assert.equal(saved.status, 200);
    await other({ 'decks/g/aaaaa.md': card('phone') });
    const status = await (await fetch(`${server.url}/api/sync`, { method: 'POST' })).json();
    assert.equal(status.conflicts, 1);

    const { conflicts } = await (await fetch(`${server.url}/api/conflicts`)).json();
    assert.equal(conflicts[0].groupName, 'G');
    const resolved = await fetch(`${server.url}/api/conflicts/${encodeURIComponent(conflicts[0].id)}`, { method: 'POST', body: JSON.stringify({ use: 'local' }) });
    assert.equal(resolved.status, 204);
    assert.equal(onRemote('decks/g/aaaaa.md'), card('mac'));
    assert.deepEqual(await (await fetch(`${server.url}/api/sync`)).json(), { pending: 0, conflicts: 0, syncing: false, error: null });
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('without auto-sync the server leaves the sync controls off', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'noesis-auto-'));
  let server;
  try {
    await mkdir(path.join(root, 'g'));
    server = await startServer({ deckDir: root, progressDir: null });
    assert.equal((await (await fetch(`${server.url}/api/deck`)).json()).canSync, undefined);
    assert.equal((await fetch(`${server.url}/api/sync`)).status, 404);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

const hook = (cwd, env, input = '{}') => spawnSync(process.execPath, [SYNC, '--hook'], {
  cwd,
  input,
  encoding: 'utf8',
  env: { ...process.env, CLAUDE_CODE_REMOTE: '', ...env },
});

test('the hook does nothing outside a cloud session', async () => {
  const { root, data, onRemote } = await setup();
  try {
    await writeFile(path.join(data, 'decks/g/bbbbb.md'), card('new'));
    const r = hook(data, {});
    assert.equal(r.status, 0);
    assert.throws(() => onRemote('decks/g/bbbbb.md'));
    assert.match(git(data, 'status', '--porcelain'), /bbbbb/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('in a cloud session the hook pushes to the default branch from any branch', async () => {
  const { root, data, onRemote } = await setup();
  try {
    git(data, 'checkout', '--quiet', '-b', 'claude/work');
    assert.equal(hook(data, { CLAUDE_CODE_REMOTE: 'true' }).status, 0);
    assert.equal(git(data, 'log', '-1', '--format=%s').trim(), 'init');

    await writeFile(path.join(data, 'decks/g/bbbbb.md'), card('new'));
    const r = hook(data, { CLAUDE_CODE_REMOTE: 'true' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(onRemote('decks/g/bbbbb.md'), card('new'));
    assert.equal(git(data, 'log', '-1', '--format=%s').trim(), 'sync: cloud');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('in a cloud session a conflict is handed back to the agent once, and nothing is forced', async () => {
  const { root, data, other, onRemote } = await setup();
  try {
    await writeFile(path.join(data, 'decks/g/aaaaa.md'), card('agent'));
    await other({ 'decks/g/aaaaa.md': card('phone') });
    const r = hook(data, { CLAUDE_CODE_REMOTE: 'true' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /decks\/g\/aaaaa\.md/);
    assert.equal(onRemote('decks/g/aaaaa.md'), card('phone'));
    assert.equal(existsSync(path.join(data, '.git', 'rebase-merge')), false);
    assert.equal(hook(data, { CLAUDE_CODE_REMOTE: 'true' }, '{"stop_hook_active":true}').status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--cloud lets an agent push to the default branch from any branch, leaving nothing for the built-in hook to flag', async () => {
  const { root, data, onRemote } = await setup();
  try {
    git(data, 'checkout', '--quiet', '-b', 'claude/work');
    const run = () => spawnSync(process.execPath, [SYNC, '--cloud'], { cwd: data, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_REMOTE: '' } });
    assert.match(run().stdout, /沒有要同步的改動/);

    await writeFile(path.join(data, 'decks/g/bbbbb.md'), card('new'));
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /origin\/master/);
    assert.equal(onRemote('decks/g/bbbbb.md'), card('new'));
    assert.equal(git(data, 'log', '-1', '--format=%s').trim(), 'sync: cloud');
    assert.equal(git(data, 'status', '--porcelain'), '');
    assert.equal(git(data, 'rev-list', '--count', 'origin/HEAD..HEAD').trim(), '0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
