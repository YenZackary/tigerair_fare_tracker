#!/usr/bin/env python3
"""把 status.json 灌進 status_template.html 產生 status.html。不需要憑證。

用法: python3 build_status.py <status.json> <status_template.html> <輸出的status.html>
"""
import json, sys
data = json.load(open(sys.argv[1], encoding='utf-8'))
tpl  = open(sys.argv[2], encoding='utf-8').read()
assert '__RUNS__' in tpl, 'template 少了 __RUNS__ 佔位符'
out = tpl.replace('__RUNS__', json.dumps(data, ensure_ascii=False, separators=(',', ':')))
open(sys.argv[3], 'w', encoding='utf-8').write(out)
print(f"status.html 已產生（{len(data.get('runs', []))} 筆紀錄，{len(out)/1024:.1f} KB）")
