#!/usr/bin/env node
import { text } from 'node:stream/consumers';
import { dataPaths, loadConfig } from '../server/config.js';
import { defaultBranchOf, gitIn, isDataRepo, pendingFiles, syncRepo, upstreamOf } from '../server/git-sync.js';

// `--cloud` is for an agent in a cloud session, whose copy is gone once the session ends: it pushes to the default
// branch, whatever branch the session works on, and leaves a conflict for the user to decide.
// `--hook` does the same from a Claude Code Stop hook, only in a cloud session, and hands a problem back to the agent
// (exit 2) so it tells the user instead of ending the turn.
const hook = process.argv.includes('--hook');
const cloud = hook || process.argv.includes('--cloud');
const FAILED = hook ? 2 : 1;

if (hook) {
  if (!process.env.CLAUDE_CODE_REMOTE) process.exit(0);
  // Claude Code runs the hook again after the agent has answered a problem; it must not keep it from stopping.
  const input = JSON.parse((await text(process.stdin).catch(() => '')) || '{}');
  if (input.stop_hook_active) process.exit(0);
}

const config = loadConfig();
// Lets a checkout that has no device of its own label its commits.
const device = process.env.NOESIS_DEVICE || config.device || (cloud ? 'cloud' : 'unknown device');
const { dataDir } = dataPaths(config);

if (!isDataRepo(dataDir)) {
  console.error(`noesis: ${dataDir} 不是有 decks/ 的 git repo。在 noesis.config.json 設定 "dataDir"，指向卡片的 repo`);
  process.exit(FAILED);
}

const git = gitIn(dataDir);
const target = cloud ? await defaultBranchOf(git) : await upstreamOf(git);
if (!target) {
  console.error('noesis: 目前的分支沒有對應的遠端分支，無法同步');
  process.exit(FAILED);
}

try {
  if (cloud && !(await pendingFiles(git, target)).size) {
    if (!hook) console.log('noesis: 沒有要同步的改動');
    process.exit(0);
  }
  const { conflicts } = await syncRepo(git, target, { message: `sync: ${device}` });
  if (conflicts.length) {
    const files = conflicts.map((c) => `  ${c.path}`).join('\n');
    console.error(cloud
      ? `noesis: 同步衝突，這些檔案在 GitHub 上也被改過：\n${files}\n改動已 commit 在這個 session 裡，但還沒推上去。請告訴使用者是哪些檔案衝突、各自改了什麼，由使用者決定；不要自己解衝突，也不要強制 push。`
      : `noesis: 同步衝突，這些檔案兩邊都改過：\n${files}\n改動已 commit 在本機，還沒推上去。打開 app 點頁首的衝突處理，或手動解決後再跑一次。`);
    process.exit(FAILED);
  }
  if (!hook) console.log(cloud ? `noesis: 已推到 ${target.remote}/${target.branch}` : 'noesis: 同步完成');
} catch (err) {
  console.error(`noesis: 同步失敗：${(err.stderr || err.message || String(err)).trim()}`);
  if (cloud) console.error('改動還在這個 session 裡，沒有推上去。請告訴使用者同步失敗，session 結束前要處理，否則改動會消失。');
  process.exit(FAILED);
}
