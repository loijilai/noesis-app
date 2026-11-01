import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SYNC = fileURLToPath(new URL('../scripts/sync.js', import.meta.url));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const sync = (cwd, env = {}) => execFileSync(process.execPath, [SYNC], { cwd, stdio: 'pipe', env: { ...process.env, ...env } });

async function clone(remote, dir) {
  git(path.dirname(dir), 'clone', '--quiet', remote, dir);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
}

async function dataRemote(root) {
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=master', remote);
  const seed = path.join(root, 'seed');
  await clone(remote, seed);
  await mkdir(path.join(seed, 'decks'));
  await writeFile(path.join(seed, '.gitignore'), 'noesis.config.json\n');
  await writeFile(path.join(seed, 'decks', '_groups.json'), '{}\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'init');
  git(seed, 'push', '--quiet', 'origin', 'master');
  return remote;
}

test('sync commits everything in the data repo that dataDir points at, pulls and pushes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'noesis-sync-'));
  try {
    const remote = await dataRemote(root);
    const data = path.join(root, 'data');
    const work = path.join(root, 'work');
    await clone(remote, data);
    await clone(remote, work);
    const code = path.join(root, 'code');
    await mkdir(code);
    await writeFile(path.join(code, 'noesis.config.json'), JSON.stringify({ device: 'home', dataDir: '../data' }));

    await mkdir(path.join(data, 'decks', 'g'));
    await mkdir(path.join(data, 'progress'));
    await writeFile(path.join(data, 'decks', 'g', 'aaaaa.md'), '## Question\nq\n');
    await writeFile(path.join(data, 'progress', 'home.jsonl'), '{}\n');
    await writeFile(path.join(data, 'AGENTS.md'), 'rules\n');
    sync(code);

    assert.equal(git(data, 'log', '-1', '--format=%s').trim(), 'sync: home');
    assert.equal(git(data, 'status', '--porcelain'), '');
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'master').trim(), 'sync: home');

    await writeFile(path.join(work, 'noesis.config.json'), JSON.stringify({ device: 'work' }));
    await mkdir(path.join(work, 'progress'), { recursive: true });
    await writeFile(path.join(work, 'progress', 'work.jsonl'), '{}\n');
    sync(work);

    assert.equal(await readFile(path.join(work, 'decks', 'g', 'aaaaa.md'), 'utf8'), '## Question\nq\n');
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'master').trim(), 'sync: work');
    assert.equal(git(work, 'ls-files', 'noesis.config.json'), '');

    await writeFile(path.join(work, 'progress', 'phone.jsonl'), '{}\n');
    sync(work, { NOESIS_DEVICE: 'phone' });
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'master').trim(), 'sync: phone');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sync refuses to run where there is no deck, so it never commits the code repo', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'noesis-sync-'));
  try {
    git(root, 'init', '--quiet');
    await writeFile(path.join(root, 'app.js'), 'v1\n');
    const r = spawnSync(process.execPath, [SYNC], { cwd: root, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /dataDir/);
    assert.equal(git(root, 'status', '--porcelain'), '?? app.js\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
