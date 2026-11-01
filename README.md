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

沒設定 `device` 也能開，但評分不會被記錄。沒設定 `dataDir` 時，資料 repo 就是目前的資料夾。

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

```bash
npm run sync
```

在資料 repo commit 所有變動，`git pull --rebase` 後 push。找不到 `decks/` 時不會執行，所以不會 commit 到這個 repo。

## 手機版

手機版是同一個練習介面，部署在這個 repo 的 GitHub Pages：<https://loijilai.github.io/noesis-app/>。push 到 `master` 後，GitHub Actions 會跑測試、打包並自動部署。

頁面本身不含任何卡片。第一次打開時輸入資料 repo 的名稱（`owner/repo`）和 fine-grained token，之後直接從 GitHub 讀寫：

- token 只開資料 repo，Repository permissions 的 Contents 設為 **Read and write**，期限可以選 No expiration。token 只存在手機的瀏覽器裡，不要寫進任何檔案。
- 打開頁面時比對檔案列表的 `sha`，只下載有變的檔案，下載過的存在手機裡。圖片在顯示時才下載。
- 評分先存在手機，練習停下來、離開練習頁面或切到背景時，一次 append 到 `progress/phone.jsonl`。寫不出去的會留著，下次再寫。
- 修改和刪除卡片都帶著手機看到的版本寫入；電腦在這段時間改過同一張卡的話，GitHub 會拒絕，不會蓋掉電腦的版本。刪除時 `.md` 和 `_group.json` 在同一個 commit 裡改。
- 手機上不能新增、搬移卡片，也不能改 group。

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
