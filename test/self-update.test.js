import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selfUpdate } from '../scripts/self-update.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

async function repos(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'noesis-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=master', remote);
  const clone = (name) => {
    const dir = path.join(root, name);
    git(root, 'clone', '--quiet', remote, dir);
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'test');
    return dir;
  };
  const upstream = clone('upstream');
  git(upstream, 'checkout', '--quiet', '-b', 'master');
  const commit = async (file, text) => {
    await writeFile(path.join(upstream, file), text);
    git(upstream, 'add', '.');
    git(upstream, 'commit', '--quiet', '-m', file);
    git(upstream, 'push', '--quiet', 'origin', 'master');
  };
  await commit('package-lock.json', '{}');
  await commit('app.js', 'v1');
  return { local: clone('local'), commit };
}

const head = (dir) => git(dir, 'rev-parse', 'HEAD').trim();
const recorder = () => {
  const calls = [];
  return { calls, install: async () => { calls.push('install'); } };
};

test('pulls the latest master and installs only when the lock file changed', async (t) => {
  const { local, commit } = await repos(t);
  await commit('app.js', 'v2');
  const r = recorder();
  assert.equal(await selfUpdate(local, r), 'updated');
  assert.equal(git(local, 'show', 'HEAD:app.js'), 'v2');
  assert.deepEqual(r.calls, []);

  await commit('package-lock.json', '{"v":2}');
  assert.equal(await selfUpdate(local, r), 'updated');
  assert.deepEqual(r.calls, ['install']);
});

test('does nothing when already on the latest version', async (t) => {
  const { local } = await repos(t);
  const r = recorder();
  assert.equal(await selfUpdate(local, r), 'current');
  assert.deepEqual(r.calls, []);
});

test('leaves a working copy with local edits or on another branch alone', async (t) => {
  const { local, commit } = await repos(t);
  await commit('app.js', 'v2');
  const before = head(local);
  await writeFile(path.join(local, 'app.js'), 'my edit');
  assert.equal(await selfUpdate(local, recorder()), 'skipped');
  assert.equal(head(local), before);

  git(local, 'checkout', '--quiet', 'app.js');
  git(local, 'checkout', '--quiet', '-b', 'feature');
  assert.equal(await selfUpdate(local, recorder()), 'skipped');
  assert.equal(head(local), before);
});

test('an untracked config file does not stop the update', async (t) => {
  const { local, commit } = await repos(t);
  await commit('app.js', 'v2');
  await writeFile(path.join(local, 'noesis.config.json'), '{}');
  assert.equal(await selfUpdate(local, recorder()), 'updated');
});

test('starts anyway when the remote cannot be reached', async (t) => {
  const { local } = await repos(t);
  git(local, 'remote', 'set-url', 'origin', path.join(local, 'missing.git'));
  assert.equal(await selfUpdate(local, recorder()), 'failed');
});
