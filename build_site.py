#!/usr/bin/env python3
"""把兩個儀表板組成一個可部署的靜態網站（含首頁）。不需要任何憑證。"""
import json, os, re, shutil, sys
from datetime import date, timedelta

def _arg(flag, default):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default

# 兩份儀表板的來源檔（預設是 artifact staging 的位置）
SRC1 = _arg('--busan', '/mnt/user-data/uploads/cowork-artifacts/tigerair-fare-tracker/index.html')
SRC2 = _arg('--all',   '/mnt/user-data/uploads/cowork-artifacts/tigerair-all-routes/index.html')
SITE = _arg('--out',   '/mnt/user-data/outputs')   # 三個頁面的輸出目錄

NAME = {'TPE':'桃園','RMQ':'台中','KHH':'高雄','TNN':'台南',
  'AXT':'秋田','CJU':'濟州','CTS':'札幌','DAD':'峴港','FKS':'福島','FUK':'福岡','GMP':'首爾金浦',
  'HKD':'函館','HNA':'花卷','HND':'東京羽田','HSG':'佐賀','ICN':'首爾仁川','ISG':'石垣島',
  'KCZ':'高知','KIJ':'新潟','KIX':'大阪','KMI':'宮崎','KMJ':'熊本','KMQ':'小松','NGO':'名古屋',
  'NRT':'東京成田','OIT':'大分','OKA':'沖繩','OKJ':'岡山','PUS':'釜山','SDJ':'仙台','YGJ':'米子'}


def block(html, sid):
    m = re.search(r'<script type="application/json" id="%s">(.*?)</script>' % sid, html, re.S)
    return json.loads(m.group(1)) if m else None


def combos():
    out = []
    d, end = date(2027, 1, 1), date(2027, 3, 31)
    while d <= end:
        for n in (3, 4, 5):
            r = d + timedelta(days=n - 1)
            if r > end:
                continue
            wd = {(d + timedelta(days=i)).weekday() for i in range(n)}
            if 5 in wd and 6 in wd:
                out.append((d.isoformat(), r.isoformat(), n))
        d += timedelta(days=1)
    return out
CB = combos()
W = '一二三四五六日'


def dow(iso):
    y, m, d = map(int, iso.split('-'))
    return W[date(y, m, d).weekday()]


def md(iso):
    return iso[5:].replace('-', '/')


def decode_v3(pay):
    p = pay.split('|')
    n = int(p[2])
    prices = [int(x) for x in p[3].split(',')]
    y, m, d = map(int, p[1].split('-'))
    d0 = date(y, m, d)
    dates = [(d0 + timedelta(days=i)).isoformat() for i in range(n)]
    legs = {}
    for seg in p[4].split(';'):
        k, body = seg.split(' ', 1)
        vals = []
        for tok in body.split(','):
            if '*' in tok:
                c, cnt = tok.split('*'); cnt = int(cnt)
            else:
                c, cnt = tok, 1
            v = None if c == '-' else prices[int(c)]
            vals += [v] * cnt
        assert len(vals) == n, (k, len(vals))
        legs[k] = {dt: v for dt, v in zip(dates, vals) if v is not None}
    return dates, legs


def stage1():
    html = open(SRC1, encoding='utf-8').read()
    hist = block(html, 'hist')
    tax = block(html, 'tax')['legs']
    p = hist[-1]['prices']
    rows = []
    for lbl, ok, bk in [('桃園 ⇄ 釜山', 'TPE-PUS', 'PUS-TPE'),
                        ('桃園 ⇄ 大阪', 'TPE-KIX', 'KIX-TPE'),
                        ('高雄 ⇄ 大阪', 'KHH-KIX', 'KIX-KHH')]:
        t = tax.get(ok, 0) + tax.get(bk, 0)
        best = None
        for dep, ret, n in CB:
            a, b = p.get(ok, {}).get(dep), p.get(bk, {}).get(ret)
            if a and b:
                v = a + b + t
                if best is None or v < best[0]:
                    best = (v, dep, ret, n, a + b)
        if best:
            rows.append(dict(label=lbl, pay=best[0], dep=best[1], ret=best[2],
                             nights=best[3], fare=best[4], tax=t, taxKnown=True))
    return hist[-1]['ts'], len(hist), rows


def stage2():
    html = open(SRC2, encoding='utf-8').read()
    latest = block(html, 'latest')
    hist = block(html, 'hist')
    taxblk = block(html, 'tax')
    tax = taxblk['legs']
    est = set(taxblk.get('estimated') or [])
    dates, legs = decode_v3(latest['pay'])
    TW = ['TPE', 'RMQ', 'KHH', 'TNN']
    rows = []
    for k in legs:
        o, d = k.split('-')
        if o not in TW:
            continue
        bk = d + '-' + o
        if bk not in legs:
            continue
        to, tb = tax.get(k) or 0, tax.get(bk) or 0
        known = (k not in est) and (bk not in est)   # 兩端都實測才算已查核
        t = to + tb
        best = None
        for dep, ret, n in CB:
            a, b = legs[k].get(dep), legs[bk].get(ret)
            if a and b:
                v = a + b
                if best is None or v < best[0]:
                    best = (v, dep, ret, n)
        if best:
            rows.append(dict(label=f"{NAME.get(o,o)} ⇄ {NAME.get(d,d)}",
                             fare=best[0], pay=best[0] + t, dep=best[1], ret=best[2],
                             nights=best[3], tax=t, taxKnown=known))
    rows.sort(key=lambda r: r['fare'])
    return latest['ts'], len(hist), len(rows), rows


LANDING = """<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>虎航票價追蹤</title>
<style>
:root{color-scheme:light;--surface-1:#fcfcfb;--plane:#f9f9f7;--ink:#0b0b0b;--ink2:#52514e;
 --muted:#898781;--grid:#e1e0d9;--ring:rgba(11,11,11,.10);--s1:#2a78d6;--s2:#eb6834;--warn:#fab219}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--surface-1:#1a1a19;--plane:#0d0d0d;
 --ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--ring:rgba(255,255,255,.10);
 --s1:#3987e5;--s2:#d95926}}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
 font-family:system-ui,-apple-system,"Segoe UI","Noto Sans TC",sans-serif;font-size:15px;line-height:1.6}
.wrap{max-width:880px;margin:0 auto;padding:56px 20px 80px}
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.01em}
.sub{color:var(--ink2);font-size:14px;max-width:640px}
.note{color:var(--muted);font-size:12px;margin-top:10px}
a.card{display:block;text-decoration:none;color:inherit;background:var(--surface-1);
 border:1px solid var(--ring);border-radius:14px;padding:22px;margin-top:18px;transition:border-color .15s}
a.card:hover{border-color:var(--s1)}
.ct{font-size:17px;font-weight:600;margin:0 0 4px}
.cd{font-size:13px;color:var(--ink2);margin:0 0 14px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:14px}
td{padding:6px 0;border-bottom:1px solid var(--grid)}
td:last-child{text-align:right;font-weight:600}
tr:last-child td{border-bottom:0}
.dt{color:var(--muted);font-size:12px;font-weight:400;margin-left:8px}
.go{font-size:13px;color:var(--s1);margin-top:12px;font-weight:500}
.badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;
 border:1px solid var(--warn);color:var(--ink2);margin-left:6px;font-weight:400}
footer{margin-top:40px;font-size:12px;color:var(--muted);border-top:1px solid var(--grid);padding-top:16px}
</style>
</head>
<body>
<div class="wrap">
<h1>虎航票價追蹤</h1>
<div class="sub">台灣虎航 2027 年 1–3 月的來回票價追蹤：行程 3–5 天，且必須涵蓋週六與週日。
每小時自動抓一次官網票價，記錄歷史最低價（只在票價真的變動時才更新頁面）。</div>
<div class="note">__UPDATED__</div>

__CARDS__

<footer>
資料來源：台灣虎航官網每日票價 API。票價為 1 位成人、不含託運行李與選位。
顯示金額為<b>實付總額</b>（票價＋稅費）。機場稅費<b>逐航段實測</b>自官網訂票引擎購物車的
「稅金與其他費用」欄位，<b>不使用推估值</b>；若有尚未實測的航段會標示<span class="badge">推估</span>。<br>
實際可售價格隨機位變動（實測一小時內就會變動），請以官網結帳頁為準。本頁僅供參考，非虎航官方頁面。<br>
每小時自動抓一次 —— <a href="status.html" style="color:var(--s1)">看排程執行紀錄</a>（哪幾次跑了、哪幾次漏了）。
</footer>
</div>
</body>
</html>
"""


def card(href, title, desc, rows, basis='pay', extra=''):
    """basis='pay' 顯示實付總額；basis='fare' 一律顯示未稅價（跨航線比較時基準才一致）"""
    trs = ''
    for r in rows:
        if basis == 'fare':
            tag, val = '', r['fare']
        else:
            tag = '' if r.get('taxKnown') else '<span class="badge">推估</span>'
            val = r['pay']
        trs += (f'<tr><td>{r["label"]}{tag}'
                f'<span class="dt">{md(r["dep"])}({dow(r["dep"])}) → {md(r["ret"])}({dow(r["ret"])}) · {r["nights"]} 天</span></td>'
                f'<td>{val:,}</td></tr>')
    return (f'<a class="card" href="{href}">'
            f'<div class="ct">{title}</div><div class="cd">{desc}</div>'
            f'<table><tbody>{trs}</tbody></table>'
            f'<div class="go">打開完整儀表板 →</div>{extra}</a>')


def main():
    os.makedirs(SITE, exist_ok=True)
    ts1, n1, r1 = stage1()
    ts2, n2, nroutes, r2 = stage2()
    shutil.copy(SRC1, os.path.join(SITE, 'busan-osaka.html'))
    shutil.copy(SRC2, os.path.join(SITE, 'all-routes.html'))
    open(os.path.join(SITE, '.nojekyll'), 'w').close()

    ntax = sum(1 for r in r2 if r['taxKnown'])
    r2p = sorted(r2, key=lambda r: r['pay'])
    cards = card('all-routes.html', '全航線 · 台灣出發',
                 f'桃園／台中／高雄／台南出發的所有航點，共 {nroutes} 條來回航線。'
                 f'目前最便宜的 5 條（<b>實付總額</b>，含稅；'
                 f'稅費 {ntax}/{nroutes} 條為官網<b>逐航段實測</b>'
                 + ('，全部航線都有含稅價' if ntax == nroutes else '，其餘標 <span class="badge">推估</span>')
                 + '）：',
                 r2p[:5], basis='pay')
    cards += card('busan-osaka.html', '釜山 / 大阪 專追',
                  '桃園⇄釜山、桃園⇄大阪、高雄⇄大阪。稅費已逐航段查核，顯示<b>實付總額</b>：',
                  r1, basis='pay')
    html = (LANDING
            .replace('__UPDATED__', f'最後更新：全航線 {ts2}／釜山大阪 {ts1}（台北時間）')
            .replace('__CARDS__', cards))
    open(os.path.join(SITE, 'index.html'), 'w', encoding='utf-8').write(html)

    total = sum(os.path.getsize(os.path.join(SITE, f)) for f in os.listdir(SITE))
    print(f'{SITE} 已產生：{", ".join(sorted(os.listdir(SITE)))}')
    print(f'共 {total/1024:.0f} KB')


if __name__ == '__main__':
    main()
