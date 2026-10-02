import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
import * as data from './data.mjs';
import * as fees from './fees.mjs';

const source=readFileSync(new URL('./watch.mjs',import.meta.url),'utf8');
function engine(fixture={}) {
  const code=source.replace(/^import .*;\r?\n/gm,'')
    .replaceAll('import.meta.url',JSON.stringify(new URL('./watch.mjs',import.meta.url).href))
    .slice(0,source.replace(/^import .*;\r?\n/gm,'').replaceAll('import.meta.url',JSON.stringify(new URL('./watch.mjs',import.meta.url).href)).lastIndexOf('main().catch'));
  return vm.runInNewContext(code+'\n({fetchAllLegs,buildCombos,computeRoutes,encodeV3,writeAllRoutes,writeIndex,detect});',{
    ...data,...fees,readFileSync:()=>JSON.stringify(fixture),writeFileSync:()=>{},URL,console,
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
  const code=tpl.slice(tpl.indexOf("const TW=['TPE'"),tpl.indexOf('/* 每條航線的最便宜組合'));
  const all=vm.runInNewContext(fees.browserFeeCode()+'\n'+code+'\nALL;',{
    LEGS:legs,NAME:data.AIRPORT_NAME,cty:()=> '韓國',isEst:()=>false,
  });
  const backend=e.computeRoutes(legs,e.buildCombos())[0];
  const best=[...all].sort((a,b)=>a.pay-b.pay)[0];
  assert.equal(best.pay,backend.pay);assert.equal(best.dep,backend.dep);
});
