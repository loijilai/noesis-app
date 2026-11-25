#!/usr/bin/env node
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TIMEOUT_MS = 15000;

// Only a clean master is updated, so work in progress on this repo is never pulled over.
export async function selfUpdate(dir, { install }) {
  const git = async (...args) => (await run('git', args, { cwd: dir, timeout: TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
  try {
    if (await git('rev-parse', '--abbrev-ref', 'HEAD') !== 'master') return 'skipped';
    if (await git('status', '--porcelain', '--untracked-files=no')) return 'skipped';
    const before = await git('rev-parse', 'HEAD');
    await git('pull', '--ff-only', '--quiet');
    if (await git('rev-parse', 'HEAD') === before) return 'current';
    if (await git('diff', '--name-only', before, 'HEAD', '--', 'package.json', 'package-lock.json')) await install();
    return 'updated';
  } catch {
    return 'failed';
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const install = () => run('npm', ['install', '--silent'], { cwd: root });
  const result = await selfUpdate(root, { install });
  const messages = {
    updated: 'noesis: 已更新到最新版',
    skipped: 'noesis: 不在 master 或有未 commit 的改動，略過更新',
    failed: 'noesis: 無法更新，用目前的版本啟動',
  };
  if (messages[result]) console.log(messages[result]);
}
