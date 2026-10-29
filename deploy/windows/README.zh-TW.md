# Windows 本機每 15 分鐘部署

## 目前的隱私與 Email 通知方式

GitHub repo 已改為 Private、Actions 已整體停用，公開 Pages 已下架。下方涉及公開 Pages 的內容是先前部署紀錄。

舊版透過 Actions bot 在 Issue #1 留言並提及擁有者，由 GitHub 寄送通知，並不需要 Resend。現在已恢復 Issue 的 `@擁有者` 提及，但本機使用擁有者本人的 GitHub token 留言，因此需至 [GitHub 通知設定](https://github.com/settings/notifications)，確認 Email 通知開啟、預設通知地址正確，並勾選 **Include your own updates／自己的更新**。本機仍維持 `EMAIL_ENABLED=false`，此值只關閉直接呼叫 Resend，不會關閉 GitHub 自己的通知信。實際投遞仍依 GitHub 帳號設定，不能以 Issue 留言成功當作已收到信。

若未來選擇由本機直接寄信，才需要另外設定寄信服務；目前不需為沿用 GitHub 通知申請 Resend 金鑰。

## 架構查核

查核起點：`f36cb3023fee3b8ffb966ea40a18eee774a489bf`（2026-10-29）。

真正抓價入口為 **Node 24+ 的 `tools/watch.mjs`**，不需要 npm 安裝，也不需要 Python。`build_site.py`、`build_status.py` 是舊版產頁工具，不會抓虎航 API。為了最小修改，保留全部業務程式，新增 Windows 腳本並移除 workflow 的 cron；不要再加 Python 轉呼叫層。

原 workflow `.github/workflows/watch.yml` 的 cron 為 `*/15 * * * *`，另有手動 `workflow_dispatch`。使用 Node 24，先跑測試，再抓四個機場 API、計算 88 航段／50 種行程（含 6 種 A 進 B 出），保存通知佇列、向 Issue #1 留言、產生靜態頁，最後 commit/push。Email 明確關閉，既有 Email 待寄紀錄保留。Pages 來源為 main 根目錄。

新流程：工作排程器 → `powershell.exe` → `Run-Tracker.ps1` → `node tools/watch.mjs` → 僅提交五個既有輸出檔 → push main → Pages。沒有新增常駐服務，沒有改動抓價／計價／通知邏輯。

## 此電腦的路徑

```powershell
$repo = 'C:\Users\zackary\Documents\Codex\2026-10-29\referenced-chatgpt-conversation-this-is-an\outputs\tigerair_fare_tracker'
Set-Location -LiteralPath $repo
```

此資料夾是實際部署位置；排程使用絕對路徑。不要任意搬動或刪除。若搬動，先停用原工作，再於新位置重新安裝。Node／Git 的絕對路徑在 `.local/config.json`，執行不依賴 PATH、Python、虛擬環境或終端機設定檔。

## 重新部署／另一台電腦

先安裝 Node 24+、Git、GitHub CLI，clone 專案，登入具有此 repo 寫入權限的 GitHub 帳號。以下均在 repo 根目錄的 Windows PowerShell 執行；若公司限制工作註冊，可用同一帳號的系統管理員 PowerShell。

```powershell
gh auth login --web
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\Install-Task.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\Save-Token.ps1 -FromGh
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\Complete-Deployment.ps1
```

`Install-Task.ps1` 預設建立停用的工作，重跑只更新同一工作。`Complete-Deployment.ps1` 會先驗證 GitHub 權限、Issue 存在與真實 API dry-run，然後移除並提交 cron（保留手動入口）。確認現存 watch workflow 沒有 queued/running 執行，拉回最後狀態，再啟用本機工作並立即啟動一次。如果雲端仍有執行，腳本會保留本機停用狀態；等雲端結束後重跑同一指令。切換期間會有短暫排程空窗。

首次推送包含 `.gitignore`、`deploy/windows` 與 workflow 切換。日後每次工作只 stage `index.html`、`all-routes.html`、`status.html`、`status.json`、`tools/state.json`。其他已追蹤檔若有未提交修改，或有已 stage 內容，會拒絕正式執行，避免誤提交；先處理修改再恢復工作。

不要在本機正式排程運作期間手動執行雲端 workflow 或直接跑 `node tools/watch.mjs`。排程器與檔案鎖只涵蓋這台電腦的 wrapper，無法鎖住遠端 Actions 或繞過 wrapper 的指令。

## Windows 登入／啟動條件

預設是目前使用者、一般權限、Interactive 模式：**需要同一使用者維持登入**，鎖定畫面可以，登出不行。每日本機時間 00:00 起每 15 分鐘觸發（00／15／30／45 分），登入時也補跑一次。工作執行視窗隱藏。

如果需要登出後也執行，請在同一 Windows 帳號的 PowerShell 執行：

```powershell
$windowsCredential = Get-Credential -UserName ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -Message '輸入 Windows 登入密碼（不是 PIN）'
& .\deploy\windows\Install-Task.ps1 -Credential $windowsCredential -Enable
```

Password 模式會加上開機觸發，可在未登入時使用網路。Windows 密碼由工作排程器管理，不寫入專案；同帳號的 GitHub DPAPI 憑證仍適用。網域的「以批次工作登入」原則可能限制註冊；若 Windows 密碼更改，需重跑上面指令。沒有使用無網路存取能力的 S4U 模式。

已設定：有網路才啟動、錯過後允許補跑、嘗試喚醒、允許電池供電且切到電池不停止、不要求閒置。`WakeToRun` 還需要硬體／Windows 電源計畫允許喚醒計時器；關機、休眠限制、斷網與系統負載仍會造成漏跑或延遲。這是固定觸發間隔，不是嚴格準時完成的 SLA。錯過多次不會補抓過去票價。可用 `powercfg /waketimers` 檢查系統喚醒安排。

## 防重疊、逾時與失敗

- 排程器 `IgnoreNew`；wrapper 再使用 `.local/run.lock` 的 Windows 獨佔檔案鎖，涵蓋手動 wrapper 與不同登入工作階段。程序結束即釋放，鎖檔留下不代表仍鎖住。
- wrapper 總期限 12 分鐘，Node 最多 8 分鐘，各 Git 子程序最多 60 秒且受總期限限制。逾時使用 Windows `taskkill /T /F` 終止該次子程序樹；排程器另有 14 分鐘上限。
- API 已有每站 30 秒 timeout，HTTP 錯誤、回傳格式錯誤、任一站沒有有效票價都失敗。整個抓價成功前不寫入票價輸出。
- 程式若通知失敗，原有持久佇列保留；wrapper 仍提交狀態後以失敗退出。下次 15 分鐘工作重試未完成管道。不額外設定立即重跑，避免通知／請求暴增。
- 啟動時先提交並推送上次留下的輸出／本機 commit，再以 `pull --ff-only` 取得最新資料。push 同一 commit 最多重試三次；不 force-push、不自動合併競爭的 state。若遠端分歧，保留本機結果並失敗，需要人工檢視。
- 每次正式執行前備份五個輸出至 `.local/backup/<時間>`，保存 30 天。state/status JSON 損壞會停止，不讓既有程式的預設值處理默默重設歷史。若硬斷電或強制終止造成檔案損壞，先停用工作、備份現況，再從最近完整備份人工復原。不要任意把已成功留言的通知標記倒回，否則可能重送。
- 原有通知並非跨 GitHub 與本機的交易：若 GitHub 已接受留言但本機尚未寫下 acknowledgement 就中斷，下次可能重送。這個方案保留既有行為，不宣稱 exactly-once。
- 退出碼 0=成功或因鎖被占用而跳過；1=既有 Node 工作失敗；2=部署／Git／設定／逾時等 wrapper 錯誤。排程器額外逾時或取消會顯示 Windows 自己的結果碼。

## 環境變數／憑證

`.local/` 已加入 `.gitignore`，包含設定、DPAPI 密文、log、備份與匯出的工作 XML。Token 不寫在 workflow、工作引數、repo URL 或 log。由 `Save-Token.ps1 -FromGh` 從現有 GitHub CLI 登入取得，透過 Windows DPAPI 保存；只有此電腦的同一 Windows 使用者可解密。這會沿用現有登入的權限；若要縮小權限，可改執行不帶 `-FromGh` 的 `Save-Token.ps1`，在隱藏輸入中提供只選此 repo、Contents 與 Issues 讀寫的 fine-grained PAT。若 repo 有分支保護，也必須允許此帳號直接推送。

正式工作每次解密並只在程序及子程序環境設定：`GITHUB_TOKEN`、`GITHUB_REPOSITORY=YenZackary/tigerair_fare_tracker`、`EMAIL_ENABLED=false`。Git 透過程序環境內的 `http.https://github.com/.extraheader` 驗證，停用互動式 credential helper；不依賴排程中跳出登入視窗。不要設定 Resend／Email 參數。Token 過期或撤銷後重新執行 `Save-Token.ps1` 即可。DPAPI 保護靜態檔案；同帳號正在執行的程式仍能讀取自己的憑證。

## 檢查與日常指令

```powershell
# 工作狀態、上次結果、下次觸發時間
Get-ScheduledTask -TaskName 'TigerairFareTracker-15m' | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName 'TigerairFareTracker-15m' | Format-List LastRunTime,LastTaskResult,NextRunTime,NumberOfMissedRuns

# 最近一次 wrapper 結果，以及對應完整 log
$lastRun = Get-Content .\.local\last-run.json -Raw | ConvertFrom-Json
$lastRun | Format-List
Get-Content -LiteralPath $lastRun.log -Encoding UTF8 -Tail 100

# 手動排程啟動（不要另開 node）
Start-ScheduledTask -TaskName 'TigerairFareTracker-15m'

# 真實 API 試跑：不寫票價／通知／Git；仍會寫本機 log 與 last-run.json
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\Run-Tracker.ps1 -DryRun

# 原有 14 項離線測試
node --test --test-isolation=none tools/pricing.test.mjs tools/notifications.test.mjs

# 暫停／恢復（只有完成雲端切換後才啟用）
Disable-ScheduledTask -TaskName 'TigerairFareTracker-15m'
Enable-ScheduledTask -TaskName 'TigerairFareTracker-15m'

# 移除工作；保留 repo、憑證與紀錄供人工處理
Unregister-ScheduledTask -TaskName 'TigerairFareTracker-15m' -Confirm:$false
```

每次執行有獨立 UTF-8 log，30 天後於下次執行清理。`last-run.json` 在開始及結束更新，包含 UTC 時間、dry-run 標記、階段、退出碼及 log 路徑；若停在 running 且程序已不在，代表外部終止／電源中斷。手動 dry-run 也會更新 last-run，請用 dryRun 欄辨識。`task.xml` 是安裝當時匯出的定義，含本機絕對路徑與帳號，沒有 Token。

原產生頁面的來源名稱／說明仍沿用「actions」，`deployed` 也是既有產頁欄位，不是 Pages 部署成功證明；本機每次的權威紀錄是上述 log。push 成功後仍需等 GitHub Pages build；必要時在 GitHub Actions 查看 Pages 執行結果。網站不一定每 15 分鐘改檔，因既有程式只於價格變更或需要紀錄事件時重寫頁面。

## 回復 GitHub 排程

先停用本機工作，等 State 不再是 Running，確認本機五個輸出已成功 push，再手動把 `.github/workflows/watch.yml` 的 `on:` 下加回：

```yaml
  schedule:
    - cron: "*/15 * * * *"
```

提交並推送 main。不要同時開兩端排程，也不要直接回退包含票價狀態的歷史 commit。

## 官方依據

- [Microsoft：排程條件、防重疊、喚醒與補跑](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset)
- [Microsoft：工作登入類型；S4U 不可存取網路](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype)
- [Microsoft：DPAPI／ConvertFrom-SecureString](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/convertfrom-securestring)
- [GitHub：schedule 可能延遲或丟棄](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
