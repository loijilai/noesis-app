import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PUSH_ATTEMPTS = 3;

export class SyncError extends Error {}

// Everything in the data repo is committed, so a folder without a deck must never get that far: it may be the code repo.
export function isDataRepo(dataDir) {
  return existsSync(path.join(dataDir, 'decks')) && existsSync(path.join(dataDir, '.git'));
}

export function gitIn(dir) {
  const git = async (...args) => (await run('git', args, { cwd: dir, maxBuffer: 256 << 20, env: { ...process.env, GIT_EDITOR: 'true' } })).stdout;
  git.ok = async (...args) => {
    try {
      await git(...args);
      return true;
    } catch {
      return false;
    }
  };
  git.show = async (spec) => {
    try {
      return await git('show', spec);
    } catch {
      return null;
    }
  };
  return git;
}

export async function upstreamOf(git) {
  try {
    const ref = (await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).trim();
    const slash = ref.indexOf('/');
    return { remote: ref.slice(0, slash), branch: ref.slice(slash + 1) };
  } catch {
    return null;
  }
}

export async function defaultBranchOf(git, remote = 'origin') {
  try {
    const ref = (await git('symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`)).trim();
    return { remote, branch: ref.slice(remote.length + 1) };
  } catch {
    return { remote, branch: 'master' };
  }
}

// What this copy has that the remote does not: files changed since the last commit, and commits not pushed yet.
export async function pendingFiles(git, { remote, branch }) {
  const files = new Set();
  for (const entry of (await git('status', '--porcelain', '-z', '--untracked-files=all')).split('\0')) {
    if (entry) files.add(entry.slice(3));
  }
  const ref = `${remote}/${branch}`;
  if (await git.ok('rev-parse', '--verify', '--quiet', ref)) {
    for (const file of (await git('diff', '--name-only', '-z', `${ref}...HEAD`)).split('\0')) if (file) files.add(file);
  }
  return files;
}

// Commits what changed, replays it on the remote, and pushes.
// A file changed on both sides is taken from `resolutions` ({ use: 'local', raw? } or { use: 'remote' }) when it has one;
// otherwise nothing is half done: the replay is undone and the files are returned as conflicts for a person to decide.
export async function syncRepo(git, { remote, branch }, { message, resolutions = new Map(), exclusive = (fn) => fn() }) {
  const ref = `${remote}/${branch}`;
  for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
    await exclusive(async () => {
      await git('add', '--all');
      if (!(await git.ok('diff', '--cached', '--quiet'))) await git('commit', '--quiet', '-m', message);
    });
    await git('fetch', '--quiet', remote, branch);
    const conflicts = await exclusive(() => replay(git, ref, resolutions));
    if (conflicts.length) return { conflicts };
    if (Number((await git('rev-list', '--count', `${ref}..HEAD`)).trim()) === 0) return { conflicts: [] };
    if (await git.ok('push', '--quiet', remote, `HEAD:refs/heads/${branch}`)) return { conflicts: [] };
  }
  throw new SyncError(`push 一直被拒絕，${remote}/${branch} 上可能一直有新的改動`);
}

async function replay(git, ref, resolutions) {
  if (await git.ok('merge-base', '--is-ancestor', ref, 'HEAD')) return [];
  if (await git.ok('rebase', '--quiet', '--autostash', ref)) return [];
  for (;;) {
    const files = (await git('diff', '--name-only', '-z', '--diff-filter=U')).split('\0').filter(Boolean);
    if (!files.length) {
      await git.ok('rebase', '--abort');
      throw new SyncError('git rebase 失敗，但沒有衝突的檔案');
    }
    const open = files.filter((file) => !resolutions.has(file));
    if (open.length) {
      // During a rebase stage 2 is the commit being built on, the remote's; stage 3 is the local commit being replayed.
      const conflicts = await Promise.all(open.map(async (file) => ({ path: file, local: await git.show(`:3:${file}`), remote: await git.show(`:2:${file}`) })));
      await git('rebase', '--abort');
      return conflicts;
    }
    for (const file of files) await take(git, file, resolutions.get(file));
    const empty = await git.ok('diff', '--cached', '--quiet');
    if (await git.ok('rebase', empty ? '--skip' : '--continue')) return [];
  }
}

async function take(git, file, { use, raw }) {
  if (use === 'local' && raw != null) {
    const full = path.join((await git('rev-parse', '--show-toplevel')).trim(), file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, raw);
  } else {
    const [stage, side] = use === 'remote' ? [2, '--ours'] : [3, '--theirs'];
    if (!(await git.ok('cat-file', '-e', `:${stage}:${file}`))) {
      await git('rm', '--quiet', '--force', '--ignore-unmatch', '--', file);
      return;
    }
    await git('checkout', side, '--', file);
  }
  await git('add', '--', file);
}
