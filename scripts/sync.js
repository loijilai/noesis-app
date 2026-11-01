#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dataPaths, loadConfig } from '../server/config.js';

const config = loadConfig();
// Lets a checkout that has no device of its own label its commits.
const device = process.env.NOESIS_DEVICE || config.device;
const { dataDir, deckDir } = dataPaths(config);

// Everything in the data repo is committed, so running in the code repo by mistake must not get that far.
if (!existsSync(deckDir)) {
  console.error(`noesis: 找不到 ${deckDir}。在 noesis.config.json 設定 "dataDir"，指向卡片的 repo`);
  process.exit(1);
}

try {
  git('add', '--all');
  if (hasStaged()) git('commit', '--quiet', '-m', `sync: ${device ?? 'unknown device'}`);
  git('pull', '--rebase', '--autostash');
  git('push');
  console.log('noesis: 同步完成');
} catch {
  console.error('noesis: 同步失敗，請看上面 git 的訊息。若是 rebase 衝突，解決後執行 git rebase --continue，再重跑 npm run sync');
  process.exit(1);
}

function git(...args) {
  execFileSync('git', args, { cwd: dataDir, stdio: 'inherit' });
}

function hasStaged() {
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: dataDir });
    return false;
  } catch {
    return true;
  }
}
