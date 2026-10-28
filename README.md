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
GitHub Actions（原有每 15 分鐘 cron／手動）
  └─ node tools/watch.mjs
       ├─ 抓虎航每日票價 API（4 個台灣機場）
       ├─ 算出每條來回航線在條件內的最低價
       ├─ 跟 tools/state.json 比對 → 判斷「新低價」與「一般變動」
       ├─ 通知寫入持久佇列 → Issue #1（Email 暫停）
       ├─ 同時在 Issue #1 留言作 log/history（不再 mention）
       └─ 重新產生 index.html / all-routes.html / status.html
  └─ 有變動就 commit 回 repo → GitHub Pages 自動更新
```

票價 API 的 CORS 鎖在 `tigerairtw.com` 網域，但**CORS 只有瀏覽器會執行** ——
Actions runner 上的 Node 不送 `Origin` header，所以可以直接呼叫。

## 通知

2026-10-28 復原：`57be938` 新增 Resend 必填依賴，但 repo 沒有 `RESEND_API_KEY`、`EMAIL_FROM`、`EMAIL_TO`，導致抓價成功後整個工作顯示失敗。

目前 `EMAIL_ENABLED` 預設為 false，workflow 也明確停用 Email。本次新通知只寫入既有 Issue #1；即使 Issue 關閉也不另開 Issue。Issue 或抓價真正失敗仍會回報失敗。

舊 `pendingNotifications` 的 Email 待寄內容與各管道狀態繼續保存；已成功寫入 Issue 的訊息不重送。復原期間新通知標為不要求寄信，Issue 寫入成功後即可完成。日誌的通知成功在此模式代表 Issue 留言成功，不代表 Email 投遞。

不設定或驗證寄信服務，亦不宣稱 Email 已送達。未來重新啟用前應另行完成 Secrets 與投遞驗證。
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

## 設定與排程

- `GITHUB_TOKEN` 由 Actions 提供，workflow 使用 `contents: write` 保存頁面與狀態、`issues: write` 沿用 Issue #1。
- `EMAIL_ENABLED: "false"`：復原期間不需要 Email Secrets，也不呼叫 Resend。
- cron 回復修改前的 `*/15 * * * *`；外部 scheduler 入口撤回。GitHub 排程仍可能延遲或漏跑，沒有準時保證。
- Pages 保留 main 分支根目錄來源。
- 人工執行：Actions → 虎航票價追蹤 → Run workflow。先用 dry 確認四個機場，再取消 dry 確認頁面／狀態保存。summary 預設關閉。
- 各機場記錄 HTTP 狀態、原始筆數、追蹤日期內有效 TWD 筆數及航段數。HTTP 錯誤、非陣列或任一機場沒有有效票價都會失敗，不覆寫資料；每次 API 呼叫最多等待 30 秒。
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
