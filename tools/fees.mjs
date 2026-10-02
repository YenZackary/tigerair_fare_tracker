import observations from './fee-observations.json' with { type: 'json' };

export const TAX_UPDATED = '2026-10-02';
export const PRICE_MODEL = 'date-fees-2026-10-02-v1';
export const PEAK_WINDOWS = [
  ['2027-01-01','2027-01-04'], ['2027-01-29','2027-02-15'],
  ['2027-02-25','2027-03-03'], ['2027-03-18','2027-03-27',['JP','KR']],
  ['2027-03-28','2027-04-11'], ['2027-04-14','2027-04-28',['NGO','KMQ','NRT']],
  ['2027-04-28','2027-05-10',['JP']], ['2027-04-28','2027-05-04'],
  ['2027-06-05','2027-06-13'], ['2027-06-24','2027-07-15'],
  ['2027-08-12','2027-08-17',['JP']], ['2027-09-11','2027-09-19'],
  ['2027-09-24','2027-09-29'], ['2027-10-07','2027-10-13'],
  ['2027-10-21','2027-10-27'],
];

// Official booking fee: TWD 350 off peak, 450 on each peak flight date.
export function bookingFee(key, date) {
  const tw = ['TPE','RMQ','KHH','TNN'];
  const foreign = key.split('-').find(code => !tw.includes(code));
  const region = ['CJU','GMP','ICN','PUS'].includes(foreign) ? 'KR' : foreign === 'DAD' ? 'VN' : 'JP';
  return PEAK_WINDOWS.some(([from,to,only]) => date >= from && date <= to &&
    (!only || only.includes(foreign) || only.includes(region))) ? 450 : 350;
}

// Normalize each measured cart fee by removing its documented booking fee.
// This preserves the measured airport/tax amount; do not infer missing routes.
export const FEE_BASE = Object.fromEntries(Object.entries(observations.legs).map(
  ([key, row]) => [key, row.fee - bookingFee(key, row.date)],
));
export function legFee(key, date) {
  if (FEE_BASE[key] == null || date < '2027-01-01' || date > '2027-10-31') return null;
  return FEE_BASE[key] + bookingFee(key, date);
}
export const FEE_OBSERVATIONS = observations;

// Embed the identical calculator in the static dashboard to prevent drift.
export function browserFeeCode() {
  return `const FEE_BASE=${JSON.stringify(FEE_BASE)};\nconst PEAK_WINDOWS=${JSON.stringify(PEAK_WINDOWS)};\n${bookingFee.toString()}\n${legFee.toString()}`;
}
