# noesis

本機執行的 flashcard 練習 app。卡片是 markdown 檔，排程用 FSRS（`ts-fsrs`），練習紀錄是 append-only 的 log。

這個 repo 只有程式碼。卡片和練習紀錄放在另一個資料 repo，用 git 在多台裝置間同步。

## 啟動

需要 Node.js（開發時用 v22）。

資料 repo 和這個 repo clone 在同一層：

```bash
npm install
echo '{ "device": "home-mac", "dataDir": "../noesis" }' > noesis.config.json   # 每台裝置取不同名稱
npm start                                                                    # http://127.0.0.1:4173
```

沒設定 `device` 也能開，但評分不會被記錄。沒設定 `dataDir` 時，資料 repo 就是目前的資料夾。不想自動同步時，在 `noesis.config.json` 加上 `"autoSync": false`。

資料 repo 也可以把這個 repo 當成套件安裝（`"noesis-app": "github:loijilai/noesis-app"`），在資料 repo 裡就能直接用 `noesis-deck` 和 `noesis-sync`，不需要 clone 這個 repo。

## 資料 repo 的結構

- `decks/<group>/<id>.md`：一張卡片，`id` 為 5 碼小寫英數。內容由 `## Question`、`## Code` 或 `## Answer`（二擇一）、選填的 `## Notes` 組成；`## Answer` 可以留白。
  - frontmatter 的 `schedule` 決定排程，可以在卡片選單或 `npm run deck -- schedule` 改：
    - `fsrs`（預設，不寫就是這個）：用 FSRS 排程，練習時評 Again／Hard／Good／Easy。
    - `<N>d`（例如 `30d`）：最後一次練過之後 N 天到期，練習時只按「看過」。適合想定期回到眼前的想法。
    - `none`：不排程、永遠不會到期，練習時只按「看過」。適合面試演練、oblique strategy 這類自己挑來練的卡。
- `decks/<group>/_group.json`：group 名稱與卡片順序；`decks/_groups.json`：group 順序。
- `progress/<device>.jsonl`：該裝置的練習紀錄，每台裝置各寫各的檔，同步時不會衝突。
- `noesis.config.json`：本機設定（`device`、`dataDir`），放在執行指令的資料夾，不進版控。

卡片可以在 app 裡新增、編輯，也可以直接改檔案，app 會自動 reload。

## 卡片狀態

狀態由 `progress/*.jsonl` 裡的事件重播算出，卡片檔案不存狀態。

- `review`：練過一次。有 `rating` 是評分，沒有 `rating` 是按「看過」。
- `reset`：清掉之前的 `review`，回到「還沒練過」。
- `suspend`：封存，不出現在任何練習。
- `unsuspend`：取消封存。

三種排程讀的都是 `review`，所以換排程不會失去進度：FSRS 只讀有 `rating` 的，`<N>d` 從最後一筆算起，`none` 只看有沒有練過。還沒練過的卡不論哪種排程，都在「還沒練過」裡，練過一次才進入排程。

封存和 `reset` 互不影響：reset 不會解除封存，封存期間練習紀錄也保留。

## 同步

規則只有兩條，手機、電腦、agent 都一樣：

1. 改了就自動同步上去，不管是誰改的、在哪裡改的。
2. 同步遇到衝突就停下來，把兩邊給人看，由人決定。

### 電腦

app 開著時會自己同步資料 repo，不用跑任何指令：

- 打開時先 pull。
- 同步的時機跟手機版一樣：離開目前的頁面（在練習頁裡換卡片、換一輪不算）、切到背景、關閉頁面時，把所有改動一起 commit 成 `sync: <device>`、`pull --rebase`、push；切回前景時也會同步一次，看別處改了什麼。關閉 app（Ctrl-C）前也會推一次。
- 改動不分來源：在 app 裡改的，或 agent 直接改檔案，都等到上面這些時機才推。app 開著時，`decks/` 或 `progress/` 一有改動，頁首的待同步數就會更新。
- 頁首的同步狀態跟手機版一樣：顯示待同步的檔案數，點一下立刻同步。
- 同一個檔案兩邊都改過時，rebase 會退回，repo 不會停在 rebase 中間。頁首顯示衝突並暫停自動同步；點進去一個檔案一個檔案並排看「這台裝置」和「GitHub 上」兩邊，這台裝置這邊可以先編輯，再選要用哪一邊。全部選完才會推上去。

只在資料 repo 有 `decks/`、而且目前分支有對應的遠端分支時才會開啟。

手動同步也還在：

```bash
npm run sync
```

做的事情一樣，衝突時一樣退回 rebase，列出衝突的檔案，到 app 裡處理。找不到 `decks/` 時不會執行，所以不會 commit 到這個 repo。

### 雲端 agent session

雲端的 Claude Code session 裡沒有 app 在跑，session 結束後 container 也會被回收，所以改動要在 session 裡就推上去。

```bash
npm run sync -- --cloud
```

推到資料 repo 的預設分支，不管 session 本身在哪個分支上，commit 訊息是 `sync: cloud`（可以用 `NOESIS_DEVICE` 改）。沒有改動時什麼都不做。衝突時不會自己解，也不會強制 push：改動留在 session 裡，列出衝突的檔案。

由 agent 來跑這個指令：在資料 repo 的 `AGENTS.md` 寫明改完 deck 要跑它、授權它推到預設分支。雲端環境內建的 Stop hook 會在 repo 有沒 commit 的改動時擋住 agent、叫它 commit 和 push，所以 agent 不會忘記；跑完 `--cloud` 後 repo 是乾淨的、也沒有沒推的 commit，內建的 hook 就會放行。

這不靠資料 repo 自己的 `.claude/settings.json`：session 放了不只一個 repo 時，起始目錄是它們的上一層，Claude Code 讀不到資料 repo 裡的設定。只放資料 repo 的 session 讀得到，也可以在那裡掛上 Stop hook，每輪回答完自動跑同一件事：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "[ -z \"$CLAUDE_CODE_REMOTE\" ] || { cd \"$CLAUDE_PROJECT_DIR\" && { [ -d node_modules/noesis-app ] || npm install --silent >/dev/null 2>&1; } && npx --no-install noesis-sync --hook; }"
          }
        ]
      }
    ]
  }
}
```

`--hook` 只在雲端 session（有 `CLAUDE_CODE_REMOTE`）動作，本地 session 什麼都不做，交給 app。衝突或推不上去時，它把原因交回給 agent，由 agent 告訴你。

## 手機版

手機版是同一個練習介面，部署在這個 repo 的 GitHub Pages：<https://loijilai.github.io/noesis-app/>。push 到 `master` 後，GitHub Actions 會跑測試、打包並自動部署。

頁面本身不含任何卡片。第一次打開時輸入資料 repo 的名稱（`owner/repo`）和 fine-grained token，之後直接從 GitHub 讀寫：

- token 只開資料 repo，Repository permissions 的 Contents 設為 **Read and write**，期限可以選 No expiration。token 只存在手機的瀏覽器裡，不要寫進任何檔案。
- 打開頁面時比對檔案列表的 `sha`，只下載有變的檔案，下載過的存在手機裡。圖片在顯示時才下載。
- 評分和卡片的新增、修改、刪除都先存在手機，畫面立刻更新，之後在背景一起寫成一個 `sync: phone` commit：離開目前的頁面（在練習頁裡換卡片、換一輪不算）、切到背景、重新打開頁面時。評分 append 到 `progress/phone.jsonl`。寫不出去的會留著，下次再寫。
- 頁首的同步狀態顯示待同步的筆數，點一下立刻同步。
- 每張卡記著手機開始改它時 GitHub 上的版本。電腦在這段時間也改過或刪了同一張卡，這張卡就不送出，頁首顯示衝突；點進去並排看「這台裝置」和「GitHub 上」兩邊，這台裝置這邊可以先編輯，再選要用哪一邊。其他沒衝突的改動照常送出。
- 可以在既有的 group 裡新增卡片（放在最後，或某張卡的前後）。新增和刪除時，`.md` 和 `_group.json` 在同一個 commit 裡改。
- 手機上不能搬移、排序卡片，也不能新增或改 group。

`npm run phone:build` 在本機打包同一個頁面到 `phone/dist/index.html`。

## 環境變數

| 變數 | 預設 |
| --- | --- |
| `PORT` | `4173` |
| `NOESIS_DATA` | `dataDir`，沒設定就是目前的資料夾 |
| `NOESIS_DECK` | `<資料 repo>/decks` |
| `NOESIS_PROGRESS` | `<資料 repo>/progress` |

## 開發

```bash
npm test
```

做卡片的 skill（`/to-card`、`/add-image`）在資料 repo 裡。

`npm run deck -- <指令>` 用指令改題庫的結構：新增、刪除、搬移、排序卡片和 group，以及封存和重設進度。它跟 app 裡的按鈕走同一段程式，順序檔也會一起更新。`npm run deck -- help` 看所有指令。Agent 改結構一律用它；卡片內容可以直接改檔案。
