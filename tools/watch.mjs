#!/usr/bin/env node
/**
 * 台灣虎航 2027 Q1 週末來回票價監控 —— 跑在 GitHub Actions 上。
 *
 * 一次執行做四件事：
 *   1. 抓價（虎航每日票價 API，4 個台灣機場）→ 算出每條來回航線在條件內的最低價
 *   2. 跟上次比對，判斷「新低價」與「一般變動」
 *   3. 通知：在 repo 的長期 Issue 留 comment（GitHub 會把留言寄到 repo 擁有者的信箱）
 *   4. 重新產生 index.html / all-routes.html / status.html，由 workflow commit 回 repo
 *
 * 追蹤條件：2027-01-01 ~ 2027-03-31 出發、行程 3–5 天（含頭尾）、且區間內同時涵蓋週六與週日、
 *           1 位成人、不含託運行李。
 * 金額一律是「實付總額」＝ 未稅票價 + 去程稅費 + 回程稅費。稅費見 tools/data.mjs（逐航段實測）。
 *
 * 用法：
 *   node tools/watch.mjs                    正常模式
 *   node tools/watch.mjs --dry              不通知、不寫檔，只印出本次會做什麼
 *   node tools/watch.mjs --fixture=x.json   用本地 JSON 取代 API（離線測試，路徑相對 repo 根目錄）
 *   node tools/watch.mjs --summary          強制發每日摘要（忽略「今天已發過」）
 *
 * 環境變數（workflow 提供）：GITHUB_TOKEN、GITHUB_REPOSITORY
 */

import { readFileSync, writeFileSync } from "node:fs";
import { AIRPORT_NAME, REGION, LEG_TAX, TAX_UPDATED } from "./data.mjs";

/* ============================ 可調參數 ============================ */

const TW_AIRPORTS = ["TPE", "RMQ", "KHH", "TNN"];
const DATE_FROM = "2027-01-01";
const DATE_TO = "2027-03-31";
const TRIP_NIGHTS = [3, 4, 5];
const REQUIRE_WEEKEND = true;

const DAILY_SUMMARY_HOUR = 8; // 台北時間 08:00 之後第一次執行時發摘要
const CHANGE_THROTTLE_MIN = 60; // 一般變動通知的最小間隔（分鐘）。新低價不受此限。
const MAX_NEWLOW = 5;
const MAX_CHANGE = 10;
const MAX_SUMMARY = 8;
const HIST_KEEP = 200; // #hist（走勢圖用）最多保留幾筆
const HIST_FINE_HOURS = 72; // 近 72 小時逐筆保留，更早的每天壓成一筆（保留當日最低）
const STATUS_KEEP = 120; // status 頁最多保留幾筆事件

const ISSUE_TITLE = "虎航票價通知";
/** repo 擁有者。每則通知都會 @ 他一次 —— Issue 是 bot 開的，
 *  擁有者預設不會自動訂閱這個討論串，但「被提及」一定會收到通知。 */
const OWNER = (process.env.GITHUB_REPOSITORY ?? "").split("/")[0];
const MENTION = OWNER ? `@${OWNER} ` : "";
const ISSUE_MARKER = "<!-- tigerair-watch-notify-thread -->";

const API = (s) => `https://api-book.tigerairtw.com/api/cms/station-daily-prices/${s}/TWD`;
const PAGE_HOME = "https://yenzackary.github.io/tigerair_fare_tracker/";
const PAGE_ALL = "https://yenzackary.github.io/tigerair_fare_tracker/all-routes.html";
const PAGE_STATUS = "https://yenzackary.github.io/tigerair_fare_tracker/status.html";

const ROOT = new URL("../", import.meta.url);
const P = {
  state: new URL("tools/state.json", ROOT),
  statusJson: new URL("status.json", ROOT),
  tplAll: new URL("tools/all-routes.template.html", ROOT),
  tplIndex: new URL("tools/index.template.html", ROOT),
  tplStatus: new URL("status_template.html", ROOT),
  outAll: new URL("all-routes.html", ROOT),
  outIndex: new URL("index.html", ROOT),
  outStatus: new URL("status.html", ROOT),
};

/* ============================ 小工具 ============================ */

const argOf = (n, d) => {
  const a = process.argv.find((v) => v.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const flag = (n) => process.argv.includes(`--${n}`);
const DRY = flag("dry");

function taipeiNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    stamp: `${d.toISOString().slice(0, 10)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    epoch: Date.now(),
  };
}

const WD = "日一二三四五六";
const fmt = (n) => n.toLocaleString("en-US");
const md = (iso) => iso.slice(5).replace("-", "/");
const dow = (iso) => WD[new Date(`${iso}T00:00:00Z`).getUTCDay()];
const nameOf = (c) => AIRPORT_NAME[c] ?? c;

function readJson(url, fallback) {
  try {
    return JSON.parse(readFileSync(url, "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") console.error(`讀取失敗，改用預設值：${e.message}`);
    return fallback;
  }
}

/** 從已產生的 all-routes.html 取回上次嵌進去的 JSON 區塊。 */
function readBlock(id) {
  try {
    const html = readFileSync(P.outAll, "utf8");
    const m = html.match(
      new RegExp(`<script type="application/json" id="${id}">(.*?)</script>`, "s"),
    );
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}

/* ============================ 抓價 ============================ */

async function fetchAllLegs() {
  const isTW = (c) => TW_AIRPORTS.includes(c);
  const fx = argOf("fixture", null);
  const fixture = fx ? JSON.parse(readFileSync(new URL(fx, ROOT), "utf8")) : null;
  const legs = {};
  for (const station of TW_AIRPORTS) {
    let rows;
    if (fixture) {
      rows = fixture[station] ?? [];
    } else {
      const res = await fetch(API(station), {
        headers: {
          accept: "application/json",
          "user-agent": "tigerair-fare-tracker (+github actions)",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} 抓 ${station} 失敗`);
      rows = await res.json();
    }
    for (const r of rows) {
      const date = r.pricingDate;
      if (!date || date < DATE_FROM || date > DATE_TO) continue;
      const o = r.origin;
      const d = r.destination;
      if (!o || !d || /XX/.test(o + d)) continue;
      if (isTW(o) === isTW(d)) continue; // 只要台灣↔國外
      (legs[`${o}-${d}`] ??= {})[date] = Number(r.pricingAmount);
    }
  }
  return legs;
}

/* ============================ V3 壓縮（頁面模板的解碼器需要這個格式） ============================ */

function dateRange() {
  const out = [];
  const end = new Date(`${DATE_TO}T00:00:00Z`);
  for (let d = new Date(`${DATE_FROM}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function encodeV3(legs) {
  const keys = Object.keys(legs).sort();
  const dates = dateRange();
  const prices = [...new Set(keys.flatMap((k) => Object.values(legs[k])))].sort((a, b) => a - b);
  const idx = new Map(prices.map((v, i) => [v, i]));
  const segs = keys.map((k) => {
    const toks = [];
    let prev = null;
    let run = 0;
    for (const d of dates) {
      const v = legs[k][d];
      const c = v == null ? "-" : String(idx.get(v));
      if (c === prev) {
        run++;
      } else {
        if (prev !== null) toks.push(run > 1 ? `${prev}*${run}` : prev);
        prev = c;
        run = 1;
      }
    }
    toks.push(run > 1 ? `${prev}*${run}` : prev);
    return `${k} ${toks.join(",")}`;
  });
  return `V3|${DATE_FROM}|${dates.length}|${prices.join(",")}|${segs.join(";")}`;
}

/* ============================ 條件與計算 ============================ */

function buildCombos() {
  const out = [];
  const end = new Date(`${DATE_TO}T00:00:00Z`);
  for (let d = new Date(`${DATE_FROM}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    for (const nights of TRIP_NIGHTS) {
      const back = new Date(d);
      back.setUTCDate(back.getUTCDate() + nights - 1);
      if (back > end) continue;
      if (REQUIRE_WEEKEND) {
        const days = new Set();
        for (let i = 0; i < nights; i++) {
          const q = new Date(d);
          q.setUTCDate(q.getUTCDate() + i);
          days.add(q.getUTCDay());
        }
        if (!days.has(6) || !days.has(0)) continue; // 6=週六, 0=週日
      }
      out.push([d.toISOString().slice(0, 10), back.toISOString().slice(0, 10), nights]);
    }
  }
  return out;
}

function computeRoutes(legs, combos) {
  const isTW = (c) => TW_AIRPORTS.includes(c);
  const routes = [];
  for (const key of Object.keys(legs)) {
    const [o, d] = key.split("-");
    if (!isTW(o)) continue;
    const back = `${d}-${o}`;
    if (!legs[back]) continue;
    let best = null;
    for (const [dep, ret, nights] of combos) {
      const a = legs[key][dep];
      const b = legs[back][ret];
      if (a == null || b == null) continue;
      const fare = a + b;
      if (!best || fare < best.fare) best = { fare, dep, ret, nights };
    }
    if (!best) continue;
    const t1 = LEG_TAX[key];
    const t2 = LEG_TAX[back];
    const taxKnown = t1 != null && t2 != null;
    const tax = taxKnown ? t1 + t2 : 0;
    routes.push({
      key,
      back,
      org: o,
      dst: d,
      label: `${nameOf(o)} ⇄ ${nameOf(d)}`,
      region: REGION[d] ?? "其他",
      ...best,
      tax,
      taxKnown,
      pay: best.fare + tax,
    });
  }
  routes.sort((a, b) => a.pay - b.pay || a.fare - b.fare);
  return routes;
}

/* ============================ 偵測 ============================ */

const EMPTY_STATE = {
  schema: 1,
  lastRunAt: null,
  lastChangeNotifyAt: null,
  lastDailyDate: null,
  best: {},
  allTimeLow: {},
  notifiedLow: {},
};

function detect(routes, state, now) {
  const newLows = [];
  const changes = [];
  for (const r of routes) {
    const low = state.allTimeLow[r.key];
    const prev = state.best[r.key];
    // 新低價 = 跌破「歷史最低」。第一次看到這條航線不算（沒有歷史可比）。
    const isNewLow = low != null && r.fare < low;
    if (isNewLow) {
      const seen = state.notifiedLow[r.key];
      const dup = seen && seen.fare === r.fare && now.epoch - (seen.at ?? 0) < 864e5;
      if (!dup) newLows.push({ ...r, prevLow: low });
    }
    // 一般變動 = 跟「上次」比有動，但不是新低
    if (prev != null && prev !== r.fare && !isNewLow) {
      changes.push({ ...r, prevFare: prev, diff: r.fare - prev });
    }
  }
  newLows.sort((a, b) => a.pay - b.pay);
  changes.sort((a, b) => a.diff - b.diff);

  const dailyDue =
    flag("summary") || (now.hour >= DAILY_SUMMARY_HOUR && state.lastDailyDate !== now.date);
  const changeDue =
    changes.length > 0 &&
    now.epoch - (state.lastChangeNotifyAt ?? 0) >= CHANGE_THROTTLE_MIN * 60000;
  return { newLows, changes, dailyDue, changeDue };
}

/* ============================ 通知內容（Markdown，貼進 Issue 留言） ============================ */

const ROUTE_HEAD = "| 航線 | 實付總額 | 未稅 + 稅費 | 去程 → 回程 | 天數 |\n|---|---:|---:|---|---:|";
const routeRow = (r) =>
  `| ${r.label} | ${r.taxKnown ? `**${fmt(r.pay)}**` : `${fmt(r.fare)}（未稅）`} | ` +
  `${r.taxKnown ? `${fmt(r.fare)} + ${fmt(r.tax)}` : "稅費未實測"} | ` +
  `${md(r.dep)}(${dow(r.dep)}) → ${md(r.ret)}(${dow(r.ret)}) | ${r.nights} |`;

function newLowBody(newLows, now) {
  const out = [`## 🔻 新低價 ${newLows.length} 條 · ${now.stamp}`, "", `${MENTION}有航線跌破歷史最低。`, "", ROUTE_HEAD];
  for (const r of newLows.slice(0, MAX_NEWLOW)) out.push(routeRow(r));
  out.push("");
  for (const r of newLows.slice(0, MAX_NEWLOW)) {
    out.push(
      `- **${r.label}** 比前低便宜 **${fmt(r.prevLow - r.fare)}**（未稅 ${fmt(r.prevLow)} → ${fmt(r.fare)}）`,
    );
  }
  if (newLows.length > MAX_NEWLOW) out.push(`- （另有 ${newLows.length - MAX_NEWLOW} 條未列出）`);
  out.push("", `[全航線儀表板](${PAGE_ALL}) · [結果頁](${PAGE_HOME})`);
  return out.join("\n");
}

function changeBody(changes, now) {
  const down = changes.filter((r) => r.diff < 0).length;
  const out = [
    `## 票價變動 ${changes.length} 條（降 ${down} / 漲 ${changes.length - down}） · ${now.stamp}`,
    "",
    `${MENTION}`,
    "",
    "| 航線 | 未稅 上次 → 這次 | 差額 | 實付總額 |",
    "|---|---|---:|---:|",
  ];
  for (const r of changes.slice(0, MAX_CHANGE)) {
    out.push(
      `| ${r.diff < 0 ? "▼" : "▲"} ${r.label} | ${fmt(r.prevFare)} → ${fmt(r.fare)} | ` +
      `${r.diff > 0 ? "+" : ""}${fmt(r.diff)} | ${r.taxKnown ? fmt(r.pay) : "—"} |`,
    );
  }
  if (changes.length > MAX_CHANGE) out.push("", `（另有 ${changes.length - MAX_CHANGE} 條未列出）`);
  out.push("", `[全航線儀表板](${PAGE_ALL})`);
  return out.join("\n");
}

function summaryBody(routes, changes, newLows, now, state, stats) {
  const cheapest = routes[0];
  const byRegion = {};
  for (const r of routes) {
    if (!byRegion[r.region] || r.pay < byRegion[r.region].pay) byRegion[r.region] = r;
  }
  const unknown = routes.filter((r) => !r.taxKnown);

  const out = [`## 每日摘要 · ${now.stamp}`, "", `${MENTION}`];
  if (now.hour >= 9) out.push("", "> 原定 08:00，因排程未能執行而延後。");
  out.push(
    "",
    `目前最便宜：**${cheapest.label} 實付 ${fmt(cheapest.pay)}**（${md(cheapest.dep)}(${dow(cheapest.dep)}) → ${md(cheapest.ret)}(${dow(cheapest.ret)})，${cheapest.nights} 天）`,
    newLows.length ? `本次偵測到 **${newLows.length} 條新低價**。` : "本次無新低價。",
    "",
    `### 最便宜 ${Math.min(MAX_SUMMARY, routes.length)} 條`,
    ROUTE_HEAD,
  );
  for (const r of routes.slice(0, MAX_SUMMARY)) out.push(routeRow(r));

  out.push("", "### 各地區最便宜");
  for (const region of ["日本", "韓國", "越南"]) {
    const r = byRegion[region];
    if (r) {
      out.push(
        `- **${region}**：${r.label} 實付 ${fmt(r.pay)}（${md(r.dep)} → ${md(r.ret)}，${r.nights} 天）`,
      );
    }
  }

  out.push("", "### 與上次相比的變動");
  if (!changes.length) {
    out.push("無變動");
  } else {
    for (const r of changes.slice(0, MAX_SUMMARY)) {
      out.push(
        `- ${r.diff < 0 ? "▼" : "▲"} ${r.label} 未稅 ${fmt(r.prevFare)} → ${fmt(r.fare)}（${r.diff > 0 ? "+" : ""}${fmt(r.diff)}）`,
      );
    }
    if (changes.length > MAX_SUMMARY) out.push(`- （另有 ${changes.length - MAX_SUMMARY} 條）`);
  }

  if (newLows.length) {
    out.push("", "### 新低價");
    for (const r of newLows.slice(0, MAX_NEWLOW)) {
      out.push(`- ${r.label} 實付 ${fmt(r.pay)}（比前低便宜 ${fmt(r.prevLow - r.fare)}）`);
    }
  }

  out.push(
    "",
    "### 資料狀態",
    `- 航線 **${routes.length}** 條；稅費逐航段實測，更新於 ${TAX_UPDATED}`,
  );
  if (unknown.length) {
    out.push(
      `- ⚠ ${unknown.length} 條航線有航段尚未實測稅費，顯示未稅價：${unknown.map((r) => r.label).join("、")}`,
    );
  }
  out.push(
    `- 票價涵蓋 ${DATE_FROM} – ${DATE_TO}`,
    `- 過去 24 小時記錄到 **${stats.ok}** 次執行${stats.gapHours != null ? `，最長間隔 ${stats.gapHours} 小時` : ""}`,
    `- 上次執行：${state.lastRunAt ?? "（無紀錄）"}`,
    "",
    `[結果頁](${PAGE_HOME}) · [全航線儀表板](${PAGE_ALL}) · [執行紀錄](${PAGE_STATUS})`,
  );
  return out.join("\n");
}

/* ============================ GitHub Issue 通知 ============================ */

async function gh(path, init = {}) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error("缺少 GITHUB_TOKEN 或 GITHUB_REPOSITORY");
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** 找到（或建立）那條長期通知 Issue，回傳 number。 */
async function ensureNotifyIssue() {
  const open = await gh("/issues?state=open&per_page=100");
  const found = open.find(
    (i) => !i.pull_request && typeof i.body === "string" && i.body.includes(ISSUE_MARKER),
  );
  if (found) return found.number;
  const body = [
    ISSUE_MARKER,
    "",
    "這是虎航票價追蹤的**通知串**。偵測到新低價、票價變動，或每天的摘要，都會以留言貼在這裡。",
    "因為你是這個 repo 的擁有者，GitHub 會把每一則留言寄到你的信箱 —— 這就是通知的送達方式。",
    "",
    "**不要關閉這個 Issue**，關掉之後程式會另外開一個新的。",
    "",
    `每則通知都會 @ ${OWNER || "你"} 一次，所以就算沒有訂閱這個討論串也會收到通知信。` +
      "若想連 Issue 本體的變動都收到，可以按右側的 Subscribe。",
    "",
    "| 事件 | 條件 | 節流 |",
    "|---|---|---|",
    "| 新低價 | 某航線未稅來回合計跌破歷史最低 | 不節流，一定發 |",
    `| 每日摘要 | 台北時間 ${DAILY_SUMMARY_HOUR}:00 後第一次執行 | 每天一次 |`,
    `| 一般變動 | 有變動但沒破歷史最低 | 每 ${CHANGE_THROTTLE_MIN} 分鐘最多一則 |`,
    "",
    `- 結果頁：${PAGE_HOME}`,
    `- 全航線儀表板：${PAGE_ALL}`,
    `- 變動與通知紀錄：${PAGE_STATUS}`,
  ].join("\n");
  const created = await gh("/issues", {
    method: "POST",
    body: JSON.stringify({ title: ISSUE_TITLE, body }),
  });
  console.log(`已建立通知 Issue #${created.number}`);
  return created.number;
}

const comment = (issue, body) =>
  gh(`/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body }) });

/* ============================ 產生頁面 ============================ */

/** 近 72 小時逐筆保留；更早的每天壓成一筆（取當日每條航線的最低，所以「追蹤最低」不會失真）。 */
function rollHist(hist, entry, now) {
  const all = [...hist.filter((h) => h.ts !== entry.ts), entry].sort((a, b) =>
    a.ts.localeCompare(b.ts),
  );
  const cut = new Date(now.epoch + 8 * 3600e3 - HIST_FINE_HOURS * 3600e3)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
  const recent = all.filter((h) => h.ts >= cut);
  const byDay = {};
  for (const h of all.filter((h) => h.ts < cut)) {
    const day = (byDay[h.ts.slice(0, 10)] ??= {});
    for (const [k, v] of Object.entries(h.best ?? {})) {
      if (day[k] == null || v < day[k]) day[k] = v;
    }
  }
  const rolled = Object.keys(byDay)
    .sort()
    .map((d) => ({ ts: `${d} 23:59`, best: byDay[d] }));
  return [...rolled, ...recent].slice(-HIST_KEEP);
}

const j = (o) => JSON.stringify(o);

function writeAllRoutes(payload, hist, now) {
  const tpl = readFileSync(P.tplAll, "utf8");
  const tax = { updated: TAX_UPDATED, checked: {}, estimated: [], legs: LEG_TAX };
  writeFileSync(
    P.outAll,
    tpl
      .replace("__LATEST__", j({ ts: now.stamp, pay: payload }))
      .replace("__HIST__", j(hist))
      .replace("__TAX__", j(tax)),
    "utf8",
  );
}

function writeIndex(routes, now, histLen) {
  const tpl = readFileSync(P.tplIndex, "utf8");
  const known = routes.filter((r) => r.taxKnown).length;
  const rows = routes
    .slice(0, 5)
    .map((r) => {
      const tag = r.taxKnown ? "" : '<span class="badge">推估</span>';
      return (
        `<tr><td>${r.label}${tag}` +
        `<span class="dt">${md(r.dep)}(${dow(r.dep)}) → ${md(r.ret)}(${dow(r.ret)}) · ${r.nights} 天</span></td>` +
        `<td>${fmt(r.taxKnown ? r.pay : r.fare)}</td></tr>`
      );
    })
    .join("");
  const desc =
    `桃園／台中／高雄／台南出發的所有航點，共 ${routes.length} 條來回航線。` +
    `目前最便宜的 5 條（<b>實付總額</b>，含稅；稅費 ${known}/${routes.length} 條為官網<b>逐航段實測</b>` +
    (known === routes.length ? "，全部航線都有含稅價" : '，其餘標 <span class="badge">推估</span>') +
    "）：";
  const cards =
    '<a class="card" href="all-routes.html">' +
    '<div class="ct">全航線 · 台灣出發</div>' +
    `<div class="cd">${desc}</div>` +
    `<table><tbody>${rows}</tbody></table>` +
    '<div class="go">打開完整儀表板 →</div></a>' +
    '<a class="card" href="status.html">' +
    '<div class="ct">變動與通知紀錄</div>' +
    '<div class="cd">每次票價變動、每一則發出的通知都會留下一筆。想看每一次抓價的完整 log，' +
    '到 repo 的 Actions 頁。</div>' +
    '<div class="go">看紀錄 →</div></a>';
  writeFileSync(
    P.outIndex,
    tpl
      .replace("__UPDATED__", `最後更新：${now.stamp}（台北時間） · 已累積 ${histLen} 次抓價`)
      .replace("__CARDS__", cards),
    "utf8",
  );
}

function writeStatus(statusData) {
  writeFileSync(P.outStatus, readFileSync(P.tplStatus, "utf8").replace("__RUNS__", j(statusData)), "utf8");
  writeFileSync(P.statusJson, `${JSON.stringify(statusData, null, 2)}\n`, "utf8");
}

/** 過去 24 小時的執行統計（摘要要用）。 */
function runStatsOf(statusData, now) {
  const ms = (ts) => Date.parse(`${ts.replace(" ", "T")}:00+08:00`);
  const recent = (statusData.runs ?? [])
    .map((r) => ms(r.ts))
    .filter((t) => Number.isFinite(t) && t >= now.epoch - 864e5)
    .sort((a, b) => a - b);
  let gap = null;
  for (let i = 1; i < recent.length; i++) {
    const g = (recent[i] - recent[i - 1]) / 3600e3;
    if (gap == null || g > gap) gap = g;
  }
  return { ok: recent.length, gapHours: gap == null ? null : Math.round(gap * 10) / 10 };
}

/* ============================ 主流程 ============================ */

async function main() {
  const now = taipeiNow();
  console.log(`[${now.stamp}] 台北時間${DRY ? "（--dry）" : ""}`);

  const legs = await fetchAllLegs();
  const combos = buildCombos();
  const routes = computeRoutes(legs, combos);
  if (!routes.length) throw new Error("沒有算出任何航線 —— API 格式可能變了，先用 --dry 檢查");
  console.log(`航段 ${Object.keys(legs).length}｜航線 ${routes.length}｜日期組合 ${combos.length}`);

  const payload = encodeV3(legs);
  const state = { ...EMPTY_STATE, ...(readJson(P.state, {}) ?? {}) };
  const statusData = readJson(P.statusJson, { schema: 1, runs: [] });
  const firstRun = Object.keys(state.best).length === 0;

  const prevLatest = readBlock("latest");
  const priceChanged = prevLatest?.pay !== payload;

  const { newLows, changes, dailyDue, changeDue } = detect(routes, state, now);
  console.log(
    `票價 ${priceChanged ? "有變動" : "與上次相同"}｜新低 ${newLows.length}｜變動 ${changes.length}` +
    `｜摘要 ${dailyDue ? "要發" : "略過"}｜變動通知 ${changeDue ? "要發" : changes.length ? "節流中" : "無"}`,
  );
  if (firstRun) console.log("第一次執行：只建立基準，不發新低價／變動通知。");

  /* ---- 通知 ---- */
  const stats = runStatsOf(statusData, now);
  const planned = [];
  if (newLows.length) planned.push(["newlow", newLowBody(newLows, now)]);
  if (dailyDue) planned.push(["daily", summaryBody(routes, changes, newLows, now, state, stats)]);
  if (changeDue && !newLows.length) planned.push(["change", changeBody(changes, now)]);

  const notified = [];
  if (DRY) {
    for (const [kind, body] of planned) console.log(`\n===== ${kind} =====\n${body}\n=====`);
    if (!planned.length) console.log("本次沒有要發的通知。");
  } else if (planned.length) {
    // 通知失敗不能阻擋資料更新；失敗時不寫 notifiedLow，下次會重試 ——
    // 這是「新低價一定要通知到」的保險。
    try {
      const issue = await ensureNotifyIssue();
      for (const [kind, body] of planned) {
        await comment(issue, body);
        notified.push(kind);
        console.log(`已留言 Issue #${issue}：${kind}`);
      }
    } catch (e) {
      console.error(`⚠ 通知失敗（頁面仍會更新，下次執行會重試）：${e.message}`);
      process.exitCode = 1;
    }
  }

  if (DRY) {
    console.log("\n--dry：不寫任何檔案。");
    return;
  }

  /* ---- 頁面 ---- */
  if (priceChanged) {
    const best = {};
    for (const r of routes) best[r.key] = r.fare;
    const hist = rollHist(readBlock("hist") ?? [], { ts: now.stamp, best }, now);
    writeAllRoutes(payload, hist, now);
    writeIndex(routes, now, hist.length);
    console.log(`已更新 all-routes.html / index.html（歷程 ${hist.length} 筆）`);
  } else {
    console.log("票價無變動：不重寫儀表板頁面。");
  }

  /* ---- status：只記有意義的事件 + 每小時一筆「還活著」 ----
     每一次執行的完整紀錄在 repo 的 Actions 頁，不需要在這裡每 15 分鐘寫一筆、
     徒增 commit 與雜訊。 */
  const heartbeatDue = now.minute < 15;
  if (priceChanged || notified.length || firstRun || heartbeatDue) {
    const noteBits = [];
    if (changes.length) {
      noteBits.push(
        changes
          .slice(0, 3)
          .map((r) => `${r.label} ${r.diff > 0 ? "+" : ""}${fmt(r.diff)}`)
          .join("、"),
      );
    }
    if (newLows.length) noteBits.push(`新低：${newLows.slice(0, 3).map((r) => r.label).join("、")}`);
    if (firstRun) noteBits.push("第一次執行，建立基準");
    if (!noteBits.length && !priceChanged) noteBits.push("例行檢查，票價無變動");

    statusData.runs = [
      ...(statusData.runs ?? []),
      {
        ts: now.stamp,
        by: "actions",
        result: priceChanged ? "changed" : "no-change",
        changed: changes.length + newLows.length,
        deployed: priceChanged,
        tax: `逐航段實測（${TAX_UPDATED}）`,
        notified,
        note: noteBits.join("；"),
      },
    ].slice(-STATUS_KEEP);
    statusData.updated = now.stamp;
    statusData.note =
      "這裡只記錄有意義的事件（票價變動、發出的通知）加上每小時一筆例行檢查。" +
      "每一次執行的完整紀錄與 log 在 repo 的 Actions 頁。";
    writeStatus(statusData);
    console.log("已更新 status.html / status.json");
  } else {
    console.log("本次無事件且非整點：不寫 status（完整執行紀錄看 Actions 頁）。");
  }

  /* ---- 狀態 ---- */
  for (const r of routes) {
    state.best[r.key] = r.fare;
    const low = state.allTimeLow[r.key];
    if (low == null || r.fare < low) state.allTimeLow[r.key] = r.fare;
  }
  if (notified.includes("newlow")) {
    for (const r of newLows) state.notifiedLow[r.key] = { fare: r.fare, at: now.epoch };
  }
  if (notified.includes("daily")) state.lastDailyDate = now.date;
  if (notified.includes("change")) state.lastChangeNotifyAt = now.epoch;
  state.lastRunAt = now.stamp;
  writeFileSync(P.state, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  console.log("已更新 tools/state.json");
}

main().catch((e) => {
  console.error(`執行失敗：${e?.stack ?? e}`);
  process.exitCode = 1;
});
