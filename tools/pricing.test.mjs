import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
import * as data from './data.mjs';
import * as fees from './fees.mjs';
import * as routeTools from './routes.mjs';

const source=readFileSync(new URL('./watch.mjs',import.meta.url),'utf8');
function engine(fixture={}) {
  const code=source.replace(/^import .*;\r?\n/gm,'')
    .replaceAll('import.meta.url',JSON.stringify(new URL('./watch.mjs',import.meta.url).href))
    .slice(0,source.replace(/^import .*;\r?\n/gm,'').replaceAll('import.meta.url',JSON.stringify(new URL('./watch.mjs',import.meta.url).href)).lastIndexOf('main().catch'));
  return vm.runInNewContext(code+'\n({fetchAllLegs,buildCombos,computeRoutes,encodeV3,writeAllRoutes,writeIndex,detect});',{
    ...data,...fees,...routeTools,readFileSync:()=>JSON.stringify(fixture),writeFileSync:()=>{},URL,console,
    process:{argv:['node','watch','--fixture=test.json'],env:{}},Date,
  });
}

test('all 88 observations reconstruct their actual cart fees',()=>{
  assert.equal(Object.keys(fees.FEE_OBSERVATIONS.legs).length,88);
  for(const [key,row] of Object.entries(fees.FEE_OBSERVATIONS.legs))assert.equal(fees.legFee(key,row.date),row.fee,key);
  assert.equal(fees.legFee('TPE-UNKNOWN','2027-06-01'),null);
  assert.equal(fees.legFee('TPE-ICN','2028-01-01'),null);
});
test('peak boundaries and airport/country restrictions match official policy',()=>{
  assert.equal(fees.bookingFee('TPE-ICN','2027-04-24'),350);
  assert.equal(fees.bookingFee('ICN-TPE','2027-04-28'),450);
  assert.equal(fees.bookingFee('TPE-NRT','2027-04-14'),450);
  assert.equal(fees.bookingFee('TPE-ICN','2027-04-14'),350);
  assert.equal(fees.bookingFee('TPE-DAD','2027-03-20'),350);
  assert.equal(fees.bookingFee('TPE-FUK','2027-03-20'),450);
  assert.equal(fees.bookingFee('TPE-PUS','2027-10-13'),450);
  assert.equal(fees.bookingFee('TPE-PUS','2027-10-14'),350);
});
test('choose lower total when equal base fares have different peak fees',()=>{
  const e=engine(), legs={'TPE-ICN':{'2027-04-24':1599,'2027-08-28':1599},'ICN-TPE':{'2027-04-28':1199,'2027-09-01':1199}};
  const r=e.computeRoutes(legs,e.buildCombos())[0];
  assert.equal(r.dep,'2027-08-28');assert.equal(r.pay,4798);
  assert(e.buildCombos().some(([d,r])=>d==='2027-10-29'&&r==='2027-10-31'));
  assert(e.buildCombos().every(([,r])=>r<='2027-10-31'));
});
test('latest API record wins regardless of response order; invalid rows are excluded',async()=>{
  const row=(amount,updatedAt)=>({origin:'TPE',destination:'ICN',pricingDate:'2027-04-24',pricingCurrency:'TWD',pricingAmount:amount,updatedAt});
  const rows=[row('1599','2026-10-02 12:00:00'),row('9999','2026-09-01 12:00:00'),row('bad','2026-10-03 12:00:00'),{...row('1','2026-10-03'),pricingCurrency:'JPY'}];
  for(const candidates of [rows,[...rows].reverse()]){
    const legs=await engine({TPE:candidates}).fetchAllLegs();assert.equal(legs['TPE-ICN']['2027-04-24'],1599);
  }
});
test('browser and backend agree on all combinations and lowest total',()=>{
  const e=engine(), legs={'TPE-ICN':{'2027-04-24':1599,'2027-08-28':1599},'ICN-TPE':{'2027-04-28':1199,'2027-09-01':1199}};
  const tpl=readFileSync(new URL('./all-routes.template.html',import.meta.url),'utf8');
  const code=tpl.replace('__ROUTE_HELPERS__',routeTools.browserRouteCode()).slice(tpl.indexOf("const TW=['TPE'"),tpl.replace('__ROUTE_HELPERS__',routeTools.browserRouteCode()).indexOf('/* 每條航線的最便宜組合'));
  const all=vm.runInNewContext(fees.browserFeeCode()+'\n'+code+'\nALL;',{
    LEGS:legs,NAME:data.AIRPORT_NAME,cty:()=> '韓國',isEst:()=>false,
  });
  const backend=e.computeRoutes(legs,e.buildCombos())[0];
  const best=[...all].sort((a,b)=>a.pay-b.pay)[0];
  assert.equal(best.pay,backend.pay);assert.equal(best.dep,backend.dep);
});

test('exactly six approved open-jaw pairs use their own fares, fees and history keys',()=>{
  const dep='2027-10-08',ret='2027-10-10';
  const legs={};
  const outward={'TPE-ICN':1000,'TPE-PUS':2000,'KHH-GMP':3000,'TPE-CJU':4000};
  const returns={'ICN-TPE':5000,'PUS-TPE':6000,'GMP-KHH':7000,'CJU-TPE':8000};
  for(const [k,v] of Object.entries(outward))legs[k]={[dep]:v};
  for(const [k,v] of Object.entries(returns))legs[k]={[ret]:v};
  const e=engine(),results=e.computeRoutes(legs,e.buildCombos());
  const open=results.filter(r=>r.openJaw);
  assert.equal(open.length,6);
  assert.equal(new Set(results.map(r=>r.key)).size,results.length);
  assert.deepEqual(Array.from(open,r=>`${r.outKey}/${r.back}`).sort(),
    routeTools.OPEN_JAW_PAIRS.map(([a,b])=>`${a}/${b}`).sort());
  for(const r of open){
    assert(!r.key.includes('CJU'));
    assert.equal(r.fare,outward[r.outKey]+returns[r.back]);
    assert.equal(r.pay,r.fare+fees.legFee(r.outKey,dep)+fees.legFee(r.back,ret));
  }
  const before=results.filter(r=>!r.openJaw);
  const state={best:Object.fromEntries(before.map(r=>[r.key,r.pay])),
    allTimeLow:Object.fromEntries(before.map(r=>[r.key,r.pay])),notifiedLow:{},lastDailyDate:'2026-10-02'};
  const detected=e.detect(results,state,{date:'2026-10-02',hour:13,epoch:0});
  assert.equal(detected.newLows.length,0);assert.equal(detected.changes.length,0);
  const missing={...legs};delete missing['GMP-KHH'];
  assert.equal(e.computeRoutes(missing,e.buildCombos()).filter(r=>r.openJaw).length,4);
  const tpl=readFileSync(new URL('./all-routes.template.html',import.meta.url),'utf8')
    .replace('__ROUTE_HELPERS__',routeTools.browserRouteCode());
  const code=tpl.slice(tpl.indexOf("const TW=['TPE'"),tpl.indexOf('/* 每條航線的最便宜組合'));
  const all=vm.runInNewContext(fees.browserFeeCode()+'\n'+code+'\nALL;',{
    LEGS:legs,NAME:data.AIRPORT_NAME,cty:c=>data.REGION[c],isEst:()=>false,
  });
  for(const r of results){
    const b=all.find(x=>x.R.key===r.key);assert(b,r.key);assert.equal(b.pay,r.pay,r.key);
  }
});
