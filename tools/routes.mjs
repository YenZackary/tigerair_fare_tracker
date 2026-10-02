// Only the six approved Korea open-jaw pairs; Jeju remains on normal round trips.
export const OPEN_JAW_PAIRS = [
  ['TPE-ICN', 'PUS-TPE'],
  ['TPE-ICN', 'GMP-KHH'],
  ['TPE-PUS', 'ICN-TPE'],
  ['TPE-PUS', 'GMP-KHH'],
  ['KHH-GMP', 'ICN-TPE'],
  ['KHH-GMP', 'PUS-TPE'],
];
export const ROUTE_MODEL = 'roundtrip-and-korea-openjaw-v1';

export function routeDefinitions(legs, names, regions) {
  const tw = ['TPE', 'RMQ', 'KHH', 'TNN'];
  const name = c => names[c] ?? c;
  const pairs = Object.keys(legs).filter(k => tw.includes(k.split('-')[0]))
    .map(k => [k, k.split('-').reverse().join('-'), false]);
  pairs.push(...OPEN_JAW_PAIRS.map(([out, back]) => [out, back, true]));
  return pairs.filter(([out, back]) => legs[out] && legs[back]).map(([outKey, back, openJaw]) => {
    const [org, dst] = outKey.split('-');
    const [returnFrom, returnTo] = back.split('-');
    return {
      key: openJaw ? `${outKey}__${back}` : outKey,
      outKey, back, org, dst, returnFrom, returnTo, openJaw,
      region: regions[dst] ?? '其他',
      label: openJaw ? `${name(org)} → ${name(dst)}／${name(returnFrom)} → ${name(returnTo)}`
        : `${name(org)} ⇄ ${name(dst)}`,
      code: openJaw ? `${outKey} / ${back}` : `${org}⇄${dst}`,
    };
  });
}

export function browserRouteCode() {
  return `const OPEN_JAW_PAIRS=${JSON.stringify(OPEN_JAW_PAIRS)};\n${routeDefinitions.toString()}`;
}
