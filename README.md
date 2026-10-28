# 虎航票價追蹤

台灣虎航 2027 年 1–10 月來回票價追蹤，跑在 **GitHub Actions** 上，以每 15 分鐘為目標排程抓價（GitHub cron 不保證準時或不漏跑）。
不需要任何本機環境、不需要瀏覽器、不需要你的電腦開著。

**公開頁面：** https://yenzackary.github.io/tigerair_fare_tracker/

**追蹤條件**：2027-01-01 ~ 2027-10-31 出發、行程 3–5 天（含頭尾）、且區間內同時涵蓋週六與週日、
1 位成人、不含託運行李。桃園／台中／高雄／台南出發的所有航點，目前 44 條同點進出航線，另外追蹤 6 種韓國 A 進 B 出行程，共用 88 個航段。

韓國 A 進 B 出僅追蹤以下配對，不包含濟州；原本濟州同點進出的追蹤仍保留。
兩段機票各自計價與加稅，不包含韓國境內交通。仁川、金浦是首爾的不同機場。
網站「行程類型」可以單獨篩選這 6 種行程；新行程首次抓價建立獨立歷史基準，之後沿用價格變動、新低價及每日摘要通知。

| 去程 | 回程 |
|---|---|
| 桃園 → 首爾仁川 | 釜山 → 桃園 |
| 桃園 → 首爾仁川 | 首爾金浦 → 高雄 |
| 桃園 → 釜山 | 首爾仁川 → 桃園 |
| 桃園 → 釜山 | 首爾金浦 → 高雄 |
| 高雄 → 首爾金浦 | 首爾仁川 → 桃園 |
| 高雄 → 首爾金浦 | 釜山 → 桃園 |

**金額一律是實付總額** ＝ 未稅票價 ＋ 去程稅費 ＋ 回程稅費。

## 怎麼運作

```
GitHub Actions（錯開整點 cron／手動／外部 scheduler）
  └─ node tools/watch.mjs
       ├─ 抓虎航每日票價 API（4 個台灣機場）
       ├─ 算出每條來回航線在條件內的最低價
       ├─ 跟 tools/state.json 比對 → 判斷「新低價」與「一般變動」
       ├─ 通知寫入持久佇列 → Resend API 寄 Email
       ├─ 同時在 Issue #1 留言作 log/history（不再 mention）
       └─ 重新產生 index.html / all-routes.html / status.html
  └─ 有變動就 commit 回 repo → GitHub Pages 自動更新
```

票價 API 的 CORS 鎖在 `tigerairtw.com` 網域，但**CORS 只有瀏覽器會執行** ——
Actions runner 上的 Node 不送 `Origin` header，所以可以直接呼叫。

## 通知

主要通知改由 **Resend Email API** 發送，不需自架伺服器，也不需安裝套件。
同一份文字仍會貼到 [Issue #1](../../issues/1) 作歷史記錄；即使 Issue 關閉也沿用 #1，不另開 Issue。
GitHub 自身可能仍寄訂閱通知，但不再依賴 mention 或訂閱信保證送達。
Email 以純文字保留 Markdown 表格、金額與網站連結；API 接受不等於收件匣一定送達，請在 Resend 查看投遞／退信及垃圾郵件分類。

| 事件 | 條件 | 節流 |
|---|---|---|
| **新低價** | 某航線含稅來回合計跌破**歷史最低** | 不節流，寫入佇列 |
| **每日摘要** | 台北時間 08:00 之後第一次執行 | 每天一次 |
| **一般變動** | 最低價跟上次比有動，但沒破歷史最低 | 預設不節流（沿用程式設定 0） |

幾個刻意的設計：

- **新低價獨立排入佇列**：不受節流限制，也不受「今天摘要已排入」影響。同一條航線 24 小時內用同一個價位
  不會重複發，價位不同就會再發。
- **通知失敗不會阻擋資料更新**。`tools/state.json` 的 `pendingNotifications` 保存原始通知及 Email／Issue 各自成功狀態；即使價格基準已更新、隔次價格相同，也會重試原訊息。成功管道不重送，兩者成功才移除。每日摘要與節流欄位代表「已排入佇列」，`status.json` 的 `notified` 代表 Email API 已接受。
- Resend 網路錯誤、逾時、HTTP 429／5xx 最多重試 3 次，每次最多等 15 秒；其他 4xx 留待設定修正後下次執行再試。每管道每次最多處理 10 筆，失敗時該管道暫停，另一管道繼續，未完成內容不丟棄。
- 相同訊息使用相同 Resend idempotency key，服務端只保留 24 小時去重。若寄送成功但狀態未能 push、或逾 24 小時才重試，仍可能重複寄送；Issue API 本身沒有相同去重保證。
- 失敗會顯示 Actions error、在狀態頁留下錯誤及佇列筆數；workflow 先嘗試 commit 頁面／狀態，最後仍標示失敗。請啟用 GitHub Actions 失敗通知並查看 push 是否成功。
- 佇列內容與既有 Issue 一樣是公開票價資訊；API key 與收寄件地址只從 Secrets 讀取，不存入 repo。
- 每次成立的通知合併成一封 Email／一則 Issue 留言；摘要已包含變動表時不再重複列出。
- **第一次執行只建立基準**，不發新低價或變動通知（沒有歷史可以比）。
- 「新低」用的是**歷史最低**，不是「跟上次比」—— 後者只是一般變動。

想調整就改 `tools/watch.mjs` 最上面那段常數：`CHANGE_THROTTLE_MIN`、`DAILY_SUMMARY_HOUR`、
`MAX_*`（訊息最多列幾條）。追蹤條件也在同一區：`DATE_FROM`、`DATE_TO`、`TRIP_NIGHTS`、`REQUIRE_WEEKEND`。

## 頁面

| 檔案 | 內容 |
|---|---|
| `index.html` | 首頁：最便宜的 5 條 + 入口 |
| `all-routes.html` | 全航線儀表板：排行、長條圖、價格日曆、單程走勢、所有組合、稅費查核進度 |
| `status.html` | 變動與通知紀錄（只記有意義的事件 + 每小時一筆例行檢查） |

**想看每一次執行的完整紀錄與 log，去 [Actions 頁](../../actions)** —— 那才是完整的執行歷史。
`status.html` 只記錄有意義的事件，避免每 15 分鐘產生一個 commit。

## 手動觸發與試跑

到 [Actions 頁](../../actions) → 選「虎航票價追蹤」→ Run workflow。
勾 **dry** 就是試跑：照樣抓價、把本次會發的通知內容印在 log 裡，但**不發通知、不改任何檔案**。
第一次設定完或改過條件之後，建議先用 dry 跑一次看輸出對不對。

本機也可以跑（需要 Node 24+，無外部套件）：

```bash
node tools/watch.mjs --dry                     # 抓真的 API，但不通知不寫檔
node tools/watch.mjs --fixture=<快照.json>     # 完全離線
node tools/watch.mjs --summary                 # 強制發每日摘要
```

## 稅金與其他費用

2026-10-02 已逐一查核全部 44 條航線最低價候選的官網購物車，保存 88 航段的實測日期與費用於 `tools/fee-observations.json`。
`tools/fees.mjs` 從實測費用扣除該日官方訂位服務費，保留航段稅費基準，再依 2027 旺季日期加回非旺季 350／旺季 450 元。
每個日期組合先算去回票價及日期相關費用，再以含稅總額選最低價。未實測的新航段只顯示未稅價。
稅費基準會受匯率及官方費率調整影響，實際以官網結帳為準。

官方規則：https://www.tigerairtw.com/zh-TW/ready-to-go/ticket-related
測試：`node tools/pricing.test.mjs`。

## 設定（只需做一次）

1. 到 [Resend](https://resend.com/) 建立帳號與具寄信權限的 API key。正式使用請驗證自己的寄件網域，並使用該網域的寄件地址。沒有網域時可先用 `onboarding@resend.dev` 測試，但只能寄到註冊 Resend 帳號的信箱；實際限制依 Resend 帳號／方案為準。
2. 到 repo **Settings → Secrets and variables → Actions → New repository secret** 加入：

   | Secret | 用途／範例 |
   |---|---|
   | `RESEND_API_KEY` | Resend 提供的寄信 API key |
   | `EMAIL_FROM` | 已驗證寄件地址，例如 `虎航票價追蹤 <tracker@your-domain.example>`；測試可用 `onboarding@resend.dev` |
   | `EMAIL_TO` | 你的收件信箱；多個收件地址用英文逗號分隔 |

   `GITHUB_TOKEN` 由 Actions 自動提供，不需自己新增。此 repo 檢查時沒有現有 Email Secrets／Variables，所以沒有可沿用的寄信帳號。請勿把 key 貼進 Issue 或 commit。
3. **Settings → Actions → General → Workflow permissions** 允許 workflow 的 `contents: write` 與 `issues: write`，用於保存頁面／狀態與 Issue 記錄。
4. **Settings → Pages** 保留 `main` 分支根目錄來源；頁面檔名、內容模板與計價規則均沿用。
5. 先手動 Run workflow 勾 `dry` 檢查輸出；再取消 `dry`、勾 `summary` 強制產生一次測試摘要。確認 Email 收到、Resend 顯示投遞狀態、Issue #1 有留言，以及 Actions 有成功保存狀態。`dry` 不驗證 Email 連線，也不送出待傳通知。

若缺少 Secrets，抓價與 Issue log 仍會執行，Email 留在佇列，workflow 最後顯示失敗。補齊 Secrets 後手動執行即可重試。當 Email 無法使用很久，會累積歷史通知，恢復後依序補寄；請留意方案額度，多個收件人也會消耗額度。

## 排程與外部 scheduler

內建 cron 改為 UTC 每小時 **07、22、37、52 分**，避開整點尖峰。四個 cron 是同一個 GitHub 排程服務，分開列出便於追查觸發來源，**不是四份獨立備援，也不能保證 15 分鐘**。每日摘要仍在台北 08:00 後首次實際執行才排入佇列。

已保留 `workflow_dispatch`（手動或 API）並新增 `repository_dispatch`，事件名稱為 `tigerair-watch`。若要降低 GitHub cron 漏觸發的風險，在你選用的外部 scheduler 設定每 15 分鐘發出以下 HTTPS 請求；所有抓價與寄信仍在 GitHub Actions 執行：

```http
POST https://api.github.com/repos/YenZackary/tigerair_fare_tracker/dispatches
Accept: application/vnd.github+json
Authorization: Bearer <外部 scheduler 安全儲存的 GitHub token>
X-GitHub-Api-Version: 2022-11-28
Content-Type: application/json

{"event_type":"tigerair-watch"}
```

使用只授權本 repo、具 **Contents: write** 的 fine-grained PAT（repository dispatch 所需），設定期限並定期輪替。token 存在外部 scheduler 的安全憑證欄位，不能寫在 URL、repo 或公開頁面；無需額外放進本 repo Secrets。外部服務需支援自訂 POST body 與 Authorization header，針對非 204 回應重試並發出警示。HTTP 204 只代表 GitHub 接受事件，還要在 Actions 確認 job 實際開始及成功。

也可用具 **Actions: write** 權限的 fine-grained PAT 呼叫：

```http
POST https://api.github.com/repos/YenZackary/tigerair_fare_tracker/actions/workflows/watch.yml/dispatches
Accept: application/vnd.github+json
Authorization: Bearer <外部 scheduler 安全儲存的 GitHub token>
X-GitHub-Api-Version: 2022-11-28
Content-Type: application/json

{"ref":"main","inputs":{"dry":false,"summary":false}}
```

外部入口已完成，但**尚未建立任何外部服務排程或 token**。啟用外部 scheduler 後可保留內建 cron 作盡力備援（可能增加抓價次數），或移除 `schedule` 區塊。共用 concurrency 避免同時改狀態；checkout 取最新分支。GitHub concurrency 只保留一個 pending job，尖峰時較新的觸發可能取代等待中的觸發，無法保證每個事件都執行。

## 驗證

```bash
node --test tools/*.test.mjs
```

涵蓋既有票價／日期費用、Resend 重試與去重 key、Email／Issue 各自失敗、佇列保存與補送、dry-run 不寫檔不通知。測試使用離線資料與模擬 API，不會真的寄信或留言。若本機限制測試子程序啟動，可用 Node 24 的 `node --test --test-isolation=none tools/*.test.mjs`。

## 限制

- GitHub 官方說明 cron 可能延遲，在負載高時甚至丟棄排程；錯開分鐘與多個 cron 都無法消除這個限制。外部 scheduler 能改善「觸發」可靠性，Actions runner 排隊、GitHub 故障或配額仍會影響實際時間，不能承諾嚴格 15 分鐘 SLA。
- cron 與 repository dispatch 的 workflow 必須存在預設分支。公開 repo 連續 60 天沒有活動時 cron 可能停用，應確認 Actions 排程狀態；本 workflow 正常保存狀態會產生活動，不能視為永久保證。
- 票價隨機位變動，未執行的時段仍可能錯過短暫低價。通知有佇列不代表能補抓過去未觀測到的價格。
- 票價僅供參考，非台灣虎航官方頁面，下訂請以官網結帳頁為準。

參考：[GitHub workflow 事件與排程限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)、[repository dispatch API](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)、[workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)、[Resend 寄信 API](https://resend.com/docs/api-reference/emails/send-email)、[Resend 24 小時去重](https://resend.com/docs/dashboard/emails/idempotency-keys)。

## 舊檔案

`build_site.py`、`build_status.py`、`busan-osaka.html` 是先前用 Claude 排程 + 瀏覽器上傳時代的產物，
已被 `tools/watch.mjs` 取代，保留只為了不打斷舊連結。釜山／大阪那三條航線
（桃園⇄釜山、桃園⇄大阪、高雄⇄大阪）現在都涵蓋在全航線儀表板裡。

## 2026-10-02 計價修正

- 88 航段官網實測值與日期存於 `tools/fee-observations.json`；`tools/fees.mjs` 扣除當日訂位服務費，保留逐航段稅費基準，再依官方 2027 旺季日期加回 350／450 元。基準可能受匯率變動，實際以官網結帳為準。
- 每個日期組合先算含稅總額再選最低；API 同日同航段重複資料保留較新 `updatedAt`，無效票價不納入。
- 歷史與通知改追蹤含稅最低價；更新計價模型後重新建立基準，保留舊事件紀錄但不與舊未稅數值混比。
